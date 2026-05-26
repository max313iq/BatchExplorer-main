/**
 * Defender-signals panel for the Role Assignment Visualizer.
 *
 * Renders the four corpus-derived signals as expandable cards inside the
 * role-graph page. Strictly presentation — every detector lives in
 * `role-graph-helpers.ts` and the page itself owns the supplementary Graph
 * reads (this component never fetches).
 *
 * Corpus citations:
 *   - C:\Users\baimgprodsesa1\Desktop\New folder\_AZURE_BYPASS_PLAYBOOK.md
 *       "Critical Defender Audit Surface" items 4-5
 *       Top-30 escalation chains items 23, 24, 25, 26
 *   - C:\Users\baimgprodsesa1\Desktop\New folder\_bypass_role_grant.md
 *       §3.5 (App Admin → existing app)
 *       §4.1/§4.2 (addPassword / addKey)
 *       §5.1/§5.3 (role-assignable groups + group ownership)
 *       §8.1 (custom role with hidden privesc actions)
 *
 * Defensive analogs to cite in tooltips:
 *   - SpecterOps/AzureHound — role-graph collection
 *   - nccgroup/PMapper, Azucar — custom-role audits
 *   - dafthack/GraphRunner — application-credentials enumeration
 *
 * NOTE: this is a defender-only surface — it shows risk indicators read out
 * of operator-tenant data the user can already see. It never invokes any of
 * the offensive primitives the citations describe; the page never POSTs an
 * `addKey`, `addPassword`, role assignment, or owner add.
 */
import * as React from "react";
import { AlertTriangle, Box, ChevronDown, ChevronRight, ExternalLink, Info, Key, KeyRound, Layers, Network, ShieldAlert, ShieldCheck, Sparkles, UserX, Users, } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { cn, pluralize } from "@/lib/utils";
import { CopyButton } from "../shared/copy-button";
import { SIGNAL_SEVERITY_META, } from "./role-graph-helpers";
const SEVERITY_ICON = {
    critical: ShieldAlert,
    high: AlertTriangle,
    medium: Info,
    info: ShieldCheck,
};
const SeverityBadge = ({ severity, }) => {
    const meta = SIGNAL_SEVERITY_META[severity];
    const Icon = SEVERITY_ICON[severity];
    return (React.createElement(Badge, { variant: meta.badgeVariant, className: "text-2xs" },
        React.createElement(Icon, { className: "mr-1 h-3 w-3", "aria-hidden": true }),
        meta.label));
};
/** Inline disclosure section — accessible, no third-party UI primitives. */
const SectionCard = ({ title, description, icon: Icon, corpusCitation, defaultOpen, badge, children, }) => {
    const [open, setOpen] = React.useState(!!defaultOpen);
    const bodyId = React.useId();
    return (React.createElement(Card, null,
        React.createElement(CardHeader, { className: "cursor-pointer py-3" },
            React.createElement("button", { type: "button", onClick: () => setOpen((o) => !o), className: "group flex w-full items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-expanded": open, "aria-controls": bodyId },
                open ? (React.createElement(ChevronDown, { className: "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground", "aria-hidden": true })) : (React.createElement(ChevronRight, { className: "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground", "aria-hidden": true })),
                React.createElement(Icon, { className: "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground", "aria-hidden": true }),
                React.createElement("div", { className: "flex min-w-0 flex-1 flex-col" },
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement("span", { className: "truncate", title: `Corpus: ${corpusCitation}` }, title),
                        badge),
                    React.createElement(CardDescription, { className: "text-xs" }, description)))),
        open && (React.createElement(CardContent, { id: bodyId, className: "flex flex-col gap-2 pt-0" }, children))));
};
// ---------------------------------------------------------------------------
// Signal A — custom-role privesc finder
// ---------------------------------------------------------------------------
const CustomRoleFindingRow = ({ f, }) => {
    return (React.createElement("li", { className: cn("flex flex-col gap-1 rounded border p-2 text-2xs", f.severity === "critical" && "border-destructive/40 bg-destructive/5", f.severity === "high" && "border-warning/40 bg-warning/5", f.severity === "medium" && "border-secondary/40 bg-muted/30", f.severity === "info" && "border-border bg-card") },
        React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
            React.createElement(SeverityBadge, { severity: f.severity }),
            React.createElement("span", { className: "font-medium", title: f.roleDefinitionId }, f.roleName),
            React.createElement(CopyButton, { value: f.roleDefinitionId, ariaLabel: `Copy role definition id ${f.roleDefinitionId}` }),
            React.createElement(Badge, { variant: "outline", className: "text-2xs" }, f.subscriptionDisplayName),
            React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                f.assignmentCount,
                " ",
                f.assignmentCount === 1 ? "assignment" : "assignments")),
        React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
            React.createElement("span", { className: "text-3xs font-medium uppercase tracking-wider text-muted-foreground" }, "Privesc actions"),
            f.matchedActions.map((a) => (React.createElement("code", { key: a, className: "rounded bg-muted/60 px-1 py-0.5 font-mono text-2xs" }, a)))),
        f.holders.length > 0 && (React.createElement("details", { className: "rounded border border-border/60 bg-background/40 p-1.5" },
            React.createElement("summary", { className: "cursor-pointer text-3xs font-medium uppercase tracking-wider text-muted-foreground" },
                "Holders (",
                f.holders.length,
                ")"),
            React.createElement("ul", { className: "mt-1 flex flex-col gap-0.5" },
                f.holders.slice(0, 10).map((h) => (React.createElement("li", { key: h.principalId, className: "flex items-center gap-1.5" },
                    React.createElement("span", { className: "truncate font-medium" }, h.displayName),
                    React.createElement(Badge, { variant: "outline", className: "text-2xs" }, h.principalType),
                    h.isGuest && (React.createElement(Badge, { variant: "warning", className: "text-2xs" },
                        React.createElement(UserX, { className: "mr-1 h-3 w-3", "aria-hidden": true }),
                        "Guest")),
                    h.isNonTierZero && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" }, "Non-Tier-0")),
                    React.createElement("span", { className: "ml-auto font-mono text-3xs opacity-60", title: h.principalId },
                        h.principalId.substring(0, 8),
                        "\u2026")))),
                f.holders.length > 10 && (React.createElement("li", { className: "italic text-muted-foreground/80" },
                    "\u2026 and ",
                    f.holders.length - 10,
                    " more")))))));
};
// ---------------------------------------------------------------------------
// Signal B — role-assignable groups + owners
// ---------------------------------------------------------------------------
const RoleAssignableGroupRow = ({ f, }) => {
    return (React.createElement("li", { className: cn("flex flex-col gap-1 rounded border p-2 text-2xs", f.severity === "critical" && "border-destructive/40 bg-destructive/5", f.severity === "high" && "border-warning/40 bg-warning/5", f.severity === "medium" && "border-secondary/40 bg-muted/30", f.severity === "info" && "border-border bg-card") },
        React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
            React.createElement(SeverityBadge, { severity: f.severity }),
            React.createElement(Users, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
            React.createElement("span", { className: "font-medium", title: f.groupId }, f.displayName),
            React.createElement(CopyButton, { value: f.groupId, ariaLabel: `Copy group id ${f.groupId}` }),
            f.groupHighestTier && (React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                "Holds: ",
                f.groupHighestTier)),
            React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                f.ownerCount,
                " ",
                f.ownerCount === 1 ? "owner" : "owners"),
            f.hasNonTierZeroOwner && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" }, "Non-Tier-0 owner"))),
        f.groupRoles.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
            React.createElement("span", { className: "text-3xs font-medium uppercase tracking-wider text-muted-foreground" }, "Currently holds"),
            f.groupRoles.slice(0, 5).map((r) => (React.createElement(Badge, { key: r, variant: "outline", className: "text-2xs" }, r))),
            f.groupRoles.length > 5 && (React.createElement("span", { className: "text-3xs italic text-muted-foreground/80" },
                "+",
                f.groupRoles.length - 5)))),
        f.sampleOwners.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
            React.createElement("span", { className: "text-3xs font-medium uppercase tracking-wider text-muted-foreground" }, "Owners"),
            f.sampleOwners.map((o) => (React.createElement(Badge, { key: o.id, variant: "outline", className: "text-2xs", title: o.id },
                o.displayName,
                o.isGuest && (React.createElement(UserX, { className: "ml-1 h-3 w-3 text-warning", "aria-hidden": true }))))),
            f.ownerCount > f.sampleOwners.length && (React.createElement("span", { className: "text-3xs italic text-muted-foreground/80" },
                "+",
                f.ownerCount - f.sampleOwners.length))))));
};
// ---------------------------------------------------------------------------
// Signal C — App Admin escalation panel
// ---------------------------------------------------------------------------
const AppAdminFindingRow = ({ f, }) => {
    return (React.createElement("li", { className: cn("flex flex-col gap-1 rounded border p-2 text-2xs", f.severity === "critical" && "border-destructive/40 bg-destructive/5", f.severity === "high" && "border-warning/40 bg-warning/5", f.severity === "medium" && "border-secondary/40 bg-muted/30", f.severity === "info" && "border-border bg-card") },
        React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
            React.createElement(SeverityBadge, { severity: f.severity }),
            React.createElement(KeyRound, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
            React.createElement("span", { className: "font-medium", title: f.principalId }, f.displayName),
            React.createElement(CopyButton, { value: f.principalId, ariaLabel: `Copy principal id ${f.principalId}` }),
            React.createElement(Badge, { variant: "outline", className: "text-2xs" }, f.principalType),
            React.createElement(Badge, { variant: "destructive", className: "text-2xs" }, f.roleName),
            f.isGuest && (React.createElement(Badge, { variant: "warning", className: "text-2xs" },
                React.createElement(UserX, { className: "mr-1 h-3 w-3", "aria-hidden": true }),
                "Guest")),
            React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                f.reachableSpCount,
                " ",
                pluralize(f.reachableSpCount, "reachable high-priv SP"))),
        f.topReachableScope && (React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
            React.createElement("span", { className: "text-3xs font-medium uppercase tracking-wider text-muted-foreground" }, "Top reachable scope"),
            React.createElement("code", { className: "rounded bg-muted/60 px-1 py-0.5 font-mono text-2xs" }, f.topReachableScope))),
        f.sampleSpNames.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
            React.createElement("span", { className: "text-3xs font-medium uppercase tracking-wider text-muted-foreground" }, "Sample SPs"),
            f.sampleSpNames.map((n) => (React.createElement(Badge, { key: n, variant: "outline", className: "text-2xs" }, n)))))));
};
// ---------------------------------------------------------------------------
// Signal D — credential surface
// ---------------------------------------------------------------------------
const CredentialSurfaceRow = ({ f, }) => {
    const totalCreds = f.passwordCredentialCount + f.keyCredentialCount;
    return (React.createElement("li", { className: cn("flex flex-col gap-1 rounded border p-2 text-2xs", f.severity === "critical" && "border-destructive/40 bg-destructive/5", f.severity === "high" && "border-warning/40 bg-warning/5", f.severity === "medium" && "border-secondary/40 bg-muted/30", f.severity === "info" && "border-border bg-card") },
        React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
            React.createElement(SeverityBadge, { severity: f.severity }),
            React.createElement(Key, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
            React.createElement("span", { className: "font-medium", title: f.spId }, f.displayName),
            React.createElement(CopyButton, { value: f.spId, ariaLabel: `Copy SP id ${f.spId}` }),
            f.isHighPriv && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" }, "High-priv SP")),
            f.isRecent && (React.createElement(Badge, { variant: "warning", className: "text-2xs" }, "Recent credential")),
            React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                f.passwordCredentialCount,
                " pwd"),
            React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                f.keyCredentialCount,
                " key"),
            React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                totalCreds,
                " total")),
        f.daysSinceNewestCredential !== undefined && (React.createElement("div", { className: "flex flex-wrap items-center gap-1 text-3xs text-muted-foreground" },
            "Newest credential minted ",
            f.daysSinceNewestCredential,
            " ",
            pluralize(f.daysSinceNewestCredential, "day"),
            " ago.",
            f.isRecent && (React.createElement("span", { className: "ml-1 font-medium text-warning" }, "Within recency window \u2014 verify intent."))))));
};
// ---------------------------------------------------------------------------
// Panel root
// ---------------------------------------------------------------------------
export const DefenderSignalsPanel = (props) => {
    const { customRoleFindings, roleAssignableGroupFindings, roleAssignableGroupsLoading, onLoadRoleAssignableGroups, roleAssignableGroupsWarning, appAdminFindings, appAdminLoading, onLoadAppAdmin, appAdminWarning, credentialSurfaceFindings, credentialSurfaceLoading, onLoadCredentialSurface, credentialSurfaceWarning, counts, score, scoreLabel, } = props;
    // Pre-compute headline counts for the section badges so they render even
    // when the section is collapsed.
    const aCritical = counts.customRolePrivescCritical;
    const aHigh = counts.customRolePrivescHigh;
    const bCritical = counts.roleAssignableGroupCritical;
    const bHigh = counts.roleAssignableGroupHigh;
    const cCritical = counts.appAdminEscalationCritical;
    const cHigh = counts.appAdminEscalationHigh;
    const dCritical = counts.credentialSurfaceCritical;
    const dHigh = counts.credentialSurfaceHigh;
    return (React.createElement("div", { className: "flex flex-col gap-2", role: "region", "aria-label": "Defender signals from offensive-tooling corpus" },
        React.createElement(Alert, { variant: score >= 60 ? "destructive" : undefined, className: cn(score >= 30 && score < 60 && "border-warning/40 bg-warning/5") },
            React.createElement(Sparkles, { className: "h-4 w-4" }),
            React.createElement(AlertTitle, { className: "flex items-center gap-2 text-sm" },
                "Defender signals \u2014 ",
                scoreLabel,
                " (",
                score,
                "/100)"),
            React.createElement(AlertDescription, { className: "text-2xs" },
                "Risk indicators wired from the offensive-tooling corpus (",
                React.createElement("code", { className: "font-mono" }, "_bypass_role_grant.md"),
                " + Top-30 privesc chains). Read-only \u2014 no offensive primitives invoked.")),
        React.createElement(SectionCard, { title: "Custom roles with hidden roleAssignments/write", description: "Custom RBAC roles whose actions[] contains an escalation wildcard. Holder of such a role can grant any role to anyone at scope.", icon: Layers, corpusCitation: "_bypass_role_grant.md \u00A78.1 + _AZURE_BYPASS_PLAYBOOK.md #25", defaultOpen: aCritical > 0 || aHigh > 0, badge: React.createElement(React.Fragment, null,
                aCritical > 0 && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" },
                    aCritical,
                    " critical")),
                aHigh > 0 && (React.createElement(Badge, { variant: "warning", className: "text-2xs" },
                    aHigh,
                    " high")),
                aCritical === 0 && aHigh === 0 && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Clean"))) }, customRoleFindings.length === 0 ? (React.createElement("p", { className: "text-2xs text-muted-foreground" },
            "No custom roles in the audited subscriptions hold one of the roleAssignments/write privesc wildcards.",
            React.createElement("br", null),
            React.createElement("span", { className: "opacity-70" }, "Defensive analog: SpecterOps/AzureHound + nccgroup/PMapper run the same custom-role action audit during their ingest."))) : (React.createElement("ul", { className: "flex flex-col gap-1.5" }, customRoleFindings.map((f) => (React.createElement(CustomRoleFindingRow, { key: `${f.subscriptionId}-${f.roleDefinitionId}`, f: f })))))),
        React.createElement(SectionCard, { title: "Role-assignable groups + their owners", description: "Group owners inherit the group's directory role transitively, with no role-grant audit event firing.", icon: Users, corpusCitation: "_bypass_role_grant.md \u00A75.1 + \u00A75.3 + _AZURE_BYPASS_PLAYBOOK.md #26", defaultOpen: bCritical > 0 || bHigh > 0, badge: React.createElement(React.Fragment, null,
                bCritical > 0 && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" },
                    bCritical,
                    " critical")),
                bHigh > 0 && (React.createElement(Badge, { variant: "warning", className: "text-2xs" },
                    bHigh,
                    " high")),
                roleAssignableGroupFindings === null && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Not loaded")),
                roleAssignableGroupFindings !== null &&
                    bCritical === 0 &&
                    bHigh === 0 && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Clean"))) },
            roleAssignableGroupFindings === null ? (React.createElement("div", { className: "flex flex-col gap-2" },
                React.createElement("p", { className: "text-2xs text-muted-foreground" },
                    "Click to enumerate role-assignable groups (",
                    React.createElement("code", { className: "font-mono" }, "isAssignableToRole eq true"),
                    ") and resolve their owners. Read-only Graph reads:",
                    React.createElement("br", null),
                    React.createElement("code", { className: "font-mono" }, "GET /v1.0/groups?$filter=isAssignableToRole eq true"),
                    React.createElement("br", null),
                    React.createElement("code", { className: "font-mono" }, "GET /v1.0/groups/{id}/owners")),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: onLoadRoleAssignableGroups, disabled: !onLoadRoleAssignableGroups || roleAssignableGroupsLoading, className: "self-start text-2xs" }, roleAssignableGroupsLoading
                    ? "Enumerating…"
                    : "Enumerate role-assignable groups"))) : roleAssignableGroupFindings.length === 0 ? (React.createElement("p", { className: "text-2xs text-muted-foreground" }, "No role-assignable groups discovered (or insufficient Graph permission to enumerate them).")) : (React.createElement("ul", { className: "flex flex-col gap-1.5" }, roleAssignableGroupFindings.map((f) => (React.createElement(RoleAssignableGroupRow, { key: f.groupId, f: f }))))),
            roleAssignableGroupsWarning && (React.createElement(Alert, { variant: "destructive", className: "mt-1" },
                React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                React.createElement(AlertDescription, { className: "text-2xs" }, roleAssignableGroupsWarning)))),
        React.createElement(SectionCard, { title: "Application Administrator \u2192 addKey chain", description: "Holders of Application Administrator can plant credentials on any app, including apps with admin-tier Graph permissions \u2014 a stealth path to GA-equivalent.", icon: Network, corpusCitation: "_bypass_role_grant.md \u00A73.5 + _AZURE_BYPASS_PLAYBOOK.md #23, #24", defaultOpen: cCritical > 0 || cHigh > 0, badge: React.createElement(React.Fragment, null,
                cCritical > 0 && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" },
                    cCritical,
                    " critical")),
                cHigh > 0 && (React.createElement(Badge, { variant: "warning", className: "text-2xs" },
                    cHigh,
                    " high")),
                appAdminFindings === null && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Not loaded")),
                appAdminFindings !== null && cCritical === 0 && cHigh === 0 && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Clean"))) },
            appAdminFindings === null ? (React.createElement("div", { className: "flex flex-col gap-2" },
                React.createElement("p", { className: "text-2xs text-muted-foreground" },
                    "Click to enumerate Application Administrator + Cloud Application Administrator holders and cross-product them with SPs holding admin-tier Graph permissions (",
                    React.createElement("code", { className: "font-mono" }, "RoleManagement.ReadWrite.Directory"),
                    " ",
                    "et al). Read-only Graph reads."),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: onLoadAppAdmin, disabled: !onLoadAppAdmin || appAdminLoading, className: "self-start text-2xs" }, appAdminLoading
                    ? "Enumerating…"
                    : "Enumerate App Admin escalation paths"))) : appAdminFindings.length === 0 ? (React.createElement("p", { className: "text-2xs text-muted-foreground" }, "No Application Administrator / Cloud Application Administrator holders detected (or insufficient permission to enumerate directoryRoles).")) : (React.createElement("ul", { className: "flex flex-col gap-1.5" }, appAdminFindings.map((f) => (React.createElement(AppAdminFindingRow, { key: f.principalId, f: f }))))),
            appAdminWarning && (React.createElement(Alert, { variant: "destructive", className: "mt-1" },
                React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                React.createElement(AlertDescription, { className: "text-2xs" }, appAdminWarning))),
            React.createElement("p", { className: "text-3xs italic text-muted-foreground" },
                "Defensive analog: dafthack/GraphRunner enumerates this chain via",
                React.createElement("code", { className: "ml-1 font-mono" }, "Invoke-GraphAppRoleEnum"),
                ".")),
        React.createElement(SectionCard, { title: "SP credential surface (addPassword / addKey)", description: "Recently-minted credentials on service principals \u2014 the canonical persistence + privesc primitive.", icon: Box, corpusCitation: "_bypass_role_grant.md \u00A74.1, \u00A74.2 + _AZURE_BYPASS_PLAYBOOK.md Defender Audit #5", defaultOpen: dCritical > 0 || dHigh > 0, badge: React.createElement(React.Fragment, null,
                dCritical > 0 && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" },
                    dCritical,
                    " critical")),
                dHigh > 0 && (React.createElement(Badge, { variant: "warning", className: "text-2xs" },
                    dHigh,
                    " high")),
                credentialSurfaceFindings === null && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Not loaded")),
                credentialSurfaceFindings !== null &&
                    dCritical === 0 &&
                    dHigh === 0 && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Clean"))) },
            credentialSurfaceFindings === null ? (React.createElement("div", { className: "flex flex-col gap-2" },
                React.createElement("p", { className: "text-2xs text-muted-foreground" },
                    "Click to enumerate credential metadata (",
                    React.createElement("code", { className: "font-mono" }, "passwordCredentials.length"),
                    ",",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "keyCredentials.length"),
                    ", newest",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "startDateTime"),
                    ") for SPs that appear as role-assignment principals AND for SPs holding admin-tier Graph permissions. Recency window: 7 days."),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: onLoadCredentialSurface, disabled: !onLoadCredentialSurface || credentialSurfaceLoading, className: "self-start text-2xs" }, credentialSurfaceLoading
                    ? "Enumerating…"
                    : "Enumerate SP credential surface"),
                React.createElement("p", { className: "text-3xs italic text-muted-foreground" }, "Note: without a baseline snapshot helper, only credentials minted within the 7-day recency window are flagged. Baseline-diff detection is a future enhancement."))) : credentialSurfaceFindings.length === 0 ? (React.createElement("p", { className: "text-2xs text-muted-foreground" },
                "No SP credentials returned (or insufficient permission to read",
                React.createElement("code", { className: "ml-1 font-mono" }, "applications"),
                " /",
                " ",
                React.createElement("code", { className: "font-mono" }, "servicePrincipals"),
                ").")) : (React.createElement("ul", { className: "flex flex-col gap-1.5" }, credentialSurfaceFindings.map((f) => (React.createElement(CredentialSurfaceRow, { key: f.spId, f: f }))))),
            credentialSurfaceWarning && (React.createElement(Alert, { variant: "destructive", className: "mt-1" },
                React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                React.createElement(AlertDescription, { className: "text-2xs" }, credentialSurfaceWarning)))),
        React.createElement("p", { className: "text-3xs italic text-muted-foreground" },
            "All findings are READ-ONLY risk indicators against the operator's own tenant. The page never invokes role-grant, addKey/addPassword, or consent primitives. Citations:",
            " ",
            React.createElement("code", { className: "font-mono" }, "_bypass_role_grant.md"),
            ",",
            " ",
            React.createElement("code", { className: "font-mono" }, "_AZURE_BYPASS_PLAYBOOK.md"),
            ".",
            " ",
            React.createElement(ExternalLink, { className: "inline h-2.5 w-2.5 opacity-60", "aria-hidden": true }))));
};
//# sourceMappingURL=defender-signals-panel.js.map