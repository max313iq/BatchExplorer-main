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
export type CredentialSource = "create" | "reset";
export interface CredentialEntry {
    upn: string;
    password: string;
    tenantId: string;
    homeAccountId: string;
    displayName?: string;
    createdAt: string;
    lastUsedAt?: string;
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
declare function readEnvelope(): VaultEnvelope | null;
declare function writeEnvelope(env: VaultEnvelope): void;
export interface CredentialVaultListFilter {
    homeAccountId?: string;
    tenantId?: string;
}
export interface CredentialVault {
    put(entry: CredentialEntry): Promise<void>;
    get(upn: string, tenantId: string, homeAccountId: string): Promise<CredentialEntry | null>;
    list(filter?: CredentialVaultListFilter): Promise<CredentialEntry[]>;
    remove(upn: string, tenantId: string, homeAccountId: string): Promise<void>;
    touch(upn: string, tenantId: string, homeAccountId: string): Promise<void>;
    clearAll(): void;
}
export declare const credentialVault: CredentialVault;
/** Internal helper — exposed for tests only. */
export declare const __testing__: {
    STORAGE_KEY: string;
    readEnvelope: typeof readEnvelope;
    writeEnvelope: typeof writeEnvelope;
};
export {};
//# sourceMappingURL=credential-vault.d.ts.map