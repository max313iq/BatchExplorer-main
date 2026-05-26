import { __awaiter } from "tslib";
/**
 * Regression tests for two compounding bugs that surfaced as
 * truncated-JSON envelopes on `delete_nodes` / `recreate_nodes`
 * with >100 nodes in one pool:
 *
 *   1. Batch's `pool/removenodes` endpoint hard-caps `nodeList` at
 *      100 entries. >100 in a single POST returns
 *      `InvalidPropertyValue`. The fix chunks into ≤100-node POSTs.
 *
 *   2. The Batch error envelope for that response has `code` +
 *      `message` at the TOP LEVEL (not nested under `error` /
 *      `odata.error`). The previous parser fell through to
 *      `text.slice(0, 400)` and surfaced a truncated JSON dump.
 */
import { removeNodes } from "../batch-service";
// jsdom doesn't expose `Response`. Minimal duck-typed stub.
function fakeResponse(opts) {
    var _a, _b, _c;
    const headers = new Headers((_a = opts.headers) !== null && _a !== void 0 ? _a : {});
    const body = (_b = opts.body) !== null && _b !== void 0 ? _b : "";
    const url = (_c = opts.url) !== null && _c !== void 0 ? _c : "https://acct.westeurope.batch.azure.com/";
    const self = {
        status: opts.status,
        ok: opts.status >= 200 && opts.status < 300,
        headers,
        url,
        text: () => __awaiter(this, void 0, void 0, function* () { return body; }),
        json: () => __awaiter(this, void 0, void 0, function* () { return (body ? JSON.parse(body) : {}); }),
        clone: () => fakeResponse(opts),
    };
    return self;
}
describe("removeNodes — chunking + error parsing", () => {
    const origFetch = global.fetch;
    const endpoint = "https://acct.westeurope.batch.azure.com";
    const poolId = "pool-1";
    const token = "fake-token";
    afterEach(() => {
        global.fetch = origFetch;
    });
    it("chunks >100 nodes into multiple 100-node POSTs", () => __awaiter(void 0, void 0, void 0, function* () {
        const nodeIds = Array.from({ length: 227 }, (_, i) => `tvm-${i}`);
        const bodies = [];
        global.fetch = ((_input, init) => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
            bodies.push(String((_a = init === null || init === void 0 ? void 0 : init.body) !== null && _a !== void 0 ? _a : ""));
            return fakeResponse({ status: 202 });
        }));
        yield removeNodes(endpoint, poolId, nodeIds, token);
        expect(bodies.length).toBe(3); // 100 + 100 + 27
        const chunks = bodies.map((b) => JSON.parse(b).nodeList);
        expect(chunks[0].length).toBe(100);
        expect(chunks[1].length).toBe(100);
        expect(chunks[2].length).toBe(27);
        expect(new Set(chunks.flat()).size).toBe(227); // every id sent exactly once
    }));
    it("sends a single POST when ≤100 nodes (no over-chunking)", () => __awaiter(void 0, void 0, void 0, function* () {
        const nodeIds = Array.from({ length: 42 }, (_, i) => `tvm-${i}`);
        let calls = 0;
        global.fetch = (() => __awaiter(void 0, void 0, void 0, function* () {
            calls += 1;
            return fakeResponse({ status: 202 });
        }));
        yield removeNodes(endpoint, poolId, nodeIds, token);
        expect(calls).toBe(1);
    }));
    it("no-ops on empty nodeIds (no network call)", () => __awaiter(void 0, void 0, void 0, function* () {
        let calls = 0;
        global.fetch = (() => __awaiter(void 0, void 0, void 0, function* () {
            calls += 1;
            return fakeResponse({ status: 202 });
        }));
        yield removeNodes(endpoint, poolId, [], token);
        expect(calls).toBe(0);
    }));
    it("treats 404 mid-chunk as idempotent (continues with next chunk)", () => __awaiter(void 0, void 0, void 0, function* () {
        const nodeIds = Array.from({ length: 150 }, (_, i) => `tvm-${i}`);
        const statuses = [404, 202];
        let i = 0;
        global.fetch = (() => __awaiter(void 0, void 0, void 0, function* () { return fakeResponse({ status: statuses[i++] }); }));
        yield expect(removeNodes(endpoint, poolId, nodeIds, token)).resolves.toBeUndefined();
    }));
    it("parses FLAT Batch error envelope (top-level code/message.value)", () => __awaiter(void 0, void 0, void 0, function* () {
        const body = JSON.stringify({
            "odata.metadata": "https://acct.westeurope.batch.azure.com/$metadata#errors",
            code: "InvalidPropertyValue",
            message: {
                lang: "en-US",
                value: "The value provided for one of the properties in the request body is invalid.",
            },
        });
        global.fetch = (() => __awaiter(void 0, void 0, void 0, function* () {
            return fakeResponse({
                status: 400,
                body,
                headers: { "content-type": "application/json" },
            });
        }));
        yield expect(removeNodes(endpoint, poolId, ["tvm-0"], token)).rejects.toMatchObject({
            code: "InvalidPropertyValue",
            message: expect.stringContaining("The value provided for one of the properties"),
        });
    }));
    it("still parses the legacy `odata.error` envelope", () => __awaiter(void 0, void 0, void 0, function* () {
        const body = JSON.stringify({
            "odata.error": {
                code: "PoolNotFound",
                message: {
                    lang: "en-US",
                    value: "The specified pool does not exist.",
                },
            },
        });
        global.fetch = (() => __awaiter(void 0, void 0, void 0, function* () {
            return fakeResponse({
                status: 400,
                body,
                headers: { "content-type": "application/json" },
            });
        }));
        yield expect(removeNodes(endpoint, poolId, ["tvm-0"], token)).rejects.toMatchObject({
            code: "PoolNotFound",
            message: expect.stringContaining("does not exist"),
        });
    }));
    it("still parses the standard `error` envelope", () => __awaiter(void 0, void 0, void 0, function* () {
        const body = JSON.stringify({
            error: {
                code: "InvalidPoolState",
                message: { lang: "en-US", value: "Pool is being deleted." },
            },
        });
        global.fetch = (() => __awaiter(void 0, void 0, void 0, function* () {
            return fakeResponse({
                status: 400,
                body,
                headers: { "content-type": "application/json" },
            });
        }));
        yield expect(removeNodes(endpoint, poolId, ["tvm-0"], token)).rejects.toMatchObject({
            code: "InvalidPoolState",
            message: expect.stringContaining("being deleted"),
        });
    }));
});
//# sourceMappingURL=remove-nodes-chunking.spec.js.map