/**
 * Targeted tests for foci-exchange.ts — covers the direct-then-proxy
 * fallback added in 2026-05-25 + the curated FOCI list invariants.
 *
 * foci-exchange.ts transitively imports msal-auth.ts (for
 * decodeJwtClaimsUnsafe), which imports @azure/msal-browser. The
 * redirect-bridge submodule is unresolvable under jest's resolver
 * (it ships only at build time via webpack alias), so we stub it.
 */
import { __awaiter } from "tslib";
// Mock the parent msal-auth module wholesale — foci-exchange only
// uses `decodeJwtClaimsUnsafe` from there, which we re-implement
// trivially in the mock. This is the same pattern the agents tests
// use to avoid pulling in the redirect-bridge package-subpath
// import that jest 27's resolver can't see (it ships only via
// package.json `exports`, which jest 27 ignores).
jest.mock("../msal-auth", () => ({
    __esModule: true,
    decodeJwtClaimsUnsafe(jwt) {
        try {
            const parts = jwt.split(".");
            if (parts.length < 2)
                return null;
            const payload = parts[1];
            const padded = payload.replace(/-/g, "+").replace(/_/g, "/") +
                "===".slice((payload.length + 3) % 4);
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const json = Buffer.from(padded, "base64").toString("utf-8");
            return JSON.parse(json);
        }
        catch (_a) {
            return null;
        }
    },
}));
import { exchangeRefreshTokenForClient, FOCI_CLIENTS } from "../foci-exchange";
describe("FOCI_CLIENTS list invariants", () => {
    it("contains no placeholder GUIDs (3e3e3e3e / 1234-5678 / all-1s / etc.)", () => {
        const placeholderPatterns = [
            /3e3e3e3e3e3e/i,
            /a3a3a3a3a3a3/i,
            /^11111111-2222-3333-4444-5+$/i,
            /1234-5678-90ab-cdef/i,
            /1c0e1c0e1c0e/i, // repeated 1c0e filler
        ];
        for (const c of FOCI_CLIENTS) {
            for (const p of placeholderPatterns) {
                expect(c.clientId).not.toMatch(p);
            }
        }
    });
    it("only marks Azure CLI / PowerShell / Office / Outlook-family GUIDs as FOCI=true with verifiable ids", () => {
        const ALLOWED_FOCI_IDS = new Set([
            "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
            "1950a258-227b-4e31-a9cf-717495945fc2",
            "c44b4083-3bb0-49c1-b47d-974e53cbdf3c",
            "872cd9fa-d31f-45e0-9eab-6e460a02d1f1",
            "aebc6443-996d-45c2-90f0-388ff96faa56",
            "1fec8e78-bce4-4aaf-ab1b-5451cc387264",
            "d3590ed6-52b3-4102-aeff-aad2292ab01c",
            "0ec893e0-5785-4de6-99da-4ed124e5296c",
            "00b41c95-dab0-4487-9791-b9d2c32c80f2",
            "27922004-5251-4030-b22d-91ecd9a37ea4",
            "5d661950-3475-41cd-a2c3-d671a3162bc1",
            "e9b154d0-7658-433b-bb25-6b8e0a8a7c59",
            "ab9b8c07-8f02-4f72-87fa-80105867a763",
            "b26aadf8-566f-4478-926f-589f601d9c74",
            "af124e86-4e96-495a-b70a-90f90ab96707",
            "d326c1ce-6cc6-4de2-bebc-4591e5e13ef0",
            "f05ff7c9-f75a-4acd-a3b5-f4b6a870245d",
            "4813382a-8fa7-425e-ab75-3b753aab3abb",
            "9ba1a5c7-f17a-4de9-a1f1-6178c8d51223",
            "eb539595-3fe1-474e-9c1d-feb3625d1be5",
            "a40d7d7d-59aa-447e-a655-679a4107e548",
            "26a7ee05-5602-4d76-a7ba-eae8b7b67941",
            "ecd6b820-32c2-49b6-98a6-444530e5a77a",
            "d7b530a4-7680-4c23-a8bf-c52c121d2e87",
            "e9c51622-460d-4d3d-952d-966a5b1da34c",
            "2d7f3606-b07d-41d1-b9d2-0d0c9296a6e8",
            "cf36b471-5b44-428c-9ce7-313bf84528de",
            "c0d2a505-13b8-4ae0-aa9e-cddd5eab0b12",
            "4e291c71-d680-4d0e-9640-0a3358e31177",
            "57fcbcfa-7cee-4eb1-8b25-12d2030b4ee0",
            "66375f6b-983f-4c2c-9701-d680650f588f",
            "22098786-6e16-43cc-a27d-191a01a1e3b5",
            "57336123-6e14-4acc-8dcf-287b6088aa28",
            "844cca35-0656-46ce-b636-13f48b0eecbd",
            "87749df4-7ccf-48f8-aa87-704bad0e0e16",
            "be1918be-3fe3-4be9-b32b-b542fc27f02e",
            "cab96880-db5b-4e15-90a7-f3f1d62ffe39",
            "dd47d17a-3194-4d86-bfd5-c6ae6f5651e3",
            "a569458c-7f2b-45cb-bab9-b7dee514d112",
            "14d82eec-204b-4c2f-b7e8-296a70dab67e", // Graph PowerShell
        ]);
        for (const c of FOCI_CLIENTS) {
            if (c.isFoci) {
                expect(ALLOWED_FOCI_IDS.has(c.clientId)).toBe(true);
            }
        }
    });
});
describe("exchangeRefreshTokenForClient direct-then-proxy fallback", () => {
    // Restore the global fetch between cases so the proxy-fallback test
    // doesn't leak its stub into the FOCI-invariant tests.
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
    it("falls back to /api/auth/proxy-token (with x-proxy-target) when direct AAD fetch throws", () => __awaiter(void 0, void 0, void 0, function* () {
        var _a, _b;
        const proxyCalls = [];
        global.fetch = jest.fn().mockImplementation((url, init) => __awaiter(void 0, void 0, void 0, function* () {
            if (url.includes("login.microsoftonline.com")) {
                throw new TypeError("Failed to fetch (CORS)");
            }
            if (url === "/api/auth/proxy-token") {
                proxyCalls.push({ url, init });
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => null },
                    json: () => __awaiter(void 0, void 0, void 0, function* () {
                        return ({
                            // valid-looking jwt header.payload.sig with empty claims {}
                            access_token: "eyJhbGciOiJub25lIn0.e30.",
                            expires_in: 3600,
                            scope: "https://management.azure.com/.default",
                        });
                    }),
                };
            }
            throw new Error(`unexpected URL ${url}`);
        }));
        const result = yield exchangeRefreshTokenForClient({
            refreshToken: "fake-rt",
            targetClientId: "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
            tenantId: "tenant-id",
            scope: "https://management.azure.com/.default",
            // intentionally omit fetchImpl so the production proxy path engages
        });
        expect(result.access_token).toContain("eyJ");
        expect(proxyCalls).toHaveLength(1);
        const headers = ((_b = (_a = proxyCalls[0].init) === null || _a === void 0 ? void 0 : _a.headers) !== null && _b !== void 0 ? _b : {});
        expect(headers["x-proxy-target"]).toMatch(/login\.microsoftonline\.com/);
        expect(headers["x-proxy-target"]).toMatch(/tenant-id/);
    }));
});
//# sourceMappingURL=foci-exchange.test.js.map