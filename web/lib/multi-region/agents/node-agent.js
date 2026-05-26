import { __awaiter } from "tslib";
import { noopAuditLogger, } from "./agent-types";
import { listPools, listNodes, performNodeAction, removeNodes, } from "../services";
import { uuidV4 } from "./_shared/ids";
import { accountEndpoint } from "./_shared/endpoints";
import { pMap } from "./_shared/parallel";
import { CancellationTracker } from "./_shared/cancellation";
import { classifyAzureError } from "./error-classifier";
export class NodeAgent {
    constructor(_ctx) {
        Object.defineProperty(this, "_ctx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: _ctx
        });
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "node"
        });
        /** Legacy flag for `cancel()` callers — mirrored to controllers. */
        Object.defineProperty(this, "_cancelled", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "_cancellation", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new CancellationTracker()
        });
    }
    cancel() {
        this._cancelled = true;
        this._cancellation.abortAll();
    }
    get _audit() {
        var _a;
        return (_a = this._ctx.auditLogger) !== null && _a !== void 0 ? _a : noopAuditLogger;
    }
    _isCancelled(signal) {
        if (this._cancelled)
            return true;
        if (signal === null || signal === void 0 ? void 0 : signal.aborted)
            return true;
        return false;
    }
    execute(params) {
        return __awaiter(this, void 0, void 0, function* () {
            const actionType = params.actionType;
            if (actionType === "reboot" ||
                actionType === "delete" ||
                actionType === "reimage" ||
                actionType === "disableScheduling" ||
                actionType === "enableScheduling") {
                return this._executeNodeAction(params);
            }
            return this._listNodes(params);
        });
    }
    /**
     * Resolve a bearer token. If a TokenProvider was supplied in the input
     * it takes precedence over the context's default accessor.
     */
    _resolveToken(provider) {
        return __awaiter(this, void 0, void 0, function* () {
            if (provider) {
                return provider.getToken();
            }
            return this._ctx.getBatchAccessToken();
        });
    }
    // -----------------------------------------------------------------
    // List nodes
    // -----------------------------------------------------------------
    _listNodes(input) {
        return __awaiter(this, void 0, void 0, function* () {
            const { store } = this._ctx;
            const { controller, signal } = this._cancellation.begin(input.signal);
            try {
                // Auto-discover: if no accountIds provided, use ALL created accounts
                let accountIds = input.accountIds;
                if (!accountIds || accountIds.length === 0) {
                    accountIds = store
                        .getState()
                        .accounts.filter((a) => a.provisioningState === "created")
                        .map((a) => a.id);
                }
                store.setAgentStatus("node", "running");
                store.addLog({
                    agent: "node",
                    level: "info",
                    message: `Listing nodes across ${accountIds.length} accounts (parallel)`,
                });
                const token = yield this._resolveToken(input.tokenProvider);
                const MAX_CONCURRENT = 2;
                const accountResults = yield pMap(accountIds, (accountId) => __awaiter(this, void 0, void 0, function* () {
                    var _a;
                    if (this._isCancelled(signal))
                        return {
                            nodes: [],
                            preempted: 0,
                            error: null,
                        };
                    const state = store.getState();
                    const account = state.accounts.find((a) => a.id === accountId);
                    if (!account)
                        return {
                            nodes: [],
                            preempted: 0,
                            error: null,
                        };
                    try {
                        const endpoint = accountEndpoint(account.accountName, account.region);
                        // 1) Fetch pools via SDK service
                        const pools = yield listPools(endpoint, token);
                        // 2) Parallel-fetch nodes across ALL pools in this account
                        const poolNodeResults = yield pMap(pools, (pool) => __awaiter(this, void 0, void 0, function* () {
                            if (this._isCancelled(signal))
                                return {
                                    nodes: [],
                                    preempted: 0,
                                };
                            try {
                                const rawNodes = yield listNodes(endpoint, pool.id, token);
                                // Throttle after each listNodes call
                                yield new Promise((r) => setTimeout(r, 200));
                                let preemptedCount = 0;
                                const mapped = rawNodes.map((n, idx) => {
                                    var _a;
                                    if (((_a = n.state) === null || _a === void 0 ? void 0 : _a.toLowerCase()) === "preempted") {
                                        preemptedCount++;
                                    }
                                    return this._toBatchNode(n, account, pool, idx);
                                });
                                // Throttle between pool iterations
                                yield new Promise((r) => setTimeout(r, 100));
                                return {
                                    nodes: mapped,
                                    preempted: preemptedCount,
                                };
                            }
                            catch (err) {
                                // Audit fix #11: surface the dropped error via the
                                // agent log instead of silently swallowing it. The
                                // returned shape is preserved (empty nodes array)
                                // so the per-pool fan-out continues; the operator
                                // gets visibility into why a pool produced no nodes.
                                const msg = err instanceof Error ? err.message : String(err);
                                store.addLog({
                                    agent: "node",
                                    level: "warn",
                                    message: `listNodes failed for ${account.accountName}/${pool.id}: ${msg}`,
                                });
                                return {
                                    nodes: [],
                                    preempted: 0,
                                };
                            }
                        }), 5);
                        const nodes = [];
                        let preempted = 0;
                        for (const pr of poolNodeResults) {
                            nodes.push(...pr.nodes);
                            preempted += pr.preempted;
                        }
                        return { nodes, preempted, error: null };
                    }
                    catch (error) {
                        return {
                            nodes: [],
                            preempted: 0,
                            error: (_a = error === null || error === void 0 ? void 0 : error.message) !== null && _a !== void 0 ? _a : String(error),
                        };
                    }
                }), MAX_CONCURRENT);
                const allNodes = [];
                let errors = 0;
                let totalPreempted = 0;
                for (const r of accountResults) {
                    if (r.error)
                        errors++;
                    else {
                        allNodes.push(...r.nodes);
                        totalPreempted += r.preempted;
                    }
                }
                store.setNodes(allNodes);
                store.setAgentStatus("node", errors > 0 ? "error" : "completed");
                store.addLog({
                    agent: "node",
                    level: "info",
                    message: `Found ${allNodes.length} nodes across accounts (${totalPreempted} preempted, ${errors} account-level errors)`,
                });
                return {
                    status: errors === 0 ? "completed" : "partial",
                    summary: {
                        total: allNodes.length,
                        preempted: totalPreempted,
                        errors,
                    },
                };
            }
            finally {
                this._cancellation.end(controller);
            }
        });
    }
    // -----------------------------------------------------------------
    // Node actions
    // -----------------------------------------------------------------
    _executeNodeAction(input) {
        var _a, _b;
        return __awaiter(this, void 0, void 0, function* () {
            const { store, scheduler } = this._ctx;
            const { controller, signal } = this._cancellation.begin(input.signal);
            try {
                const action = input.actionType;
                const actionLabels = {
                    reboot: { present: "Rebooting", past: "Rebooted" },
                    delete: { present: "Removing", past: "Removed" },
                    reimage: { present: "Reimaging", past: "Reimaged" },
                    disableScheduling: {
                        present: "Disabling scheduling on",
                        past: "Disabled scheduling on",
                    },
                    enableScheduling: {
                        present: "Enabling scheduling on",
                        past: "Enabled scheduling on",
                    },
                };
                const label = (_a = actionLabels[action]) !== null && _a !== void 0 ? _a : {
                    present: action,
                    past: action,
                };
                store.setAgentStatus("node", "running");
                store.addLog({
                    agent: "node",
                    level: "info",
                    message: `${label.present} ${input.nodeIds.length} node(s)`,
                });
                let succeeded = 0;
                let failed = 0;
                for (const internalId of input.nodeIds) {
                    if (this._isCancelled(signal))
                        break;
                    const state = store.getState();
                    const node = state.nodes.find((n) => n.id === internalId);
                    if (!node)
                        continue;
                    const account = state.accounts.find((a) => a.id === node.accountId);
                    if (!account)
                        continue;
                    try {
                        yield scheduler.run(node.accountId, () => __awaiter(this, void 0, void 0, function* () {
                            if (this._isCancelled(signal)) {
                                throw new Error("cancelled");
                            }
                            const token = yield this._resolveToken(input.tokenProvider);
                            const endpoint = accountEndpoint(account.accountName, account.region);
                            if (action === "delete") {
                                yield removeNodes(endpoint, node.poolId, [node.nodeId], token);
                            }
                            else {
                                yield performNodeAction(endpoint, node.poolId, node.nodeId, action, token);
                            }
                        }));
                        store.addLog({
                            agent: "node",
                            level: "info",
                            message: `${label.past} node ${node.nodeId} in ${account.accountName}/${node.poolId}`,
                        });
                        // Update local store state after successful action
                        switch (action) {
                            case "delete":
                                store.removeNode(internalId);
                                break;
                            case "reboot":
                                store.updateNode(internalId, { state: "rebooting" });
                                break;
                            case "reimage":
                                store.updateNode(internalId, { state: "reimaging" });
                                break;
                            case "disableScheduling":
                                store.updateNode(internalId, {
                                    schedulingState: "disabled",
                                });
                                break;
                            case "enableScheduling":
                                store.updateNode(internalId, {
                                    schedulingState: "enabled",
                                });
                                break;
                        }
                        succeeded++;
                        this._audit.record({
                            action: `node_${action}`,
                            target: `${account.accountName}/${node.poolId}/${node.nodeId}`,
                            status: "success",
                            details: {
                                accountId: account.id,
                                poolId: node.poolId,
                                nodeId: node.nodeId,
                            },
                        });
                    }
                    catch (error) {
                        const errorMsg = (_b = error === null || error === void 0 ? void 0 : error.message) !== null && _b !== void 0 ? _b : String(error);
                        const classified = classifyAzureError(error);
                        store.addLog({
                            agent: "node",
                            level: "error",
                            message: `Failed to ${action} node ${node.nodeId} [${classified.kind}]: ${errorMsg}`,
                        });
                        failed++;
                        this._audit.record({
                            action: `node_${action}`,
                            target: `${account.accountName}/${node.poolId}/${node.nodeId}`,
                            status: "failure",
                            error: errorMsg,
                            details: {
                                accountId: account.id,
                                poolId: node.poolId,
                                nodeId: node.nodeId,
                                classification: classified.kind,
                            },
                        });
                    }
                }
                store.setAgentStatus("node", failed > 0 ? "error" : "completed");
                return {
                    status: failed === 0 ? "completed" : succeeded === 0 ? "failed" : "partial",
                    summary: { total: input.nodeIds.length, succeeded, failed },
                };
            }
            finally {
                this._cancellation.end(controller);
            }
        });
    }
    // -----------------------------------------------------------------
    // Map Batch API node response to ManagedNode
    // -----------------------------------------------------------------
    /**
     * Convert a raw Batch data-plane node response into a ManagedNode.
     *
     * isDedicated mapping: the Batch API may return `isDedicated` on the
     * node itself. When it is not present, we infer dedication from the
     * pool counters -- if the node's ordinal index is less than the pool's
     * `currentDedicatedNodes`, it is dedicated; otherwise low-priority.
     */
    _toBatchNode(n, account, pool, nodeIndex) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const nodeState = ((_a = n.state) !== null && _a !== void 0 ? _a : "unknown").toLowerCase();
        // --- isDedicated ---
        let isDedicated;
        if (typeof n.isDedicated === "boolean") {
            isDedicated = n.isDedicated;
        }
        else {
            // Infer from pool counters: nodes indexed below
            // currentDedicatedNodes are dedicated.
            const currentDedicated = (_b = pool.currentDedicatedNodes) !== null && _b !== void 0 ? _b : 0;
            isDedicated =
                ((_c = pool.targetDedicatedNodes) !== null && _c !== void 0 ? _c : 0) > 0 && nodeIndex < currentDedicated;
        }
        // --- errors ---
        let errorMsg = null;
        if (n.errors && n.errors.length > 0) {
            errorMsg = n.errors
                .map((e) => {
                var _a, _b;
                const msg = `${(_a = e.code) !== null && _a !== void 0 ? _a : "Error"}: ${(_b = e.message) !== null && _b !== void 0 ? _b : "Unknown error"}`;
                return msg;
            })
                .join("; ");
        }
        // --- startTaskInfo errors ---
        if (((_d = n.startTaskInfo) === null || _d === void 0 ? void 0 : _d.result) === "failure" ||
            (((_e = n.startTaskInfo) === null || _e === void 0 ? void 0 : _e.exitCode) !== undefined &&
                n.startTaskInfo.exitCode !== 0)) {
            const stInfo = n.startTaskInfo;
            const stMsg = `StartTask exit=${(_f = stInfo.exitCode) !== null && _f !== void 0 ? _f : "?"} result=${(_g = stInfo.result) !== null && _g !== void 0 ? _g : "unknown"}`;
            errorMsg = errorMsg ? `${errorMsg}; ${stMsg}` : stMsg;
        }
        return {
            id: uuidV4(),
            accountId: account.id,
            accountName: account.accountName,
            region: account.region,
            poolId: pool.id,
            nodeId: n.id,
            state: nodeState,
            vmSize: (_h = n.vmSize) !== null && _h !== void 0 ? _h : pool.vmSize,
            ipAddress: n.ipAddress,
            isDedicated,
            lastBootTime: n.lastBootTime,
            totalTasksRun: n.totalTasksRun,
            runningTasksCount: n.runningTasksCount,
            schedulingState: n.schedulingState,
            subscriptionId: account.subscriptionId,
            error: errorMsg,
        };
    }
}
//# sourceMappingURL=node-agent.js.map