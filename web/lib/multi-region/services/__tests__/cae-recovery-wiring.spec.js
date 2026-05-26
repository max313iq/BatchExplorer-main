import { __awaiter } from "tslib";
/**
 * Wiring test: `guardedFetch` should call `tokenProvider(claims)` on a
 * CAE 401 and retry the request with the fresh bearer header.
 */
import { guardedFetch } from "../../scheduling/request-governance";
/**
 * Minimal fake Response. jsdom doesn't expose `Response`, and the unit
 * test only exercises `status` / `headers.get` / `clone().text()` /
 * `text()` / `json()` — stubbing those keeps the test deterministic
 * without pulling in a full polyfill.
 */
function fakeResponse(opts) {
    var _a, _b, _c;
    const headers = new Headers((_a = opts.headers) !== null && _a !== void 0 ? _a : {});
    const body = (_b = opts.body) !== null && _b !== void 0 ? _b : "";
    const url = (_c = opts.url) !== null && _c !== void 0 ? _c : "https://example.test/";
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
function b64UrlEncode(s) {
    return btoa(s).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
describe("guardedFetch + CAE recovery", () => {
    const origFetch = global.fetch;
    afterEach(() => {
        global.fetch = origFetch;
    });
    it("retries with claims-derived token when caller supplies tokenProvider", () => __awaiter(void 0, void 0, void 0, function* () {
        const challengeClaims = b64UrlEncode(JSON.stringify({ access_token: { acrs: { essential: true } } }));
        const wwwAuth = `Bearer authorization_uri="https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize", error="insufficient_claims", claims="${challengeClaims}"`;
        let calls = 0;
        const seen = [];
        global.fetch = jest.fn((_url, init) => __awaiter(void 0, void 0, void 0, function* () {
            calls++;
            const headers = new Headers(init === null || init === void 0 ? void 0 : init.headers);
            seen.push(headers.get("Authorization"));
            if (calls === 1) {
                return fakeResponse({
                    status: 401,
                    body: JSON.stringify({ error: { code: "401" } }),
                    headers: { "WWW-Authenticate": wwwAuth },
                });
            }
            return fakeResponse({
                status: 200,
                body: JSON.stringify({ ok: true }),
            });
        }));
        const tokenProvider = jest.fn((claims) => __awaiter(void 0, void 0, void 0, function* () {
            expect(typeof claims).toBe("string");
            expect((claims !== null && claims !== void 0 ? claims : "").length).toBeGreaterThan(0);
            return "fresh-token";
        }));
        const resp = yield guardedFetch("https://management.azure.com/subscriptions/test", {
            headers: { Authorization: "Bearer stale-token" },
        }, {
            subscriptionId: "sub-test",
            family: "arm",
            tokenProvider,
        });
        expect(resp.status).toBe(200);
        expect(calls).toBe(2);
        expect(tokenProvider).toHaveBeenCalledTimes(1);
        // First call used the stale token, retry used the fresh one.
        expect(seen[0]).toBe("Bearer stale-token");
        expect(seen[1]).toBe("Bearer fresh-token");
    }));
    it("bubbles 401 unchanged when no tokenProvider is supplied", () => __awaiter(void 0, void 0, void 0, function* () {
        global.fetch = jest.fn(() => __awaiter(void 0, void 0, void 0, function* () {
            return fakeResponse({
                status: 401,
                body: "{}",
                headers: {
                    "WWW-Authenticate": `Bearer claims="${b64UrlEncode("{}")}"`,
                },
            });
        }));
        const resp = yield guardedFetch("https://management.azure.com/foo", { headers: { Authorization: "Bearer x" } }, { subscriptionId: "sub-test", family: "arm" });
        expect(resp.status).toBe(401);
    }));
});
//# sourceMappingURL=cae-recovery-wiring.spec.js.map