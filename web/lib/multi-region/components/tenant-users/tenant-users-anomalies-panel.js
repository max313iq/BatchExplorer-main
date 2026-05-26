import { __awaiter } from "tslib";
/**
 * Defender-side surface: tenant-user anomaly hunt. Operator-triggered (never
 * runs automatically on render) because the most expensive detector here
 * issues a Graph `$batch` round-trip for every visible guest's role
 * memberships — useful, but not free.
 *
 * Three detectors, every one wired to the offensive-tooling corpus:
 *
 *   1. **External (guest) users holding admin-tier directory roles.**
 *      The corpus ranks "Stale guest with role" as the #3 stealth foothold
 *      across all cross-tenant tricks (`_bypass_tenant_switch.md` §11 table
 *      and §12 item 2 — "find dormant guest accounts with active roles;
 *      revive via password reset"). Defender-side this is the highest-
 *      value signal on a tenant user list: a guest UPN (#EXT# or
 *      mismatched-mail-domain) plus Tier-0 / Tier-1 role membership.
 *      Tier-0 ids come from `_bypass_role_grant.md` and are the same set
 *      we score in `tenant-users-deleted-panel.tsx`.
 *
 *   2. **Disabled accounts with subscription-role footholds.**
 *      `accountEnabled === false` users normally have no operational
 *      value to a defender; a disabled user that still owns subscription
 *      role assignments is a configuration leak ("ghost owner") that the
 *      corpus calls out under `_bypass_modify_delete.md` §4 lifecycle ops
 *      — the move there is "soft-disable rather than delete, then leave
 *      role assignments behind for later reactivation." We surface them
 *      so the defender can clean them up.
 *
 *   3. **Rapid create-then-delete on the same UPN.**
 *      Cross-references this WebUI's local audit log (`create_user`
 *      entries from User Creator) against the soft-delete bucket
 *      (`deletedRows` — Graph `/directory/deletedItems/microsoft.graph.user`).
 *      When a `create_user` audit entry and a soft-delete share a UPN
 *      and the delete happened within `RAPID_WINDOW_HOURS` of the
 *      create, that's a textbook cleanup of attacker scaffolding —
 *      `_bypass_modify_delete.md` §4.7 calls out "Defender's investigation
 *      may miss the user during this window" as the explicit attacker
 *      tactic. The signal only fires when both halves are observable, so
 *      this is deliberately conservative (will miss out-of-band creates
 *      whose audit entry never reached this WebUI).
 *
 * Defensive-only constraints (same as `tenant-users-deleted-panel.tsx`):
 *
 *   - This panel NEVER calls a state-changing primitive. No PATCH, no
 *     DELETE, no POST. The only Graph traffic is the batched memberOf GET
 *     in detector #1, and we already have that bulk API in the service
 *     layer (`getUserDirectoryRolesBatched`).
 *
 *   - Remediation is portal deep-links — the operator clicks through and
 *     the audit-log entry records their *intent*, not any change made by
 *     this WebUI.
 */
import * as React from "react";
import { AlertTriangle, Cloud, ExternalLink, Loader2, ShieldAlert, Sparkles, Trash2, UserCog, UserX, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn, formatRelativeTime } from "@/lib/utils";
import { auditLog } from "../../services/audit-log";
import { getGraphTokenForAccount, } from "../../auth/msal-auth";
import { getUserDirectoryRolesBatched, } from "../../services/graph-service";
import { CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
// =============================================================================
// Constants — Tier-0 role template ids
// =============================================================================
//
// Same canonical set used in `tenant-users-deleted-panel.tsx`. Kept in
// a local copy (instead of importing) so this panel is self-contained
// and the deleted-panel can evolve its own list without dragging the
// anomaly heuristic along. Corpus: `_bypass_role_grant.md` Tier-0
// catalogue.
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
    // Cloud Application Administrator
    "158c047a-c907-4556-b7ef-446551a6b5f7",
    // Conditional Access Administrator
    "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9",
    // Exchange Administrator
    "29232cdf-9323-42fd-ade2-1d097af3e4de",
    // SharePoint Administrator
    "f28a1f50-f6e7-4571-818b-6a12f2af6b6c",
]);
// Window inside which a soft-delete that follows a `create_user` audit
// entry counts as "rapid". Corpus §4.7 says the 30-day soft-delete bucket
// is the attacker's hiding window — we tighten the rapid-cleanup
// heuristic to a 24-hour follow-up so we surface the high-signal cases
// without drowning in long-tail noise from routine deprovisioning.
const RAPID_WINDOW_HOURS = 24;
const MS_PER_HOUR = 3600000;
// Portal deep-link to a single user's role assignments blade. Used for
// the "Open in Entra Portal" affordance on guest-admin findings.
function portalUserRolesUrl(tenantId, userId) {
    return (`https://entra.microsoft.com/#@${encodeURIComponent(tenantId)}` +
        `/blade/Microsoft_AAD_UsersAndTenants/UserAssignedRolesMenuBlade/` +
        `overview/userId/${encodeURIComponent(userId)}`);
}
// =============================================================================
// Pure detectors (cheap, no async)
// =============================================================================
/**
 * Detector #2 — disabled accounts that still own subscription roles.
 * Pure / cheap: runs on every render of the visible row set.
 */
function detectDisabledWithSubs(rows) {
    const out = [];
    for (const u of rows) {
        if (u.accountEnabled)
            continue;
        if (u.subscriptionCount <= 0)
            continue;
        out.push({
            kind: "disabled-with-subs",
            // ≥3 sub-role assignments on a disabled account is the loud case
            // (the user is effectively a privileged ghost); 1–2 is high.
            severity: u.subscriptionCount >= 3 ? "critical" : "high",
            user: u,
        });
    }
    return out;
}
/**
 * Detector #3 — rapid create→delete on the same UPN.
 *
 * Source signals:
 *   - this WebUI's local audit log (`create_user` entries with target = UPN)
 *   - the deleted-users surface (`/directory/deletedItems/microsoft.graph.user`)
 *
 * We cross-reference by UPN (case-insensitive) and emit a finding when
 * the delete falls inside `RAPID_WINDOW_HOURS` of the create. This is
 * deliberately one-sided: the WebUI doesn't observe out-of-band creates,
 * so we can never claim "no rapid create→delete in this tenant" — we
 * can only surface the ones whose create *we* logged.
 */
function detectRapidCreateDelete(auditEntries, deletedRows) {
    var _a, _b;
    if (deletedRows.length === 0)
        return [];
    // Index deletes by lowercase UPN.
    const deletedByUpn = new Map();
    for (const d of deletedRows) {
        const k = ((_a = d.userPrincipalName) !== null && _a !== void 0 ? _a : "").toLowerCase();
        if (!k)
            continue;
        // Keep the most-recent deletion for a UPN (in case the same UPN
        // was recreated-and-redeleted multiple times — operators sometimes
        // recycle).
        const existing = deletedByUpn.get(k);
        if (!existing ||
            Date.parse(d.deletedDateTime) > Date.parse(existing.deletedDateTime)) {
            deletedByUpn.set(k, d);
        }
    }
    const findings = [];
    for (const e of auditEntries) {
        if (e.action !== "create_user")
            continue;
        if (e.status !== "success")
            continue;
        const upn = ((_b = e.target) !== null && _b !== void 0 ? _b : "").toLowerCase();
        if (!upn)
            continue;
        const del = deletedByUpn.get(upn);
        if (!del)
            continue;
        const createdMs = Date.parse(e.timestamp);
        const deletedMs = Date.parse(del.deletedDateTime);
        if (!Number.isFinite(createdMs) || !Number.isFinite(deletedMs))
            continue;
        // Only fire when the delete FOLLOWS the create (sanity check).
        if (deletedMs <= createdMs)
            continue;
        const deltaH = (deletedMs - createdMs) / MS_PER_HOUR;
        if (deltaH > RAPID_WINDOW_HOURS)
            continue;
        findings.push({
            kind: "rapid-create-delete",
            // Critical when the delete arrived inside an hour of the create —
            // that's "set up + tear down" attacker tempo. High otherwise.
            severity: deltaH <= 1 ? "critical" : "high",
            upn: e.target,
            createdAt: e.timestamp,
            deletedAt: del.deletedDateTime,
            deltaHours: deltaH,
            deletedRow: del,
        });
    }
    // Newest first.
    findings.sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
    return findings;
}
// =============================================================================
// Severity ordering + presentation
// =============================================================================
const SEVERITY_ORDER = {
    critical: 0,
    high: 1,
    medium: 2,
};
const SEVERITY_BADGE = {
    critical: { label: "Critical", variant: "destructive" },
    high: { label: "High", variant: "warning" },
    medium: { label: "Medium", variant: "secondary" },
};
// =============================================================================
// Panel
// =============================================================================
export const TenantUsersAnomaliesPanel = ({ tenantId, homeAccountId, actor, rows, deletedRows, auditEntries }) => {
    const [guestAdminFindings, setGuestAdminFindings] = React.useState([]);
    const [guestProbeAt, setGuestProbeAt] = React.useState(null);
    const [probing, setProbing] = React.useState(false);
    const [probeError, setProbeError] = React.useState(null);
    // Bumped whenever the host's row set changes meaningfully — used to
    // mark a previous probe as "stale" so the UI can dim it.
    const rowFingerprintRef = React.useRef("");
    const [probeStale, setProbeStale] = React.useState(false);
    // Compute a cheap fingerprint over the guest set the operator would
    // probe. We don't auto-rerun the probe; we just dim the previous result
    // when the underlying set changes so the operator knows to re-hunt.
    const guestFingerprint = React.useMemo(() => {
        const ids = rows
            .filter((u) => u.isGuest)
            .map((u) => u.id)
            .sort();
        return ids.join(",");
    }, [rows]);
    React.useEffect(() => {
        if (rowFingerprintRef.current === "") {
            rowFingerprintRef.current = guestFingerprint;
            return;
        }
        if (rowFingerprintRef.current !== guestFingerprint) {
            rowFingerprintRef.current = guestFingerprint;
            if (guestProbeAt !== null)
                setProbeStale(true);
        }
    }, [guestFingerprint, guestProbeAt]);
    // ---- Cheap detectors run every render ----------------------------------
    const disabledWithSubsFindings = React.useMemo(() => detectDisabledWithSubs(rows), [rows]);
    const rapidFindings = React.useMemo(() => detectRapidCreateDelete(auditEntries, deletedRows), [auditEntries, deletedRows]);
    // ---- Detector #1: hunt guest admins ------------------------------------
    // Manual button — we never auto-probe because this issues `$batch` calls
    // and may consume a meaningful chunk of the tenant's Graph budget.
    const huntSeqRef = React.useRef(0);
    const handleHunt = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _a;
        if (!tenantId || !homeAccountId)
            return;
        const guests = rows.filter((u) => u.isGuest);
        if (guests.length === 0) {
            setGuestAdminFindings([]);
            setGuestProbeAt(Date.now());
            setProbeStale(false);
            return;
        }
        const seq = ++huntSeqRef.current;
        setProbing(true);
        setProbeError(null);
        try {
            const token = yield getGraphTokenForAccount(homeAccountId, tenantId);
            if (seq !== huntSeqRef.current)
                return;
            const map = yield getUserDirectoryRolesBatched(tenantId, guests.map((g) => g.id), token);
            if (seq !== huntSeqRef.current)
                return;
            const found = [];
            for (const g of guests) {
                const roles = (_a = map.get(g.id)) !== null && _a !== void 0 ? _a : [];
                if (roles.length === 0)
                    continue;
                const tier0 = roles.filter((r) => TIER0_ROLE_TEMPLATE_IDS.has(r.roleTemplateId));
                // Even a non-Tier-0 role on a guest is unusual — defenders should
                // see it. Tier-0 escalates to critical.
                const severity = tier0.length > 0 ? "critical" : "high";
                found.push({
                    kind: "guest-admin",
                    severity,
                    user: g,
                    roles,
                    tier0Roles: tier0,
                });
            }
            // Sort: tier-0 holders first; then by role-count desc.
            found.sort((a, b) => {
                const t = b.tier0Roles.length - a.tier0Roles.length;
                if (t !== 0)
                    return t;
                return b.roles.length - a.roles.length;
            });
            setGuestAdminFindings(found);
            setGuestProbeAt(Date.now());
            setProbeStale(false);
            auditLog.record({
                actor: actor !== null && actor !== void 0 ? actor : "unknown",
                action: "anomaly_hunt_guest_admins",
                target: tenantId,
                status: "success",
                details: {
                    tenantId,
                    guestsProbed: guests.length,
                    findings: found.length,
                    tier0Findings: found.filter((f) => f.tier0Roles.length > 0).length,
                    source: "tenant-users:anomalies-panel",
                },
            });
        }
        catch (err) {
            if (seq !== huntSeqRef.current)
                return;
            const msg = err instanceof Error ? err.message : String(err);
            setProbeError(msg);
            auditLog.record({
                actor: actor !== null && actor !== void 0 ? actor : "unknown",
                action: "anomaly_hunt_guest_admins",
                target: tenantId,
                status: "failure",
                error: msg,
                details: {
                    tenantId,
                    source: "tenant-users:anomalies-panel",
                },
            });
        }
        finally {
            if (seq === huntSeqRef.current)
                setProbing(false);
        }
    }), [tenantId, homeAccountId, actor, rows]);
    // ---- Aggregate counts + sort ------------------------------------------
    const allFindings = React.useMemo(() => {
        const list = [
            ...guestAdminFindings,
            ...disabledWithSubsFindings,
            ...rapidFindings,
        ];
        list.sort((a, b) => {
            const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
            if (s !== 0)
                return s;
            // Kinds within same severity — group consistently for the eye.
            const kindOrder = (k) => k === "guest-admin" ? 0 : k === "rapid-create-delete" ? 1 : 2;
            return kindOrder(a.kind) - kindOrder(b.kind);
        });
        return list;
    }, [guestAdminFindings, disabledWithSubsFindings, rapidFindings]);
    const counts = React.useMemo(() => {
        const c = { critical: 0, high: 0, medium: 0 };
        for (const f of allFindings)
            c[f.severity] += 1;
        return c;
    }, [allFindings]);
    // ---- Render ------------------------------------------------------------
    return (React.createElement("div", { className: "flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-sm" },
        React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
            React.createElement("div", { className: "flex items-center gap-2" },
                React.createElement(Sparkles, { className: "h-4 w-4 text-warning", "aria-hidden": true }),
                React.createElement("span", { className: "text-sm font-semibold text-foreground" }, "Anomaly hunt"),
                React.createElement(Badge, { variant: "outline", className: "tabular-nums" }, allFindings.length),
                counts.critical > 0 && (React.createElement(Badge, { variant: "destructive", className: "gap-1" },
                    React.createElement(ShieldAlert, { className: "h-3 w-3", "aria-hidden": true }),
                    counts.critical,
                    " critical")),
                counts.high > 0 && (React.createElement(Badge, { variant: "warning", className: "tabular-nums" },
                    counts.high,
                    " high"))),
            React.createElement("div", { className: "flex items-center gap-2" },
                guestProbeAt !== null && (React.createElement("span", { className: cn("text-2xs tabular-nums", probeStale ? "text-warning" : "text-muted-foreground"), title: new Date(guestProbeAt).toLocaleString() },
                    probeStale ? "stale · " : "",
                    "guest probe",
                    " ",
                    formatRelativeTime(new Date(guestProbeAt).toISOString()))),
                React.createElement(TooltipProvider, { delayDuration: 250 },
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement(Button, { type: "button", variant: "outline", size: "xs", onClick: () => void handleHunt(), disabled: probing || !tenantId || !homeAccountId, "aria-label": "Run guest-admin probe" },
                                probing ? (React.createElement(Loader2, { className: "animate-spin" })) : (React.createElement(Sparkles, null)),
                                probing ? "Probing…" : "Hunt guest admins")),
                        React.createElement(TooltipContent, { side: "bottom" }, "Issues a Graph $batch GET /users/{id}/memberOf for each guest in the current view (\u2264 20 sub-requests per call). No state-changing primitive is invoked. Corpus: _bypass_tenant_switch.md \u00A711 / \u00A712."))))),
        probeError && (React.createElement(Alert, { variant: "destructive", className: "py-2" },
            React.createElement(AlertTriangle, { className: "h-4 w-4" }),
            React.createElement(AlertDescription, { className: "text-2xs" }, probeError))),
        allFindings.length === 0 ? (React.createElement(EmptyState, { icon: Sparkles, title: guestProbeAt === null
                ? "Click “Hunt guest admins” to start"
                : "No anomalies detected", description: guestProbeAt === null
                ? "Disabled-with-subs and rapid create→delete detectors run automatically over the current view. The guest-admin detector is on-demand because it issues Graph $batch calls. See corpus citations in the file header."
                : "Disabled-with-subs and rapid create→delete returned no findings on the current view, and no guest holds a directory role. Re-run the hunt after a filter change to refresh the guest-admin signal." })) : (React.createElement("ul", { role: "list", "aria-label": "Detected anomalies", className: "flex flex-col gap-1" }, allFindings.map((f, idx) => (React.createElement("li", { key: `${f.kind}:${idx}`, className: cn("flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2", f.severity === "critical"
                ? "border-destructive/40 bg-destructive/5"
                : f.severity === "high"
                    ? "border-warning/30 bg-warning/5"
                    : "border-border") },
            React.createElement(Badge, { variant: SEVERITY_BADGE[f.severity].variant, className: "shrink-0 uppercase" }, SEVERITY_BADGE[f.severity].label),
            renderFindingBody(f, tenantId)))))),
        React.createElement("p", { className: "border-t border-border pt-2 text-2xs text-muted-foreground" },
            "Corpus references:",
            " ",
            React.createElement("code", { className: "font-mono" }, "_bypass_tenant_switch.md"),
            " \u00A711 / \u00A712 item 2 (stale-guest privesc),",
            " ",
            React.createElement("code", { className: "font-mono" }, "_bypass_modify_delete.md"),
            " \u00A74.7 (rapid create\u2192delete cleanup),",
            " ",
            React.createElement("code", { className: "font-mono" }, "_bypass_role_grant.md"),
            " (Tier-0 role ids). State-changing primitives (PATCH/DELETE/POST) are deliberately NOT invoked here.")));
};
// =============================================================================
// Per-finding row body
// =============================================================================
function renderFindingBody(f, tenantId) {
    switch (f.kind) {
        case "guest-admin":
            return (React.createElement(React.Fragment, null,
                React.createElement(UserCog, { className: "h-4 w-4 text-warning", "aria-hidden": true }),
                React.createElement("div", { className: "flex min-w-0 flex-1 flex-col" },
                    React.createElement("span", { className: "truncate text-xs text-foreground" },
                        f.user.displayName || "(unnamed)",
                        f.tier0Roles.length > 0 && (React.createElement("span", { className: "ml-1.5 text-2xs text-destructive" },
                            "\u00B7 holds ",
                            f.tier0Roles.length,
                            " Tier-0 role",
                            f.tier0Roles.length === 1 ? "" : "s"))),
                    React.createElement("span", { className: "truncate font-mono text-2xs text-muted-foreground" }, f.user.userPrincipalName || "(no UPN)"),
                    React.createElement("span", { className: "mt-0.5 flex flex-wrap gap-1 text-2xs" },
                        f.roles.slice(0, 4).map((r) => {
                            var _a;
                            return (React.createElement("span", { key: r.id, className: cn("rounded-sm border px-1 py-px font-mono", TIER0_ROLE_TEMPLATE_IDS.has(r.roleTemplateId)
                                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                                    : "border-border bg-muted text-muted-foreground"), title: (_a = r.description) !== null && _a !== void 0 ? _a : r.displayName }, r.displayName));
                        }),
                        f.roles.length > 4 && (React.createElement("span", { className: "text-muted-foreground" },
                            "+",
                            f.roles.length - 4,
                            " more")))),
                React.createElement("div", { className: "flex items-center gap-1" },
                    tenantId && (React.createElement(Button, { type: "button", variant: "outline", size: "xs", asChild: true, "aria-label": `Open role assignments for ${f.user.displayName} in Entra Portal` },
                        React.createElement("a", { href: portalUserRolesUrl(tenantId, f.user.id), target: "_blank", rel: "noreferrer noopener" },
                            React.createElement(ExternalLink, { className: "h-3 w-3", "aria-hidden": true }),
                            "Roles in portal"))),
                    React.createElement(CopyButton, { value: f.user.userPrincipalName || f.user.id, ariaLabel: `Copy UPN for ${f.user.displayName}`, alwaysVisible: false, iconSize: 14 }))));
        case "disabled-with-subs":
            return (React.createElement(React.Fragment, null,
                React.createElement(UserX, { className: "h-4 w-4 text-warning", "aria-hidden": true }),
                React.createElement("div", { className: "flex min-w-0 flex-1 flex-col" },
                    React.createElement("span", { className: "truncate text-xs text-foreground" },
                        f.user.displayName || "(unnamed)",
                        React.createElement("span", { className: "ml-1.5 text-2xs text-muted-foreground" },
                            "\u00B7 disabled but owns ",
                            f.user.subscriptionCount,
                            " subscription",
                            f.user.subscriptionCount === 1 ? "" : "s")),
                    React.createElement("span", { className: "truncate font-mono text-2xs text-muted-foreground" }, f.user.userPrincipalName || "(no UPN)"),
                    React.createElement("span", { className: "mt-0.5 inline-flex items-center gap-1 text-2xs text-muted-foreground" },
                        React.createElement(Cloud, { className: "h-3 w-3", "aria-hidden": true }),
                        "ghost-owner pattern \u2014 clean up the role assignments or re-enable, never leave both in place")),
                React.createElement(CopyButton, { value: f.user.userPrincipalName || f.user.id, ariaLabel: `Copy UPN for ${f.user.displayName}`, alwaysVisible: false, iconSize: 14 })));
        case "rapid-create-delete":
            return (React.createElement(React.Fragment, null,
                React.createElement(Trash2, { className: "h-4 w-4 text-warning", "aria-hidden": true }),
                React.createElement("div", { className: "flex min-w-0 flex-1 flex-col" },
                    React.createElement("span", { className: "truncate text-xs text-foreground" },
                        React.createElement("span", { className: "font-mono" }, f.upn),
                        React.createElement("span", { className: "ml-1.5 text-2xs text-destructive" },
                            "\u00B7 created and deleted within",
                            " ",
                            f.deltaHours < 1
                                ? `${Math.round(f.deltaHours * 60)} min`
                                : `${f.deltaHours.toFixed(1)} hr`)),
                    React.createElement("span", { className: "text-2xs text-muted-foreground tabular-nums" },
                        "created ",
                        formatRelativeTime(f.createdAt),
                        " \u00B7 soft-deleted",
                        " ",
                        formatRelativeTime(f.deletedAt)),
                    React.createElement("span", { className: "mt-0.5 inline-flex items-center gap-1 text-2xs text-muted-foreground" }, "local create_user audit entry + Graph deletedItems match \u2014 attacker scaffolding cleanup is a known tactic (corpus \u00A74.7)")),
                React.createElement(CopyButton, { value: f.upn, ariaLabel: "Copy UPN", alwaysVisible: false, iconSize: 14 })));
    }
}
//# sourceMappingURL=tenant-users-anomalies-panel.js.map