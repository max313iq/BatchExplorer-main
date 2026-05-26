/**
 * Targeted tests for the device-code flow tightening done in 2026-05-25:
 *   - tenant-mismatch on the polled token's `tid` claim
 *   - `interaction_required` is treated as terminal, not "keep polling"
 *
 * device-code-login.ts transitively imports msal-auth.ts (for
 * decodeJwtClaimsUnsafe), which imports @azure/msal-browser. The
 * redirect-bridge submodule is unresolvable under jest's resolver
 * (it ships only at build time via webpack alias), so we stub it.
 */
import { __awaiter } from "tslib";
// Mock the parent msal-auth module wholesale — device-code-login only
// uses `decodeJwtClaimsUnsafe` from there. Avoids the redirect-bridge
// resolver issue under jest 27 (see foci-exchange.test.ts for context).
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
            const json = Buffer.from(padded, "base64").toString("utf-8");
            return JSON.parse(json);
        }
        catch (_a) {
            return null;
        }
    },
}));
import { pollDeviceCodeFlow, DeviceCodeError, } from "../device-code-login";
// Helper: build a JWT with a given `tid` claim. Header / signature
// are irrelevant — the prod code uses decodeJwtClaimsUnsafe (base64-
// decode-only).
function makeJwtWithTid(tid) {
    const header = Buffer.from(JSON.stringify({ alg: "none" }))
        .toString("base64url")
        .replace(/=+$/, "");
    const payload = Buffer.from(JSON.stringify({ tid, oid: "object-id", aud: "test" }))
        .toString("base64url")
        .replace(/=+$/, "");
    return `${header}.${payload}.`;
}
describe("pollDeviceCodeFlow tenant binding", () => {
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
    function buildChallenge(tenant) {
        return {
            user_code: "ABCD-WXYZ",
            verification_uri: "https://microsoft.com/devicelogin",
            device_code: "device-code-blob",
            expires_at: Date.now() + 5 * 60 * 1000,
            interval: 1,
            tenant,
            client_id: "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
        };
    }
    it("rejects when the polled token tid does not match the requested tenant", () => __awaiter(void 0, void 0, void 0, function* () {
        const challenge = buildChallenge("tenant-requested");
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: () => __awaiter(void 0, void 0, void 0, function* () {
                return ({
                    access_token: makeJwtWithTid("tenant-OTHER"),
                    expires_in: 3600,
                    scope: "https://management.azure.com/.default",
                });
            }),
        });
        yield expect(pollDeviceCodeFlow(challenge, { sleepFn: () => __awaiter(void 0, void 0, void 0, function* () { return undefined; }) })).rejects.toMatchObject({
            name: "DeviceCodeError",
            code: "tenant_mismatch",
        });
    }));
    it("accepts when tid matches the requested tenant", () => __awaiter(void 0, void 0, void 0, function* () {
        const challenge = buildChallenge("tenant-good");
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: () => __awaiter(void 0, void 0, void 0, function* () {
                return ({
                    access_token: makeJwtWithTid("tenant-good"),
                    expires_in: 3600,
                    scope: "scope",
                });
            }),
        });
        const result = yield pollDeviceCodeFlow(challenge, {
            sleepFn: () => __awaiter(void 0, void 0, void 0, function* () { return undefined; }),
        });
        expect(result.access_token).toContain("eyJ");
    }));
    it("treats 'common' / 'organizations' / 'consumers' as meta-tenants (no tid match required)", () => __awaiter(void 0, void 0, void 0, function* () {
        const challenge = buildChallenge("common");
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: () => __awaiter(void 0, void 0, void 0, function* () {
                return ({
                    access_token: makeJwtWithTid("some-real-guid"),
                    expires_in: 3600,
                    scope: "scope",
                });
            }),
        });
        const result = yield pollDeviceCodeFlow(challenge, {
            sleepFn: () => __awaiter(void 0, void 0, void 0, function* () { return undefined; }),
        });
        expect(result.access_token).toContain("eyJ");
    }));
});
describe("pollDeviceCodeFlow interaction_required terminal handling", () => {
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
    it("throws DeviceCodeError('interaction_required') instead of polling forever", () => __awaiter(void 0, void 0, void 0, function* () {
        const challenge = {
            user_code: "X",
            verification_uri: "https://microsoft.com/devicelogin",
            device_code: "dc",
            expires_at: Date.now() + 60000,
            interval: 1,
            tenant: "common",
            client_id: "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
        };
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 400,
            headers: { get: () => null },
            json: () => __awaiter(void 0, void 0, void 0, function* () {
                return ({
                    error: "interaction_required",
                    error_description: "AADSTS50076: MFA required",
                });
            }),
        });
        yield expect(pollDeviceCodeFlow(challenge, { sleepFn: () => __awaiter(void 0, void 0, void 0, function* () { return undefined; }) })).rejects.toMatchObject({
            name: "DeviceCodeError",
            code: "interaction_required",
        });
    }));
});
// Smoke check for the imported `DeviceCodeError` class to keep TS
// from complaining about the unused-import lint.
test("DeviceCodeError is constructable", () => {
    const e = new DeviceCodeError("x", "y");
    expect(e.code).toBe("x");
    expect(e.message).toBe("y");
});
//# sourceMappingURL=device-code-login.test.js.map