/**
 * Tricky Login — defensive admin flip of red-team cross-tenant token
 * tricks (ROADtools `roadtx`, AADInternals `Get-AADIntAccessTokenWith*`,
 * Stormspotter silent pivot).
 *
 * Legitimate use case:
 *   Tenant admins who are ALREADY signed in with account X want to mint a
 *   token for tenant Y (where X is a guest, partner, or B2B member)
 *   WITHOUT re-entering credentials, then optionally use the result as a
 *   "duplicate" account context they can switch between.
 *
 * Why this is NOT an offensive primitive: every operation here only
 * succeeds when the operator has already authenticated AND the target
 * tenant has granted them access. We never POP a credential prompt, we
 * never extract credentials from the browser keychain, and we never
 * touch the operator's PRT / device cert. The page is constrained to:
 *
 *   1. MSAL silent multi-tenant — `acquireTokenSilent` with the target
 *      tenant authority. Works for the operator's OWN session.
 *   2. FOCI refresh-token exchange — POST `grant_type=refresh_token` to
 *      `/{targetTenantId}/oauth2/v2.0/token` with a refresh token the
 *      operator already imported via the Token Importer page.
 *   3. Auto — try MSAL first, fall back to FOCI on InteractionRequired.
 *
 * Every mint goes to the audit log (`tricky_login_mint`); token material
 * is NEVER logged or audited.
 *
 * Files in this folder:
 *   - tricky-login-helpers.ts — pure helpers (this page imports them)
 *   - tricky-login-page.tsx   — THIS file
 *
 * The page deliberately consumes EXISTING auth / store / shared-UI APIs
 * and does not modify any service / auth / store / page-router / sidebar-
 * nav file (per the spec's hard constraints).
 */
import * as React from "react";
export declare const TrickyLoginPage: React.FC;
//# sourceMappingURL=tricky-login-page.d.ts.map