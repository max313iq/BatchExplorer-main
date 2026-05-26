/**
 * Defender-side surface: recently soft-deleted users (the 30-day recovery
 * window). Wired from the offensive-tooling corpus as a READ-ONLY signal
 * for an operator running this tool against THEIR OWN tenant — the page
 * never invokes the hard-delete / restore primitive itself; it surfaces
 * the trail and provides a portal deep-link so any remediation is done
 * by the operator in the audited Azure Portal UI.
 *
 * Corpus citations (see CLAUDE.md "Primary research resource"):
 *
 *   - `_AZURE_BYPASS_PLAYBOOK.md` §"Critical Defender Audit Surface" item 9
 *     ("Hard delete user" Entra audit event) — this is one of the top
 *     ten signals a defensive program should alert on.
 *
 *   - `_bypass_modify_delete.md` §4.7 — soft-delete moves a user to
 *     `/directory/deletedItems/microsoft.graph.user` for 30 days before
 *     permanent removal. The attacker tactic the playbook calls out is
 *     "Defender's investigation may miss the user during this window."
 *
 *   - `_bypass_modify_delete.md` §4.9 — permanent hard-delete (`DELETE
 *     /v1.0/directory/deletedItems/<user-id>`) is unrecoverable; the
 *     playbook flags it as "evidence destruction (last resort, scorched
 *     earth)." This panel is the inverse of that capability: it lets the
 *     defender see WHO is sitting in the soft-delete bucket so they
 *     either restore them (portal) or notice an unexplained delete.
 *
 *   - Canonical corpus tool for user lifecycle is Gerenios/AADInternals
 *     (see CLAUDE.md curated index "Gerenios\ — 4 .md files / 3 repos").
 *     The wire shape (object id + displayName + UPN-at-deletion +
 *     deletedDateTime) matches what AADInternals' Get-AADIntUsers/
 *     -DeletedUsers cmdlets surface; same shape as Graph's
 *     `/directory/deletedItems/microsoft.graph.user`.
 *
 * Severity model (defender perspective — corpus item 9):
 *
 *   - critical = the deleted user held a Tier-0 directory role at the
 *     moment of deletion (Global Admin, Privileged Authentication Admin,
 *     User Administrator, etc.). Attackers commonly delete the user
 *     they were imitating right before a hard-delete to break sign-in
 *     correlation in the audit log. Tier-0 role detection is not
 *     available in the current Graph scope, so this column shows the
 *     last-known role list from the audit log enrichment (see
 *     `rolesAtDeletion` in the row shape) if the operator's corpus
 *     extension has populated it; otherwise the badge stays at "high"
 *     or "medium" based on recency.
 *
 *   - high = deleted in the last 7 days (operator should still be able
 *     to talk to the user / their manager about it).
 *
 *   - medium = deleted in last 30 days but older than 7 days.
 *
 * Permission gate: requires `Directory.AccessAsUser.All` (delegated) or
 * `User.Read.All` (app-only) on the caller. When the caller does not
 * have those grants, the panel surfaces a "Permission required" hint
 * instead of silently failing.
 *
 * IMPORTANT — defensive-only constraint: this component MUST NEVER
 * call `DELETE /v1.0/directory/deletedItems/<id>` (hard-delete) or
 * `POST /directory/deletedItems/<id>/restore`. Restore surfaces as a
 * portal deep-link the operator clicks through; the audit-log entry
 * is for the *click* (operator intent), not for any state change made
 * by this WebUI.
 */
import * as React from "react";
import { AlertTriangle, Eraser, ExternalLink, Info, Loader2, ShieldAlert, Trash2, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn, formatRelativeTime } from "@/lib/utils";
import { auditLog } from "../../services/audit-log";
import { CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
/**
 * Tier-0 directory-role template ids (subset). The full canonical list
 * lives in the corpus playbooks under `_bypass_role_grant.md`. We only
 * carry the ones a soft-deleted user is plausibly carrying at the
 * moment of deletion.
 */
const TIER0_ROLE_TEMPLATE_IDS = new Set([
    // Global Administrator
    "62e90394-69f5-4237-9190-012177145e10",
    // Privileged Authentication Administrator
    "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
    // Privileged Role Administrator
    "e8611ab8-c189-46e8-94e1-60213ab1f814",
    // User Administrator
    "fe930be7-5e62-47db-91af-98c3a49a38b1",
    // Application Administrator
    "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
    // Hybrid Identity Administrator
    "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2",
]);
const MS_PER_DAY = 86400000;
const SOFT_DELETE_RETENTION_DAYS = 30;
const HIGH_SEVERITY_WINDOW_DAYS = 7;
function scoreRow(row, nowMs) {
    var _a, _b;
    const deletedMs = Date.parse(row.deletedDateTime);
    const valid = Number.isFinite(deletedMs);
    const ageDays = valid ? Math.max(0, (nowMs - deletedMs) / MS_PER_DAY) : NaN;
    const daysRemaining = valid
        ? Math.max(0, SOFT_DELETE_RETENTION_DAYS - ageDays)
        : NaN;
    // Critical wins regardless of recency: deleting a Tier-0-role-holder is
    // the high-confidence attacker tell (corpus §4.9 evidence-destruction).
    const heldTier0 = (_b = (_a = row.rolesAtDeletion) === null || _a === void 0 ? void 0 : _a.some((id) => TIER0_ROLE_TEMPLATE_IDS.has(id))) !== null && _b !== void 0 ? _b : false;
    if (heldTier0) {
        return { row, severity: "critical", daysRemaining, ageDays };
    }
    if (!valid) {
        return { row, severity: "unknown", daysRemaining, ageDays };
    }
    if (ageDays <= HIGH_SEVERITY_WINDOW_DAYS) {
        return { row, severity: "high", daysRemaining, ageDays };
    }
    return { row, severity: "medium", daysRemaining, ageDays };
}
const SEVERITY_BADGE = {
    critical: { label: "Critical", variant: "destructive" },
    high: { label: "High", variant: "warning" },
    medium: { label: "Medium", variant: "secondary" },
    unknown: { label: "Unknown", variant: "outline" },
};
/**
 * Portal deep-link for the tenant-scoped Deleted users blade. We
 * deliberately link to the LIST view (not a per-user "Restore" action
 * URL), because restore is a state-changing operation we will not
 * automate — the operator confirms in the audited portal UI.
 */
function portalDeletedUsersUrl(tenantId) {
    return `https://entra.microsoft.com/#@${encodeURIComponent(tenantId)}/blade/Microsoft_AAD_UsersAndTenants/UserManagementMenuBlade/DeletedUsers`;
}
export const DeletedUsersPanel = ({ tenantId, actor, rows, permissionGranted, loading, error, onRefresh, }) => {
    // Snapshot of "now" — one reference timestamp across all rows in this render.
    const nowMs = React.useMemo(() => Date.now(), [rows]);
    const scored = React.useMemo(() => {
        const out = rows.map((r) => scoreRow(r, nowMs));
        // Sort by severity (critical > high > medium > unknown), then most
        // recent deletion first within each severity bucket.
        const severityOrder = {
            critical: 0,
            high: 1,
            medium: 2,
            unknown: 3,
        };
        out.sort((a, b) => {
            const s = severityOrder[a.severity] - severityOrder[b.severity];
            if (s !== 0)
                return s;
            return (Date.parse(b.row.deletedDateTime) - Date.parse(a.row.deletedDateTime));
        });
        return out;
    }, [rows, nowMs]);
    const counts = React.useMemo(() => {
        const c = { critical: 0, high: 0, medium: 0, unknown: 0 };
        for (const s of scored)
            c[s.severity] += 1;
        return c;
    }, [scored]);
    // ---- Render branches ---------------------------------------------------
    if (!permissionGranted) {
        return (React.createElement("div", { className: "flex flex-col gap-2 rounded-lg border border-dashed border-warning/40 bg-warning/5 px-4 py-3" },
            React.createElement("div", { className: "flex items-center gap-2 text-sm font-semibold text-warning" },
                React.createElement(ShieldAlert, { className: "h-4 w-4", "aria-hidden": true }),
                "Deleted users (last 30 days)"),
            React.createElement(Alert, { variant: "default", className: "border-warning/30 bg-warning/10 py-2" },
                React.createElement(Info, { className: "h-4 w-4 text-warning" }),
                React.createElement(AlertDescription, { className: "text-2xs" },
                    "Permission required. The current Graph token does not appear to hold ",
                    React.createElement("code", { className: "font-mono" }, "Directory.AccessAsUser.All"),
                    " ",
                    "or ",
                    React.createElement("code", { className: "font-mono" }, "User.Read.All"),
                    ". The deleted-users surface needs read access to",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "/directory/deletedItems/microsoft.graph.user"),
                    " ",
                    "(a 30-day recovery window \u2014 see corpus",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "_bypass_modify_delete.md"),
                    " \u00A74.7)."))));
    }
    return (React.createElement("div", { className: "flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-sm" },
        React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
            React.createElement("div", { className: "flex items-center gap-2" },
                React.createElement(Trash2, { className: "h-4 w-4 text-warning", "aria-hidden": true }),
                React.createElement("span", { className: "text-sm font-semibold text-foreground" }, "Deleted users (last 30 days)"),
                React.createElement(Badge, { variant: "outline", className: "tabular-nums" }, rows.length),
                counts.critical > 0 && (React.createElement(Badge, { variant: "destructive", className: "gap-1" },
                    React.createElement(ShieldAlert, { className: "h-3 w-3", "aria-hidden": true }),
                    counts.critical,
                    " critical")),
                counts.high > 0 && (React.createElement(Badge, { variant: "warning", className: "tabular-nums" },
                    counts.high,
                    " high"))),
            React.createElement("div", { className: "flex items-center gap-2" },
                loading && (React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs text-muted-foreground" },
                    React.createElement(Loader2, { className: "h-3 w-3 animate-spin", "aria-hidden": true }),
                    "Loading\u2026")),
                onRefresh && !loading && (React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: onRefresh, "aria-label": "Refresh deleted users" }, "Refresh")),
                tenantId && (React.createElement(TooltipProvider, { delayDuration: 250 },
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement(Button, { type: "button", variant: "outline", size: "xs", asChild: true, "aria-label": "Open Deleted users in Entra Portal" },
                                React.createElement("a", { href: portalDeletedUsersUrl(tenantId), target: "_blank", rel: "noreferrer noopener", onClick: () => {
                                        // Audit the operator's click on the list-level
                                        // portal link — distinct from per-row restore
                                        // links because it means "I'm reviewing the
                                        // whole bucket" rather than acting on one user.
                                        if (!tenantId)
                                            return;
                                        auditLog.record({
                                            actor: actor !== null && actor !== void 0 ? actor : "unknown",
                                            action: "deleted_users_portal_view",
                                            target: tenantId,
                                            status: "success",
                                            details: {
                                                tenantId,
                                                source: "tenant-users:deleted-panel",
                                                mode: "portal-deep-link",
                                            },
                                        });
                                    } },
                                    React.createElement(ExternalLink, { className: "h-3 w-3", "aria-hidden": true }),
                                    "Open in Entra Portal"))),
                        React.createElement(TooltipContent, { side: "bottom" }, "Opens the tenant-scoped Deleted users blade. Restore is a state-changing operation; this WebUI never invokes it directly \u2014 perform it in the audited portal UI.")))))),
        error && (React.createElement(Alert, { variant: "destructive", className: "py-2" },
            React.createElement(AlertTriangle, { className: "h-4 w-4" }),
            React.createElement(AlertDescription, { className: "text-2xs" }, error))),
        scored.length === 0 && !loading && !error ? (React.createElement(EmptyState, { icon: Eraser, title: "No recently deleted users", description: "No users are sitting in the 30-day soft-delete recovery window for this tenant. An unexplained deletion appearing here is a known attacker tactic \u2014 see corpus _bypass_modify_delete.md \u00A74.9." })) : (React.createElement("ul", { role: "list", "aria-label": "Deleted users in the 30-day recovery window", className: "flex flex-col gap-1" }, scored.map(({ row, severity, daysRemaining, ageDays }) => {
            var _a, _b;
            const badge = SEVERITY_BADGE[severity];
            const displayUpn = row.userPrincipalName || "(no UPN at deletion)";
            const displayName = row.displayName || "(unnamed)";
            const heldTier0 = (_b = (_a = row.rolesAtDeletion) === null || _a === void 0 ? void 0 : _a.some((id) => TIER0_ROLE_TEMPLATE_IDS.has(id))) !== null && _b !== void 0 ? _b : false;
            return (React.createElement("li", { key: row.id, className: cn("flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2", severity === "critical"
                    ? "border-destructive/40 bg-destructive/5"
                    : severity === "high"
                        ? "border-warning/30 bg-warning/5"
                        : "border-border") },
                React.createElement(Badge, { variant: badge.variant, className: "shrink-0 uppercase" }, badge.label),
                React.createElement("div", { className: "flex min-w-0 flex-1 flex-col" },
                    React.createElement("span", { className: "truncate text-xs text-foreground" }, displayName),
                    React.createElement("span", { className: "truncate font-mono text-2xs text-muted-foreground" }, displayUpn),
                    heldTier0 && (React.createElement("span", { className: "mt-0.5 inline-flex items-center gap-1 text-2xs text-destructive" },
                        React.createElement(ShieldAlert, { className: "h-3 w-3", "aria-hidden": true }),
                        "Held a Tier-0 directory role at deletion"))),
                React.createElement("div", { className: "flex flex-col items-end gap-0.5 text-2xs tabular-nums text-muted-foreground" },
                    React.createElement("span", { title: new Date(row.deletedDateTime).toLocaleString() },
                        "Deleted",
                        " ",
                        Number.isFinite(ageDays)
                            ? formatRelativeTime(row.deletedDateTime)
                            : "(unknown date)"),
                    Number.isFinite(daysRemaining) && (React.createElement("span", { className: cn(daysRemaining <= 3
                            ? "text-destructive"
                            : daysRemaining <= 7
                                ? "text-warning"
                                : "text-muted-foreground") },
                        Math.ceil(daysRemaining),
                        "d until permanent purge"))),
                React.createElement(CopyButton, { value: row.id, ariaLabel: `Copy object id for ${displayName}`, alwaysVisible: false, iconSize: 14 })));
        }))),
        React.createElement("p", { className: "border-t border-border pt-2 text-2xs text-muted-foreground" },
            "Source: defender-perspective synthesis of",
            " ",
            React.createElement("code", { className: "font-mono" }, "_AZURE_BYPASS_PLAYBOOK.md"),
            " item 9 +",
            " ",
            React.createElement("code", { className: "font-mono" }, "_bypass_modify_delete.md"),
            " \u00A74.7/4.9 +",
            " ",
            React.createElement("code", { className: "font-mono" }, "_analysis_aadinternals.md"),
            ". Restore / hard-delete primitives are deliberately NOT invoked here.")));
};
//# sourceMappingURL=tenant-users-deleted-panel.js.map