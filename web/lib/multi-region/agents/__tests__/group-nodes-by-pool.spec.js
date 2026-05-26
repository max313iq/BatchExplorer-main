/**
 * Tests for `groupNodesByPool` — the shared primitive that replaced
 * three inline copies in orchestrator-agent (audit fix #23).
 */
import { groupNodesByPool, } from "../_shared/group-nodes";
const node = (id, accountId, poolId, nodeId, accountName = "a-" + accountId, region = "eastus") => ({
    id,
    accountId,
    accountName,
    region,
    poolId,
    nodeId,
});
const account = (id) => ({
    id,
    accountName: "a-" + id,
    region: "eastus",
});
describe("groupNodesByPool", () => {
    it("returns an empty map for empty input", () => {
        const groups = groupNodesByPool([], [account("a")]);
        expect(groups.size).toBe(0);
    });
    it("groups nodes by accountId + poolId", () => {
        const nodes = [
            node("n1", "a", "p1", "batch1"),
            node("n2", "a", "p1", "batch2"),
            node("n3", "a", "p2", "batch3"),
            node("n4", "b", "p1", "batch4"),
        ];
        const groups = groupNodesByPool(nodes, [account("a"), account("b")]);
        expect(groups.size).toBe(3);
        const ap1 = groups.get("a||p1");
        expect(ap1.nodeIds).toEqual(["batch1", "batch2"]);
        expect(ap1.internalIds).toEqual(["n1", "n2"]);
        expect(ap1.accountName).toBe("a-a");
        const ap2 = groups.get("a||p2");
        expect(ap2.nodeIds).toEqual(["batch3"]);
        const bp1 = groups.get("b||p1");
        expect(bp1.nodeIds).toEqual(["batch4"]);
    });
    it("skips nodes whose account is not in the accounts list", () => {
        const nodes = [
            node("n1", "a", "p1", "batch1"),
            node("n2", "missing", "p1", "batch2"),
        ];
        const groups = groupNodesByPool(nodes, [account("a")]);
        expect(groups.size).toBe(1);
        expect(groups.get("a||p1").nodeIds).toEqual(["batch1"]);
    });
    it("includes all nodes when accounts list is omitted", () => {
        const nodes = [
            node("n1", "a", "p1", "batch1"),
            node("n2", "b", "p2", "batch2"),
        ];
        const groups = groupNodesByPool(nodes);
        expect(groups.size).toBe(2);
    });
    it("preserves accountName/region from the input node", () => {
        const nodes = [
            node("n1", "a", "p1", "batch1", "custom-name", "westus2"),
        ];
        const groups = groupNodesByPool(nodes, [account("a")]);
        const g = groups.get("a||p1");
        // The function trusts node-level accountName/region (matches the
        // inline implementations that used `node.accountName`).
        expect(g.accountName).toBe("custom-name");
        expect(g.region).toBe("westus2");
    });
    it("nodeIds and internalIds stay aligned in insertion order", () => {
        const nodes = [
            node("internal-A", "x", "p", "batch-A"),
            node("internal-B", "x", "p", "batch-B"),
            node("internal-C", "x", "p", "batch-C"),
        ];
        const groups = groupNodesByPool(nodes, [account("x")]);
        const g = groups.get("x||p");
        expect(g.nodeIds).toEqual(["batch-A", "batch-B", "batch-C"]);
        expect(g.internalIds).toEqual(["internal-A", "internal-B", "internal-C"]);
        // Each index pair matches:
        for (let i = 0; i < g.nodeIds.length; i++) {
            const nodeFromInput = nodes.find((n) => n.id === g.internalIds[i]);
            expect(nodeFromInput === null || nodeFromInput === void 0 ? void 0 : nodeFromInput.nodeId).toBe(g.nodeIds[i]);
        }
    });
});
//# sourceMappingURL=group-nodes-by-pool.spec.js.map