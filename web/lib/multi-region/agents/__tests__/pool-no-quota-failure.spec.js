/**
 * Audit fix #5: PoolAgent.executeWithFallback's no-quota early-return
 * used to produce `status:"failed"` with an empty `failures[]`,
 * which caused the orchestrator to surface a generic "Pool creation
 * failed" notification. The fix populates `failures[]` with a
 * descriptive `kind:"no_quota"` entry per account.
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
const makeAccount = (id) => ({
    id,
    accountName: `acct-${id}`,
    resourceGroup: "rg",
    subscriptionId: "sub1",
    region: "eastus",
    provisioningState: "created",
});
const makeInfo = (id, lpFree) => ({
    id,
    accountName: `acct-${id}`,
    subscriptionId: "sub1",
    region: "eastus",
    resourceGroup: "rg",
    dedicatedCoreQuota: 0,
    lowPriorityCoreQuota: lpFree,
    poolQuota: 100,
    activeJobAndJobScheduleQuota: 100,
    dedicatedCoresUsed: 0,
    lowPriorityCoresUsed: 0,
    poolCount: 0,
    dedicatedCoresFree: 0,
    lowPriorityCoresFree: lpFree,
    poolsFree: 100,
    dedicatedCoreQuotaPerVMFamilyEnforced: false,
});
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
    mockedCreatePool.mockReset();
});
describe("PoolAgent.executeWithFallback — no-quota failure shape (audit fix #5)", () => {
    it("surfaces a descriptive no_quota failure entry for every input account", () => __awaiter(void 0, void 0, void 0, function* () {
        const store = new MultiRegionStore();
        store.addAccount(makeAccount("a1"));
        store.addAccount(makeAccount("a2"));
        store.setAccountInfos([makeInfo("a1", 0), makeInfo("a2", 0)]);
        const agent = new PoolAgent(makeCtx(store));
        const result = yield agent.executeWithFallback({
            accountIds: ["a1", "a2"],
            vmSizes: ["Standard_NC6s_v3"],
            poolConfig: {},
            quotaType: "lowPriority",
        });
        expect(result.status).toBe("failed");
        expect(mockedCreatePool).not.toHaveBeenCalled();
        const failures = result.summary.failures;
        expect(failures).toBeDefined();
        expect(failures.length).toBe(2);
        for (const f of failures) {
            expect(f.kind).toBe("no_quota");
            expect(f.requestedSlots).toBeDefined();
            expect(f.availableSlots).toBe(0);
            expect(f.vmFamily).toBe("Standard_NC6s_v3");
            expect(typeof f.reason).toBe("string");
            expect(typeof f.error).toBe("string");
        }
    }));
    it("still surfaces exhausted failure when every VM size is rejected", () => __awaiter(void 0, void 0, void 0, function* () {
        const store = new MultiRegionStore();
        store.addAccount(makeAccount("a1"));
        // 5 cores free → NC6s (6 vCPUs) cannot fit → maxNodes=0 → loop exits
        // without creating a pool. Audit fix #6 ensures we still get a
        // failure entry per account in that case.
        store.setAccountInfos([makeInfo("a1", 5)]);
        const agent = new PoolAgent(makeCtx(store));
        const result = yield agent.executeWithFallback({
            accountIds: ["a1"],
            vmSizes: ["Standard_NC6s_v3"],
            poolConfig: {},
            quotaType: "lowPriority",
        });
        expect(mockedCreatePool).not.toHaveBeenCalled();
        const failures = result.summary.failures;
        expect(failures).toBeDefined();
        expect(failures.length).toBeGreaterThan(0);
    }));
});
//# sourceMappingURL=pool-no-quota-failure.spec.js.map