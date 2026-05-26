/**
 * Audit fix #1: AbortSignal plumbing.
 *
 *   - OrchestratorAgent.execute forwards the caller's signal to
 *     sub-agents that accept one.
 *   - PoolAgent.executeWithFallback honors `signal` and exits the
 *     resize-poll loop on abort instead of waiting up to the full
 *     15-second interval.
 *
 * These tests stay fast by mocking out the service calls and using a
 * tiny pollInterval via signal-driven shortcut.
 */
import { __awaiter } from "tslib";
jest.mock("../../auth/msal-auth", () => ({
    setActiveTenant: jest.fn(),
    getArmTokenForAccount: jest.fn().mockResolvedValue("arm-token"),
    getGraphToken: jest.fn().mockResolvedValue("graph-token"),
    getGraphTokenForAccount: jest.fn().mockResolvedValue("graph-token"),
    listAccessibleTenants: jest.fn().mockResolvedValue([]),
}));
// credential-vault touches WebCrypto on module load; stub it.
jest.mock("../../auth/credential-vault", () => ({
    credentialVault: {
        put: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
        clearAll: jest.fn().mockResolvedValue(undefined),
        list: jest.fn().mockResolvedValue([]),
        get: jest.fn().mockResolvedValue(null),
    },
}));
jest.mock("../../services", () => {
    const actual = jest.requireActual("../../services");
    return Object.assign(Object.assign({}, actual), { listSubscriptions: jest.fn().mockResolvedValue([]), listBatchAccounts: jest.fn().mockResolvedValue([]), getBatchAccount: jest.fn(), listPools: jest.fn().mockResolvedValue([]), listNodes: jest.fn().mockResolvedValue([]), performNodeAction: jest.fn(), removeNodes: jest.fn(), createPool: jest.fn(), deletePool: jest.fn(), patchPool: jest.fn(), listOrgUsers: jest.fn().mockResolvedValue([]), getMyDirectoryRoles: jest.fn().mockResolvedValue([]), resetUserPassword: jest.fn(), canResetPasswords: jest.fn() });
});
jest.mock("../../services/audit-log", () => ({
    auditLog: { record: jest.fn() },
}));
jest.mock("../../scheduling/request-governance", () => ({
    getSharedRequestGuard: jest.fn().mockReturnValue({ setTelemetry: jest.fn() }),
}));
// Mock just the node-agent — the rest of the orchestrator's
// constructed sub-agents are real but inert because their service
// calls are stubbed above.
const nodeExec = jest.fn((_input) => __awaiter(void 0, void 0, void 0, function* () {
    return ({
        status: "completed",
        summary: {},
    });
}));
jest.mock("../node-agent", () => ({
    NodeAgent: jest.fn().mockImplementation(() => ({
        name: "node",
        execute: nodeExec,
        cancel: jest.fn(),
    })),
}));
import { OrchestratorAgent } from "../orchestrator-agent";
import { MultiRegionStore } from "../../store/multi-region-store";
import { PoolAgent } from "../pool-agent";
function makeCtx(store) {
    return {
        store,
        scheduler: {
            run: jest.fn((_k, fn) => fn()),
        },
        armUrl: "https://management.azure.com",
        getAccessToken: () => __awaiter(this, void 0, void 0, function* () { return "arm-token"; }),
        getBatchAccessToken: () => __awaiter(this, void 0, void 0, function* () { return "batch-token"; }),
    };
}
beforeEach(() => {
    nodeExec.mockClear();
});
describe("OrchestratorAgent forwards AbortSignal to sub-agents", () => {
    it("forwards the caller's AbortSignal to node-agent.execute", () => __awaiter(void 0, void 0, void 0, function* () {
        var _a;
        const store = new MultiRegionStore();
        const orch = new OrchestratorAgent(makeCtx(store));
        const controller = new AbortController();
        yield orch.execute({
            action: "list_nodes",
            payload: { accountIds: ["a1"] },
            signal: controller.signal,
        });
        const arg = (_a = nodeExec.mock.calls[0]) === null || _a === void 0 ? void 0 : _a[0];
        expect(arg === null || arg === void 0 ? void 0 : arg.signal).toBeInstanceOf(AbortSignal);
    }));
});
describe("PoolAgent.executeWithFallback honors signal", () => {
    it("bails out without making any createPool calls when signal is aborted up front", () => __awaiter(void 0, void 0, void 0, function* () {
        const services = jest.requireMock("../../services");
        const store = new MultiRegionStore();
        store.addAccount({
            id: "a1",
            accountName: "x",
            resourceGroup: "rg",
            subscriptionId: "s1",
            region: "eastus",
            provisioningState: "created",
        });
        store.setAccountInfos([
            {
                id: "a1",
                accountName: "x",
                subscriptionId: "s1",
                region: "eastus",
                resourceGroup: "rg",
                dedicatedCoreQuota: 0,
                lowPriorityCoreQuota: 100,
                poolQuota: 100,
                activeJobAndJobScheduleQuota: 100,
                dedicatedCoresUsed: 0,
                lowPriorityCoresUsed: 0,
                poolCount: 0,
                dedicatedCoresFree: 0,
                lowPriorityCoresFree: 100,
                poolsFree: 100,
                dedicatedCoreQuotaPerVMFamilyEnforced: false,
            },
        ]);
        // Use a real scheduler stub
        const scheduler = {
            run: jest.fn((_k, fn) => fn()),
        };
        const ctx = {
            store,
            scheduler,
            armUrl: "https://management.azure.com",
            getAccessToken: () => __awaiter(void 0, void 0, void 0, function* () { return "arm-token"; }),
            getBatchAccessToken: () => __awaiter(void 0, void 0, void 0, function* () { return "batch-token"; }),
        };
        const agent = new PoolAgent(ctx);
        const controller = new AbortController();
        controller.abort();
        yield agent.executeWithFallback({
            accountIds: ["a1"],
            vmSizes: ["Standard_NC6s_v3"],
            poolConfig: {},
            quotaType: "lowPriority",
            signal: controller.signal,
        });
        expect(services.createPool).not.toHaveBeenCalled();
    }));
});
//# sourceMappingURL=abort-signal.spec.js.map