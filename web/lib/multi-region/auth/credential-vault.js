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
import { __awaiter } from "tslib";
// AUDIT-LOG BINDING. Vault put / remove events surface through the
// shared audit-binding so the services-layer audit-log can record them
// without us pulling that module in here. See `auth/audit-binding.ts`.
import { recordAuditEvent } from "./audit-binding";
const STORAGE_KEY = "azbm:credential-vault:v1";
const PBKDF2_ITERATIONS = 250000;
const PBKDF2_SALT_BYTES = 16;
const AES_IV_BYTES = 12;
const VAULT_VERSION = 1;
// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
function isCryptoAvailable() {
    return typeof crypto !== "undefined" && !!crypto.subtle;
}
function bytesToBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++)
        s += String.fromCharCode(bytes[i]);
    return btoa(s);
}
function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
function deriveKey(passphrase, salt) {
    return __awaiter(this, void 0, void 0, function* () {
        const baseKey = yield crypto.subtle.importKey("raw", textEncoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
        return crypto.subtle.deriveKey({
            name: "PBKDF2",
            salt,
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256",
        }, baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    });
}
function passphraseFor(homeAccountId) {
    const origin = typeof window !== "undefined" ? window.location.origin : "ssr";
    return `${homeAccountId}|${origin}`;
}
// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
function readEnvelope() {
    if (typeof localStorage === "undefined")
        return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (typeof (parsed === null || parsed === void 0 ? void 0 : parsed.version) !== "number" ||
            typeof (parsed === null || parsed === void 0 ? void 0 : parsed.saltB64) !== "string" ||
            typeof (parsed === null || parsed === void 0 ? void 0 : parsed.ivB64) !== "string" ||
            typeof (parsed === null || parsed === void 0 ? void 0 : parsed.ciphertextB64) !== "string") {
            return null;
        }
        return parsed;
    }
    catch (_a) {
        return null;
    }
}
function writeEnvelope(env) {
    if (typeof localStorage === "undefined")
        return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(env));
}
function decryptVault(homeAccountId, env) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!isCryptoAvailable())
            return null;
        try {
            const salt = base64ToBytes(env.saltB64);
            const iv = base64ToBytes(env.ivB64);
            const key = yield deriveKey(passphraseFor(homeAccountId), salt);
            const plain = yield crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, base64ToBytes(env.ciphertextB64));
            const json = textDecoder.decode(plain);
            const payload = JSON.parse(json);
            if ((payload === null || payload === void 0 ? void 0 : payload.version) !== VAULT_VERSION || !Array.isArray(payload.entries)) {
                return null;
            }
            return payload;
        }
        catch (_a) {
            // Wrong key / corrupted / different MSAL account — treat as empty so a
            // signed-in user never sees another user's data.
            return null;
        }
    });
}
function encryptVault(homeAccountId, payload) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!isCryptoAvailable()) {
            throw new Error("Web Crypto unavailable; cannot encrypt credential vault.");
        }
        const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
        const iv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
        const key = yield deriveKey(passphraseFor(homeAccountId), salt);
        const cipher = yield crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textEncoder.encode(JSON.stringify(payload)));
        return {
            version: VAULT_VERSION,
            saltB64: bytesToBase64(salt),
            ivB64: bytesToBase64(iv),
            ciphertextB64: bytesToBase64(new Uint8Array(cipher)),
        };
    });
}
class LocalCredentialVault {
    /**
     * The vault is keyed by the writing-user's homeAccountId. Reads scope to
     * the same key, so vault entries written by one MSAL account are invisible
     * to a different signed-in account on the same browser.
     */
    put(entry) {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            if (!(entry === null || entry === void 0 ? void 0 : entry.homeAccountId) || !entry.upn || !entry.tenantId)
                return;
            const env = readEnvelope();
            const existing = env
                ? (_a = (yield decryptVault(entry.homeAccountId, env))) !== null && _a !== void 0 ? _a : {
                    version: VAULT_VERSION,
                    entries: [],
                }
                : { version: VAULT_VERSION, entries: [] };
            // Replace prior entry for the same upn+tenant.
            const next = {
                version: VAULT_VERSION,
                entries: [
                    ...existing.entries.filter((e) => !(e.upn === entry.upn &&
                        e.tenantId === entry.tenantId &&
                        e.homeAccountId === entry.homeAccountId)),
                    entry,
                ],
            };
            const sealed = yield encryptVault(entry.homeAccountId, next);
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
        });
    }
    get(upn, tenantId, homeAccountId) {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            const all = yield this.list({ homeAccountId, tenantId });
            return (_a = all.find((e) => e.upn === upn)) !== null && _a !== void 0 ? _a : null;
        });
    }
    list(filter) {
        return __awaiter(this, void 0, void 0, function* () {
            const env = readEnvelope();
            if (!env)
                return [];
            // We need a homeAccountId to decrypt. Caller must pass one in filter, or
            // we return [] (we can't enumerate every signed-in account here without
            // a circular import; pages always know their active account).
            if (!(filter === null || filter === void 0 ? void 0 : filter.homeAccountId))
                return [];
            const payload = yield decryptVault(filter.homeAccountId, env);
            if (!payload)
                return [];
            return payload.entries.filter((e) => {
                if (filter.tenantId && e.tenantId !== filter.tenantId)
                    return false;
                if (filter.homeAccountId && e.homeAccountId !== filter.homeAccountId)
                    return false;
                return true;
            });
        });
    }
    remove(upn, tenantId, homeAccountId) {
        return __awaiter(this, void 0, void 0, function* () {
            const env = readEnvelope();
            if (!env)
                return;
            const payload = yield decryptVault(homeAccountId, env);
            if (!payload)
                return;
            const next = {
                version: VAULT_VERSION,
                entries: payload.entries.filter((e) => !(e.upn === upn &&
                    e.tenantId === tenantId &&
                    e.homeAccountId === homeAccountId)),
            };
            const sealed = yield encryptVault(homeAccountId, next);
            writeEnvelope(sealed);
            recordAuditEvent({
                actor: upn,
                action: "credentialVault.remove",
                target: upn,
                status: "success",
                details: { tenantId, homeAccountId },
            });
        });
    }
    touch(upn, tenantId, homeAccountId) {
        return __awaiter(this, void 0, void 0, function* () {
            const entry = yield this.get(upn, tenantId, homeAccountId);
            if (!entry)
                return;
            yield this.put(Object.assign(Object.assign({}, entry), { lastUsedAt: new Date().toISOString() }));
        });
    }
    clearAll() {
        if (typeof localStorage === "undefined")
            return;
        try {
            localStorage.removeItem(STORAGE_KEY);
        }
        catch (_a) {
            /* ignore */
        }
    }
}
export const credentialVault = new LocalCredentialVault();
/** Internal helper — exposed for tests only. */
export const __testing__ = {
    STORAGE_KEY,
    readEnvelope,
    writeEnvelope,
};
//# sourceMappingURL=credential-vault.js.map