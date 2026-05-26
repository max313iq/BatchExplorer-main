/**
 * Audit fix #20: dry-run mode. When `config.dryRun === true`, write-side
 * agents (PoolAgent + ProvisionerAgent) must compute the body, log a
 * `[dry-run]` line, and NOT call the real createPool / createBatchAccount.
 */
import { __awaiter } from "tslib";
jest.mock("../../auth/msal-auth", () => ({
    setActiveTenant: jest.fn(),
}));
jest.mock("../../services/batch-service", () => ({
    createPool: jest.fn(),
    listPools: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../services/arm-service", () => ({
    createResourceGroup: jest.fn(),
    createBatchAccount: jest.fn(),
    ensureProvidersRegistered: jest.fn(),
}));
// Provisioner runs a subscription-validation probe through
// guardedFetch. We stub it to always allow.
jest.mock("../../scheduling/request-governance", () => ({
    guardedFetch: jest.fn(() => __awaiter(void 0, void 0, void 0, function* () {
        return ({
            ok: true,
            status: 200,
            json: () => __awaiter(void 0, void 0, void 0, function* () { return ({ state: "Enabled" }); }),
        });
    })),
    getSharedRequestGuard: jest.fn().mockReturnValue({ setTelemetry: jest.fn() }),
}));
import { PoolAgent } from "../pool-agent";
import { ProvisionerAgent } from "../provisioner-agent";
import { MultiRegionStore } from "../../store/multi-region-store";
import { RequestScheduler } from "../../scheduling/request-scheduler";
import * as batchService from "../../services/batch-service";
import * as armService from "../../services/arm-service";
const mockedCreatePool = batchService.createPool;
const mockedCreateRg = armService.createResourceGroup;
const mockedCreateAccount = armService.createBatchAccount;
const mockedEnsureProviders = armService.ensureProvidersRegistered;
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
        getAccessToken: () => __awaiter(this, void 0, void 0, function* () { return "arm-token"; }),
        getBatchAccessToken: () => __awaiter(this, void 0, void 0, function* () { return "batch-token"; }),
    };
}
beforeEach(() => {
    mockedCreatePool.mockReset();
    mockedCreateRg.mockReset();
    mockedCreateAccount.mockReset();
    mockedEnsureProviders
        .mockReset()
        .mockResolvedValue({ newlyRegistered: [], already: [] });
});
describe("PoolAgent dry-run", () => {
    it("does not call createPool when dryRun is true", () => __awaiter(void 0, void 0, void 0, function* () {
        const store = new MultiRegionStore();
        store.addAccount(makeAccount("a1"));
        const agent = new PoolAgent(makeCtx(store));
        const result = yield agent.execute({
            accountIds: ["a1"],
            poolConfig: { id: "dry", vmSize: "Standard_NC6s_v3" },
            config: { dryRun: true },
        });
        expect(mockedCreatePool).not.toHaveBeenCalled();
        expect(result.status).toBe("completed");
        expect(result.summary.dryRun).toBe(true);
        // A `[dry-run]` log line was emitted.
        const logs = store.getState().agentLogs;
        expect(logs.some((l) => l.message.startsWith("[dry-run]"))).toBe(true);
    }));
});
describe("ProvisionerAgent dry-run", () => {
    it("does not call createResourceGroup / createBatchAccount when dryRun is true", () => __awaiter(void 0, void 0, void 0, function* () {
        const store = new MultiRegionStore();
        const agent = new ProvisionerAgent(makeCtx(store));
        const result = yield agent.execute({
            subscriptionId: "11111111-2222-3333-4444-555555555555",
            regions: ["eastus"],
            config: { dryRun: true },
        });
        expect(mockedCreateRg).not.toHaveBeenCalled();
        expect(mockedCreateAccount).not.toHaveBeenCalled();
        expect(mockedEnsureProviders).not.toHaveBeenCalled();
        expect(result.status).toBe("completed");
        expect(result.summary.dryRun).toBe(true);
        const logs = store.getState().agentLogs;
        expect(logs.some((l) => l.message.startsWith("[dry-run]"))).toBe(true);
    }));
});
//# sourceMappingURL=dry-run.spec.js.map