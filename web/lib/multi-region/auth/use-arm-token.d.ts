export interface ArmTokenState {
    /** The current valid ARM access token, or null while loading / on error. */
    token: string | null;
    /** True while a token acquire (initial or refresh) is in flight. */
    loading: boolean;
    /** Last acquire error message, or null. */
    error: string | null;
    /** Force a fresh acquire (bypasses MSAL silent cache). Returns the new token. */
    refresh: () => Promise<string | null>;
    /** UNIX seconds timestamp from the token's `exp` claim, or null. */
    expiresAt: number | null;
    /** Seconds until the current token expires (recomputed on every render via tick). */
    secondsUntilExpiry: number | null;
    /** True when expiry is < 10 min away (UI hint to show a warning badge). */
    expiringSoon: boolean;
    /** Tenant the current token was minted against (from `tid` claim). */
    tokenTenantId: string | null;
    /**
     * True when the last acquire failed with an error class that ONLY
     * an interactive popup can resolve (interaction_required,
     * invalid_grant, "Cached session is no longer valid", etc.).
     * Pages should surface a "Re-authenticate" CTA when this is true —
     * silent retries (refresh()) won't help.
     */
    needsReauth: boolean;
    /**
     * Interactive re-authenticate this account against the (optional)
     * target tenant. Pops the MSAL login dialog with `prompt: "login"`
     * which forces AAD to mint a fresh refresh token regardless of
     * cache state, then auto-retries the silent acquire. Returns the
     * new token (or null on failure / cancellation).
     *
     * Defaults: tenantId = the hook's current effective tenant;
     * loginHint = passed in by the caller, or omitted.
     */
    reauth: (opts?: {
        tenantId?: string;
        loginHint?: string;
    }) => Promise<string | null>;
}
/**
 * Acquire-and-track an ARM token for the given account. Handles:
 *   - Initial acquire on mount
 *   - Re-mint whenever the resolved tenant changes (TENANT_CHANGED_EVENT)
 *   - Background refresh 60 s before expiry
 *   - Per-second `secondsUntilExpiry` tick so badge UI stays current
 *   - Imported-token short-circuit via `getArmTokenForAccount` (unchanged)
 *
 * Pass `undefined`/`""` for the account when no account is selected;
 * the hook will return null token without erroring.
 */
export declare function useArmToken(homeAccountId: string | undefined, tenantId: string | undefined): ArmTokenState;
//# sourceMappingURL=use-arm-token.d.ts.map