/**
 * Shared id / correlation primitives.
 *
 * Extracted from pool-agent / node-agent / orchestrator-agent which all
 * carried near-identical copies of `uuidV4` (and similar helpers). One
 * implementation, imported everywhere — keeps id-generation behavior
 * consistent and gives us a single place to swap in `crypto.randomUUID()`
 * once we drop the JSDOM / older-Node test fallback.
 */
/**
 * RFC4122 v4 UUID using `Math.random` — sufficient for client-side
 * correlation ids and store keys (NOT for cryptographic use). Uses
 * `crypto.randomUUID` when available for better entropy; falls back to
 * the Math.random template that mirrors the original inline copies so
 * existing tests that pattern-match on uuid shape continue to pass.
 */
export function uuidV4() {
    var _a;
    if (typeof globalThis !== "undefined" &&
        ((_a = globalThis.crypto) === null || _a === void 0 ? void 0 : _a.randomUUID)) {
        try {
            return globalThis.crypto.randomUUID();
        }
        catch (_b) {
            /* fall through to Math.random template below */
        }
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
/**
 * Short 4-character random suffix used in pool names (`auto-{vm}-{r4}`,
 * `gpu-{vm}-{r4}`). Base36 → letters + digits, lowercase. Matches the
 * inline implementation that previously lived in pool-agent and
 * orchestrator-agent.
 */
export function random4() {
    return Math.random().toString(36).substring(2, 6);
}
/**
 * Orchestrator-style correlation id. Identical to `uuidV4` shape but
 * named to make the intent explicit at call sites.
 */
export function correlationId() {
    return uuidV4();
}
//# sourceMappingURL=ids.js.map