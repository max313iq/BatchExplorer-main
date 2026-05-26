import { __awaiter } from "tslib";
import { NodeAgent } from "../node-agent";
import { MultiRegionStore } from "../../store/multi-region-store";
import { RequestScheduler } from "../../scheduling/request-scheduler";
// NOTE: this file uses the `.test.ts` extension. The project's default
// jest config matches `*.spec.ts`, so this file is skipped by the
// runner. The test bodies remain as a reference for future suite work
// — see `*.spec.ts` siblings of this file for the live behavioral
// tests covering the agents subsystem.
// Avoid persistence side effects from msal-auth's setActiveTenant.
jest.mock("../../auth/msal-auth", () => ({
    setActiveTenant: jest.fn(),
}));
// Mock the batch-service layer (re-exported via "../services").
jest.mock("../../services", () => {
    const actual = jest.requireActual("../../services");
    return Object.assign(Object.assign({}, actual), { listPools: jest.fn(), listNodes: jest.fn(), performNodeAction: jest.fn(), removeNodes: jest.fn() });
});
import { listPools, listNodes, performNodeAction, removeNodes } from "../../services";
const mockedListPools = listPools;
const mockedListNodes = listNodes;
const mockedPerformNodeAction = performNodeAction;
const mockedRemoveNodes = removeNodes;
// ---------------------------------------------------------------------------
// Test fixtures + helpers
// ---------------------------------------------------------------------------
const makeAccount = (id, overrides = {}) => (Object.assign({ id, accountName: `acct-${id}`, resourceGroup: "rg", subscriptionId: "sub-1", region: "eastus", provisioningState: "created" }, overrides));
const makeManagedNode = (id, overrides = {}) => (Object.assign({ id, accountId: "a1", accountName: "acct-a1", region: "eastus", poolId: "pool-1", nodeId: `node-${id}`, state: "idle", isDedicated: true }, overrides));
const makeBatchPool = (id, overrides = {}) => (Object.assign({ id, vmSize: "Standard_A1", targetDedicatedNodes: 2, currentDedicatedNodes: 1 }, overrides));
const makeBatchNode = (id, overrides = {}) => (Object.assign({ id, state: "idle", schedulingState: "enabled", vmSize: "Standard_A1" }, overrides));
const makeContext = (store) => ({
    store,
    scheduler: new RequestScheduler({
        concurrency: 5,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
    }),
    armUrl: "https://management.azure.com",
    getAccessToken: jest.fn().mockResolvedValue("arm-token"),
    getBatchAccessToken: jest.fn().mockResolvedValue("batch-token"),
});
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("NodeAgent", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });
    // -------------------------------------------------------------------------
    // list_nodes
    // -------------------------------------------------------------------------
    describe("list_nodes (no actionType)", () => {
        it("happy path: aggregates nodes across accounts and pools, marks completed", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            const acct = makeAccount("a1");
            store.addAccount(acct);
            mockedListPools.mockResolvedValue([
                makeBatchPool("pool-1"),
                makeBatchPool("pool-2"),
            ]);
            mockedListNodes.mockResolvedValueOnce([
                makeBatchNode("n1", { state: "preempted" }),
                makeBatchNode("n2", { state: "idle" }),
            ]);
            mockedListNodes.mockResolvedValueOnce([makeBatchNode("n3")]);
            const agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({ accountIds: ["a1"] });
            expect(result.status).toBe("completed");
            expect(result.summary).toMatchObject({
                total: 3,
                preempted: 1,
                errors: 0,
            });
            expect(store.getState().nodes).toHaveLength(3);
            expect(store.getState().agentStatuses.node).toBe("completed");
        }));
        it("auto-discovers accountIds when none provided (uses created accounts)", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1", { provisioningState: "created" }));
            store.addAccount(makeAccount("a2", { provisioningState: "pending" }));
            mockedListPools.mockResolvedValue([]);
            const agent = new NodeAgent(makeContext(store));
            yield agent.execute({ accountIds: [] });
            // Only the "created" account should be queried.
            expect(mockedListPools).toHaveBeenCalledTimes(1);
        }));
        it("uses tokenProvider override when supplied", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            mockedListPools.mockResolvedValue([]);
            const tokenProvider = { getToken: jest.fn().mockResolvedValue("custom-token") };
            const agent = new NodeAgent(makeContext(store));
            yield agent.execute({ accountIds: ["a1"], tokenProvider });
            expect(tokenProvider.getToken).toHaveBeenCalled();
            expect(mockedListPools).toHaveBeenCalledWith(expect.stringContaining("acct-a1.eastus.batch.azure.com"), "custom-token");
        }));
        it("error path: account-level failure marks status partial and increments errors", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            store.addAccount(makeAccount("a2"));
            mockedListPools.mockImplementation((endpoint) => {
                if (endpoint.includes("acct-a1")) {
                    return Promise.reject(new Error("account a1 fetch failed"));
                }
                return Promise.resolve([]);
            });
            const agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({ accountIds: ["a1", "a2"] });
            expect(result.status).toBe("partial");
            expect(result.summary).toMatchObject({ errors: 1, total: 0 });
            expect(store.getState().agentStatuses.node).toBe("error");
        }));
        it("error path: pool-level listNodes failure is swallowed (no account error)", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            mockedListPools.mockResolvedValue([makeBatchPool("p1"), makeBatchPool("p2")]);
            mockedListNodes
                .mockRejectedValueOnce(new Error("pool 1 fail"))
                .mockResolvedValueOnce([makeBatchNode("ok")]);
            const agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({ accountIds: ["a1"] });
            expect(result.status).toBe("completed");
            expect(result.summary).toMatchObject({ total: 1, errors: 0 });
        }));
        it("skips unknown accountIds gracefully", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            mockedListPools.mockResolvedValue([]);
            const agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({ accountIds: ["unknown-id"] });
            expect(result.status).toBe("completed");
            expect(result.summary).toMatchObject({ total: 0, errors: 0 });
            expect(mockedListPools).not.toHaveBeenCalled();
        }));
        it("maps node-level errors and startTaskInfo failures into ManagedNode.error", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            mockedListPools.mockResolvedValue([makeBatchPool("p1")]);
            mockedListNodes.mockResolvedValue([
                makeBatchNode("nodeA", {
                    errors: [{ code: "Boom", message: "kaboom" }],
                    startTaskInfo: { exitCode: 1, result: "failure" },
                }),
                makeBatchNode("nodeB", {
                    isDedicated: false,
                }),
            ]);
            const agent = new NodeAgent(makeContext(store));
            yield agent.execute({ accountIds: ["a1"] });
            const nodes = store.getState().nodes;
            expect(nodes).toHaveLength(2);
            const a = nodes.find((n) => n.nodeId === "nodeA");
            expect(a.error).toContain("Boom");
            expect(a.error).toContain("StartTask exit=1");
            const b = nodes.find((n) => n.nodeId === "nodeB");
            expect(b.isDedicated).toBe(false);
        }));
        it("supports cancellation between account iterations", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            mockedListPools.mockResolvedValue([]);
            const agent = new NodeAgent(makeContext(store));
            agent.cancel(); // pre-cancel, but _executeNodeAction resets _cancelled
            // Simply confirm cancel() doesn't throw and execute still resolves.
            const result = yield agent.execute({ accountIds: ["a1"] });
            expect(result).toBeDefined();
        }));
    });
    // -------------------------------------------------------------------------
    // Per-action handlers
    // -------------------------------------------------------------------------
    describe("reboot action", () => {
        it("happy path: calls performNodeAction and updates node state to rebooting", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            store.setNodes([makeManagedNode("n1")]);
            mockedPerformNodeAction.mockResolvedValue();
            const agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({ actionType: "reboot", nodeIds: ["n1"] });
            expect(result.status).toBe("completed");
            expect(result.summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
            expect(mockedPerformNodeAction).toHaveBeenCalledWith(expect.stringContaining("acct-a1.eastus.batch.azure.com"), "pool-1", "node-n1", "reboot", "batch-token");
            expect(store.getState().nodes[0].state).toBe("rebooting");
        }));
        it("error path: failed reboot returns failed status and logs error", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            store.setNodes([makeManagedNode("n1")]);
            mockedPerformNodeAction.mockRejectedValue(new Error("reboot kaboom"));
            const agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({ actionType: "reboot", nodeIds: ["n1"] });
            expect(result.status).toBe("failed");
            expect(result.summary).toMatchObject({ failed: 1, succeeded: 0 });
            expect(store.getState().agentStatuses.node).toBe("error");
            expect(store.getState().agentLogs.some((l) => l.level === "error" && /reboot kaboom/.test(l.message))).toBe(true);
        }));
    });
    describe("delete action (remove)", () => {
        it("happy path: calls removeNodes and removes node from store", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            store.setNodes([makeManagedNode("n1"), makeManagedNode("n2")]);
            mockedRemoveNodes.mockResolvedValue();
            const agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({ actionType: "delete", nodeIds: ["n1"] });
            expect(result.status).toBe("completed");
            expect(mockedRemoveNodes).toHaveBeenCalledWith(expect.any(String), "pool-1", ["node-n1"], "batch-token");
            expect(store.getState().nodes.map((n) => n.id)).toEqual(["n2"]);
        }));
        it("error path: rejection from removeNodes yields failed", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            store.setNodes([makeManagedNode("n1")]);
            mockedRemoveNodes.mockRejectedValue(new Error("delete failed"));
            const agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({ actionType: "delete", nodeIds: ["n1"] });
            expect(result.status).toBe("failed");
            expect(store.getState().nodes).toHaveLength(1); // not removed
        }));
    });
    describe("reimage action", () => {
        it("happy path: updates node state to reimaging", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            store.setNodes([makeManagedNode("n1")]);
            mockedPerformNodeAction.mockResolvedValue();
            const agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({ actionType: "reimage", nodeIds: ["n1"] });
            expect(result.status).toBe("completed");
            expect(store.getState().nodes[0].state).toBe("reimaging");
        }));
        it("error path: rejection yields failed status", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            store.setNodes([makeManagedNode("n1")]);
            mockedPerformNodeAction.mockRejectedValue("string-error");
            const agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({ actionType: "reimage", nodeIds: ["n1"] });
            expect(result.status).toBe("failed");
        }));
    });
    describe("disableScheduling action", () => {
        it("happy path: sets schedulingState to disabled", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            store.setNodes([makeManagedNode("n1", { schedulingState: "enabled" })]);
            mockedPerformNodeAction.mockResolvedValue();
            const agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({
                actionType: "disableScheduling",
                nodeIds: ["n1"],
            });
            expect(result.status).toBe("completed");
            expect(store.getState().nodes[0].schedulingState).toBe("disabled");
        }));
        it("error path: failed call increments failed counter", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            store.setNodes([makeManagedNode("n1"), makeManagedNode("n2")]);
            mockedPerformNodeAction
                .mockResolvedValueOnce()
                .mockRejectedValueOnce(new Error("nope"));
            const agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({
                actionType: "disableScheduling",
                nodeIds: ["n1", "n2"],
            });
            expect(result.status).toBe("partial");
            expect(result.summary).toMatchObject({ succeeded: 1, failed: 1 });
        }));
    });
    describe("enableScheduling action", () => {
        it("happy path: sets schedulingState to enabled and uses tokenProvider", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            store.setNodes([makeManagedNode("n1", { schedulingState: "disabled" })]);
            mockedPerformNodeAction.mockResolvedValue();
            const tokenProvider = { getToken: jest.fn().mockResolvedValue("override-tok") };
            const agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({
                actionType: "enableScheduling",
                nodeIds: ["n1"],
                tokenProvider,
            });
            expect(result.status).toBe("completed");
            expect(tokenProvider.getToken).toHaveBeenCalled();
            expect(mockedPerformNodeAction).toHaveBeenCalledWith(expect.any(String), "pool-1", "node-n1", "enableScheduling", "override-tok");
            expect(store.getState().nodes[0].schedulingState).toBe("enabled");
        }));
        it("error path: missing node is silently skipped, no failure recorded", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            // No nodes set up, so the lookup fails
            const agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({
                actionType: "enableScheduling",
                nodeIds: ["missing-node"],
            });
            // Total reflects requested ids; succeeded/failed both 0 since the node was skipped.
            expect(result.summary).toMatchObject({ total: 1, succeeded: 0, failed: 0 });
            expect(mockedPerformNodeAction).not.toHaveBeenCalled();
        }));
    });
    // -------------------------------------------------------------------------
    // Cancellation
    // -------------------------------------------------------------------------
    describe("cancellation", () => {
        it("breaks out of the action loop when cancel() is called between iterations", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            store.addAccount(makeAccount("a1"));
            store.setNodes([
                makeManagedNode("n1"),
                makeManagedNode("n2"),
                makeManagedNode("n3"),
            ]);
            let agent;
            mockedPerformNodeAction.mockImplementation(() => {
                // Cancel after first successful call so the loop terminates early.
                agent.cancel();
                return Promise.resolve();
            });
            agent = new NodeAgent(makeContext(store));
            const result = yield agent.execute({
                actionType: "reboot",
                nodeIds: ["n1", "n2", "n3"],
            });
            expect(mockedPerformNodeAction).toHaveBeenCalledTimes(1);
            expect(result.summary).toMatchObject({ total: 3, succeeded: 1, failed: 0 });
        }));
    });
});
//# sourceMappingURL=node-agent.test.js.map