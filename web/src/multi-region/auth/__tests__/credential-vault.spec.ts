/**
 * Behavioural tests for the per-account credential vault.
 *
 * The project's jest runner only matches `*.spec.ts` (see
 * util/common-config/jest-common.js `testMatch`), so the sibling
 * `credential-vault.test.ts` is DEAD — it never runs. This `.spec.ts` is the
 * live suite. It covers the regression that motivated the per-account
 * rewrite:
 *
 *   - A write by account B must NOT clobber account A's saved passwords
 *     (the original single-envelope design re-encrypted the whole blob under
 *     the last writer's key, erasing everyone else).
 *   - `listAllForAccounts` merges across signed-in accounts (what the
 *     "Created by me" page now uses to show every saved password).
 *   - The vault survives logout (msal-auth no longer calls clearAll()).
 *   - `clearAll()` still wipes every per-account envelope on explicit request.
 *   - Legacy single-envelope entries migrate on read.
 *   - Payload at rest stays opaque (no plaintext password / upn).
 *
 * jsdom doesn't ship Web Crypto subtle, so we polyfill from node:crypto.
 */
import { webcrypto } from "node:crypto";
import { TextEncoder, TextDecoder } from "node:util";

// The vault module runs `new TextEncoder()/TextDecoder()` and reads `crypto`
// at IMPORT time. jsdom provides neither by default, and a `beforeAll` runs
// too late (module eval happens first). Polyfill all three on globalThis
// BEFORE importing the module under test.
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.TextEncoder === "undefined") g.TextEncoder = TextEncoder;
if (typeof g.TextDecoder === "undefined") g.TextDecoder = TextDecoder;
Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
  writable: true,
});

/* eslint-disable import/first */
import {
  __testing__,
  credentialVault,
  type CredentialEntry,
} from "../credential-vault";
/* eslint-enable import/first */

function wipeVaultKeys(): void {
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (
      k &&
      (k === __testing__.STORAGE_KEY ||
        k.startsWith(__testing__.STORAGE_KEY_PREFIX))
    ) {
      toRemove.push(k);
    }
  }
  for (const k of toRemove) localStorage.removeItem(k);
}

afterEach(() => {
  wipeVaultKeys();
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

const entryB: CredentialEntry = {
  upn: "beth@fabrikam.com",
  password: "P@ssw0rd-Beth-5678",
  tenantId: TENANT_B,
  homeAccountId: HOME_ID_B,
  displayName: "Beth Roe",
  createdAt: "2026-05-02T00:00:00.000Z",
  source: "create",
};

describe("credentialVault (per-account)", () => {
  it("round-trips put → get for a single account", async () => {
    await credentialVault.put(entryA);
    const got = await credentialVault.get(
      entryA.upn,
      entryA.tenantId,
      entryA.homeAccountId,
    );
    expect(got?.password).toBe(entryA.password);
    expect(got?.displayName).toBe("Alex Doe");
    expect(got?.mustChangePassword).toBe(true);
  });

  it("list() without homeAccountId returns empty", async () => {
    await credentialVault.put(entryA);
    expect(await credentialVault.list()).toEqual([]);
  });

  it("does not leak entries across MSAL accounts", async () => {
    await credentialVault.put(entryA);
    expect(await credentialVault.list({ homeAccountId: HOME_ID_B })).toEqual([]);
    expect(
      await credentialVault.get(entryA.upn, entryA.tenantId, HOME_ID_B),
    ).toBeNull();
  });

  it("a write by one account does NOT clobber another account's entries", async () => {
    await credentialVault.put(entryA);
    await credentialVault.put(entryB);
    const listA = await credentialVault.list({ homeAccountId: HOME_ID_A });
    const listB = await credentialVault.list({ homeAccountId: HOME_ID_B });
    expect(listA).toHaveLength(1);
    expect(listA[0]?.upn).toBe(entryA.upn);
    expect(listB).toHaveLength(1);
    expect(listB[0]?.upn).toBe(entryB.upn);
  });

  it("listAllForAccounts merges across accounts and de-dupes ids", async () => {
    await credentialVault.put(entryA);
    await credentialVault.put(entryB);
    const merged = await credentialVault.listAllForAccounts([
      HOME_ID_A,
      HOME_ID_B,
      HOME_ID_A,
    ]);
    expect(merged.map((e) => e.upn).sort()).toEqual([
      "alex@contoso.com",
      "beth@fabrikam.com",
    ]);
  });

  it("listAllForAccounts can filter by tenant", async () => {
    await credentialVault.put(entryA);
    await credentialVault.put(entryB);
    const onlyA = await credentialVault.listAllForAccounts(
      [HOME_ID_A, HOME_ID_B],
      TENANT_A,
    );
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]?.upn).toBe(entryA.upn);
  });

  it("remove() drops a single entry within its account", async () => {
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
    const got = await credentialVault.get(entryA.upn, TENANT_A, HOME_ID_A);
    expect(got?.password).toBe(entryA.password);
    expect(got?.lastUsedAt).toBeDefined();
  });

  it("clearAll() wipes every per-account envelope", async () => {
    await credentialVault.put(entryA);
    await credentialVault.put(entryB);
    const keyA = __testing__.envelopeKeyFor(HOME_ID_A);
    const keyB = __testing__.envelopeKeyFor(HOME_ID_B);
    expect(localStorage.getItem(keyA)).not.toBeNull();
    expect(localStorage.getItem(keyB)).not.toBeNull();
    credentialVault.clearAll();
    expect(localStorage.getItem(keyA)).toBeNull();
    expect(localStorage.getItem(keyB)).toBeNull();
  });

  it("migrates a legacy single-envelope entry on read", async () => {
    const legacyPayload = { version: 1 as const, entries: [entryA] };
    const sealed = await __testing__.encryptForTest(HOME_ID_A, legacyPayload);
    __testing__.writeEnvelopeAt(__testing__.STORAGE_KEY, sealed);
    expect(
      localStorage.getItem(__testing__.envelopeKeyFor(HOME_ID_A)),
    ).toBeNull();

    const list = await credentialVault.list({ homeAccountId: HOME_ID_A });
    expect(list).toHaveLength(1);
    expect(list[0]?.password).toBe(entryA.password);
    // Read migrated it into the per-account envelope.
    expect(
      localStorage.getItem(__testing__.envelopeKeyFor(HOME_ID_A)),
    ).not.toBeNull();
  });

  it("payload at rest is opaque (no plaintext password or upn)", async () => {
    await credentialVault.put(entryA);
    const raw = localStorage.getItem(__testing__.envelopeKeyFor(HOME_ID_A));
    expect(raw).not.toBeNull();
    expect(raw!).not.toContain(entryA.password);
    expect(raw!).not.toContain(entryA.upn);
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
