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

import {
  __testing__,
  credentialVault,
  type CredentialEntry,
} from "../credential-vault";

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

const entryA: CredentialEntry = {
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
  it("round-trips put → get for a single account", async () => {
    await credentialVault.put(entryA);
    const got = await credentialVault.get(
      entryA.upn,
      entryA.tenantId,
      entryA.homeAccountId,
    );
    expect(got).not.toBeNull();
    expect(got?.password).toBe(entryA.password);
    expect(got?.displayName).toBe("Alex Doe");
    expect(got?.mustChangePassword).toBe(true);
  });

  it("list() requires homeAccountId; without it returns empty", async () => {
    await credentialVault.put(entryA);
    const empty = await credentialVault.list();
    expect(empty).toEqual([]);
  });

  it("list() filters by tenantId within an account", async () => {
    await credentialVault.put(entryA);
    await credentialVault.put({ ...entryA, upn: "bob@contoso.com" });
    await credentialVault.put({
      ...entryA,
      upn: "carol@fabrikam.com",
      tenantId: TENANT_B,
    });
    const tenantA = await credentialVault.list({
      homeAccountId: HOME_ID_A,
      tenantId: TENANT_A,
    });
    expect(tenantA).toHaveLength(2);
    const tenantB = await credentialVault.list({
      homeAccountId: HOME_ID_A,
      tenantId: TENANT_B,
    });
    expect(tenantB).toHaveLength(1);
    expect(tenantB[0]?.upn).toBe("carol@fabrikam.com");
  });

  it("does not leak entries across MSAL accounts", async () => {
    await credentialVault.put(entryA);
    // A different signed-in account would derive a different key, so
    // listing under HOME_ID_B yields nothing.
    const otherList = await credentialVault.list({ homeAccountId: HOME_ID_B });
    expect(otherList).toEqual([]);
    const otherGet = await credentialVault.get(
      entryA.upn,
      entryA.tenantId,
      HOME_ID_B,
    );
    expect(otherGet).toBeNull();
  });

  it("remove() drops a single entry", async () => {
    await credentialVault.put(entryA);
    await credentialVault.put({ ...entryA, upn: "kept@contoso.com" });
    await credentialVault.remove(entryA.upn, TENANT_A, HOME_ID_A);
    const list = await credentialVault.list({ homeAccountId: HOME_ID_A });
    expect(list).toHaveLength(1);
    expect(list[0]?.upn).toBe("kept@contoso.com");
  });

  it("touch() updates lastUsedAt without changing the password", async () => {
    await credentialVault.put(entryA);
    await credentialVault.touch(entryA.upn, TENANT_A, HOME_ID_A);
    const got = await credentialVault.get(
      entryA.upn,
      entryA.tenantId,
      entryA.homeAccountId,
    );
    expect(got?.password).toBe(entryA.password);
    expect(got?.lastUsedAt).toBeDefined();
  });

  it("clearAll() wipes the localStorage envelope", async () => {
    await credentialVault.put(entryA);
    expect(localStorage.getItem(__testing__.STORAGE_KEY)).not.toBeNull();
    credentialVault.clearAll();
    expect(localStorage.getItem(__testing__.STORAGE_KEY)).toBeNull();
  });

  it("payload at rest is opaque (no plaintext password)", async () => {
    await credentialVault.put(entryA);
    const raw = localStorage.getItem(__testing__.STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw!).not.toContain(entryA.password);
    expect(raw!).not.toContain(entryA.upn);
    // Envelope shape sanity-check
    const env = JSON.parse(raw!) as {
      version: number;
      saltB64: string;
      ivB64: string;
      ciphertextB64: string;
    };
    expect(env.version).toBe(1);
    expect(env.saltB64.length).toBeGreaterThan(0);
    expect(env.ivB64.length).toBeGreaterThan(0);
    expect(env.ciphertextB64.length).toBeGreaterThan(0);
  });
});
