/**
 * Audit fix #19: idempotency-key handling in `PoolAgent.execute`.
 * Same key → same derived pool name across retries; missing key →
 * legacy random behavior (poolId === caller's config.id ?? "pool").
 */
import { __awaiter } from "tslib";
jest.mock("../../auth/msal-auth", () => ({
    setActiveTenant: jest.fn(),
}));
jest.mock("../../services/batch-service", () => ({
    createPool: jest.fn(),
    listPools: jest.fn().mockResolvedValue([]),
}));
import { PoolAgent } from "../pool-agent";
import { MultiRegionStore } from "../../store/multi-region-store";
import { RequestScheduler } from "../../scheduling/request-scheduler";
import * as batchService from "../../services/batch-service";
const mockedCreatePool = batchService.createPool;
function makeAccount(id) {
    return {
        id,
        accountName: `acct-${id}`,
        resourceGroup: "rg",
        subscriptionId: "sub1",
        region: "eastus",
        provisioningState: "created",
    };
}
function makeCtx(store) {
    return {
        store,
        scheduler: new RequestScheduler({
            concurrency: 1,
            delayMs: 0,
            retryAttempts: 0,
            retryBackoffSeconds: [],
            jitterPct: 0,
        }),
        armUrl: "https://management.azure.com",
        getAccessToken: () => __awaiter(this, void 0, void 0, function* () { return "tok"; }),
        getBatchAccessToken: () => __awaiter(this, void 0, void 0, function* () { return "btok"; }),
    };
}
beforeEach(() => {
    mockedCreatePool.mockReset().mockResolvedValue(undefined);
});
describe("PoolAgent.execute — idempotency key (audit fix #19)", () => {
    it("derives the same pool name on retry when idempotencyKey is set", () => __awaiter(void 0, void 0, void 0, function* () {
        const store = new MultiRegionStore();
        store.addAccount(makeAccount("a1"));
        const agent = new PoolAgent(makeCtx(store));
        yield agent.execute({
            accountIds: ["a1"],
            poolConfig: { id: "myprefix", vmSize: "Standard_NC6s_v3" },
            config: { idempotencyKey: "request-42" },
        });
        const idFirst = mockedCreatePool.mock.calls[0][1].id;
        // Retry with the same key — should produce the SAME pool name.
        yield agent.execute({
            accountIds: ["a1"],
            poolConfig: { id: "myprefix", vmSize: "Standard_NC6s_v3" },
            config: { idempotencyKey: "request-42" },
        });
        const idSecond = mockedCreatePool.mock.calls[1][1].id;
        expect(idFirst).toBe(idSecond);
        expect(idFirst.startsWith("myprefix-")).toBe(true);
    }));
    it("derives different names for different idempotency keys", () => __awaiter(void 0, void 0, void 0, function* () {
        const store = new MultiRegionStore();
        store.addAccount(makeAccount("a1"));
        const agent = new PoolAgent(makeCtx(store));
        yield agent.execute({
            accountIds: ["a1"],
            poolConfig: { id: "x", vmSize: "Standard_NC6s_v3" },
            config: { idempotencyKey: "key-A" },
        });
        yield agent.execute({
            accountIds: ["a1"],
            poolConfig: { id: "x", vmSize: "Standard_NC6s_v3" },
            config: { idempotencyKey: "key-B" },
        });
        const idA = mockedCreatePool.mock.calls[0][1].id;
        const idB = mockedCreatePool.mock.calls[1][1].id;
        expect(idA).not.toBe(idB);
    }));
    it("uses the configured poolId verbatim when no idempotency key is set", () => __awaiter(void 0, void 0, void 0, function* () {
        const store = new MultiRegionStore();
        store.addAccount(makeAccount("a1"));
        const agent = new PoolAgent(makeCtx(store));
        yield agent.execute({
            accountIds: ["a1"],
            poolConfig: { id: "plain", vmSize: "Standard_NC6s_v3" },
        });
        const id = mockedCreatePool.mock.calls[0][1].id;
        expect(id).toBe("plain");
    }));
});
//# sourceMappingURL=idempotency-key.spec.js.map