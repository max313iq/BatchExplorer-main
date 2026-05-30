/**
 * Credential vault for the auto-portal-login feature.
 *
 * Captures every credential the app mints (create-user / reset-password)
 * and stores it AES-GCM-encrypted in localStorage so the user can re-launch
 * an Azure portal sign-in for any provisioned account on demand.
 *
 * Storage model — PER-ACCOUNT envelopes (v1):
 *   key   = `azbm:credential-vault:v1:<homeAccountId>`
 *   value = { version, saltB64, ivB64, ciphertextB64 }  (one VaultEnvelope)
 *
 *   Each signed-in MSAL account gets its OWN encrypted envelope, keyed by
 *   homeAccountId and encrypted under a key derived from that same
 *   homeAccountId. This is a deliberate change from the original
 *   single-envelope design (`azbm:credential-vault:v1`, no suffix), where a
 *   write by account B re-encrypted the whole blob under B's key and so
 *   CLOBBERED account A's entries — only the last writer's credentials ever
 *   survived. Per-account envelopes let multiple accounts' credentials
 *   coexist, which is what the "Created by me" page needs to surface every
 *   saved password regardless of which account minted it.
 *
 * Migration:
 *   The legacy single-envelope key is read-only now. `loadPayloadForAccount`
 *   migrates on read: if an account has no per-account envelope yet but the
 *   legacy envelope decrypts under that account's key, its entries are copied
 *   into the per-account key. The legacy key is left in place so a different
 *   account can still migrate its own slice out of it; stale legacy data is
 *   harmless once every account has migrated.
 *
 * Encryption key: derived per-MSAL-account via PBKDF2 from
 *   `${homeAccountId}|${window.location.origin}`. The signed-in user is
 *   already authenticated; we treat the homeAccountId as a per-user salt so
 *   one signed-in account can't decrypt another's vault entries.
 *
 * Lifecycle: the vault deliberately SURVIVES logout. Sign-out clears the
 * MSAL token cache (see msal-auth.logout / logoutAccount, which explicitly
 * skip `azbm:credential-vault:` keys) but leaves saved passwords intact so
 * an operator who signs back in still sees what they created. `clearAll()`
 * remains available for an explicit, user-initiated wipe.
 */

// AUDIT-LOG BINDING. Vault put / remove events surface through the
// shared audit-binding so the services-layer audit-log can record them
// without us pulling that module in here. See `auth/audit-binding.ts`.
import { recordAuditEvent } from "./audit-binding";

/** Legacy single-envelope key (read-only; migrate-on-read source). */
const STORAGE_KEY = "azbm:credential-vault:v1";
/** Per-account envelope key prefix; full key = PREFIX + homeAccountId. */
const STORAGE_KEY_PREFIX = "azbm:credential-vault:v1:";
const PBKDF2_ITERATIONS = 250_000;
const PBKDF2_SALT_BYTES = 16;
const AES_IV_BYTES = 12;
const VAULT_VERSION = 1;

export type CredentialSource = "create" | "reset";

export interface CredentialEntry {
  upn: string;
  password: string;
  tenantId: string;
  homeAccountId: string;
  displayName?: string;
  createdAt: string; // ISO
  lastUsedAt?: string; // ISO
  source: CredentialSource;
  /** Was the user told to change-password-next-sign-in? Drives autopilot. */
  mustChangePassword?: boolean;
}

interface VaultEnvelope {
  version: number;
  saltB64: string;
  ivB64: string;
  ciphertextB64: string;
}

interface VaultPayload {
  version: 1;
  entries: CredentialEntry[];
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function isCryptoAvailable(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function passphraseFor(homeAccountId: string): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "ssr";
  return `${homeAccountId}|${origin}`;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Full localStorage key for an account's per-account envelope. */
function envelopeKeyFor(homeAccountId: string): string {
  return `${STORAGE_KEY_PREFIX}${homeAccountId}`;
}

function readEnvelopeAt(storageKey: string): VaultEnvelope | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(storageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as VaultEnvelope;
    if (
      typeof parsed?.version !== "number" ||
      typeof parsed?.saltB64 !== "string" ||
      typeof parsed?.ivB64 !== "string" ||
      typeof parsed?.ciphertextB64 !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeEnvelopeAt(storageKey: string, env: VaultEnvelope): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(storageKey, JSON.stringify(env));
}

/** Legacy single-envelope reader, retained for migration + tests. */
function readEnvelope(): VaultEnvelope | null {
  return readEnvelopeAt(STORAGE_KEY);
}

function writeEnvelope(env: VaultEnvelope): void {
  writeEnvelopeAt(STORAGE_KEY, env);
}

async function decryptVault(
  homeAccountId: string,
  env: VaultEnvelope,
): Promise<VaultPayload | null> {
  if (!isCryptoAvailable()) return null;
  try {
    const salt = base64ToBytes(env.saltB64);
    const iv = base64ToBytes(env.ivB64);
    const key = await deriveKey(passphraseFor(homeAccountId), salt);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      base64ToBytes(env.ciphertextB64),
    );
    const json = textDecoder.decode(plain);
    const payload = JSON.parse(json) as VaultPayload;
    if (payload?.version !== VAULT_VERSION || !Array.isArray(payload.entries)) {
      return null;
    }
    return payload;
  } catch {
    // Wrong key / corrupted / different MSAL account — treat as empty so a
    // signed-in user never sees another user's data.
    return null;
  }
}

async function encryptVault(
  homeAccountId: string,
  payload: VaultPayload,
): Promise<VaultEnvelope> {
  if (!isCryptoAvailable()) {
    throw new Error("Web Crypto unavailable; cannot encrypt credential vault.");
  }
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
  const key = await deriveKey(passphraseFor(homeAccountId), salt);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(JSON.stringify(payload)),
  );
  return {
    version: VAULT_VERSION,
    saltB64: bytesToBase64(salt),
    ivB64: bytesToBase64(iv),
    ciphertextB64: bytesToBase64(new Uint8Array(cipher)),
  };
}

/**
 * Decrypt an account's full credential payload, preferring the per-account
 * envelope and migrating on read from the legacy single envelope when the
 * per-account one is absent. Returns null when the account has no readable
 * entries (no envelope, wrong key, or crypto unavailable).
 */
async function loadPayloadForAccount(
  homeAccountId: string,
): Promise<VaultPayload | null> {
  // Preferred: the account's own envelope.
  const perAccount = readEnvelopeAt(envelopeKeyFor(homeAccountId));
  if (perAccount) {
    const decoded = await decryptVault(homeAccountId, perAccount);
    if (decoded) return decoded;
  }
  // Migrate-on-read: the legacy single envelope held one account's entries
  // (encrypted under the last writer's key). If it decrypts under THIS
  // account, copy those entries into the per-account key so future writes
  // by other accounts can't clobber them.
  const legacy = readEnvelopeAt(STORAGE_KEY);
  if (legacy) {
    const decoded = await decryptVault(homeAccountId, legacy);
    if (decoded) {
      try {
        const sealed = await encryptVault(homeAccountId, decoded);
        writeEnvelopeAt(envelopeKeyFor(homeAccountId), sealed);
      } catch {
        /* best-effort migration — fall through with the decoded payload */
      }
      return decoded;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CredentialVaultListFilter {
  homeAccountId?: string;
  tenantId?: string;
}

export interface CredentialVault {
  put(entry: CredentialEntry): Promise<void>;
  get(
    upn: string,
    tenantId: string,
    homeAccountId: string,
  ): Promise<CredentialEntry | null>;
  list(filter?: CredentialVaultListFilter): Promise<CredentialEntry[]>;
  /**
   * List credentials across MANY signed-in accounts at once, merged into a
   * single array. Used by the "Created by me" page so the operator sees every
   * saved password regardless of which account created it. Order follows
   * `homeAccountIds`; duplicate ids are de-duplicated.
   */
  listAllForAccounts(
    homeAccountIds: string[],
    tenantId?: string,
  ): Promise<CredentialEntry[]>;
  remove(
    upn: string,
    tenantId: string,
    homeAccountId: string,
  ): Promise<void>;
  touch(
    upn: string,
    tenantId: string,
    homeAccountId: string,
  ): Promise<void>;
  clearAll(): void;
}

class LocalCredentialVault implements CredentialVault {
  /**
   * Each entry lives in the writing account's own per-account envelope, so a
   * write by one signed-in account never disturbs another's saved credentials.
   */
  async put(entry: CredentialEntry): Promise<void> {
    if (!entry?.homeAccountId || !entry.upn || !entry.tenantId) return;
    const existing = (await loadPayloadForAccount(entry.homeAccountId)) ?? {
      version: VAULT_VERSION as 1,
      entries: [] as CredentialEntry[],
    };
    // Replace any prior entry for the same upn+tenant within this account.
    const next: VaultPayload = {
      version: VAULT_VERSION,
      entries: [
        ...existing.entries.filter(
          (e) =>
            !(
              e.upn === entry.upn &&
              e.tenantId === entry.tenantId &&
              e.homeAccountId === entry.homeAccountId
            ),
        ),
        entry,
      ],
    };
    const sealed = await encryptVault(entry.homeAccountId, next);
    writeEnvelopeAt(envelopeKeyFor(entry.homeAccountId), sealed);
    // NEVER include the password / decrypted body — only enough
    // identifying metadata for the operator to correlate the audit
    // entry with the action that produced it.
    recordAuditEvent({
      actor: entry.upn,
      action: "credentialVault.put",
      target: entry.upn,
      status: "success",
      details: {
        tenantId: entry.tenantId,
        homeAccountId: entry.homeAccountId,
        source: entry.source,
        mustChangePassword: entry.mustChangePassword === true,
      },
    });
  }

  async get(
    upn: string,
    tenantId: string,
    homeAccountId: string,
  ): Promise<CredentialEntry | null> {
    const all = await this.list({ homeAccountId, tenantId });
    return all.find((e) => e.upn === upn) ?? null;
  }

  async list(filter?: CredentialVaultListFilter): Promise<CredentialEntry[]> {
    // We need a homeAccountId to decrypt. Callers that want every account's
    // entries use `listAllForAccounts`; a bare list() with no account returns
    // [] (we can't enumerate accounts here without a circular import — pages
    // always know their signed-in accounts).
    if (!filter?.homeAccountId) return [];
    const payload = await loadPayloadForAccount(filter.homeAccountId);
    if (!payload) return [];
    return payload.entries.filter((e) => {
      if (filter.tenantId && e.tenantId !== filter.tenantId) return false;
      if (filter.homeAccountId && e.homeAccountId !== filter.homeAccountId)
        return false;
      return true;
    });
  }

  async listAllForAccounts(
    homeAccountIds: string[],
    tenantId?: string,
  ): Promise<CredentialEntry[]> {
    const seen = new Set<string>();
    const out: CredentialEntry[] = [];
    for (const id of homeAccountIds) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const payload = await loadPayloadForAccount(id);
      if (!payload) continue;
      for (const e of payload.entries) {
        if (tenantId && e.tenantId !== tenantId) continue;
        // Guard against a corrupted envelope leaking another account's id.
        if (e.homeAccountId !== id) continue;
        out.push(e);
      }
    }
    return out;
  }

  async remove(
    upn: string,
    tenantId: string,
    homeAccountId: string,
  ): Promise<void> {
    const payload = await loadPayloadForAccount(homeAccountId);
    if (!payload) return;
    const next: VaultPayload = {
      version: VAULT_VERSION,
      entries: payload.entries.filter(
        (e) =>
          !(
            e.upn === upn &&
            e.tenantId === tenantId &&
            e.homeAccountId === homeAccountId
          ),
      ),
    };
    const sealed = await encryptVault(homeAccountId, next);
    writeEnvelopeAt(envelopeKeyFor(homeAccountId), sealed);
    recordAuditEvent({
      actor: upn,
      action: "credentialVault.remove",
      target: upn,
      status: "success",
      details: { tenantId, homeAccountId },
    });
  }

  async touch(
    upn: string,
    tenantId: string,
    homeAccountId: string,
  ): Promise<void> {
    const entry = await this.get(upn, tenantId, homeAccountId);
    if (!entry) return;
    await this.put({ ...entry, lastUsedAt: new Date().toISOString() });
  }

  /**
   * Explicit, user-initiated wipe of EVERY saved credential (legacy + all
   * per-account envelopes). NOT called on logout — sign-out keeps the vault
   * so a returning operator still sees what they created.
   */
  clearAll(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k === STORAGE_KEY || k.startsWith(STORAGE_KEY_PREFIX))) {
          toRemove.push(k);
        }
      }
      for (const k of toRemove) localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}

export const credentialVault: CredentialVault = new LocalCredentialVault();

/** Internal helpers — exposed for tests only. */
export const __testing__ = {
  STORAGE_KEY,
  STORAGE_KEY_PREFIX,
  envelopeKeyFor,
  readEnvelope,
  readEnvelopeAt,
  writeEnvelope,
  writeEnvelopeAt,
  /** Seal a payload under an account's key — lets tests author a legacy envelope. */
  encryptForTest: (homeAccountId: string, payload: VaultPayload) =>
    encryptVault(homeAccountId, payload),
};
