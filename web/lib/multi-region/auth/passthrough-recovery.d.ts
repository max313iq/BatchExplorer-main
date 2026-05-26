/**
 * Auto-recovery for the "passthrough token detected without proper
 * resource provider context" 401 that the Microsoft.Billing and
 * Microsoft.Subscription RPs return when a token's `tid` claim
 * doesn't match a tenant the RP trusts for the requested resource.
 *
 * The recovery is a single force-refresh round-trip:
 *
 *   1. Run the caller's function with the token they already have.
 *   2. If it throws a passthrough-style 401, force-refresh the ARM
 *      token (`{ forceRefresh: true }` bypasses MSAL's silent cache,
 *      and also skips the imported-tokens short-circuit), then run
 *      the function again with the fresh token.
 *   3. If the second attempt also fails, re-throw — the caller's
 *      existing error handling will show its tailored remediation
 *      Alert.
 *
 * Why this is worth doing even though forceRefresh doesn't always
 * change the `tid` claim: MSAL's silent cache can hold a stale token
 * whose `tid` no longer matches the *currently active* tenant for
 * the account (e.g. operator switched tenants via the inline picker
 * but a long-running list call already had the old token). A
 * force-refresh fetches a token against the account's current
 * active-tenant authority, which is exactly the recovery the user
 * would otherwise click "Re-acquire token" for.
 *
 * `withPassthroughRecovery` is intentionally narrow: it does NOT
 * try to interactively sign in, prompt for consent, or chase a
 * different authority. Those flows belong in user-initiated UI
 * (the existing "Re-acquire token" / "Sign out + in" buttons).
 */
/**
 * Wraps a token-consuming async function so that a passthrough 401
 * is auto-recovered by force-refreshing the ARM token and retrying
 * exactly once. Other errors pass through unchanged.
 *
 * @param fn  An async function that takes an ARM token and returns
 *            data. Re-invoked with a fresh token on passthrough 401.
 * @param homeAccountId  Account whose ARM token should be refreshed.
 * @param tenantId       Tenant authority for the refresh (use the
 *                       same tenant the failing call expected — i.e.
 *                       the account's currently active tenant).
 * @param initialToken   The token used for the first attempt. If
 *                       omitted, the function is called with a fresh
 *                       token directly.
 * @param onRecovered    Optional hook fired when the second attempt
 *                       succeeds — useful for surfacing a "token
 *                       auto-refreshed" toast to the operator.
 */
export declare function withPassthroughRecovery<T>(fn: (token: string) => Promise<T>, homeAccountId: string, tenantId: string | undefined, initialToken: string, onRecovered?: () => void): Promise<T>;
/**
 * Detect the passthrough-token 401 fingerprint. ARM wraps the
 * underlying error message inconsistently across RPs (Subscription
 * vs Billing vs ManagementPartner), so we match on any of the three
 * stable substrings.
 */
export declare function isPassthroughTokenError(err: unknown): boolean;
//# sourceMappingURL=passthrough-recovery.d.ts.map