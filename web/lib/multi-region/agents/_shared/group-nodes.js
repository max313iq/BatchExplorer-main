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
export function groupNodesByPool(nodes, accounts) {
    const accountMap = accounts
        ? new Map(accounts.map((a) => [a.id, a]))
        : null;
    const groups = new Map();
    for (const node of nodes) {
        if (accountMap && !accountMap.has(node.accountId)) {
            continue;
        }
        const key = `${node.accountId}||${node.poolId}`;
        let bucket = groups.get(key);
        if (!bucket) {
            bucket = {
                accountId: node.accountId,
                accountName: node.accountName,
                region: node.region,
                poolId: node.poolId,
                nodeIds: [],
                internalIds: [],
            };
            groups.set(key, bucket);
        }
        bucket.nodeIds.push(node.nodeId);
        bucket.internalIds.push(node.id);
    }
    return groups;
}
//# sourceMappingURL=group-nodes.js.map