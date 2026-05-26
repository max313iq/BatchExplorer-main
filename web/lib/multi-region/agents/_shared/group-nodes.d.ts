/**
 * `groupNodesByPool` — shared primitive replacing three near-identical
 * inline implementations that lived in orchestrator-agent
 * (`_deleteNodes`, `_recreateNodes`, `bulk_node_action`).
 *
 * Given a list of nodes (each with `accountId` + `poolId`) and the
 * accounts they belong to, returns a map keyed by `accountId||poolId`
 * with everything callers needed to fan out per-pool requests:
 *   - the owning account's display fields (name, region)
 *   - the list of Batch-API node ids (`nodeId`)
 *   - the matching internal store ids (the ones the UI sees)
 *
 * The exact field set is chosen to be a superset of all three previous
 * implementations so all of them can switch to this primitive without
 * losing information.
 */
export interface NodeForGrouping {
    /** Internal store id — matches what `_deleteNodes` calls `internalId`. */
    id: string;
    accountId: string;
    accountName: string;
    region: string;
    poolId: string;
    /** Batch API node id (what gets sent to removeNodes / performNodeAction). */
    nodeId: string;
}
export interface AccountForGrouping {
    id: string;
    accountName: string;
    region: string;
}
export interface NodePoolGroup {
    accountId: string;
    accountName: string;
    region: string;
    poolId: string;
    /** Batch API node ids — pass to removeNodes / performNodeAction. */
    nodeIds: string[];
    /** Internal store ids — use these for store.removeNode(...) etc. */
    internalIds: string[];
}
/**
 * Group a flat list of nodes by `accountId||poolId`. Nodes whose
 * `accountId` is not present in `accounts` are silently skipped — the
 * caller decides whether to surface that as a warning (the previous
 * inline implementations did so).
 *
 * `accounts` is optional. When omitted, the node's own
 * `{accountName, region}` are trusted. When provided, the function
 * skips nodes whose account isn't found — preserving the
 * `if (!account) continue` behavior the orchestrator's bulk path
 * relied on.
 */
export declare function groupNodesByPool(nodes: readonly NodeForGrouping[], accounts?: readonly AccountForGrouping[]): Map<string, NodePoolGroup>;
//# sourceMappingURL=group-nodes.d.ts.map