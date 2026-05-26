/**
 * Canonical regex matching MSAL / AAD errors that REQUIRE an interactive
 * popup to recover from. Silent retries are useless against these — the
 * account's refresh token in MSAL's cache is dead (expired, revoked, or
 * wiped) and only an interactive sign-in can mint a new one.
 *
 * Covers:
 *   - `interaction_required` (canonical MSAL error code)
 *   - `invalid_grant` (RT no longer accepted by AAD)
 *   - "Cached session is no longer valid" (MSAL.js exception message)
 *   - AADSTS 50173 (FreshTokenNeeded), 50058 (UserInformationNotProvided),
 *     50076 (UserStrongAuthClientAuthNRequired),
 *     50079 (StrongAuthEnrollmentRequired), 65001 (DelegationDoesNotExist)
 *
 * Single source of truth — both `auth/perform-tenant-switch.ts` and
 * `auth/use-arm-token.ts` import from here so we no longer need the
 * "keep these in sync" comments that used to flank duplicated copies.
 */
export declare const REAUTH_REQUIRED_PATTERN: RegExp;
/**
 * Convenience predicate. Accepts any error-like value (Error, string,
 * unknown) and returns true when the message text triggers
 * `REAUTH_REQUIRED_PATTERN`.
 */
export declare function isReauthRequiredError(err: unknown): boolean;
//# sourceMappingURL=reauth-patterns.d.ts.map