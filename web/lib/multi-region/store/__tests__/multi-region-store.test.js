import { MultiRegionStore } from "../multi-region-store";
import { DEFAULT_USER_PREFERENCES, DEFAULT_AGENT_STATUSES, } from "../store-types";
// Avoid persistence side effects from msal-auth's setActiveTenant.
jest.mock("../../auth/msal-auth", () => ({
    setActiveTenant: jest.fn(),
}));
const makeAccount = (id) => ({
    id,
    accountName: `acct-${id}`,
    resourceGroup: "rg",
    subscriptionId: "sub1",
    region: "eastus",
    provisioningState: "pending",
});
const makePool = (id, accountId = "a1") => ({
    id,
    accountId,
    poolId: `pool-${id}`,
    provisioningState: "pending",
    config: {},
});
const makeNode = (id) => ({
    id,
    accountId: "a1",
    accountName: "acct-a1",
    region: "eastus",
    poolId: "p1",
    nodeId: `node-${id}`,
    state: "idle",
    isDedicated: true,
});
const makeAuditEntry = (id) => ({
    id,
    timestamp: new Date().toISOString(),
    actor: "user@example.com",
    action: "create-pool",
    target: `pool-${id}`,
    status: "success",
});
const makeAzureAccount = (homeAccountId) => ({
    homeAccountId,
    username: `${homeAccountId}@contoso.com`,
    name: `User ${homeAccountId}`,
    tenantId: "tenant-1",
    environment: "login.microsoftonline.com",
    subscriptions: [],
    subscriptionCount: 0,
    status: "active",
    addedAt: new Date().toISOString(),
});
beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
});
describe("MultiRegionStore — construction & subscriptions", () => {
    it("constructor produces createInitialState() shape with non-empty sessionId", () => {
        const store = new MultiRegionStore();
        const state = store.getState();
        expect(state.sessionId).toMatch(/^session-/);
        expect(state.subscriptions).toEqual([]);
        expect(state.accounts).toEqual([]);
        expect(state.pools).toEqual([]);
        expect(state.nodes).toEqual([]);
        expect(state.poolInfos).toEqual([]);
        expect(state.accountInfos).toEqual([]);
        expect(state.notifications).toEqual([]);
        expect(state.azureAccounts).toEqual([]);
        expect(state.auditEntries).toEqual([]);
        expect(state.activities).toEqual([]);
        expect(state.agentStatuses).toEqual(DEFAULT_AGENT_STATUSES);
        expect(state.activeTenants).toEqual({});
        expect(state.tenantUsers).toEqual({});
        expect(state.passwordResetCapability).toEqual({});
    });
    it("constructor merges initial state overrides", () => {
        const store = new MultiRegionStore({
            subscriptions: [{ subscriptionId: "s1", displayName: "Sub 1" }],
        });
        expect(store.getState().subscriptions).toHaveLength(1);
    });
    it("onChange returns an unsubscribe function and listeners fire on changes", () => {
        const store = new MultiRegionStore();
        const listener = jest.fn();
        const unsubscribe = store.onChange(listener);
        store.setSubscriptions([{ subscriptionId: "s1", displayName: "Sub 1" }]);
        expect(listener).toHaveBeenCalledTimes(1);
        store.addAccount(makeAccount("a1"));
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
        store.addAccount(makeAccount("a2"));
        expect(listener).toHaveBeenCalledTimes(2);
    });
    it("listener errors do not break notification fan-out", () => {
        const store = new MultiRegionStore();
        const broken = jest.fn(() => {
            throw new Error("listener boom");
        });
        const ok = jest.fn();
        store.onChange(broken);
        store.onChange(ok);
        expect(() => store.setSubscriptions([{ subscriptionId: "s", displayName: "x" }])).not.toThrow();
        expect(ok).toHaveBeenCalled();
    });
});
describe("MultiRegionStore — accounts / pools / nodes", () => {
    it("addAccount, updateAccount, removeAccount manage accounts slice", () => {
        const store = new MultiRegionStore();
        const listener = jest.fn();
        store.onChange(listener);
        store.addAccount(makeAccount("a1"));
        expect(store.getState().accounts).toHaveLength(1);
        store.updateAccount("a1", { provisioningState: "created" });
        expect(store.getState().accounts[0].provisioningState).toBe("created");
        store.removeAccount("a1");
        expect(store.getState().accounts).toEqual([]);
        expect(listener).toHaveBeenCalledTimes(3);
    });
    it("addPool, updatePool manage pools slice", () => {
        const store = new MultiRegionStore();
        store.addPool(makePool("p1"));
        expect(store.getState().pools).toHaveLength(1);
        store.updatePool("p1", { provisioningState: "created" });
        expect(store.getState().pools[0].provisioningState).toBe("created");
    });
    it("setNodes, updateNode, removeNode manage nodes slice", () => {
        var _a;
        const store = new MultiRegionStore();
        store.setNodes([makeNode("n1"), makeNode("n2")]);
        expect(store.getState().nodes).toHaveLength(2);
        store.updateNode("n1", { state: "running" });
        expect((_a = store.getState().nodes.find((n) => n.id === "n1")) === null || _a === void 0 ? void 0 : _a.state).toBe("running");
        store.removeNode("n1");
        expect(store.getState().nodes).toHaveLength(1);
    });
    it("setPoolInfos, updatePoolInfo manage poolInfos slice", () => {
        const store = new MultiRegionStore();
        const pi = {
            id: "pi1",
            accountId: "a1",
            accountName: "acct-a1",
            region: "eastus",
            poolId: "pool-1",
            vmSize: "standard_d2",
            state: "active",
            allocationState: "steady",
            targetDedicatedNodes: 1,
            currentDedicatedNodes: 1,
            targetLowPriorityNodes: 0,
            currentLowPriorityNodes: 0,
            taskSlotsPerNode: 1,
            enableAutoScale: false,
        };
        store.setPoolInfos([pi]);
        expect(store.getState().poolInfos).toHaveLength(1);
        store.updatePoolInfo("pi1", { state: "deleting" });
        expect(store.getState().poolInfos[0].state).toBe("deleting");
    });
    it("setAccountInfos, updateAccountInfo manage accountInfos slice", () => {
        const store = new MultiRegionStore();
        const ai = {
            id: "ai1",
            accountName: "acct",
            subscriptionId: "sub",
            region: "eastus",
            resourceGroup: "rg",
            dedicatedCoreQuota: 100,
            lowPriorityCoreQuota: 100,
            poolQuota: 10,
            activeJobAndJobScheduleQuota: 10,
            dedicatedCoresUsed: 0,
            lowPriorityCoresUsed: 0,
            poolCount: 0,
            dedicatedCoresFree: 100,
            lowPriorityCoresFree: 100,
            poolsFree: 10,
            dedicatedCoreQuotaPerVMFamilyEnforced: false,
        };
        store.setAccountInfos([ai]);
        expect(store.getState().accountInfos).toHaveLength(1);
        store.updateAccountInfo("ai1", { dedicatedCoresUsed: 50 });
        expect(store.getState().accountInfos[0].dedicatedCoresUsed).toBe(50);
    });
    it("retryFailedAccounts and retryFailedPools reset failed entries to pending", () => {
        var _a;
        const store = new MultiRegionStore();
        store.addAccount(Object.assign(Object.assign({}, makeAccount("a1")), { provisioningState: "failed" }));
        store.addAccount(Object.assign(Object.assign({}, makeAccount("a2")), { provisioningState: "created" }));
        const ids = store.retryFailedAccounts();
        expect(ids).toEqual(["a1"]);
        expect((_a = store.getState().accounts.find((a) => a.id === "a1")) === null || _a === void 0 ? void 0 : _a.provisioningState).toBe("pending");
        store.addPool(Object.assign(Object.assign({}, makePool("p1")), { provisioningState: "failed" }));
        const poolIds = store.retryFailedPools();
        expect(poolIds).toEqual(["p1"]);
    });
});
describe("MultiRegionStore — audit log binding", () => {
    it("addAuditEntry prepends and notifies both listener sets", () => {
        const store = new MultiRegionStore();
        const generalListener = jest.fn();
        const auditListener = jest.fn();
        store.onChange(generalListener);
        const unsubAudit = store.subscribeAuditLog(auditListener);
        store.addAuditEntry(makeAuditEntry("e1"));
        store.addAuditEntry(makeAuditEntry("e2"));
        const entries = store.getAuditEntries();
        expect(entries).toHaveLength(2);
        expect(entries[0].id).toBe("e2");
        expect(entries[1].id).toBe("e1");
        expect(generalListener).toHaveBeenCalledTimes(2);
        expect(auditListener).toHaveBeenCalledTimes(2);
        unsubAudit();
        store.addAuditEntry(makeAuditEntry("e3"));
        expect(auditListener).toHaveBeenCalledTimes(2);
    });
    it("getAuditEntries returns a defensive copy", () => {
        const store = new MultiRegionStore();
        store.addAuditEntry(makeAuditEntry("e1"));
        const copy = store.getAuditEntries();
        copy.push(makeAuditEntry("e2"));
        expect(store.getAuditEntries()).toHaveLength(1);
    });
    it("clearAuditEntries empties the slice and notifies", () => {
        const store = new MultiRegionStore();
        const auditListener = jest.fn();
        store.subscribeAuditLog(auditListener);
        store.addAuditEntry(makeAuditEntry("e1"));
        store.clearAuditEntries();
        expect(store.getAuditEntries()).toEqual([]);
        expect(auditListener).toHaveBeenCalledTimes(2);
    });
    it("audit listener errors do not break fan-out", () => {
        const store = new MultiRegionStore();
        const bad = jest.fn(() => {
            throw new Error("audit listener boom");
        });
        const good = jest.fn();
        store.subscribeAuditLog(bad);
        store.subscribeAuditLog(good);
        expect(() => store.addAuditEntry(makeAuditEntry("e1"))).not.toThrow();
        expect(good).toHaveBeenCalled();
    });
    it("audit entries are capped at 500", () => {
        const store = new MultiRegionStore();
        for (let i = 0; i < 510; i++) {
            store.addAuditEntry(makeAuditEntry(`e${i}`));
        }
        expect(store.getAuditEntries()).toHaveLength(500);
    });
});
describe("MultiRegionStore — auth mode", () => {
    it("getAuthMode defaults to msal", () => {
        const store = new MultiRegionStore();
        expect(store.getAuthMode()).toBe("msal");
    });
    it("setAuthMode updates and notifies on change", () => {
        const store = new MultiRegionStore();
        const listener = jest.fn();
        store.onChange(listener);
        store.setAuthMode("cli");
        expect(store.getAuthMode()).toBe("cli");
        expect(listener).toHaveBeenCalledTimes(1);
    });
    it("setAuthMode does NOT notify when value is unchanged", () => {
        const store = new MultiRegionStore();
        const listener = jest.fn();
        store.onChange(listener);
        store.setAuthMode("msal");
        expect(listener).not.toHaveBeenCalled();
    });
});
describe("MultiRegionStore — user preferences", () => {
    it("getUserPreferences returns DEFAULT_USER_PREFERENCES when localStorage is empty", () => {
        const store = new MultiRegionStore();
        expect(store.getUserPreferences()).toEqual(DEFAULT_USER_PREFERENCES);
    });
    it("saveUserPreferences performs a partial merge into localStorage", () => {
        const store = new MultiRegionStore();
        store.saveUserPreferences({ density: "compact", theme: "light" });
        const after = store.getUserPreferences();
        expect(after.density).toBe("compact");
        expect(after.theme).toBe("light");
        expect(after.autoRefreshEnabled).toBe(DEFAULT_USER_PREFERENCES.autoRefreshEnabled);
        // Subsequent partial save preserves prior fields.
        store.saveUserPreferences({ sidebarCollapsed: true });
        const merged = store.getUserPreferences();
        expect(merged.density).toBe("compact");
        expect(merged.theme).toBe("light");
        expect(merged.sidebarCollapsed).toBe(true);
        const raw = localStorage.getItem("multi-region-prefs");
        expect(raw).not.toBeNull();
        expect(JSON.parse(raw).sidebarCollapsed).toBe(true);
    });
    it("getUserPreferences falls back to defaults when JSON is malformed", () => {
        localStorage.setItem("multi-region-prefs", "{not json");
        const store = new MultiRegionStore();
        expect(store.getUserPreferences()).toEqual(DEFAULT_USER_PREFERENCES);
    });
});
describe("MultiRegionStore — notifications", () => {
    it("addNotification appends with generated id+timestamp; removeNotification deletes by id", () => {
        const store = new MultiRegionStore();
        store.addNotification({ type: "success", message: "Saved" });
        const list = store.getState().notifications;
        expect(list).toHaveLength(1);
        expect(list[0].id).toBeTruthy();
        expect(list[0].timestamp).toBeTruthy();
        store.removeNotification(list[0].id);
        expect(store.getState().notifications).toEqual([]);
    });
    it("addNotification keeps only the last 50", () => {
        const store = new MultiRegionStore();
        for (let i = 0; i < 60; i++) {
            store.addNotification({ type: "info", message: `m${i}` });
        }
        const notifications = store.getState().notifications;
        expect(notifications).toHaveLength(50);
        expect(notifications[0].message).toBe("m10");
        expect(notifications[49].message).toBe("m59");
    });
});
describe("MultiRegionStore — session export & reset", () => {
    it("exportSessionAsJson produces valid JSON without agentStatuses", () => {
        const store = new MultiRegionStore();
        store.addAccount(makeAccount("a1"));
        const json = store.exportSessionAsJson();
        const parsed = JSON.parse(json);
        expect(parsed.accounts).toHaveLength(1);
        expect(parsed.accounts[0].id).toBe("a1");
        expect(parsed.agentStatuses).toBeUndefined();
        expect(parsed.sessionId).toBeTruthy();
    });
    it("newSession resets state and assigns a fresh sessionId", () => {
        const store = new MultiRegionStore();
        const oldSessionId = store.sessionId;
        store.addAccount(makeAccount("a1"));
        store.addPool(makePool("p1"));
        store.addAuditEntry(makeAuditEntry("e1"));
        const listener = jest.fn();
        store.onChange(listener);
        store.newSession();
        expect(listener).toHaveBeenCalledTimes(1);
        const after = store.getState();
        expect(after.sessionId).not.toBe(oldSessionId);
        expect(after.accounts).toEqual([]);
        expect(after.pools).toEqual([]);
        expect(after.auditEntries).toEqual([]);
    });
    it("reset() restores createInitialState shape", () => {
        const store = new MultiRegionStore();
        store.addAccount(makeAccount("a1"));
        store.reset();
        expect(store.getState().accounts).toEqual([]);
    });
});
describe("MultiRegionStore — auto-save", () => {
    it("enableAutoSave returns a cleanup function that unsubscribes", () => {
        const store = new MultiRegionStore();
        const dispose = store.enableAutoSave();
        expect(typeof dispose).toBe("function");
        expect(() => dispose()).not.toThrow();
    });
    it("saveSession persists to localStorage under namespaced key", () => {
        const store = new MultiRegionStore();
        store.addAccount(makeAccount("a1"));
        store.saveSession();
        const key = `multi-region-sessions:${store.sessionId}`;
        const raw = localStorage.getItem(key);
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw);
        expect(parsed.accounts).toHaveLength(1);
        const indexRaw = localStorage.getItem("multi-region-session-index");
        expect(indexRaw).not.toBeNull();
    });
});
describe("MultiRegionStore — global filter, workflow, agent statuses, logs", () => {
    it("setGlobalFilter merges patches", () => {
        const store = new MultiRegionStore();
        store.setGlobalFilter({ regions: ["eastus"], searchText: "foo" });
        expect(store.getState().globalFilter.regions).toEqual(["eastus"]);
        expect(store.getState().globalFilter.searchText).toBe("foo");
        store.setGlobalFilter({ searchText: "bar" });
        expect(store.getState().globalFilter.regions).toEqual(["eastus"]);
        expect(store.getState().globalFilter.searchText).toBe("bar");
    });
    it("setWorkflowState merges patches", () => {
        const store = new MultiRegionStore();
        store.setWorkflowState({ isRunning: true, currentStep: "discover" });
        expect(store.getState().workflow.isRunning).toBe(true);
        expect(store.getState().workflow.currentStep).toBe("discover");
    });
    it("setAgentStatus updates only the targeted agent", () => {
        const store = new MultiRegionStore();
        store.setAgentStatus("orchestrator", "running");
        expect(store.getState().agentStatuses.orchestrator).toBe("running");
        expect(store.getState().agentStatuses.provisioner).toBe("idle");
    });
    it("addLog appends a timestamped entry; clearLogs empties", () => {
        const store = new MultiRegionStore();
        store.addLog({ agent: "orchestrator", level: "info", message: "hi" });
        expect(store.getState().agentLogs).toHaveLength(1);
        expect(store.getState().agentLogs[0].timestamp).toBeTruthy();
        store.clearLogs();
        expect(store.getState().agentLogs).toEqual([]);
    });
    it("setSubscriptions replaces the slice", () => {
        const store = new MultiRegionStore();
        const subs = [
            { subscriptionId: "s1", displayName: "Sub 1" },
        ];
        store.setSubscriptions(subs);
        expect(store.getState().subscriptions).toEqual(subs);
    });
});
describe("MultiRegionStore — Azure accounts & tenants", () => {
    it("setAzureAccounts replaces; upsertAzureAccount inserts then updates", () => {
        var _a;
        const store = new MultiRegionStore();
        store.setAzureAccounts([makeAzureAccount("h1")]);
        expect(store.getState().azureAccounts).toHaveLength(1);
        store.upsertAzureAccount(makeAzureAccount("h2"));
        expect(store.getState().azureAccounts).toHaveLength(2);
        const updated = Object.assign(Object.assign({}, makeAzureAccount("h1")), { name: "Updated Name" });
        store.upsertAzureAccount(updated);
        expect(store.getState().azureAccounts).toHaveLength(2);
        expect((_a = store.getState().azureAccounts.find((a) => a.homeAccountId === "h1")) === null || _a === void 0 ? void 0 : _a.name).toBe("Updated Name");
    });
    it("removeAzureAccount removes by homeAccountId; updateAzureAccount patches", () => {
        const store = new MultiRegionStore();
        store.setAzureAccounts([makeAzureAccount("h1"), makeAzureAccount("h2")]);
        store.removeAzureAccount("h1");
        expect(store.getState().azureAccounts.map((a) => a.homeAccountId)).toEqual([
            "h2",
        ]);
        store.updateAzureAccount("h2", { status: "loading" });
        expect(store.getState().azureAccounts[0].status).toBe("loading");
    });
    it("setActiveTenant updates activeTenants and the matching azureAccount", () => {
        const store = new MultiRegionStore();
        store.setAzureAccounts([makeAzureAccount("h1")]);
        store.setActiveTenant("h1", "tenant-x");
        expect(store.getState().activeTenants["h1"]).toBe("tenant-x");
        expect(store.getState().azureAccounts[0].activeTenantId).toBe("tenant-x");
    });
    it("setActiveTenant ignores empty inputs", () => {
        const store = new MultiRegionStore();
        const listener = jest.fn();
        store.onChange(listener);
        store.setActiveTenant("", "t");
        store.setActiveTenant("h", "");
        expect(listener).not.toHaveBeenCalled();
    });
    it("setTenantUsers / addTenantUser / updateTenantUser maintain per-tenant lists", () => {
        var _a, _b;
        const store = new MultiRegionStore();
        const u1 = {
            id: "u1",
            displayName: "User 1",
            userPrincipalName: "u1@x.com",
            mail: null,
            accountEnabled: true,
        };
        const u2 = {
            id: "u2",
            displayName: "User 2",
            userPrincipalName: "u2@x.com",
            mail: null,
            accountEnabled: true,
        };
        store.setTenantUsers("t1", [u1]);
        expect(store.getState().tenantUsers["t1"]).toHaveLength(1);
        store.addTenantUser("t1", u2);
        expect(store.getState().tenantUsers["t1"]).toHaveLength(2);
        // Adding existing user upserts in-place
        const u1Updated = Object.assign(Object.assign({}, u1), { displayName: "Renamed" });
        store.addTenantUser("t1", u1Updated);
        expect(store.getState().tenantUsers["t1"]).toHaveLength(2);
        expect((_a = store.getState().tenantUsers["t1"].find((u) => u.id === "u1")) === null || _a === void 0 ? void 0 : _a.displayName).toBe("Renamed");
        store.updateTenantUser("t1", "u2", { displayName: "U2 Updated" });
        expect((_b = store.getState().tenantUsers["t1"].find((u) => u.id === "u2")) === null || _b === void 0 ? void 0 : _b.displayName).toBe("U2 Updated");
    });
    it("setPasswordResetCapability stores per-account flag", () => {
        const store = new MultiRegionStore();
        store.setPasswordResetCapability("h1", true);
        expect(store.getState().passwordResetCapability["h1"]).toBe(true);
    });
});
describe("MultiRegionStore — throttle stats", () => {
    it("setThrottleStatusEntry stores a new entry; pushThrottleTransition appends history", () => {
        const store = new MultiRegionStore();
        const entry = {
            state: "closed",
            refillPerSec: 10,
            recentThrottles: 0,
        };
        store.setThrottleStatusEntry("sub1", "arm", entry);
        expect(store.getThrottleStats().perSubscription["sub1::arm"]).toEqual(entry);
        const transition = {
            timestamp: new Date().toISOString(),
            subscriptionId: "sub1",
            family: "arm",
            from: "closed",
            to: "open",
            reason: "rate-limited",
        };
        store.pushThrottleTransition(transition);
        expect(store.getThrottleStats().history).toHaveLength(1);
    });
    it("setThrottleStatusEntry skips notification on duplicate state", () => {
        const store = new MultiRegionStore();
        const entry = {
            state: "closed",
            refillPerSec: 10,
            recentThrottles: 0,
        };
        store.setThrottleStatusEntry("sub1", "arm", entry);
        const listener = jest.fn();
        store.onChange(listener);
        store.setThrottleStatusEntry("sub1", "arm", entry);
        expect(listener).not.toHaveBeenCalled();
    });
});
describe("MultiRegionStore — activities", () => {
    it("addActivity returns id and tracks; updateActivity patches; clearCompletedActivities removes terminal entries", () => {
        const store = new MultiRegionStore();
        const id1 = store.addActivity({
            action: "create",
            target: "pool",
            status: "running",
        });
        const id2 = store.addActivity({
            action: "delete",
            target: "pool",
            status: "completed",
        });
        expect(id1).not.toBe(id2);
        expect(store.getState().activities).toHaveLength(2);
        store.updateActivity(id1, { status: "completed" });
        store.clearCompletedActivities();
        expect(store.getState().activities).toEqual([]);
    });
    it("addChildActivity links to parent", () => {
        const store = new MultiRegionStore();
        const parent = store.addActivity({
            action: "bulk",
            target: "all",
            status: "running",
        });
        const child = store.addChildActivity(parent, {
            action: "create",
            target: "pool-1",
            status: "running",
        });
        const parentEntry = store.getState().activities.find((a) => a.id === parent);
        expect(parentEntry === null || parentEntry === void 0 ? void 0 : parentEntry.children).toContain(child);
    });
    it("pauseActivity and resumeActivity toggle status; isActivityPaused reflects state", () => {
        var _a, _b;
        const store = new MultiRegionStore();
        const id = store.addActivity({
            action: "scan",
            target: "all",
            status: "running",
        });
        store.pauseActivity(id);
        expect(store.isActivityPaused(id)).toBe(true);
        expect((_a = store.getState().activities.find((a) => a.id === id)) === null || _a === void 0 ? void 0 : _a.status).toBe("paused");
        store.resumeActivity(id);
        expect(store.isActivityPaused(id)).toBe(false);
        expect((_b = store.getState().activities.find((a) => a.id === id)) === null || _b === void 0 ? void 0 : _b.status).toBe("running");
    });
    it("markActivityCancelling sets status to cancelling", () => {
        var _a;
        const store = new MultiRegionStore();
        const id = store.addActivity({
            action: "scan",
            target: "all",
            status: "running",
        });
        store.markActivityCancelling(id);
        expect((_a = store.getState().activities.find((a) => a.id === id)) === null || _a === void 0 ? void 0 : _a.status).toBe("cancelling");
    });
});
describe("MultiRegionStore — pool defaults", () => {
    it("updatePoolDefaults patches a single field", () => {
        const store = new MultiRegionStore();
        const before = store.getState().poolDefaults;
        store.updatePoolDefaults({ targetDedicatedNodes: 7 });
        expect(store.getState().poolDefaults.targetDedicatedNodes).toBe(7);
        expect(store.getState().poolDefaults.poolIdPrefix).toBe(before.poolIdPrefix);
    });
    it("resetPoolDefaults returns the fresh defaults snapshot", () => {
        const store = new MultiRegionStore();
        store.updatePoolDefaults({ targetDedicatedNodes: 99 });
        const fresh = store.resetPoolDefaults();
        expect(fresh.targetDedicatedNodes).not.toBe(99);
        expect(store.getState().poolDefaults).toEqual(fresh);
    });
});
//# sourceMappingURL=multi-region-store.test.js.map