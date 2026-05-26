import { __awaiter } from "tslib";
/**
 * Device Code Sign-in dialog.
 *
 * Drives the two-step OAuth 2.0 Device Authorization Grant (RFC 8628) via
 * `auth/device-code-login`:
 *
 *   1. On mount → call startDeviceCodeFlow() to fetch a user_code +
 *      verification_uri. Show those in a large, copy-friendly layout so the
 *      operator can type the code on their phone (or another browser).
 *   2. As soon as we have the challenge → kick off pollDeviceCodeFlow() in
 *      the background. Render a poll-counter so the operator can see we're
 *      still waiting on them.
 *   3. On success → show "Signed in as <upn>" briefly, fire onComplete, and
 *      auto-dismiss.
 *   4. On failure / expiry → show a red error with a "Try again" button
 *      that restarts the flow from step 1.
 *   5. Cancel button (and Esc/X-close) at all times → aborts the in-flight
 *      poll via AbortController so we don't keep hammering AAD.
 *
 * Sensitive-data discipline: this component NEVER logs access_token,
 * refresh_token, id_token, device_code, or user_code. The user_code IS
 * displayed in the UI (that's its whole purpose — the operator types it
 * on another device) but no console / audit log writes it.
 */
import * as React from "react";
import { AlertCircle, CheckCircle2, Copy, ExternalLink, Loader2, } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { DeviceCodeError, isAbortError, pollDeviceCodeFlow, startDeviceCodeFlow, } from "../../auth/device-code-login";
const COPY_FEEDBACK_MS = 1500;
/**
 * Format the seconds-until-expiry as `M:SS`. Returns "expired" once the
 * countdown reaches 0.
 */
function formatRemaining(ms) {
    if (ms <= 0)
        return "expired";
    const total = Math.floor(ms / 1000);
    const mm = Math.floor(total / 60);
    const ss = total % 60;
    return `${mm}:${ss.toString().padStart(2, "0")}`;
}
/**
 * Extract a UPN / preferred_username from a decoded JWT claim bag, falling
 * back to upn / unique_name / email / oid for tokens that don't carry the
 * v2 claim shape.
 */
function pickDisplayName(claims) {
    if (!claims)
        return undefined;
    const c = claims;
    for (const k of ["preferred_username", "upn", "unique_name", "email", "oid"]) {
        const v = c[k];
        if (typeof v === "string" && v.trim())
            return v;
    }
    return undefined;
}
export const DeviceCodeDialog = ({ open, onOpenChange, tenantId, clientId, scopes, onComplete, }) => {
    const [phase, setPhase] = React.useState({ kind: "starting" });
    const [now, setNow] = React.useState(() => Date.now());
    const [copyFeedback, setCopyFeedback] = React.useState(null);
    // AbortController for the active flow. Re-created on each (re)try; the
    // unmount / dialog-close path aborts it to tear down in-flight polls.
    const abortRef = React.useRef(null);
    // Bump this to restart the flow without remounting the dialog.
    const [restartTick, setRestartTick] = React.useState(0);
    // Latched: once we've called onComplete we never call it again, even if
    // a stale poll resolves after we've dismissed.
    const completedRef = React.useRef(false);
    // 1-second tick for the countdown clock. Only runs while a challenge is
    // active — saves wakeups when the dialog is showing the success / error
    // state or hasn't started yet.
    React.useEffect(() => {
        if (phase.kind !== "polling")
            return;
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, [phase.kind]);
    // Auto-dismiss the success state after a short beat so the operator sees
    // the confirmation. onComplete fires immediately (the parent can already
    // start using the tokens before we close).
    React.useEffect(() => {
        if (phase.kind !== "success")
            return;
        const t = window.setTimeout(() => onOpenChange(false), 1200);
        return () => window.clearTimeout(t);
    }, [phase.kind, onOpenChange]);
    // Main effect: drive the flow whenever the dialog is open OR the user
    // clicks "Try again" (which bumps restartTick). Cleans up by aborting
    // the controller so a closing dialog stops polling at AAD.
    React.useEffect(() => {
        if (!open)
            return;
        completedRef.current = false;
        const controller = new AbortController();
        abortRef.current = controller;
        setPhase({ kind: "starting" });
        let cancelled = false;
        (() => __awaiter(void 0, void 0, void 0, function* () {
            try {
                const challenge = yield startDeviceCodeFlow({
                    tenantId,
                    clientId,
                    scopes: scopes && scopes.length > 0
                        ? scopes
                        : [
                            "https://management.azure.com/.default",
                            "offline_access",
                            "openid",
                            "profile",
                        ],
                    signal: controller.signal,
                });
                if (cancelled)
                    return;
                setPhase({ kind: "polling", challenge, polls: 0 });
                // Poll-counter ticker. Each AAD response (success/pending/slow_down)
                // takes ~interval seconds, so a 1× interval tick is the right cadence.
                const pollTicker = window.setInterval(() => {
                    setPhase((p) => p.kind === "polling" ? Object.assign(Object.assign({}, p), { polls: p.polls + 1 }) : p);
                }, Math.max(1, challenge.interval) * 1000);
                try {
                    const result = yield pollDeviceCodeFlow(challenge, {
                        tenantId,
                        clientId,
                        signal: controller.signal,
                    });
                    if (cancelled || completedRef.current)
                        return;
                    completedRef.current = true;
                    const upn = pickDisplayName(result.claims);
                    setPhase({ kind: "success", upn });
                    // Fire BEFORE the auto-dismiss timer so the parent can record the
                    // audit entry and store the tokens immediately.
                    try {
                        onComplete(result);
                    }
                    catch (cbErr) {
                        // Don't let a callback error swallow the success UI.
                        console.error("[device-code-dialog] onComplete threw:", cbErr);
                    }
                }
                finally {
                    window.clearInterval(pollTicker);
                }
            }
            catch (err) {
                if (cancelled || isAbortError(err))
                    return;
                const code = err instanceof DeviceCodeError ? err.code : "unknown_error";
                const message = err instanceof Error ? err.message : String(err);
                setPhase({ kind: "error", code, message });
            }
        }))();
        return () => {
            cancelled = true;
            try {
                controller.abort();
            }
            catch (_a) {
                /* ignore */
            }
            abortRef.current = null;
        };
        // restartTick is intentionally part of the dep array to re-run the flow.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, restartTick]);
    const handleCopy = (value, target) => __awaiter(void 0, void 0, void 0, function* () {
        try {
            yield navigator.clipboard.writeText(value);
            setCopyFeedback(target);
            window.setTimeout(() => setCopyFeedback(null), COPY_FEEDBACK_MS);
        }
        catch (_a) {
            // Clipboard write can fail in iframes / private mode — best-effort.
        }
    });
    const handleOpenInTab = (url) => {
        try {
            window.open(url, "_blank", "noopener,noreferrer");
        }
        catch (_a) {
            // Popup blocked is the whole reason the operator chose this flow —
            // silently no-op; the URL is still on screen + copyable.
        }
    };
    const handleTryAgain = () => {
        setRestartTick((t) => t + 1);
    };
    const remainingMs = phase.kind === "polling" ? phase.challenge.expires_at - now : 0;
    return (React.createElement(Dialog, { open: open, onOpenChange: onOpenChange },
        React.createElement(DialogContent, { className: "max-w-md" },
            React.createElement(DialogHeader, null,
                React.createElement(DialogTitle, null, "Device code sign-in"),
                React.createElement(DialogDescription, null, "Visit the URL on another device (your phone, or another browser tab) and enter the code below to complete sign-in.")),
            phase.kind === "starting" && (React.createElement("div", { className: "flex items-center gap-2 py-6 text-sm text-muted-foreground" },
                React.createElement(Loader2, { className: "h-4 w-4 animate-spin", "aria-hidden": "true" }),
                "Requesting code from Azure AD\u2026")),
            phase.kind === "polling" && (React.createElement("div", { className: "flex flex-col gap-4" },
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Your code"),
                    React.createElement("div", { className: "flex items-center gap-2" },
                        React.createElement("code", { className: "flex-1 rounded-md border border-border bg-card/40 px-3 py-3 text-center font-mono text-2xl font-bold tracking-[0.3em] text-foreground", "aria-label": "Device code" }, phase.challenge.user_code),
                        React.createElement(Button, { variant: "outline", size: "icon", onClick: () => handleCopy(phase.challenge.user_code, "code"), "aria-label": "Copy code to clipboard" }, copyFeedback === "code" ? (React.createElement(CheckCircle2, { className: "h-4 w-4 text-success" })) : (React.createElement(Copy, { className: "h-4 w-4" }))))),
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Verification URL"),
                    React.createElement("div", { className: "flex items-center gap-2" },
                        React.createElement("code", { className: "flex-1 truncate rounded-md border border-border bg-card/40 px-3 py-2 font-mono text-xs text-foreground", title: phase.challenge.verification_uri }, phase.challenge.verification_uri),
                        React.createElement(Button, { variant: "outline", size: "icon-sm", onClick: () => handleCopy(phase.challenge.verification_uri, "url"), "aria-label": "Copy URL to clipboard" }, copyFeedback === "url" ? (React.createElement(CheckCircle2, { className: "h-3.5 w-3.5 text-success" })) : (React.createElement(Copy, { className: "h-3.5 w-3.5" }))),
                        React.createElement(Button, { variant: "outline", size: "icon-sm", onClick: () => handleOpenInTab(phase.challenge.verification_uri), "aria-label": "Open verification URL in new tab" },
                            React.createElement(ExternalLink, { className: "h-3.5 w-3.5" })))),
                React.createElement("div", { className: "flex items-center justify-between gap-3 text-xs text-muted-foreground" },
                    React.createElement("span", { className: "flex items-center gap-2" },
                        React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin", "aria-hidden": "true" }),
                        "Waiting for sign-in\u2026 (",
                        phase.polls,
                        " poll",
                        phase.polls === 1 ? "" : "s",
                        ")"),
                    React.createElement("span", { className: cn("font-mono tabular-nums", remainingMs <= 60000 && remainingMs > 0
                            ? "text-warning"
                            : remainingMs <= 0
                                ? "text-destructive"
                                : ""), "aria-live": "polite" }, formatRemaining(remainingMs))))),
            phase.kind === "success" && (React.createElement("div", { className: "flex items-center gap-2 py-6 text-sm" },
                React.createElement(CheckCircle2, { className: "h-5 w-5 text-success", "aria-hidden": "true" }),
                React.createElement("span", null,
                    "Signed in",
                    phase.upn ? (React.createElement(React.Fragment, null,
                        " as ",
                        React.createElement("strong", { className: "font-medium text-foreground" }, phase.upn))) : (""),
                    "."))),
            phase.kind === "error" && (React.createElement("div", { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex items-start gap-2 text-sm text-destructive" },
                    React.createElement(AlertCircle, { className: "mt-0.5 h-4 w-4 shrink-0", "aria-hidden": "true" }),
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement("span", { className: "font-medium" },
                            "Device code sign-in failed",
                            phase.code ? ` (${phase.code})` : "",
                            "."),
                        React.createElement("span", { className: "text-xs text-destructive/90" }, phase.message))))),
            React.createElement(DialogFooter, null,
                phase.kind === "error" && (React.createElement(Button, { variant: "default", size: "sm", onClick: handleTryAgain }, "Try again")),
                React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => onOpenChange(false), disabled: phase.kind === "success" }, phase.kind === "success" ? "Closing…" : "Cancel")))));
};
//# sourceMappingURL=device-code-dialog.js.map