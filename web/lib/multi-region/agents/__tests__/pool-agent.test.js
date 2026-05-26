/**
 * Unit tests for PoolAgent.
 *
 * The agent exposes two actions: `execute` (basic pool creation across
 * accounts) and `executeWithFallback` (smart pool creation with VM-size
 * waterfall fallback). Both call into batch-service.createPool / listPools
 * and emit state mutations onto MultiRegionStore — so we mock the service
 * layer and assert on store state + return summaries.
 */
import { __awaiter } from "tslib";
// Avoid persistence side effects from msal-auth's setActiveTenant when the
// store is constructed.
jest.mock("../../auth/msal-auth", () => ({
    setActiveTenant: jest.fn(),
}));
// Mock batch-service module — both functions used by pool-agent.
jest.mock("../../services/batch-service", () => ({
    createPool: jest.fn(),
    listPools: jest.fn(),
}));
// Mock arm-service in case any indirect import path picks it up.
jest.mock("../../services/arm-service", () => ({}), { virtual: false });
// NOTE: this file uses the `.test.ts` extension. The project's default
// jest config matches `*.spec.ts`, so this file is skipped. See the
// `*.spec.ts` siblings in this directory for the active suite that
// exercises PoolAgent behaviors after the audit-driven rewrite.
import { PoolAgent } from "../pool-agent";
import { MultiRegionStore } from "../../store/multi-region-store";
import { RequestScheduler } from "../../scheduling/request-scheduler";
import { AzureRequestError } from "../../services/types";
import * as batchService from "../../services/batch-service";
const mockedCreatePool = batchService.createPool;
const mockedListPools = batchService.listPools;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const makeAccount = (id, region = "eastus") => ({
    id,
    accountName: `acct-${id}`,
    resourceGroup: "rg",
    subscriptionId: "sub1",
    region,
    provisioningState: "created",
});
const makeAccountInfo = (id, lpFree) => ({
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
function makeContext() {
    const store = new MultiRegionStore();
    // Scheduler with no pacing/retry so tests run fast.
    const scheduler = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 0,
        retryBackoffSeconds: [],
        jitterPct: 0,
    });
    const ctx = {
        store,
        scheduler,
        armUrl: "https://management.azure.com",
        getAccessToken: () => __awaiter(this, void 0, void 0, function* () { return "arm-token"; }),
        getBatchAccessToken: () => __awaiter(this, void 0, void 0, function* () { return "batch-token"; }),
    };
    return { ctx, store };
}
// Speed up the 15-second resize-poll wait so the smart-mode tests
// complete inside the jest timeout. Production code uses 15s.
PoolAgent.POLL_INTERVAL_MS = 10;
beforeEach(() => {
    jest.clearAllMocks();
    mockedCreatePool.mockReset().mockResolvedValue(undefined);
    mockedListPools.mockReset().mockResolvedValue([]);
});
// ---------------------------------------------------------------------------
// execute() — basic pool creation
// ---------------------------------------------------------------------------
describe("PoolAgent.execute — basic pool creation", () => {
    it("creates pools across multiple accounts and reports completion", () => __awaiter(void 0, void 0, void 0, function* () {
        const { ctx, store } = makeContext();
        store.addAccount(makeAccount("a1"));
        store.addAccount(makeAccount("a2", "westus"));
        const agent = new PoolAgent(ctx);
        const result = yield agent.execute({
            accountIds: ["a1", "a2"],
            poolConfig: { id: "my-pool", vmSize: "standard_nc6s_v3" },
        });
        expect(result.status).toBe("completed");
        expect(result.summary.total).toBe(2);
        expect(result.summary.created).toBe(2);
        expect(result.summary.failed).toBe(0);
        expect(mockedCreatePool).toHaveBeenCalledTimes(2);
        // Verify the agent forced targetDedicatedNodes = 0 for safety.
        const [, sentConfig] = mockedCreatePool.mock.calls[0];
        expect(sentConfig.targetDedicatedNodes).toBe(0);
        // Pool entries persisted in store with state = "created".
        const pools = store.getState().pools;
        expect(pools).toHaveLength(2);
        expect(pools.every((p) => p.provisioningState === "created")).toBe(true);
        // Status reporter fired transitions running → completed.
        expect(store.getState().agentStatuses.pool).toBe("completed");
        // PoolInfo entry should be appended on success.
        expect(store.getState().poolInfos).toHaveLength(2);
    }));
    it("warns and skips when an accountId does not exist in the store", () => __awaiter(void 0, void 0, void 0, function* () {
        const { ctx, store } = makeContext();
        store.addAccount(makeAccount("a1"));
        const agent = new PoolAgent(ctx);
        const result = yield agent.execute({
            accountIds: ["a1", "missing-account"],
            poolConfig: { id: "p", vmSize: "standard_nc6s_v3" },
        });
        expect(result.summary.created).toBe(1);
        expect(result.summary.failed).toBe(0);
        const warnLogs = store
            .getState()
            .agentLogs.filter((l) => l.level === "warn");
        expect(warnLogs.some((l) => l.message.includes("missing-account"))).toBe(true);
    }));
    it("records a failure with AzureRequestError details when createPool throws", () => __awaiter(void 0, void 0, void 0, function* () {
        const { ctx, store } = makeContext();
        store.addAccount(makeAccount("a1"));
        mockedCreatePool.mockRejectedValueOnce(new AzureRequestError("quota exceeded", 400, "QuotaExceeded", null));
        const agent = new PoolAgent(ctx);
        const result = yield agent.execute({
            accountIds: ["a1"],
            poolConfig: { id: "p", vmSize: "standard_nc6s_v3" },
        });
        expect(result.status).toBe("failed");
        expect(result.summary.failed).toBe(1);
        const failures = result.summary.failures;
        expect(failures[0].error).toContain("quota exceeded");
        const pool = store.getState().pools[0];
        expect(pool.provisioningState).toBe("failed");
        expect(pool.error).toContain("quota exceeded");
        expect(store.getState().agentStatuses.pool).toBe("error");
    }));
    it("returns 'partial' status when some accounts succeed and others fail", () => __awaiter(void 0, void 0, void 0, function* () {
        const { ctx, store } = makeContext();
        store.addAccount(makeAccount("a1"));
        store.addAccount(makeAccount("a2", "westus"));
        mockedCreatePool
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("transient"));
        const agent = new PoolAgent(ctx);
        const result = yield agent.execute({
            accountIds: ["a1", "a2"],
            poolConfig: { id: "p", vmSize: "standard_nc6s_v3" },
        });
        expect(result.status).toBe("partial");
        expect(result.summary.created).toBe(1);
        expect(result.summary.failed).toBe(1);
    }));
    it("falls back to default poolId 'pool' when poolConfig.id is missing", () => __awaiter(void 0, void 0, void 0, function* () {
        const { ctx, store } = makeContext();
        store.addAccount(makeAccount("a1"));
        const agent = new PoolAgent(ctx);
        yield agent.execute({
            accountIds: ["a1"],
            poolConfig: { vmSize: "standard_nc6s_v3" },
        });
        expect(store.getState().pools[0].poolId).toBe("pool");
    }));
    it("uses an explicit token provider when supplied to the constructor", () => __awaiter(void 0, void 0, void 0, function* () {
        const { ctx, store } = makeContext();
        store.addAccount(makeAccount("a1"));
        const tokenProvider = jest.fn().mockResolvedValue("explicit-token");
        const agent = new PoolAgent(ctx, tokenProvider);
        yield agent.execute({
            accountIds: ["a1"],
            poolConfig: { id: "p", vmSize: "standard_nc6s_v3" },
        });
        expect(tokenProvider).toHaveBeenCalled();
        const [, , token] = mockedCreatePool.mock.calls[0];
        expect(token).toBe("explicit-token");
    }));
    it("cancel() halts the loop after the current iteration", () => __awaiter(void 0, void 0, void 0, function* () {
        const { ctx, store } = makeContext();
        store.addAccount(makeAccount("a1"));
        store.addAccount(makeAccount("a2", "westus"));
        const agent = new PoolAgent(ctx);
        // Cancel mid-flight — first call resolves, then we cancel.
        mockedCreatePool.mockImplementationOnce(() => __awaiter(void 0, void 0, void 0, function* () {
            agent.cancel();
        }));
        const result = yield agent.execute({
            accountIds: ["a1", "a2"],
            poolConfig: { id: "p", vmSize: "standard_nc6s_v3" },
        });
        // Only one pool actually attempted before cancel took effect.
        expect(mockedCreatePool).toHaveBeenCalledTimes(1);
        expect(result.summary.created).toBe(1);
    }));
});
// ---------------------------------------------------------------------------
// executeWithFallback() — smart waterfall pool creation
// ---------------------------------------------------------------------------
describe("PoolAgent.executeWithFallback — smart pool creation", () => {
    it("skips accounts with zero free LP quota", () => __awaiter(void 0, void 0, void 0, function* () {
        const { ctx, store } = makeContext();
        store.addAccount(makeAccount("a1"));
        store.setAccountInfos([makeAccountInfo("a1", 0)]);
        const agent = new PoolAgent(ctx);
        const result = yield agent.executeWithFallback({
            accountIds: ["a1"],
            vmSizes: ["Standard_NC6s_v3"],
            poolConfig: {},
            quotaType: "lowPriority",
        });
        expect(mockedCreatePool).not.toHaveBeenCalled();
        expect(result.summary.created).toBe(0);
        expect(result.summary.failed).toBe(0);
        const warns = store
            .getState()
            .agentLogs.filter((l) => l.level === "warn");
        expect(warns.some((l) => l.message.includes("No free LP quota"))).toBe(true);
    }));
    it("creates a pool, polls for steady state, then accounts for actual node usage", () => __awaiter(void 0, void 0, void 0, function* () {
        const { ctx, store } = makeContext();
        store.addAccount(makeAccount("a1"));
        // 12 cores free → NC6s (6 vCPUs) → maxNodes = 2.
        store.setAccountInfos([makeAccountInfo("a1", 12)]);
        // listPools poll: pool reaches "steady" with 2 LP nodes allocated.
        mockedListPools.mockResolvedValue([
            {
                id: "gpu-nc6s-v3-xxxx",
                allocationState: "steady",
                currentLowPriorityNodes: 2,
                targetLowPriorityNodes: 2,
                currentDedicatedNodes: 0,
                resizeErrors: [],
            },
        ]);
        const agent = new PoolAgent(ctx);
        const result = yield agent.executeWithFallback({
            accountIds: ["a1"],
            vmSizes: ["Standard_NC6s_v3"],
            poolConfig: { startTask: { commandLine: "echo hi" } },
            quotaType: "lowPriority",
        });
        expect(mockedCreatePool).toHaveBeenCalledTimes(1);
        const [, sentConfig] = mockedCreatePool.mock.calls[0];
        const cfg = sentConfig;
        // SAFETY: targetDedicatedNodes always 0; uses LP only.
        expect(cfg.targetDedicatedNodes).toBe(0);
        expect(cfg.targetLowPriorityNodes).toBe(2);
        expect(cfg.startTask).toEqual({ commandLine: "echo hi" });
        // Pool ID format: gpu-{vmSizeShort}-{rand}.
        expect(cfg.id.startsWith("gpu-nc6s-v3-")).toBe(true);
        expect(result.status).toBe("completed");
        expect(result.summary.created).toBe(1);
        // PoolInfo appended.
        expect(store.getState().poolInfos).toHaveLength(1);
    }), 30000);
    it("falls back to the next VM size on a capacity error", () => __awaiter(void 0, void 0, void 0, function* () {
        const { ctx, store } = makeContext();
        store.addAccount(makeAccount("a1"));
        store.setAccountInfos([makeAccountInfo("a1", 12)]);
        // First VM throws a capacity error; second succeeds.
        mockedCreatePool
            .mockRejectedValueOnce(new AzureRequestError("AllocationFailed: not enough capacity", 500, "AllocationFailed", null))
            .mockResolvedValueOnce(undefined);
        mockedListPools.mockResolvedValue([
            {
                id: "irrelevant",
                allocationState: "steady",
                currentLowPriorityNodes: 2,
                targetLowPriorityNodes: 2,
                currentDedicatedNodes: 0,
                resizeErrors: [],
            },
        ]);
        const agent = new PoolAgent(ctx);
        const result = yield agent.executeWithFallback({
            accountIds: ["a1"],
            vmSizes: ["Standard_NC12s_v3", "Standard_NC6s_v3"],
            poolConfig: {},
            quotaType: "lowPriority",
        });
        expect(mockedCreatePool).toHaveBeenCalledTimes(2);
        expect(result.status).toBe("completed");
        expect(result.summary.created).toBe(1);
    }), 30000);
    it("aborts on a non-retryable 400 error without trying other VM sizes", () => __awaiter(void 0, void 0, void 0, function* () {
        const { ctx, store } = makeContext();
        store.addAccount(makeAccount("a1"));
        store.setAccountInfos([makeAccountInfo("a1", 12)]);
        mockedCreatePool.mockRejectedValueOnce(new AzureRequestError("bad request", 400, "InvalidArgument", null));
        const agent = new PoolAgent(ctx);
        const result = yield agent.executeWithFallback({
            accountIds: ["a1"],
            vmSizes: ["Standard_NC6s_v3", "Standard_NC12s_v3"],
            poolConfig: {},
            quotaType: "lowPriority",
        });
        expect(mockedCreatePool).toHaveBeenCalledTimes(1);
        expect(result.status).toBe("failed");
        expect(result.summary.failed).toBe(1);
    }));
    it("aborts on a generic non-capacity error without fallback", () => __awaiter(void 0, void 0, void 0, function* () {
        const { ctx, store } = makeContext();
        store.addAccount(makeAccount("a1"));
        store.setAccountInfos([makeAccountInfo("a1", 12)]);
        mockedCreatePool.mockRejectedValueOnce(new Error("network blip"));
        const agent = new PoolAgent(ctx);
        const result = yield agent.executeWithFallback({
            accountIds: ["a1"],
            vmSizes: ["Standard_NC6s_v3", "Standard_NC12s_v3"],
            poolConfig: {},
            quotaType: "lowPriority",
        });
        expect(mockedCreatePool).toHaveBeenCalledTimes(1);
        expect(result.status).toBe("failed");
    }));
    it("skips a VM size that does not fit in the remaining quota", () => __awaiter(void 0, void 0, void 0, function* () {
        const { ctx, store } = makeContext();
        store.addAccount(makeAccount("a1"));
        // 5 cores free → NC6s (6 vCPUs) won't fit, so we move on.
        store.setAccountInfos([makeAccountInfo("a1", 5)]);
        const agent = new PoolAgent(ctx);
        const result = yield agent.executeWithFallback({
            accountIds: ["a1"],
            vmSizes: ["Standard_NC6s_v3"],
            poolConfig: {},
            quotaType: "lowPriority",
        });
        expect(mockedCreatePool).not.toHaveBeenCalled();
        expect(result.summary.created).toBe(0);
        expect(result.summary.failed).toBe(1);
    }));
    it("warns and skips an unknown account id", () => __awaiter(void 0, void 0, void 0, function* () {
        const { ctx, store } = makeContext();
        const agent = new PoolAgent(ctx);
        const result = yield agent.executeWithFallback({
            accountIds: ["nope"],
            vmSizes: ["Standard_NC6s_v3"],
            poolConfig: {},
            quotaType: "lowPriority",
        });
        expect(mockedCreatePool).not.toHaveBeenCalled();
        expect(result.summary.created).toBe(0);
        // After audit fix #5, the pre-flight check fires when no
        // accountInfo exists for any input account — we surface a
        // "No free LP quota" warning + a structured no_quota failure
        // entry, rather than reaching the per-account `account not
        // found` warn branch. Either log message constitutes a valid
        // diagnostic for this edge case.
        const warns = store
            .getState()
            .agentLogs.filter((l) => l.level === "warn");
        expect(warns.some((l) => l.message.includes("not found") ||
            l.message.includes("No free LP quota"))).toBe(true);
    }));
});
//# sourceMappingURL=pool-agent.test.js.map