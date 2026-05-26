import { __awaiter } from "tslib";
import * as batchService from "../batch-service";
import { AzureRequestError, } from "../types";
/**
 * Build a Response-like object compatible with what `guardedFetch` and
 * `batch-service` consume. Mirrors the helper used in `arm-service.test.ts`:
 * - `headers.get(name)` for Retry-After / x-ms-throttling-version
 * - `clone().text()` for error bodies
 * - `json()` for the parsed Batch payload
 */
function makeResponse(init = {}) {
    var _a, _b, _c, _d;
    const status = (_a = init.status) !== null && _a !== void 0 ? _a : 200;
    const statusText = (_b = init.statusText) !== null && _b !== void 0 ? _b : "";
    const url = (_c = init.url) !== null && _c !== void 0 ? _c : "https://acct.eastus.batch.azure.com/";
    const headersMap = new Map(Object.entries((_d = init.headers) !== null && _d !== void 0 ? _d : {}).map(([k, v]) => [k.toLowerCase(), v]));
    const headers = {
        get: (name) => { var _a; return (_a = headersMap.get(name.toLowerCase())) !== null && _a !== void 0 ? _a : null; },
    };
    const text = init.rawText !== undefined
        ? init.rawText
        : init.body !== undefined
            ? JSON.stringify(init.body)
            : "";
    const response = {
        status,
        statusText,
        ok: status >= 200 && status < 300,
        url,
        headers,
        text: () => Promise.resolve(text),
        json: () => init.body !== undefined
            ? Promise.resolve(init.body)
            : Promise.reject(new Error("no body")),
        clone: () => makeResponse(init),
    };
    return response;
}
function getFetchMock() {
    return global.fetch;
}
function queueResponses(responses) {
    const mock = getFetchMock();
    for (const r of responses) {
        mock.mockResolvedValueOnce(r);
    }
}
// Valid Batch endpoint per the SSRF guard in `validateAccountEndpoint`.
const VALID_ENDPOINT = "https://acct.eastus.batch.azure.com";
const TOKEN = "test-token";
// ---------------------------------------------------------------------------
// Setup / teardown — hermetic per design contract §9.
// ---------------------------------------------------------------------------
describe("batch-service", () => {
    // jest.fn() token provider per the brief; the service itself takes raw
    // strings, so the provider is called by tests that need rotation semantics.
    let tokenProvider;
    beforeEach(() => {
        global.fetch = jest.fn();
        tokenProvider = jest.fn(() => TOKEN);
    });
    afterEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });
    // -------------------------------------------------------------------------
    // Endpoint validation (SSRF guard) — exercised through every public method
    // -------------------------------------------------------------------------
    describe("endpoint validation", () => {
        it("rejects non-batch.azure.com endpoints in listPools", () => __awaiter(void 0, void 0, void 0, function* () {
            yield expect(batchService.listPools("evil.example.com", tokenProvider())).rejects.toThrow(/batch\.azure\.com/);
            expect(getFetchMock()).not.toHaveBeenCalled();
        }));
        it("rejects malformed endpoints", () => __awaiter(void 0, void 0, void 0, function* () {
            yield expect(batchService.listPools("not a url at all !!!", tokenProvider())).rejects.toThrow(/Invalid accountEndpoint|hostname/);
            expect(getFetchMock()).not.toHaveBeenCalled();
        }));
        it("accepts bare hostnames (auto-prepends https://)", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
            queueResponses([makeResponse({ status: 200, body: { value: [] } })]);
            yield expect(batchService.listPools("acct.eastus.batch.azure.com", tokenProvider())).resolves.toEqual([]);
            expect(getFetchMock()).toHaveBeenCalledTimes(1);
            const url = (_a = getFetchMock().mock.calls[0]) === null || _a === void 0 ? void 0 : _a[0];
            expect(url).toMatch(/^https:\/\/acct\.eastus\.batch\.azure\.com\/pools\?/);
        }));
    });
    // -------------------------------------------------------------------------
    // listPools
    // -------------------------------------------------------------------------
    describe("listPools", () => {
        it("returns pools and follows odata.nextLink pagination", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b, _c;
            queueResponses([
                makeResponse({
                    status: 200,
                    body: {
                        value: [{ id: "pool-1", vmSize: "STANDARD_D2_V3" }],
                        "odata.nextLink": "https://acct.eastus.batch.azure.com/pools?api-version=2024-07-01.20.0&skip=1",
                    },
                }),
                makeResponse({
                    status: 200,
                    body: {
                        value: [{ id: "pool-2", vmSize: "STANDARD_D2_V3" }],
                    },
                }),
            ]);
            const pools = yield batchService.listPools(VALID_ENDPOINT, tokenProvider());
            expect(pools).toHaveLength(2);
            expect((_a = pools[0]) === null || _a === void 0 ? void 0 : _a.id).toBe("pool-1");
            expect((_b = pools[1]) === null || _b === void 0 ? void 0 : _b.id).toBe("pool-2");
            expect(getFetchMock()).toHaveBeenCalledTimes(2);
            // Verify Authorization header on the first call.
            const firstInit = (_c = getFetchMock().mock.calls[0]) === null || _c === void 0 ? void 0 : _c[1];
            const headers = firstInit === null || firstInit === void 0 ? void 0 : firstInit.headers;
            expect(headers === null || headers === void 0 ? void 0 : headers.Authorization).toBe(`Bearer ${TOKEN}`);
            expect(headers === null || headers === void 0 ? void 0 : headers.Accept).toMatch(/application\/json/);
            // Token provider was invoked exactly once per call site.
            expect(tokenProvider).toHaveBeenCalledTimes(1);
        }));
        it("returns [] when value is missing or non-array", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([makeResponse({ status: 200, body: { value: null } })]);
            const pools = yield batchService.listPools(VALID_ENDPOINT, TOKEN);
            expect(pools).toEqual([]);
        }));
        it("throws AzureRequestError on 401 (auth failure)", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 401,
                    statusText: "Unauthorized",
                    body: {
                        error: {
                            code: "InvalidAuthenticationToken",
                            message: { value: "token expired" },
                        },
                    },
                }),
            ]);
            try {
                yield batchService.listPools(VALID_ENDPOINT, "bad");
                fail("expected throw");
            }
            catch (e) {
                const err = e;
                expect(err).toBeInstanceOf(AzureRequestError);
                expect(err.status).toBe(401);
                expect(err.code).toBe("InvalidAuthenticationToken");
                expect(err.message).toBe("token expired");
            }
        }));
        it("surfaces 5xx errors as AzureRequestError with status preserved", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 503,
                    statusText: "Service Unavailable",
                    body: {
                        error: { code: "ServiceUnavailable", message: "try later" },
                    },
                }),
            ]);
            yield expect(batchService.listPools(VALID_ENDPOINT, TOKEN)).rejects.toMatchObject({ status: 503 });
        }));
        it("falls back to a default message when the error body is empty", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({ status: 500, rawText: "", body: undefined }),
            ]);
            try {
                yield batchService.listPools(VALID_ENDPOINT, TOKEN);
                fail("expected throw");
            }
            catch (e) {
                const err = e;
                expect(err.status).toBe(500);
                expect(err.message).toContain("500");
            }
        }));
    });
    // -------------------------------------------------------------------------
    // createPool
    // -------------------------------------------------------------------------
    describe("createPool", () => {
        it("POSTs the pool body and resolves on 201", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
            queueResponses([
                makeResponse({ status: 201, body: { /* Batch returns empty */} }),
            ]);
            yield expect(batchService.createPool(VALID_ENDPOINT, { id: "new-pool", vmSize: "STANDARD_D2_V3" }, TOKEN)).resolves.toBeUndefined();
            const call = getFetchMock().mock.calls[0];
            expect((_a = call === null || call === void 0 ? void 0 : call[1]) === null || _a === void 0 ? void 0 : _a.method).toBe("POST");
            const init = call === null || call === void 0 ? void 0 : call[1];
            const headers = init === null || init === void 0 ? void 0 : init.headers;
            expect(headers === null || headers === void 0 ? void 0 : headers.Authorization).toBe(`Bearer ${TOKEN}`);
            expect(headers === null || headers === void 0 ? void 0 : headers["Content-Type"]).toMatch(/application\/json/);
            expect(init === null || init === void 0 ? void 0 : init.body).toBe(JSON.stringify({ id: "new-pool", vmSize: "STANDARD_D2_V3" }));
        }));
        it("throws AzureRequestError on 400 (validation)", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 400,
                    statusText: "Bad Request",
                    body: {
                        "odata.error": {
                            code: "InvalidPropertyValue",
                            message: { value: "vmSize is required" },
                        },
                    },
                }),
            ]);
            try {
                yield batchService.createPool(VALID_ENDPOINT, { id: "incomplete" }, TOKEN);
                fail("expected throw");
            }
            catch (e) {
                const err = e;
                expect(err.status).toBe(400);
                expect(err.code).toBe("InvalidPropertyValue");
                expect(err.message).toBe("vmSize is required");
            }
        }));
    });
    // -------------------------------------------------------------------------
    // patchPool (resize / update)
    // -------------------------------------------------------------------------
    describe("patchPool", () => {
        it("PATCHes the pool with the provided patch body", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            queueResponses([makeResponse({ status: 200, body: {} })]);
            yield batchService.patchPool(VALID_ENDPOINT, "pool with spaces", { targetDedicatedNodes: 5 }, TOKEN);
            const call = getFetchMock().mock.calls[0];
            expect((_a = call === null || call === void 0 ? void 0 : call[1]) === null || _a === void 0 ? void 0 : _a.method).toBe("PATCH");
            // poolId is URI-encoded.
            expect(call === null || call === void 0 ? void 0 : call[0]).toContain("/pools/pool%20with%20spaces?");
            expect((_b = call === null || call === void 0 ? void 0 : call[1]) === null || _b === void 0 ? void 0 : _b.body).toBe(JSON.stringify({ targetDedicatedNodes: 5 }));
        }));
        it("throws AzureRequestError on 404 (resize a missing pool)", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 404,
                    statusText: "Not Found",
                    body: {
                        error: {
                            code: "PoolNotFound",
                            message: { value: "pool 'ghost' does not exist" },
                        },
                    },
                }),
            ]);
            try {
                yield batchService.patchPool(VALID_ENDPOINT, "ghost", { targetDedicatedNodes: 1 }, TOKEN);
                fail("expected throw");
            }
            catch (e) {
                const err = e;
                expect(err.status).toBe(404);
                expect(err.code).toBe("PoolNotFound");
            }
        }));
    });
    // -------------------------------------------------------------------------
    // deletePool
    // -------------------------------------------------------------------------
    describe("deletePool", () => {
        it("DELETEs the encoded pool URL", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            queueResponses([makeResponse({ status: 202, body: {} })]);
            yield batchService.deletePool(VALID_ENDPOINT, "p/1", TOKEN);
            const call = getFetchMock().mock.calls[0];
            expect((_a = call === null || call === void 0 ? void 0 : call[1]) === null || _a === void 0 ? void 0 : _a.method).toBe("DELETE");
            expect(call === null || call === void 0 ? void 0 : call[0]).toContain("/pools/p%2F1?");
            const headers = (_b = call === null || call === void 0 ? void 0 : call[1]) === null || _b === void 0 ? void 0 : _b.headers;
            expect(headers === null || headers === void 0 ? void 0 : headers.Authorization).toBe(`Bearer ${TOKEN}`);
        }));
        it("throws AzureRequestError on 429 with retry hint surfaced", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 429,
                    statusText: "Too Many Requests",
                    headers: { "retry-after": "30" },
                    body: {
                        error: {
                            code: "TooManyRequests",
                            message: { value: "slow down" },
                        },
                    },
                }),
            ]);
            try {
                yield batchService.deletePool(VALID_ENDPOINT, "p", TOKEN);
                fail("expected throw");
            }
            catch (e) {
                const err = e;
                expect(err.status).toBe(429);
                expect(err.code).toBe("TooManyRequests");
                // The base AzureRequestError marks 429 as retryable.
                expect(err.isRetryable).toBe(true);
            }
        }));
    });
    // -------------------------------------------------------------------------
    // listNodes
    // -------------------------------------------------------------------------
    describe("listNodes", () => {
        it("returns nodes for a pool", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b, _c;
            queueResponses([
                makeResponse({
                    status: 200,
                    body: {
                        value: [
                            { id: "node-1", state: "idle", schedulingState: "enabled" },
                            { id: "node-2", state: "running", schedulingState: "enabled" },
                        ],
                    },
                }),
            ]);
            const nodes = yield batchService.listNodes(VALID_ENDPOINT, "my-pool", TOKEN);
            expect(nodes).toHaveLength(2);
            expect((_a = nodes[0]) === null || _a === void 0 ? void 0 : _a.id).toBe("node-1");
            expect((_b = nodes[1]) === null || _b === void 0 ? void 0 : _b.schedulingState).toBe("enabled");
            const url = (_c = getFetchMock().mock.calls[0]) === null || _c === void 0 ? void 0 : _c[0];
            expect(url).toContain("/pools/my-pool/nodes?");
        }));
        it("throws AzureRequestError on 404 (pool removed mid-flight)", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 404,
                    body: {
                        error: { code: "PoolNotFound", message: "deleted" },
                    },
                }),
            ]);
            yield expect(batchService.listNodes(VALID_ENDPOINT, "gone", TOKEN)).rejects.toMatchObject({ status: 404 });
        }));
    });
    // -------------------------------------------------------------------------
    // performNodeAction (reboot / reimage / scheduling state)
    // -------------------------------------------------------------------------
    describe("performNodeAction", () => {
        const cases = [
            { action: "reboot", expectedSegment: "reboot" },
            { action: "reimage", expectedSegment: "reimage" },
            { action: "disableScheduling", expectedSegment: "disablescheduling" },
            { action: "enableScheduling", expectedSegment: "enablescheduling" },
        ];
        it.each(cases)("POSTs to the correct segment for action=%p", ({ action, expectedSegment }) => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            queueResponses([makeResponse({ status: 202, body: {} })]);
            yield batchService.performNodeAction(VALID_ENDPOINT, "pool-x", "node-y", action, TOKEN);
            const call = getFetchMock().mock.calls[0];
            expect((_a = call === null || call === void 0 ? void 0 : call[1]) === null || _a === void 0 ? void 0 : _a.method).toBe("POST");
            // URL must contain encoded poolId/nodeId and the mapped segment.
            expect(call === null || call === void 0 ? void 0 : call[0]).toContain(`/pools/pool-x/nodes/node-y/${expectedSegment}?`);
            // Body is `{}` per the implementation.
            expect((_b = call === null || call === void 0 ? void 0 : call[1]) === null || _b === void 0 ? void 0 : _b.body).toBe("{}");
        }));
        it("URI-encodes pool and node IDs containing special characters", () => __awaiter(void 0, void 0, void 0, function* () {
            var _c;
            queueResponses([makeResponse({ status: 202, body: {} })]);
            yield batchService.performNodeAction(VALID_ENDPOINT, "p/1", "n#2", "reboot", TOKEN);
            const url = (_c = getFetchMock().mock.calls[0]) === null || _c === void 0 ? void 0 : _c[0];
            expect(url).toContain("/pools/p%2F1/nodes/n%232/reboot?");
        }));
        it("throws AzureRequestError on 5xx (transient batch failure)", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 502,
                    body: { error: { code: "BadGateway", message: "upstream broke" } },
                }),
            ]);
            try {
                yield batchService.performNodeAction(VALID_ENDPOINT, "p", "n", "reimage", TOKEN);
                fail("expected throw");
            }
            catch (e) {
                const err = e;
                expect(err.status).toBe(502);
                // 5xx is retryable per AzureRequestError auto-classification.
                expect(err.isRetryable).toBe(true);
            }
        }));
    });
    // -------------------------------------------------------------------------
    // removeNodes (bulk node removal)
    // -------------------------------------------------------------------------
    describe("removeNodes", () => {
        it("POSTs nodeList JSON body to /removenodes", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            queueResponses([makeResponse({ status: 202, body: {} })]);
            yield batchService.removeNodes(VALID_ENDPOINT, "p/1", ["a", "b", "c"], TOKEN);
            const call = getFetchMock().mock.calls[0];
            expect((_a = call === null || call === void 0 ? void 0 : call[1]) === null || _a === void 0 ? void 0 : _a.method).toBe("POST");
            expect(call === null || call === void 0 ? void 0 : call[0]).toContain("/pools/p%2F1/removenodes?");
            expect((_b = call === null || call === void 0 ? void 0 : call[1]) === null || _b === void 0 ? void 0 : _b.body).toBe(JSON.stringify({ nodeList: ["a", "b", "c"] }));
        }));
        it("throws AzureRequestError on 403 (permission denied)", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 403,
                    body: {
                        error: {
                            code: "AuthorizationFailed",
                            message: { value: "no access" },
                        },
                    },
                }),
            ]);
            try {
                yield batchService.removeNodes(VALID_ENDPOINT, "p", ["x"], TOKEN);
                fail("expected throw");
            }
            catch (e) {
                const err = e;
                expect(err.status).toBe(403);
            }
        }));
    });
    // -------------------------------------------------------------------------
    // Error pathways covered via the toBatchError helper indirectly. These
    // tests verify the message-extraction branches survive the JSON parse
    // failure path (`response.json().catch(() => ({}))` in batch-service).
    // -------------------------------------------------------------------------
    describe("error body parsing", () => {
        it("recovers when error body is non-JSON", () => __awaiter(void 0, void 0, void 0, function* () {
            // `json()` rejects -> caught -> falls back to default message.
            const badResponse = makeResponse({
                status: 500,
                rawText: "<html>oops</html>",
            });
            // Override json() to reject so the catch path runs.
            badResponse.json = () => Promise.reject(new SyntaxError("Unexpected token <"));
            queueResponses([badResponse]);
            try {
                yield batchService.listPools(VALID_ENDPOINT, TOKEN);
                fail("expected throw");
            }
            catch (e) {
                const err = e;
                expect(err.status).toBe(500);
                // Default fallback message contains the status code.
                expect(err.message).toMatch(/500/);
            }
        }));
    });
});
//# sourceMappingURL=batch-service.test.js.map