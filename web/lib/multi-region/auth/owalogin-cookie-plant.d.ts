/**
 * Browser-side equivalent of ROADtools' `roadtx owalogin` — opens the
 * Outlook / SharePoint / Teams Web UI as the target identity by POSTing a
 * substrate access token to the relevant `?bO=1` endpoint. The substrate
 * answers with `Set-Cookie` headers that the browser persists for that
 * origin natively, opening the UI session without a re-login round-trip.
 *
 * Legitimate use case
 * -------------------
 * After a tenant pivot (the operator switched a multi-tenant account to
 * a different active tenantId), the WebUI already holds a fresh bearer
 * for the new tenant's Outlook / Teams / SPO scope. Rather than burn a
 * device-code or pop another MSAL login, this helper lets the operator
 * "promote" that already-acquired token into live UI session cookies for
 * the corresponding Microsoft 365 service. The substrate APIs accept
 * Bearer-scope tokens and reply with the `Set-Cookie` headers that open
 * the UI session natively.
 *
 * This is the same primitive ROADrecon / AzureHound use under the hood;
 * exposed here so the operator does NOT need to copy the token out of
 * the WebUI, decode it, and POST it manually with curl.
 *
 * Token handling
 * --------------
 * The token is embedded into a transient `<form>` element that auto-
 * submits into a `target=_blank` window opened beforehand. The form is
 * removed from the parent DOM in the same microtask as `.submit()` so:
 *
 *   - It is never accessible to other scripts via `document.forms[…]`
 *     for longer than one event loop tick.
 *   - It never appears in the user's reflowed DOM (no visible artifact).
 *   - It is never written to `localStorage`, `sessionStorage`, or
 *     `IndexedDB`.
 *   - It is never `console.log`'d or stringified anywhere — including
 *     error messages, which only mention the destination URL.
 *
 * The new tab IS the consumer — the substrate response sets cookies on
 * that origin which the browser persists, so the parent tab no longer
 * needs to hold the token. The parent SHOULD clear its in-memory copy
 * after this call (e.g. set `localToken = ""`) if it doesn't need to
 * re-issue the call.
 *
 * The browser cannot set httpOnly cookies cross-origin from JavaScript;
 * we rely on the substrate's own response headers for that, which is why
 * we POST to the substrate URL rather than trying to `document.cookie =`
 * ourselves.
 *
 * Operator caveats
 * ----------------
 *   - Pop-up blocking: the new tab MUST be opened from a synchronous
 *     user gesture (click handler). Calling these helpers outside one
 *     causes `window.open` to return null in most browsers; the caller
 *     gets `null` back and should surface a "please click again" hint.
 *   - SameSite=Strict: some tenants ship CA policies that require the
 *     UI to also pass a CAE step-up. The new tab will then redirect to
 *     `login.microsoftonline.com` instead of landing on the inbox.
 *     That's a tenant-config issue, not a bug here.
 *   - Scopes: tokens minted for the wrong audience (e.g. Graph instead
 *     of `https://outlook.office.com/.default`) will be silently
 *     rejected by the substrate with a 401 inside the new tab. There is
 *     no client-side way to validate the audience without parsing the
 *     JWT, which we intentionally avoid here (the operator already
 *     decoded the token in the Account Intelligence panel before
 *     reaching this code-path).
 */
export interface OpenOutlookOptions {
    /**
     * Optional explicit mailbox (e.g. `someone@contoso.com`). When set, OWA
     * opens the shared mailbox view for that address. Omit to open the
     * token-holder's own mailbox.
     */
    mailbox?: string;
}
/**
 * Open Outlook on the Web (OWA) as the identity represented by the
 * supplied substrate access token. The token MUST be scoped to
 * `https://outlook.office.com/.default` (or a sub-scope like
 * `Mail.Read`). Returns the Window handle or null on pop-up block.
 */
export declare function openOutlookAsIdentity(substrateAccessToken: string, opts?: OpenOutlookOptions): Window | null;
export interface OpenSharePointOptions {
    /**
     * SharePoint Online tenant URL — e.g. `https://contoso.sharepoint.com`.
     * Required because SPO is per-tenant; there is no `_common` host.
     */
    tenantUrl: string;
    /**
     * Optional site path to land on (e.g. `/sites/marketing`). Defaults to
     * `/_layouts/15/sharepoint.aspx` (the tenant root).
     */
    sitePath?: string;
}
/**
 * Open SharePoint Online as the supplied identity. Token MUST be scoped
 * to the SPO tenant URL itself (`https://contoso.sharepoint.com/.default`),
 * NOT to the generic Graph audience — SPO checks audience strictly.
 *
 * Returns the Window handle or null on pop-up block.
 */
export declare function openSharePointAsIdentity(substrateAccessToken: string, opts: OpenSharePointOptions): Window | null;
/**
 * Open Microsoft Teams Web as the supplied identity. Token MUST be
 * scoped to `https://api.spaces.skype.com/.default` (Teams substrate).
 * Returns the Window handle or null on pop-up block.
 */
export declare function openTeamsAsIdentity(substrateAccessToken: string): Window | null;
//# sourceMappingURL=owalogin-cookie-plant.d.ts.map