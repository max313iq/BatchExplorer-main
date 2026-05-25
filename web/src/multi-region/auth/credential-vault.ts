/**
 * Credential vault for the auto-portal-login feature.
 *
 * Captures every credential the app mints (create-user / reset-password)
 * and stores it AES-GCM-encrypted in localStorage so the user can re-launch
 * an Azure portal sign-in for any provisioned account on demand.
 *
 * Encryption key: derived per-MSAL-account via PBKDF2 from
 *   `${homeAccountId}|${window.location.origin}`. The signed-in user is
 *   already authenticated; we treat the homeAccountId as a per-user salt so
 *   one signed-in account can't read another's vault entries (matches the
 *   multi-account model in msal-auth.ts).
 *
 * Storage shape (after decrypt):
 *   { version: 1, entries: CredentialEntry[] }
 *
 * On `clearAll()` (called from msal-auth.logout) we wipe the localStorage
 * key entirely — no decrypt round-trip needed.
 */

// AUDIT-LOG BINDING. Vault put / remove events surface through the
// shared audit-binding so the services-layer audit-log can record them
// without us pulling that module in here. See `auth/audit-binding.ts`.
import { recordAuditEvent } from "./audit-binding";

const STORAGE_KEY = "azbm:credential-vault:v1";
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

function readEnvelope(): VaultEnvelope | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
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

function writeEnvelope(env: VaultEnvelope): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(env));
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
   * The vault is keyed by the writing-user's homeAccountId. Reads scope to
   * the same key, so vault entries written by one MSAL account are invisible
   * to a different signed-in account on the same browser.
   */
  async put(entry: CredentialEntry): Promise<void> {
    if (!entry?.homeAccountId || !entry.upn || !entry.tenantId) return;
    const env = readEnvelope();
    const existing = env
      ? (await decryptVault(entry.homeAccountId, env)) ?? {
          version: VAULT_VERSION as 1,
          entries: [],
        }
      : { version: VAULT_VERSION as 1, entries: [] as CredentialEntry[] };
    // Replace prior entry for the same upn+tenant.
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
    writeEnvelope(sealed);
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
    const env = readEnvelope();
    if (!env) return [];
    // We need a homeAccountId to decrypt. Caller must pass one in filter, or
    // we return [] (we can't enumerate every signed-in account here without
    // a circular import; pages always know their active account).
    if (!filter?.homeAccountId) return [];
    const payload = await decryptVault(filter.homeAccountId, env);
    if (!payload) return [];
    return payload.entries.filter((e) => {
      if (filter.tenantId && e.tenantId !== filter.tenantId) return false;
      if (filter.homeAccountId && e.homeAccountId !== filter.homeAccountId)
        return false;
      return true;
    });
  }

  async remove(
    upn: string,
    tenantId: string,
    homeAccountId: string,
  ): Promise<void> {
    const env = readEnvelope();
    if (!env) return;
    const payload = await decryptVault(homeAccountId, env);
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
    writeEnvelope(sealed);
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

  clearAll(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}

export const credentialVault: CredentialVault = new LocalCredentialVault();

/** Internal helper — exposed for tests only. */
export const __testing__ = {
  STORAGE_KEY,
  readEnvelope,
  writeEnvelope,
};
