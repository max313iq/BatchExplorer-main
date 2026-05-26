import { __awaiter } from "tslib";
/**
 * Service Principal credential login tab — sibling of the user-account
 * tricky-login flow, mounted under the Tricky Login page as a second
 * top-level Tabs section.
 *
 * Three sub-modes:
 *   1. Client Secret   — `grant_type=client_credentials` (app-only token).
 *   2. Certificate     — out-of-scope for a browser SPA (private-key
 *      assertion signing needs WebCrypto + DER parsing; we surface a
 *      explanation note instead of silently failing).
 *   3. OBO (On-Behalf-Of) — `grant_type=urn:ietf:params:oauth:grant-type:
 *      jwt-bearer` with a user access token as the assertion, exchanged
 *      for a downstream-scoped token via the same client.
 *
 * Both POST flows go through the same dev-server `/api/auth/proxy-token`
 * relay MSAL uses (`x-proxy-target` header → AAD's
 * `/oauth2/v2.0/token`). This dodges AAD's browser CORS reject on direct
 * `client_credentials` POSTs (AAD only sets CORS headers for public-client
 * `authorization_code` + `refresh_token` grants).
 *
 * Audit:
 *   action: tricky_login_sp_mint
 *   details: { tenantId, clientId, scope, mode, durationMs }
 *   NEVER includes the secret, NEVER includes the returned token.
 *
 * The result panel renders decoded claims, a copy button, and an
 * "Import to vault" button that uses the same `previewToken` +
 * `importToken` plumbing as the user-flow result panel.
 */
import * as React from "react";
import { AlertTriangle, CheckCircle2, ClipboardCopy, Eye, EyeOff, KeyRound, Lock, Loader2, ShieldAlert, Sparkles, XCircle, } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger, } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { decodeJwtClaimsUnsafe } from "../../auth/msal-auth";
import { classifyAudience, importToken, previewToken, } from "../../auth/imported-tokens";
import { auditLog } from "../../services/audit-log";
import { useMultiRegionStore } from "../../store/store-context";
import { CopyButton } from "../shared/copy-button";
import { InfoTooltip } from "../shared/info-tooltip";
import { extractAadErrorCode, fmtDuration, formatExpiresIn, maskToken, CLAIM_EXPLAIN, } from "./tricky-login-helpers";
/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */
/** Default scope used by every mode — operators can override per call. */
const DEFAULT_SCOPE = "https://management.azure.com/.default";
/**
 * Format a JWT claim value for the per-claim result table. Mirrors the
 * helper in tricky-login-page.tsx (kept local so this file can stand alone
 * — it doesn't import from the page).
 */
function formatClaimValue(name, value) {
    if (value == null)
        return "(null)";
    if (typeof value === "string")
        return value;
    if (typeof value === "number") {
        if (name === "iat" || name === "nbf" || name === "exp") {
            try {
                const iso = new Date(value * 1000).toISOString();
                return `${value} (${iso})`;
            }
            catch (_a) {
                return String(value);
            }
        }
        return String(value);
    }
    if (typeof value === "boolean")
        return value ? "true" : "false";
    try {
        return JSON.stringify(value);
    }
    catch (_b) {
        return String(value);
    }
}
/**
 * POST a token request to AAD's v2 endpoint via the dev-server proxy.
 *
 * Why the proxy: AAD only sets the `Access-Control-Allow-Origin: *`
 * header for public-client flows (authorization_code, refresh_token).
 * Confidential-client grants (client_credentials, jwt-bearer) get NO
 * CORS allowance, so a direct browser POST fails with a CORS error
 * BEFORE the response body is readable. The webpack dev server's
 * /api/auth/proxy-token middleware reads `x-proxy-target` and re-issues
 * the POST server-side, then streams the body back to the browser. This
 * is the same plumbing MSAL's customNetworkClient uses (msal-auth.ts
 * sendPostRequestAsync).
 *
 * Returns the parsed JSON body, or throws an Error whose message starts
 * with `AADSTS…` when AAD rejected.
 *
 * The optional `signal` lets callers cancel the in-flight POST (e.g.
 * on unmount). Aborting trips the standard `AbortError` path.
 */
function postTokenRequest(tenantId, body, signal) {
    return __awaiter(this, void 0, void 0, function* () {
        const target = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
        const resp = yield fetch("/api/auth/proxy-token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "x-proxy-target": target,
            },
            body: body.toString(),
            signal,
        });
        let parsed;
        try {
            parsed = yield resp.json();
        }
        catch (err) {
            throw new Error(`AAD returned HTTP ${resp.status} with non-JSON body (${err instanceof Error ? err.message : String(err)}).`);
        }
        const data = (parsed !== null && parsed !== void 0 ? parsed : {});
        if (!resp.ok || typeof data.access_token !== "string") {
            const desc = typeof data.error_description === "string"
                ? data.error_description
                : typeof data.error === "string"
                    ? data.error
                    : `HTTP ${resp.status}`;
            throw new Error(desc);
        }
        return data;
    });
}
/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */
export const SpLoginTab = () => {
    const store = useMultiRegionStore();
    /* --- Mount lifecycle (same pattern as the parent page). */
    const mountedRef = React.useRef(true);
    // AbortController for in-flight token POSTs. Aborted on unmount so
    // the SP-mint fetch doesn't outlive the tab. A fresh controller is
    // created per submit; the ref always points at the most-recent one
    // so unmount can call .abort() exactly once.
    const submitAbortRef = React.useRef(null);
    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            var _a;
            mountedRef.current = false;
            (_a = submitAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
            submitAbortRef.current = null;
        };
    }, []);
    /* --- Mode + form state. */
    const [mode, setMode] = React.useState("secret");
    // Shared fields across modes.
    const [tenantId, setTenantId] = React.useState("");
    const [clientId, setClientId] = React.useState("");
    const [clientSecret, setClientSecret] = React.useState("");
    const [scope, setScope] = React.useState(DEFAULT_SCOPE);
    // OBO-only field — the user access token to swap.
    const [userAssertion, setUserAssertion] = React.useState("");
    // Visibility toggles so screen-share-safe by default.
    const [secretRevealed, setSecretRevealed] = React.useState(false);
    const [assertionRevealed, setAssertionRevealed] = React.useState(false);
    const [tokenRevealed, setTokenRevealed] = React.useState(false);
    /* --- Submit state. */
    const [minting, setMinting] = React.useState(false);
    const [result, setResult] = React.useState(null);
    /* --- Form validity per-mode. */
    const canSubmit = React.useMemo(() => {
        if (!tenantId.trim() || !clientId.trim() || !scope.trim())
            return false;
        if (mode === "certificate")
            return false; // explicitly out-of-scope
        if (mode === "secret")
            return clientSecret.trim().length > 0;
        if (mode === "obo")
            return clientSecret.trim().length > 0 && userAssertion.trim().length > 0;
        return false;
    }, [tenantId, clientId, scope, mode, clientSecret, userAssertion]);
    /* --- Submit handler. */
    const handleSubmit = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _a, _b;
        if (!canSubmit)
            return;
        // Cancel any in-flight previous submit (operators clicking twice
        // shouldn't get races). Then mount a fresh controller for this one.
        (_a = submitAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
        const controller = new AbortController();
        submitAbortRef.current = controller;
        const startedAt = performance.now();
        setMinting(true);
        setResult(null);
        setTokenRevealed(false);
        const tid = tenantId.trim();
        const cid = clientId.trim();
        const sc = scope.trim();
        try {
            const body = new URLSearchParams();
            body.set("client_id", cid);
            body.set("client_secret", clientSecret);
            body.set("scope", sc);
            if (mode === "secret") {
                body.set("grant_type", "client_credentials");
            }
            else if (mode === "obo") {
                body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
                body.set("assertion", userAssertion.trim());
                body.set("requested_token_use", "on_behalf_of");
            }
            else {
                throw new Error("Certificate mode is not supported in the browser.");
            }
            const data = yield postTokenRequest(tid, body, controller.signal);
            const accessToken = data.access_token;
            const claims = (_b = decodeJwtClaimsUnsafe(accessToken)) !== null && _b !== void 0 ? _b : {};
            const expiresAt = typeof claims.exp === "number" ? claims.exp : undefined;
            const durationMs = Math.round(performance.now() - startedAt);
            const finalResult = {
                status: "success",
                mode,
                tenantId: tid,
                clientId: cid,
                scope: sc,
                durationMs,
                accessToken,
                claims,
                expiresAt,
                finishedAt: new Date().toISOString(),
            };
            if (mountedRef.current) {
                setResult(finalResult);
            }
            // Audit: NEVER include the secret or the returned token.
            auditLog.record({
                actor: `sp:${cid}`,
                action: "tricky_login_sp_mint",
                target: `${tid} / ${sc}`,
                status: "success",
                details: {
                    tenantId: tid,
                    clientId: cid,
                    scope: sc,
                    mode,
                    durationMs,
                    tokenAudience: typeof claims.aud === "string" ? claims.aud : null,
                },
            });
        }
        catch (err) {
            // AbortError = operator unmounted / re-submitted. Not a real
            // failure; bail without audit-logging a spurious failed-mint.
            const errName = err === null || err === void 0 ? void 0 : err.name;
            if (errName === "AbortError" || controller.signal.aborted) {
                if (mountedRef.current)
                    setMinting(false);
                return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            const code = extractAadErrorCode(msg);
            const durationMs = Math.round(performance.now() - startedAt);
            const finalResult = {
                status: "failure",
                mode,
                tenantId: tid,
                clientId: cid,
                scope: sc,
                durationMs,
                errorCode: code,
                errorMessage: msg,
                finishedAt: new Date().toISOString(),
            };
            if (mountedRef.current) {
                setResult(finalResult);
            }
            auditLog.record({
                actor: `sp:${cid}`,
                action: "tricky_login_sp_mint",
                target: `${tid} / ${sc}`,
                status: "failure",
                error: msg,
                details: {
                    tenantId: tid,
                    clientId: cid,
                    scope: sc,
                    mode,
                    durationMs,
                    errorCode: code !== null && code !== void 0 ? code : null,
                },
            });
        }
        finally {
            if (mountedRef.current)
                setMinting(false);
            // Clear the ref only if it still points at this controller —
            // an in-flight resubmit might have already swapped it.
            if (submitAbortRef.current === controller) {
                submitAbortRef.current = null;
            }
        }
    }), [
        canSubmit,
        tenantId,
        clientId,
        clientSecret,
        scope,
        userAssertion,
        mode,
    ]);
    /* --- Per-result actions. */
    const handleCopyToken = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!(result === null || result === void 0 ? void 0 : result.accessToken))
            return;
        try {
            yield navigator.clipboard.writeText(result.accessToken);
            store.addNotification({
                type: "success",
                message: "SP access token copied to clipboard.",
            });
        }
        catch (_c) {
            store.addNotification({
                type: "warning",
                message: "Could not access clipboard — reveal the token below and copy manually.",
            });
        }
    }), [result, store]);
    const handleImportToVault = React.useCallback(() => {
        var _a;
        if (!result || result.status !== "success" || !result.accessToken)
            return;
        const preview = previewToken(result.accessToken);
        if (!preview) {
            store.addNotification({
                type: "error",
                message: "Could not decode the new SP token — refusing to import. " +
                    "App-only tokens missing oid/tid can't be vaulted.",
            });
            return;
        }
        const entry = importToken(preview);
        store.addNotification({
            type: "success",
            message: `Imported ${classifyAudience(preview.rawAudience)} SP token for ${(_a = preview.upn) !== null && _a !== void 0 ? _a : preview.oid} → ${preview.tenantId}.`,
        });
        auditLog.record({
            actor: `sp:${result.clientId}`,
            action: "tricky_login_sp_import_to_vault",
            target: `${result.tenantId} / ${result.scope}`,
            status: "success",
            details: {
                tenantId: result.tenantId,
                clientId: result.clientId,
                scope: result.scope,
                importedHomeAccountId: entry.homeAccountId,
            },
        });
    }, [result, store]);
    /* ------------------------------------------------------------------ */
    /* Render                                                              */
    /* ------------------------------------------------------------------ */
    return (React.createElement(Card, null,
        React.createElement(CardHeader, null,
            React.createElement(CardTitle, { className: "flex items-center gap-2 text-base" },
                React.createElement(Lock, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                "Service Principal credential login",
                React.createElement(InfoTooltip, { content: "Mint a token directly from a Service Principal credential. Use for headless / CI-style identities that don't have a user behind them. No popup, no MSAL \u2014 just a raw POST to AAD's token endpoint via the dev-server proxy." })),
            React.createElement(CardDescription, null, "Mint tokens for non-interactive identities (CI runners, daemons, background workers). Three sub-modes: client secret, certificate (out-of-scope for browser), and On-Behalf-Of for downstream delegation.")),
        React.createElement(CardContent, { className: "flex flex-col gap-4" },
            React.createElement(Alert, { variant: "warning", role: "alert" },
                React.createElement(ShieldAlert, { className: "h-4 w-4", "aria-hidden": true }),
                React.createElement(AlertTitle, { className: "text-sm" }, "Service-Principal credentials are high-stakes"),
                React.createElement(AlertDescription, { className: "text-xs" },
                    React.createElement("p", { className: "m-0" },
                        "Client secrets and user assertions are pasted in plain text and held only in component state for this tab's lifetime. They are never logged, never persisted, and never sent outside the dev-server token proxy. The resulting access token is auditable (",
                        React.createElement("code", { className: "font-mono" }, "tricky_login_sp_mint"),
                        ") but the secret itself is not. Treat this surface like a keyvault unlock: only paste credentials you intend to use for this specific mint, on a screen you control. Prefer certificate-based SPs outside the browser whenever the workflow allows."))),
            React.createElement(Tabs, { value: mode, onValueChange: (v) => setMode(v) },
                React.createElement(TabsList, null,
                    React.createElement(TabsTrigger, { value: "secret", className: "gap-1" },
                        React.createElement(KeyRound, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Client Secret"),
                    React.createElement(TabsTrigger, { value: "certificate", className: "gap-1" },
                        React.createElement(ShieldAlert, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Certificate"),
                    React.createElement(TabsTrigger, { value: "obo", className: "gap-1" },
                        React.createElement(Sparkles, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "OBO")),
                React.createElement("div", { className: "mt-4 grid gap-3 lg:grid-cols-2" },
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement(Label, { htmlFor: "sp-tenant-id", className: "text-xs" }, "Tenant id"),
                        React.createElement(Input, { id: "sp-tenant-id", value: tenantId, onChange: (e) => setTenantId(e.target.value), placeholder: "00000000-0000-0000-0000-000000000000", className: "font-mono text-xs", spellCheck: false, autoComplete: "off" })),
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement(Label, { htmlFor: "sp-client-id", className: "text-xs" }, "App (client) id"),
                        React.createElement(Input, { id: "sp-client-id", value: clientId, onChange: (e) => setClientId(e.target.value), placeholder: "00000000-0000-0000-0000-000000000000", className: "font-mono text-xs", spellCheck: false, autoComplete: "off" })),
                    React.createElement("div", { className: "flex flex-col gap-1 lg:col-span-2" },
                        React.createElement(Label, { htmlFor: "sp-scope", className: "text-xs" }, "Scope"),
                        React.createElement(Input, { id: "sp-scope", value: scope, onChange: (e) => setScope(e.target.value), placeholder: DEFAULT_SCOPE, className: "font-mono text-xs", spellCheck: false, autoComplete: "off" }))),
                React.createElement(TabsContent, { value: "secret", className: "flex flex-col gap-3" },
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement(Label, { htmlFor: "sp-client-secret", className: "flex items-center gap-1 text-xs" },
                            "Client secret",
                            React.createElement(InfoTooltip, { content: "Pasted plain-text. We never log it or persist it \u2014 it's used once for this POST and lives only in component state for the lifetime of this page." })),
                        React.createElement("div", { className: "flex items-center gap-2" },
                            React.createElement(Input, { id: "sp-client-secret", type: secretRevealed ? "text" : "password", value: clientSecret, onChange: (e) => setClientSecret(e.target.value), placeholder: "paste the SP secret here", className: "flex-1 font-mono text-xs", spellCheck: false, autoComplete: "off" }),
                            React.createElement(Button, { variant: "ghost", size: "sm", type: "button", onClick: () => setSecretRevealed((v) => !v), className: "gap-1" },
                                secretRevealed ? (React.createElement(EyeOff, { className: "h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(Eye, { className: "h-3.5 w-3.5", "aria-hidden": true })),
                                secretRevealed ? "Hide" : "Reveal"))),
                    React.createElement("p", { className: "text-2xs text-muted-foreground" },
                        "POSTs ",
                        React.createElement("code", null, "grant_type=client_credentials"),
                        " with the SP credential. The returned access token is an app-only token \u2014",
                        React.createElement("code", { className: "ml-1" }, "oid"),
                        " = the SP's object id, no",
                        " ",
                        React.createElement("code", null, "upn"),
                        ".")),
                React.createElement(TabsContent, { value: "certificate" },
                    React.createElement(Alert, { variant: "info" },
                        React.createElement(ShieldAlert, { className: "h-4 w-4", "aria-hidden": true }),
                        React.createElement(AlertTitle, { className: "text-sm" }, "Certificate flow is out of scope for browser"),
                        React.createElement(AlertDescription, { className: "text-xs" },
                            React.createElement("p", { className: "m-0" },
                                "Certificate-credential mints require building a signed JWT client assertion using the SP's private key. That needs WebCrypto + PKCS#8/PEM parsing and a thumbprint header \u2014 meaningful work that's also a security footgun (private keys in a browser tab). Use",
                                " ",
                                React.createElement("code", null, "az login --service-principal --certificate"),
                                " ",
                                "outside the WebUI, or run the equivalent in your CI runner, and paste the resulting access token into the Token Importer page.")))),
                React.createElement(TabsContent, { value: "obo", className: "flex flex-col gap-3" },
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement(Label, { htmlFor: "sp-obo-secret", className: "flex items-center gap-1 text-xs" },
                            "Client secret (the middle-tier app's secret)",
                            React.createElement(InfoTooltip, { content: "The middle-tier confidential client's secret. OBO needs both the user's token AND proof-of-possession from the client app the user delivered the token to." })),
                        React.createElement("div", { className: "flex items-center gap-2" },
                            React.createElement(Input, { id: "sp-obo-secret", type: secretRevealed ? "text" : "password", value: clientSecret, onChange: (e) => setClientSecret(e.target.value), placeholder: "middle-tier client secret", className: "flex-1 font-mono text-xs", spellCheck: false, autoComplete: "off" }),
                            React.createElement(Button, { variant: "ghost", size: "sm", type: "button", onClick: () => setSecretRevealed((v) => !v), className: "gap-1" },
                                secretRevealed ? (React.createElement(EyeOff, { className: "h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(Eye, { className: "h-3.5 w-3.5", "aria-hidden": true })),
                                secretRevealed ? "Hide" : "Reveal"))),
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement(Label, { htmlFor: "sp-obo-assertion", className: "flex items-center gap-1 text-xs" },
                            "User access token (assertion)",
                            React.createElement(InfoTooltip, { content: "The user-bound access token your middle-tier app received from a downstream call. AAD verifies the user is who they claim and mints a NEW token scoped to the downstream API." })),
                        React.createElement("div", { className: "flex items-center gap-2" },
                            React.createElement("textarea", { id: "sp-obo-assertion", value: userAssertion, onChange: (e) => setUserAssertion(e.target.value), placeholder: "paste the user's access token (the assertion)", className: cn("flex h-24 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-2xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", !assertionRevealed && "blur-sm"), spellCheck: false, autoComplete: "off" }),
                            React.createElement(Button, { variant: "ghost", size: "sm", type: "button", onClick: () => setAssertionRevealed((v) => !v), className: "gap-1 self-start" },
                                assertionRevealed ? (React.createElement(EyeOff, { className: "h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(Eye, { className: "h-3.5 w-3.5", "aria-hidden": true })),
                                assertionRevealed ? "Hide" : "Reveal"))),
                    React.createElement("p", { className: "text-2xs text-muted-foreground" },
                        "POSTs",
                        " ",
                        React.createElement("code", null, "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer"),
                        " ",
                        "with the assertion and",
                        " ",
                        React.createElement("code", null, "requested_token_use=on_behalf_of"),
                        ". AAD swaps the user-bound token for a downstream-scoped one \u2014 same identity, new audience."))),
            React.createElement("div", { className: "flex flex-wrap items-center gap-3 pt-2" },
                React.createElement(Button, { onClick: () => void handleSubmit(), disabled: !canSubmit || minting, loading: minting, className: "gap-2" },
                    React.createElement(Sparkles, { className: "h-4 w-4", "aria-hidden": true }),
                    mode === "secret"
                        ? "Mint app-only token"
                        : mode === "obo"
                            ? "Exchange OBO token"
                            : "Certificate mode unavailable"),
                minting && (React.createElement("span", { className: "flex items-center gap-1.5 text-2xs text-muted-foreground" },
                    React.createElement(Loader2, { className: "h-3 w-3 animate-spin", "aria-hidden": true }),
                    "POSTing /",
                    tenantId || "{tid}",
                    "/oauth2/v2.0/token via proxy\u2026"))),
            result && (React.createElement("div", { className: cn("flex flex-col gap-3 rounded-md border p-3", result.status === "success"
                    ? "border-success/40 bg-success/5"
                    : "border-destructive/40 bg-destructive/5") },
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement("span", { className: "text-xs font-semibold" }, "SP mint result"),
                    result.status === "success" ? (React.createElement(Badge, { variant: "success", className: "gap-1" },
                        React.createElement(CheckCircle2, { className: "h-3 w-3", "aria-hidden": true }),
                        "Success")) : (React.createElement(Badge, { variant: "destructive", className: "gap-1" },
                        React.createElement(XCircle, { className: "h-3 w-3", "aria-hidden": true }),
                        "Failure")),
                    React.createElement(Badge, { variant: "outline", className: "px-1.5 py-0" }, result.mode.toUpperCase()),
                    React.createElement(Badge, { variant: "outline" },
                        fmtDuration(result.durationMs / 1000),
                        " elapsed"),
                    result.status === "success" && result.expiresAt && (React.createElement(Badge, { variant: "outline" }, formatExpiresIn(result.expiresAt))),
                    result.status === "failure" && result.errorCode && (React.createElement(Badge, { variant: "destructive" }, result.errorCode))),
                result.status === "failure" && (React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
                    React.createElement(AlertTitle, { className: "text-sm" },
                        "SP mint failed",
                        result.errorCode ? ` — ${result.errorCode}` : ""),
                    React.createElement(AlertDescription, { className: "text-xs" },
                        React.createElement("p", { className: "m-0 whitespace-pre-wrap break-all font-mono" }, result.errorMessage)))),
                result.status === "success" && result.claims && (React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "flex flex-col gap-1 rounded-md border bg-card/30 p-3" },
                        React.createElement("div", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Decoded access-token claims"),
                        React.createElement("div", { className: "overflow-x-auto" },
                            React.createElement("table", { className: "w-full text-xs" },
                                React.createElement("thead", { className: "border-b text-2xs uppercase text-muted-foreground" },
                                    React.createElement("tr", null,
                                        React.createElement("th", { className: "w-40 px-3 py-1.5 text-left font-medium" }, "Claim"),
                                        React.createElement("th", { className: "px-3 py-1.5 text-left font-medium" }, "Value"))),
                                React.createElement("tbody", null, Object.entries(result.claims)
                                    .sort(([a], [b]) => a.localeCompare(b))
                                    .map(([k, v]) => (React.createElement("tr", { key: k, className: "border-b last:border-b-0 hover:bg-muted/30" },
                                    React.createElement("td", { className: "px-3 py-1.5 align-top font-mono text-2xs" },
                                        React.createElement("span", { className: "inline-flex items-center gap-1" },
                                            k,
                                            CLAIM_EXPLAIN[k] && (React.createElement(InfoTooltip, { content: CLAIM_EXPLAIN[k], ariaLabel: `${k} explained`, size: 12 })))),
                                    React.createElement("td", { className: "px-3 py-1.5 align-top break-all font-mono text-2xs text-muted-foreground" }, formatClaimValue(k, v))))))))),
                    result.accessToken && (React.createElement("div", { className: "flex flex-col gap-2" },
                        React.createElement("div", { className: "flex flex-wrap items-center gap-2 text-xs" },
                            React.createElement(Badge, { variant: "success", className: "gap-1" },
                                React.createElement(KeyRound, { className: "h-3 w-3", "aria-hidden": true }),
                                "Access token minted"),
                            React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => setTokenRevealed((v) => !v), className: "gap-1" },
                                tokenRevealed ? (React.createElement(EyeOff, { className: "h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(Eye, { className: "h-3.5 w-3.5", "aria-hidden": true })),
                                tokenRevealed ? "Hide" : "Reveal"),
                            React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" }, maskToken(result.accessToken))),
                        tokenRevealed && (React.createElement("div", { className: "flex items-center gap-2" },
                            React.createElement("code", { className: "flex-1 break-all rounded border bg-muted/30 p-2 font-mono text-2xs text-muted-foreground" }, result.accessToken),
                            React.createElement(CopyButton, { value: result.accessToken, alwaysVisible: true, ariaLabel: "Copy SP access token" }))))),
                    React.createElement("div", { className: "flex flex-wrap gap-2 pt-1" },
                        React.createElement(Button, { variant: "outline", size: "sm", onClick: handleImportToVault, className: "gap-1" },
                            React.createElement(KeyRound, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                            "Import to vault"),
                        React.createElement(Button, { variant: "outline", size: "sm", onClick: () => void handleCopyToken(), className: "gap-1" },
                            React.createElement(ClipboardCopy, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                            "Copy raw token")))))))));
};
//# sourceMappingURL=sp-login-tab.js.map