import { __awaiter } from "tslib";
/**
 * AcceptOwnershipPanel — destination-tenant companion to the cross-tenant
 * EA / MCA creation flow.
 *
 * Microsoft's documented contract: when an alias is created with
 * `subscriptionTenantId` pointing to a different tenant, the new owner has
 * 7 days to accept ownership. The accept-ownership API requires a token
 * from the DESTINATION tenant — i.e. the operator running this WebUI must
 * be signed in as the invited owner (or a delegate in that tenant).
 *
 * Flow:
 *   1. Operator pastes / types the subscriptionId.
 *   2. We call GET /acceptOwnershipStatus to verify the request exists and
 *      is still in `Pending` state.
 *   3. If pending, render an "Accept ownership" form (optional rename +
 *      management group) and call POST /acceptOwnership on submit.
 *   4. Audit each step; never throw — surface failures via toast.
 *
 * Extracted from the monolithic ea-subscription-page.tsx so that typing in
 * the parent form (alias name, recipients, etc.) does not re-mount the
 * memoised handlers inside this panel. Each open of the panel still
 * contains its own self-contained subId / checking / accepting state.
 */
import * as React from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, ExternalLink, Hourglass, Inbox, Loader2, RefreshCw, ShieldCheck, } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getArmTokenForAccount } from "../../auth/msal-auth";
import { auditLog } from "../../services/audit-log";
import { acceptSubscriptionOwnership, getAcceptOwnershipStatus, } from "../../services/arm-service";
import { CopyableId } from "./copyable-id";
import { azurePortalLinkForSubscription, suggestRemediation } from "./ea-helpers";
const SUB_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AcceptOwnershipPanel = ({ account, store, }) => {
    var _a;
    const [open, setOpen] = React.useState(false);
    const [subId, setSubId] = React.useState("");
    const [checking, setChecking] = React.useState(false);
    const [accepting, setAccepting] = React.useState(false);
    const [status, setStatus] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [renameTo, setRenameTo] = React.useState("");
    const subIdValid = React.useMemo(() => SUB_ID_REGEX.test(subId.trim()), [subId]);
    const handleCheck = React.useCallback((forceRefresh = false) => __awaiter(void 0, void 0, void 0, function* () {
        var _b, _c;
        if (!subIdValid) {
            setError("Subscription ID must be a UUID (8-4-4-4-12).");
            return;
        }
        setChecking(true);
        setError(null);
        setStatus(null);
        // Audit kickoff so the action is in the timeline even if the
        // token acquire throws below (this matters when AADSTS hits).
        auditLog.record({
            actor: account.username || account.name || account.homeAccountId,
            action: "accept_ownership_check_start",
            target: subId.trim(),
            status: "success",
            details: {
                tenantId: account.tenantId,
                forceRefresh,
            },
        });
        try {
            // Cross-tenant: the accept-ownership API requires a token from
            // the DESTINATION tenant (where the new subscription is intended
            // to land). The active account in this WebUI MUST be in that
            // tenant — we don't auto-switch tenants here. If the operator
            // hits a 401, the most common cause is a stale token from a
            // different tenant; forceRefresh re-mints under the active one.
            const token = yield getArmTokenForAccount(account.homeAccountId, account.tenantId, { forceRefresh });
            const res = yield getAcceptOwnershipStatus(subId.trim(), token);
            setStatus(res);
            if (res.displayName && !renameTo) {
                // Pre-fill rename input with the current name so the operator
                // sees what would land if they accept without editing.
                setRenameTo(res.displayName);
            }
            auditLog.record({
                actor: account.username || account.name || account.homeAccountId,
                action: "accept_ownership_check",
                target: subId.trim(),
                status: "success",
                details: {
                    tenantId: account.tenantId,
                    state: res.acceptOwnershipState,
                    billingOwner: (_b = res.billingOwner) !== null && _b !== void 0 ? _b : null,
                    destinationTenantId: (_c = res.subscriptionTenantId) !== null && _c !== void 0 ? _c : null,
                    forceRefresh,
                },
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
            auditLog.record({
                actor: account.username || account.name || account.homeAccountId,
                action: "accept_ownership_check",
                target: subId.trim(),
                status: "failure",
                error: msg,
                details: { tenantId: account.tenantId, forceRefresh },
            });
        }
        finally {
            setChecking(false);
        }
    }), [account, subId, subIdValid, renameTo]);
    const handleAccept = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _d;
        if (!status || status.acceptOwnershipState !== "Pending")
            return;
        setAccepting(true);
        setError(null);
        // Audit start so the partial-failure case (token fine, ARM throws)
        // is still attributable in the timeline.
        auditLog.record({
            actor: account.username || account.name || account.homeAccountId,
            action: "accept_ownership_start",
            target: status.subscriptionId,
            status: "success",
            details: {
                tenantId: account.tenantId,
                renamedTo: renameTo.trim() || undefined,
                previousDisplayName: (_d = status.displayName) !== null && _d !== void 0 ? _d : null,
            },
        });
        try {
            // Per Microsoft's docs, the accept-ownership token MUST be from the
            // destination tenant. We force-refresh so a fresh claim set is in
            // play — common AADSTS70000 fix when this would otherwise 401.
            const token = yield getArmTokenForAccount(account.homeAccountId, account.tenantId, { forceRefresh: true });
            yield acceptSubscriptionOwnership(status.subscriptionId, {
                displayName: renameTo.trim() && renameTo.trim() !== status.displayName
                    ? renameTo.trim()
                    : undefined,
            }, token);
            // Re-check status — it should now be Completed.
            const refreshed = yield getAcceptOwnershipStatus(status.subscriptionId, token);
            setStatus(refreshed);
            store.addNotification({
                type: "success",
                message: `Accepted ownership of ${status.subscriptionId}. Subscription is now in your tenant.`,
            });
            auditLog.record({
                actor: account.username || account.name || account.homeAccountId,
                action: "accept_ownership",
                target: status.subscriptionId,
                status: "success",
                details: {
                    tenantId: account.tenantId,
                    renamedTo: renameTo.trim() || undefined,
                    finalState: refreshed.acceptOwnershipState,
                },
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
            store.addNotification({
                type: "error",
                message: `Accept ownership failed: ${msg}`,
            });
            auditLog.record({
                actor: account.username || account.name || account.homeAccountId,
                action: "accept_ownership",
                target: status.subscriptionId,
                status: "failure",
                error: msg,
                details: { tenantId: account.tenantId },
            });
        }
        finally {
            setAccepting(false);
        }
    }), [account, status, renameTo, store]);
    // Tone of the "current state" badge.
    const stateTone = (status === null || status === void 0 ? void 0 : status.acceptOwnershipState) === "Pending"
        ? "warning"
        : (status === null || status === void 0 ? void 0 : status.acceptOwnershipState) === "Completed"
            ? "success"
            : (status === null || status === void 0 ? void 0 : status.acceptOwnershipState) === "Expired"
                ? "destructive"
                : "muted";
    return (React.createElement(Card, { className: "border-warning/30 bg-warning/5 transition-colors duration-200 ease-out" },
        React.createElement(CardHeader, null,
            React.createElement("button", { type: "button", className: "flex w-full items-start gap-3 text-left", onClick: () => setOpen((o) => !o), "aria-expanded": open },
                React.createElement("span", { "aria-hidden": true, className: "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning" },
                    React.createElement(Inbox, { className: "h-4 w-4", "aria-hidden": true })),
                React.createElement("div", { className: "flex flex-1 flex-col gap-0.5" },
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement("span", null, "Accept incoming subscription"),
                        React.createElement(ChevronRight, { className: cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ease-out", open && "rotate-90"), "aria-hidden": true })),
                    React.createElement(CardDescription, null, "Paste a subscription ID someone provisioned for you in another tenant. We'll check pending status and let you accept ownership inline. Token comes from the currently-selected account (must be in the destination tenant).")))),
        open && (React.createElement(CardContent, { className: "flex flex-col gap-3" },
            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                React.createElement("div", { className: "relative min-w-[280px] flex-1" },
                    React.createElement(Input, { type: "text", placeholder: "00000000-0000-0000-0000-000000000000", value: subId, onChange: (e) => {
                            setSubId(e.target.value);
                            setError(null);
                        }, "aria-label": "Subscription ID", "aria-invalid": subId.length > 0 && !subIdValid ? true : undefined, className: "font-mono" })),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => void handleCheck(false), disabled: !subIdValid || checking || accepting, "aria-label": "Check acceptance status", className: "gap-1" },
                    checking ? (React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin motion-reduce:animate-none" })) : (React.createElement(Hourglass, { className: "h-3.5 w-3.5" })),
                    "Check status"),
                React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => void handleCheck(true), disabled: !subIdValid || checking || accepting, "aria-label": "Force-refresh ARM token and re-check", className: "gap-1" },
                            React.createElement(RefreshCw, { className: "h-3.5 w-3.5" }),
                            "Force refresh")),
                    React.createElement(TooltipContent, { className: "max-w-xs" }, "Bypass MSAL silent cache and acquire a brand-new ARM token before checking. Use when a previous check returned 401 / AADSTS \u2014 common when the destination- tenant role assignment was granted after the cached token was minted."))),
            error && (React.createElement("div", { className: "flex flex-col gap-1" },
                React.createElement(ErrorState, { message: "Status check failed", detail: error, size: "compact" }),
                (() => {
                    const tip = suggestRemediation(error);
                    return tip ? (React.createElement("p", { className: "rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-2xs text-destructive/90" },
                        React.createElement("span", { className: "font-semibold" }, "How to fix: "),
                        tip)) : null;
                })())),
            status && (React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2.5" },
                React.createElement("div", { className: "flex flex-wrap items-center gap-2 text-xs" },
                    React.createElement("span", { className: "font-medium text-foreground" }, "Status:"),
                    React.createElement("span", { className: cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider ring-1", stateTone === "warning" &&
                            "bg-warning/10 text-warning ring-warning/30", stateTone === "success" &&
                            "bg-success/10 text-success ring-success/30", stateTone === "destructive" &&
                            "bg-destructive/10 text-destructive ring-destructive/30", stateTone === "muted" &&
                            "bg-muted/40 text-muted-foreground ring-border") }, status.acceptOwnershipState),
                    status.billingOwner && (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        "invited by",
                        " ",
                        React.createElement("span", { className: "font-mono text-foreground" }, status.billingOwner)))),
                React.createElement("div", { className: "flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground" },
                    React.createElement("span", { className: "flex items-center gap-1.5" },
                        React.createElement("span", null, "Subscription ID:"),
                        React.createElement(CopyableId, { value: status.subscriptionId, label: "subscription id" })),
                    status.acceptOwnershipState === "Completed" && (React.createElement("a", { href: azurePortalLinkForSubscription(status.subscriptionId), target: "_blank", rel: "noopener noreferrer", className: cn("inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-2xs font-medium text-foreground", "transition-all duration-200 ease-out hover:border-primary hover:bg-accent/5 hover:text-primary"), "aria-label": "Open in Azure Portal" },
                        React.createElement(ExternalLink, { className: "h-3 w-3", "aria-hidden": true }),
                        "Open in Portal"))),
                status.displayName && (React.createElement("div", { className: "flex items-center gap-2 text-2xs text-muted-foreground" },
                    React.createElement("span", null, "Display name:"),
                    React.createElement("span", { className: "font-mono text-foreground" }, status.displayName))),
                status.subscriptionTenantId && (React.createElement("div", { className: "flex items-center gap-2 text-2xs text-muted-foreground" },
                    React.createElement("span", null, "Destination tenant:"),
                    React.createElement("code", { className: "rounded bg-background px-1.5 py-0.5 font-mono text-foreground" }, status.subscriptionTenantId),
                    status.subscriptionTenantId.toLowerCase() !==
                        account.tenantId.toLowerCase() && (React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("span", { className: "flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full bg-warning/20 text-warning", "aria-label": "Tenant mismatch" },
                                React.createElement(AlertTriangle, { className: "h-2.5 w-2.5", "aria-hidden": true }))),
                        React.createElement(TooltipContent, { className: "max-w-xs" },
                            "The destination tenant does NOT match your active account tenant (",
                            account.tenantId,
                            "). Acceptance will fail with 401. Switch this account's active tenant to",
                            " ",
                            status.subscriptionTenantId,
                            ", or sign in with an account in that tenant, then retry."))))),
                status.acceptOwnershipState === "Pending" && (React.createElement("div", { className: "mt-1 flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2" },
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement(Label, { htmlFor: "accept-rename", className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Display name (optional rename)"),
                        React.createElement(Input, { id: "accept-rename", type: "text", value: renameTo, onChange: (e) => setRenameTo(e.target.value), disabled: accepting, className: "text-xs", placeholder: (_a = status.displayName) !== null && _a !== void 0 ? _a : "Leave unchanged" })),
                    React.createElement(Button, { type: "button", variant: "default", size: "sm", disabled: accepting, onClick: () => void handleAccept(), "aria-label": "Accept ownership of this subscription", className: "gap-1 self-end" },
                        accepting ? (React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin motion-reduce:animate-none" })) : (React.createElement(ShieldCheck, { className: "h-3.5 w-3.5" })),
                        "Accept ownership"))),
                status.acceptOwnershipState === "Completed" && (React.createElement("div", { className: "mt-1 flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-2xs text-success", role: "status" },
                    React.createElement(CheckCircle2, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                    React.createElement("span", null, "This subscription is fully owned in your tenant \u2014 nothing more to do."))),
                status.acceptOwnershipState === "Expired" && (React.createElement("div", { className: "mt-1 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-2xs text-destructive", role: "status" },
                    React.createElement(AlertTriangle, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                    React.createElement("span", null, "The 7-day acceptance window has elapsed. The source operator must re-create the subscription with a fresh invitation."))))),
            React.createElement("p", { className: "text-2xs text-muted-foreground" },
                React.createElement("span", { className: "font-medium" }, "How this works:"),
                " when someone in another tenant runs \"Create EA Subscription\" with you as the recipient, Azure mints the subscription pinned to their billing scope but with you as the designated owner. The subscription enters",
                " ",
                React.createElement("code", { className: "font-mono" }, "Pending"),
                " for 7 days; you accept here (or via the email link) to move it into your tenant.")))));
};
//# sourceMappingURL=accept-ownership-panel.js.map