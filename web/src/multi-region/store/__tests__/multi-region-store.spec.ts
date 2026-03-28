import { MultiRegionStore } from "../multi-region-store";
import {
    ManagedAccount,
    ManagedPool,
    ManagedNode,
    Subscription,
} from "../store-types";

describe("MultiRegionStore", () => {
    let store: MultiRegionStore;

    beforeEach(() => {
        store = new MultiRegionStore();
    });

    // -----------------------------------------------------------------------
    // Subscriptions
    // -----------------------------------------------------------------------

    describe("setSubscriptions", () => {
        it("updates the subscriptions in state", () => {
            const subs: Subscription[] = [
                { subscriptionId: "sub-1", displayName: "Sub One" },
                { subscriptionId: "sub-2", displayName: "Sub Two" },
            ];

            store.setSubscriptions(subs);

            expect(store.getState().subscriptions).toEqual(subs);
            expect(store.getState().subscriptions).toHaveLength(2);
        });

        it("notifies listeners", () => {
            const listener = jest.fn();
            store.onChange(listener);

            store.setSubscriptions([{ subscriptionId: "s", displayName: "S" }]);

            expect(listener).toHaveBeenCalledTimes(1);
        });

        it("replaces previous subscriptions", () => {
            store.setSubscriptions([{ subscriptionId: "a", displayName: "A" }]);
            store.setSubscriptions([{ subscriptionId: "b", displayName: "B" }]);

            expect(store.getState().subscriptions).toHaveLength(1);
            expect(store.getState().subscriptions[0].subscriptionId).toBe("b");
        });
    });

    // -----------------------------------------------------------------------
    // Accounts
    // -----------------------------------------------------------------------

    describe("addAccount", () => {
        it("appends an account to the accounts array", () => {
            const account: ManagedAccount = {
                id: "acct-1",
                accountName: "myacct",
                resourceGroup: "rg-1",
                subscriptionId: "sub-1",
                region: "eastus",
                provisioningState: "pending",
            };

            store.addAccount(account);

            expect(store.getState().accounts).toHaveLength(1);
            expect(store.getState().accounts[0].id).toBe("acct-1");
        });

        it("appends without removing existing accounts", () => {
            store.addAccount({
                id: "a1",
                accountName: "a1",
                resourceGroup: "rg",
                subscriptionId: "s",
                region: "eastus",
                provisioningState: "created",
            });
            store.addAccount({
                id: "a2",
                accountName: "a2",
                resourceGroup: "rg",
                subscriptionId: "s",
                region: "westus",
                provisioningState: "pending",
            });

            expect(store.getState().accounts).toHaveLength(2);
        });
    });

    describe("updateAccount", () => {
        it("patches an account by id", () => {
            store.addAccount({
                id: "acct-1",
                accountName: "myacct",
                resourceGroup: "rg-1",
                subscriptionId: "sub-1",
                region: "eastus",
                provisioningState: "pending",
            });

            store.updateAccount("acct-1", {
                provisioningState: "created",
            });

            expect(store.getState().accounts[0].provisioningState).toBe(
                "created"
            );
        });

        it("does not modify other accounts", () => {
            store.addAccount({
                id: "a1",
                accountName: "a1",
                resourceGroup: "rg",
                subscriptionId: "s",
                region: "eastus",
                provisioningState: "pending",
            });
            store.addAccount({
                id: "a2",
                accountName: "a2",
                resourceGroup: "rg",
                subscriptionId: "s",
                region: "westus",
                provisioningState: "pending",
            });

            store.updateAccount("a1", { provisioningState: "created" });

            expect(store.getState().accounts[1].provisioningState).toBe(
                "pending"
            );
        });

        it("is a no-op if id does not match", () => {
            store.addAccount({
                id: "a1",
                accountName: "a1",
                resourceGroup: "rg",
                subscriptionId: "s",
                region: "eastus",
                provisioningState: "pending",
            });

            store.updateAccount("nonexistent", {
                provisioningState: "created",
            });

            expect(store.getState().accounts[0].provisioningState).toBe(
                "pending"
            );
        });
    });

    describe("removeAccount", () => {
        it("removes an account by id", () => {
            store.addAccount({
                id: "a1",
                accountName: "a1",
                resourceGroup: "rg",
                subscriptionId: "s",
                region: "eastus",
                provisioningState: "pending",
            });

            store.removeAccount("a1");

            expect(store.getState().accounts).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // Pools
    // -----------------------------------------------------------------------

    describe("addPool / updatePool", () => {
        it("adds and updates pools", () => {
            const pool: ManagedPool = {
                id: "p1",
                accountId: "a1",
                poolId: "pool-1",
                provisioningState: "pending",
                config: { vmSize: "Standard_D2s_v3" },
            };

            store.addPool(pool);
            expect(store.getState().pools).toHaveLength(1);

            store.updatePool("p1", { provisioningState: "created" });
            expect(store.getState().pools[0].provisioningState).toBe("created");
        });
    });

    // -----------------------------------------------------------------------
    // Nodes
    // -----------------------------------------------------------------------

    describe("setNodes / updateNode / removeNode", () => {
        it("replaces all nodes", () => {
            const nodes: ManagedNode[] = [
                {
                    id: "n1",
                    accountId: "a1",
                    accountName: "acct1",
                    region: "eastus",
                    poolId: "p1",
                    nodeId: "node-1",
                    state: "idle",
                    isDedicated: true,
                },
            ];

            store.setNodes(nodes);

            expect(store.getState().nodes).toHaveLength(1);
            expect(store.getState().nodes[0].nodeId).toBe("node-1");
        });

        it("updates a node by id", () => {
            store.setNodes([
                {
                    id: "n1",
                    accountId: "a1",
                    accountName: "acct1",
                    region: "eastus",
                    poolId: "p1",
                    nodeId: "node-1",
                    state: "idle",
                    isDedicated: true,
                },
            ]);

            store.updateNode("n1", { state: "running" });

            expect(store.getState().nodes[0].state).toBe("running");
        });

        it("removes a node by id", () => {
            store.setNodes([
                {
                    id: "n1",
                    accountId: "a1",
                    accountName: "acct1",
                    region: "eastus",
                    poolId: "p1",
                    nodeId: "node-1",
                    state: "idle",
                    isDedicated: true,
                },
            ]);

            store.removeNode("n1");

            expect(store.getState().nodes).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // onChange listener
    // -----------------------------------------------------------------------

    describe("onChange", () => {
        it("calls listener on state changes", () => {
            const listener = jest.fn();
            store.onChange(listener);

            store.setSubscriptions([]);
            store.addAccount({
                id: "a1",
                accountName: "a",
                resourceGroup: "rg",
                subscriptionId: "s",
                region: "r",
                provisioningState: "pending",
            });

            expect(listener).toHaveBeenCalledTimes(2);
        });

        it("returns unsubscribe function that stops notifications", () => {
            const listener = jest.fn();
            const unsub = store.onChange(listener);

            store.setSubscriptions([]);
            expect(listener).toHaveBeenCalledTimes(1);

            unsub();

            store.setSubscriptions([{ subscriptionId: "s", displayName: "S" }]);
            // Should still be 1, not 2
            expect(listener).toHaveBeenCalledTimes(1);
        });

        it("swallows listener errors without breaking other listeners", () => {
            const badListener = jest.fn(() => {
                throw new Error("listener crash");
            });
            const goodListener = jest.fn();

            store.onChange(badListener);
            store.onChange(goodListener);

            store.setSubscriptions([]);

            expect(badListener).toHaveBeenCalledTimes(1);
            expect(goodListener).toHaveBeenCalledTimes(1);
        });
    });

    // -----------------------------------------------------------------------
    // Agent statuses
    // -----------------------------------------------------------------------

    describe("setAgentStatus", () => {
        it("updates a single agent status", () => {
            store.setAgentStatus("provisioner", "running");

            expect(store.getState().agentStatuses.provisioner).toBe("running");
            // Others remain idle
            expect(store.getState().agentStatuses.orchestrator).toBe("idle");
        });
    });

    // -----------------------------------------------------------------------
    // Notifications
    // -----------------------------------------------------------------------

    describe("notifications", () => {
        it("adds a notification with generated id and timestamp", () => {
            store.addNotification({ type: "info", message: "Hello" });

            const notes = store.getState().notifications;
            expect(notes).toHaveLength(1);
            expect(notes[0].message).toBe("Hello");
            expect(notes[0].id).toBeTruthy();
            expect(notes[0].timestamp).toBeTruthy();
        });

        it("removes a notification by id", () => {
            store.addNotification({ type: "info", message: "A" });
            const id = store.getState().notifications[0].id;

            store.removeNotification(id);

            expect(store.getState().notifications).toHaveLength(0);
        });

        it("caps notifications at 50", () => {
            for (let i = 0; i < 55; i++) {
                store.addNotification({
                    type: "info",
                    message: `msg-${i}`,
                });
            }
            expect(store.getState().notifications).toHaveLength(50);
        });
    });

    // -----------------------------------------------------------------------
    // Workflow state
    // -----------------------------------------------------------------------

    describe("setWorkflowState", () => {
        it("patches workflow state", () => {
            store.setWorkflowState({
                isRunning: true,
                currentStep: "discover",
            });

            const wf = store.getState().workflow;
            expect(wf.isRunning).toBe(true);
            expect(wf.currentStep).toBe("discover");
            // Other fields remain at defaults
            expect(wf.completedSteps).toEqual([]);
        });
    });

    // -----------------------------------------------------------------------
    // Retry failed
    // -----------------------------------------------------------------------

    describe("retryFailedAccounts", () => {
        it("resets failed accounts to pending and returns their ids", () => {
            store.addAccount({
                id: "a1",
                accountName: "a1",
                resourceGroup: "rg",
                subscriptionId: "s",
                region: "eastus",
                provisioningState: "failed",
                error: "some error",
            });
            store.addAccount({
                id: "a2",
                accountName: "a2",
                resourceGroup: "rg",
                subscriptionId: "s",
                region: "westus",
                provisioningState: "created",
            });

            const ids = store.retryFailedAccounts();

            expect(ids).toEqual(["a1"]);
            expect(store.getState().accounts[0].provisioningState).toBe(
                "pending"
            );
            expect(store.getState().accounts[0].error).toBeNull();
            // Non-failed account remains unchanged
            expect(store.getState().accounts[1].provisioningState).toBe(
                "created"
            );
        });
    });

    // -----------------------------------------------------------------------
    // Reset
    // -----------------------------------------------------------------------

    describe("reset", () => {
        it("restores initial state", () => {
            store.addAccount({
                id: "a1",
                accountName: "a",
                resourceGroup: "rg",
                subscriptionId: "s",
                region: "r",
                provisioningState: "created",
            });
            store.setSubscriptions([{ subscriptionId: "s", displayName: "S" }]);

            store.reset();

            expect(store.getState().accounts).toHaveLength(0);
            expect(store.getState().subscriptions).toHaveLength(0);
        });

        it("notifies listeners on reset", () => {
            const listener = jest.fn();
            store.onChange(listener);

            store.reset();

            expect(listener).toHaveBeenCalledTimes(1);
        });
    });

    // -----------------------------------------------------------------------
    // Global filter
    // -----------------------------------------------------------------------

    describe("setGlobalFilter", () => {
        it("merges partial filter into existing filter", () => {
            store.setGlobalFilter({ regions: ["eastus", "westus"] });

            expect(store.getState().globalFilter.regions).toEqual([
                "eastus",
                "westus",
            ]);
            // Other filter fields remain at defaults
            expect(store.getState().globalFilter.searchText).toBe("");
        });
    });

    // -----------------------------------------------------------------------
    // Activities
    // -----------------------------------------------------------------------

    describe("activities", () => {
        it("adds an activity and returns its id", () => {
            const id = store.addActivity({
                action: "createPool",
                target: "pool-1",
                status: "running",
            });

            expect(typeof id).toBe("string");
            expect(id.length).toBeGreaterThan(0);

            const activities = store.getState().activities;
            expect(activities).toHaveLength(1);
            expect(activities[0].action).toBe("createPool");
            expect(activities[0].startedAt).toBeTruthy();
        });

        it("updates an activity", () => {
            const id = store.addActivity({
                action: "createPool",
                target: "pool-1",
                status: "running",
            });

            store.updateActivity(id, { status: "completed" });

            expect(store.getState().activities[0].status).toBe("completed");
        });

        it("clears completed activities", () => {
            store.addActivity({
                action: "a",
                target: "t1",
                status: "completed",
            });
            store.addActivity({
                action: "b",
                target: "t2",
                status: "running",
            });
            store.addActivity({
                action: "c",
                target: "t3",
                status: "failed",
            });

            store.clearCompletedActivities();

            const remaining = store.getState().activities;
            expect(remaining).toHaveLength(1);
            expect(remaining[0].status).toBe("running");
        });

        it("caps activities at 100", () => {
            for (let i = 0; i < 105; i++) {
                store.addActivity({
                    action: "test",
                    target: `t-${i}`,
                    status: "completed",
                });
            }
            expect(store.getState().activities).toHaveLength(100);
        });
    });

    // -----------------------------------------------------------------------
    // Azure login accounts (if methods exist)
    // -----------------------------------------------------------------------

    // TODO: test setAzureAccounts, upsertAzureAccount, removeAzureAccount
    // when implemented by another agent
});
