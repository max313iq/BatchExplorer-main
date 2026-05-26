import { __awaiter } from "tslib";
/**
 * Tests for the encrypted credential vault used by the auto-portal-login
 * feature. Covers:
 *   - put/get round-trip across the AES-GCM envelope
 *   - list filters by homeAccountId + tenantId
 *   - remove + touch
 *   - clearAll wipes localStorage
 *   - opaque on-disk payload (no plaintext password leakage)
 *
 * jsdom doesn't ship Web Crypto subtle by default, so we polyfill it from
 * node:crypto.webcrypto for the duration of the test file.
 */
import { webcrypto } from "node:crypto";
import { __testing__, credentialVault, } from "../credential-vault";
beforeAll(() => {
    // Override the test-setup stub with the real Node webcrypto so AES-GCM and
    // PBKDF2 work. Defined as configurable so this assignment doesn't conflict
    // with the polyfill in src/__tests__/setup-tests.ts.
    Object.defineProperty(globalThis, "crypto", {
        value: webcrypto,
        configurable: true,
        writable: true,
    });
});
afterEach(() => {
    localStorage.removeItem(__testing__.STORAGE_KEY);
});
const HOME_ID_A = "home-account-A";
const HOME_ID_B = "home-account-B";
const TENANT_A = "00000000-0000-0000-0000-aaaaaaaaaaaa";
const TENANT_B = "00000000-0000-0000-0000-bbbbbbbbbbbb";
const entryA = {
    upn: "alex@contoso.com",
    password: "P@ssw0rd-Alex-1234",
    tenantId: TENANT_A,
    homeAccountId: HOME_ID_A,
    displayName: "Alex Doe",
    createdAt: "2026-05-01T00:00:00.000Z",
    source: "create",
    mustChangePassword: true,
};
describe("credentialVault", () => {
    it("round-trips put → get for a single account", () => __awaiter(void 0, void 0, void 0, function* () {
        yield credentialVault.put(entryA);
        const got = yield credentialVault.get(entryA.upn, entryA.tenantId, entryA.homeAccountId);
        expect(got).not.toBeNull();
        expect(got === null || got === void 0 ? void 0 : got.password).toBe(entryA.password);
        expect(got === null || got === void 0 ? void 0 : got.displayName).toBe("Alex Doe");
        expect(got === null || got === void 0 ? void 0 : got.mustChangePassword).toBe(true);
    }));
    it("list() requires homeAccountId; without it returns empty", () => __awaiter(void 0, void 0, void 0, function* () {
        yield credentialVault.put(entryA);
        const empty = yield credentialVault.list();
        expect(empty).toEqual([]);
    }));
    it("list() filters by tenantId within an account", () => __awaiter(void 0, void 0, void 0, function* () {
        var _a;
        yield credentialVault.put(entryA);
        yield credentialVault.put(Object.assign(Object.assign({}, entryA), { upn: "bob@contoso.com" }));
        yield credentialVault.put(Object.assign(Object.assign({}, entryA), { upn: "carol@fabrikam.com", tenantId: TENANT_B }));
        const tenantA = yield credentialVault.list({
            homeAccountId: HOME_ID_A,
            tenantId: TENANT_A,
        });
        expect(tenantA).toHaveLength(2);
        const tenantB = yield credentialVault.list({
            homeAccountId: HOME_ID_A,
            tenantId: TENANT_B,
        });
        expect(tenantB).toHaveLength(1);
        expect((_a = tenantB[0]) === null || _a === void 0 ? void 0 : _a.upn).toBe("carol@fabrikam.com");
    }));
    it("does not leak entries across MSAL accounts", () => __awaiter(void 0, void 0, void 0, function* () {
        yield credentialVault.put(entryA);
        // A different signed-in account would derive a different key, so
        // listing under HOME_ID_B yields nothing.
        const otherList = yield credentialVault.list({ homeAccountId: HOME_ID_B });
        expect(otherList).toEqual([]);
        const otherGet = yield credentialVault.get(entryA.upn, entryA.tenantId, HOME_ID_B);
        expect(otherGet).toBeNull();
    }));
    it("remove() drops a single entry", () => __awaiter(void 0, void 0, void 0, function* () {
        var _b;
        yield credentialVault.put(entryA);
        yield credentialVault.put(Object.assign(Object.assign({}, entryA), { upn: "kept@contoso.com" }));
        yield credentialVault.remove(entryA.upn, TENANT_A, HOME_ID_A);
        const list = yield credentialVault.list({ homeAccountId: HOME_ID_A });
        expect(list).toHaveLength(1);
        expect((_b = list[0]) === null || _b === void 0 ? void 0 : _b.upn).toBe("kept@contoso.com");
    }));
    it("touch() updates lastUsedAt without changing the password", () => __awaiter(void 0, void 0, void 0, function* () {
        yield credentialVault.put(entryA);
        yield credentialVault.touch(entryA.upn, TENANT_A, HOME_ID_A);
        const got = yield credentialVault.get(entryA.upn, entryA.tenantId, entryA.homeAccountId);
        expect(got === null || got === void 0 ? void 0 : got.password).toBe(entryA.password);
        expect(got === null || got === void 0 ? void 0 : got.lastUsedAt).toBeDefined();
    }));
    it("clearAll() wipes the localStorage envelope", () => __awaiter(void 0, void 0, void 0, function* () {
        yield credentialVault.put(entryA);
        expect(localStorage.getItem(__testing__.STORAGE_KEY)).not.toBeNull();
        credentialVault.clearAll();
        expect(localStorage.getItem(__testing__.STORAGE_KEY)).toBeNull();
    }));
    it("payload at rest is opaque (no plaintext password)", () => __awaiter(void 0, void 0, void 0, function* () {
        yield credentialVault.put(entryA);
        const raw = localStorage.getItem(__testing__.STORAGE_KEY);
        expect(raw).not.toBeNull();
        expect(raw).not.toContain(entryA.password);
        expect(raw).not.toContain(entryA.upn);
        // Envelope shape sanity-check
        const env = JSON.parse(raw);
        expect(env.version).toBe(1);
        expect(env.saltB64.length).toBeGreaterThan(0);
        expect(env.ivB64.length).toBeGreaterThan(0);
        expect(env.ciphertextB64.length).toBeGreaterThan(0);
    }));
});
//# sourceMappingURL=credential-vault.test.js.map