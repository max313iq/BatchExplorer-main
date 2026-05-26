/**
 * Tests for the imported-tokens module — specifically the
 * proxy-fallback path of `redeemRefreshToken` and the
 * `parseRetryAfterHeader` helper. Both were tightened in the
 * 2026-05-25 auth-pod pass.
 */
import { __awaiter } from "tslib";
/* eslint-disable @typescript-eslint/no-require-imports */
import { parseRetryAfterHeader, ImportedTokenError } from "../imported-tokens";
describe("parseRetryAfterHeader", () => {
    it("returns null for missing / empty input", () => {
        expect(parseRetryAfterHeader(null)).toBeNull();
        expect(parseRetryAfterHeader("")).toBeNull();
        expect(parseRetryAfterHeader("   ")).toBeNull();
    });
    it("parses an integer seconds form to milliseconds", () => {
        expect(parseRetryAfterHeader("30")).toBe(30000);
        expect(parseRetryAfterHeader("0")).toBe(0);
        expect(parseRetryAfterHeader("2.5")).toBe(2500);
    });
    it("parses an HTTP-date form to a positive delta", () => {
        const future = new Date(Date.now() + 5000).toUTCString();
        const ms = parseRetryAfterHeader(future);
        expect(ms).not.toBeNull();
        expect(ms).toBeGreaterThan(2000);
        expect(ms).toBeLessThan(8000);
    });
    it("returns null for non-numeric, non-date input", () => {
        expect(parseRetryAfterHeader("soonish")).toBeNull();
    });
});
describe("redeemRefreshToken proxy fallback", () => {
    // ALWAYS register the redeemRefreshToken function fresh so the
    // mock fetch state doesn't leak between cases.
    let originalFetch;
    beforeEach(() => {
        originalFetch = global.fetch;
    });
    afterEach(() => {
        if (originalFetch)
            global.fetch = originalFetch;
        else
            delete global.fetch;
    });
    it("includes x-proxy-target header when falling back to /api/auth/proxy-token", () => __awaiter(void 0, void 0, void 0, function* () {
        var _a, _b;
        const calls = [];
        global.fetch = jest.fn().mockImplementation((url, init) => __awaiter(void 0, void 0, void 0, function* () {
            calls.push({ url, init });
            if (typeof url === "string" && url.includes("login.microsoftonline.com")) {
                // Simulate CORS failure on direct AAD POST.
                throw new TypeError("Failed to fetch");
            }
            if (typeof url === "string" && url === "/api/auth/proxy-token") {
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => null },
                    json: () => __awaiter(void 0, void 0, void 0, function* () {
                        return ({
                            access_token: "proxied-arm-token",
                            expires_in: 3600,
                        });
                    }),
                };
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
        }));
        const { redeemRefreshToken } = require("../imported-tokens");
        const result = yield redeemRefreshToken("fake-rt", "04b07795-8ddb-461a-bbee-02f9e1bf7b46", "tenant-id", "https://management.azure.com/.default");
        expect(result.access_token).toBe("proxied-arm-token");
        // Find the proxy call.
        const proxyCall = calls.find((c) => c.url === "/api/auth/proxy-token");
        expect(proxyCall).toBeDefined();
        const headers = ((_b = (_a = proxyCall.init) === null || _a === void 0 ? void 0 : _a.headers) !== null && _b !== void 0 ? _b : {});
        // Header MUST point at AAD's login.microsoftonline.com endpoint.
        expect(headers["x-proxy-target"]).toMatch(/login\.microsoftonline\.com/);
        expect(headers["x-proxy-target"]).toMatch(/oauth2\/v2\.0\/token/);
    }));
    it("propagates the 429 + Retry-After as a typed ImportedTokenError", () => __awaiter(void 0, void 0, void 0, function* () {
        global.fetch = jest.fn().mockImplementation(() => __awaiter(void 0, void 0, void 0, function* () {
            return {
                ok: false,
                status: 429,
                headers: {
                    get: (name) => name.toLowerCase() === "retry-after" ? "10" : null,
                },
                json: () => __awaiter(void 0, void 0, void 0, function* () { return ({ error: "throttled" }); }),
            };
        }));
        const { redeemRefreshToken } = require("../imported-tokens");
        yield expect(redeemRefreshToken("fake-rt", "04b07795-8ddb-461a-bbee-02f9e1bf7b46", "tenant", "https://management.azure.com/.default")).rejects.toMatchObject({
            name: "ImportedTokenError",
            code: "rate_limited",
            httpStatus: 429,
            retryAfterMs: 10000,
        });
    }));
    it("throws retry_after_exceeded when Retry-After is > 60s", () => __awaiter(void 0, void 0, void 0, function* () {
        global.fetch = jest.fn().mockImplementation(() => __awaiter(void 0, void 0, void 0, function* () {
            return {
                ok: false,
                status: 429,
                headers: {
                    get: (name) => name.toLowerCase() === "retry-after" ? "300" : null,
                },
                json: () => __awaiter(void 0, void 0, void 0, function* () { return ({ error: "throttled" }); }),
            };
        }));
        const { redeemRefreshToken } = require("../imported-tokens");
        yield expect(redeemRefreshToken("rt", "client", "tenant", "scope")).rejects.toMatchObject({
            name: "ImportedTokenError",
            code: "retry_after_exceeded",
        });
    }));
});
describe("ImportedTokenError", () => {
    it("carries code / body / httpStatus and preserves message on .message", () => {
        const err = new ImportedTokenError("invalid_grant", "AAD says no.", { error: "invalid_grant", error_description: "expired RT" }, 400);
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe("ImportedTokenError");
        expect(err.message).toBe("AAD says no.");
        expect(err.code).toBe("invalid_grant");
        expect(err.httpStatus).toBe(400);
        expect(err.body.error_description).toBe("expired RT");
    });
});
//# sourceMappingURL=imported-tokens.test.js.map