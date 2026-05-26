/**
 * Multi-hop path-finder visualizer for the Role Assignment Visualizer.
 *
 * Renders the BFS results from `findShortestPath` and the
 * transitive-ownership-chain findings from `detectOwnershipChains` as
 * hop-by-hop chips so the operator can see EVERY edge they have to revoke
 * to break the chain — not just the leaf principal.
 *
 * Corpus citations (mirrored from `role-graph-helpers.ts`):
 *   - `_bypass_role_grant.md` §5.3 group ownership = membership management
 *   - `_bypass_role_grant.md` §5.4 nested groups
 *   - `_bypass_role_grant.md` §10  role-graph privesc chain reference
 *   - `_analysis_specterops.md`    AzureHound shortestPath queries
 *
 * No I/O — every input is precomputed in the page or in the helper module.
 */
import * as React from "react";
import { ArrowRight, Boxes, ChevronDown, ChevronRight, GitBranch, Key, Layers, Network, Route, Shield, Target, User, Users, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { CopyButton } from "../shared/copy-button";
import { PRIVILEGE_TIER_META, SIGNAL_SEVERITY_META, } from "./role-graph-helpers";
/** Map a hop kind to an icon. */
const HOP_ICON = {
    principal: User,
    group: Users,
    role: Key,
    scope: Boxes,
};
/** Color a hop chip by kind. */
function hopChipClass(kind, tier) {
    if (kind === "role") {
        if (tier === "critical")
            return "border-destructive/50 bg-destructive/10 text-destructive";
        if (tier === "privileged")
            return "border-warning/50 bg-warning/10 text-warning";
        if (tier === "write")
            return "border-secondary/50 bg-muted/40";
        return "border-border bg-card";
    }
    if (kind === "principal")
        return "border-primary/40 bg-primary/5";
    if (kind === "group")
        return "border-amber-500/40 bg-amber-500/5";
    if (kind === "scope")
        return "border-blue-500/40 bg-blue-500/5";
    return "border-border bg-card";
}
const HopChip = ({ hop, onClick, isLast }) => {
    const Icon = HOP_ICON[hop.kind];
    return (React.createElement(React.Fragment, null,
        React.createElement("button", { type: "button", onClick: onClick, disabled: !onClick, className: cn("inline-flex max-w-[260px] items-center gap-1 rounded border px-1.5 py-1 text-2xs", hopChipClass(hop.kind, hop.tier), onClick &&
                "cursor-pointer hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", !onClick && "cursor-default"), title: hop.detail ? `${hop.label} — ${hop.detail}` : hop.label },
            React.createElement(Icon, { className: "h-3 w-3 shrink-0", "aria-hidden": true }),
            React.createElement("span", { className: "truncate font-medium" }, hop.label),
            hop.kind === "role" && hop.tier && (React.createElement(Badge, { variant: PRIVILEGE_TIER_META[hop.tier].badgeVariant, className: "ml-1 text-3xs" }, PRIVILEGE_TIER_META[hop.tier].label)),
            hop.detail && hop.kind === "group" && (React.createElement("span", { className: "ml-1 rounded bg-muted px-1 text-3xs opacity-80" }, hop.detail))),
        !isLast && (React.createElement(ArrowRight, { className: "h-3 w-3 shrink-0 text-muted-foreground", "aria-hidden": true }))));
};
const PathRow = ({ path, onFocusPrincipal, onFocusGroup }) => {
    const meta = PRIVILEGE_TIER_META[path.highestTier];
    return (React.createElement("li", { className: cn("flex flex-col gap-1.5 rounded border p-2 text-2xs", path.highestTier === "critical" &&
            "border-destructive/40 bg-destructive/5", path.highestTier === "privileged" && "border-warning/40 bg-warning/5", path.highestTier === "write" && "border-secondary/40 bg-muted/30", path.highestTier === "readonly" && "border-border bg-card") },
        React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
            React.createElement(Badge, { variant: meta.badgeVariant, className: "text-2xs" }, meta.label),
            React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                path.hopCount,
                " ",
                path.hopCount === 1 ? "hop" : "hops"),
            path.viaGroup && (React.createElement(Badge, { variant: "warning", className: "text-2xs" },
                React.createElement(Users, { className: "mr-1 h-3 w-3", "aria-hidden": true }),
                "via group")),
            path.viaNestedGroup && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" },
                React.createElement(GitBranch, { className: "mr-1 h-3 w-3", "aria-hidden": true }),
                "nested group"))),
        React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "list", "aria-label": "Hop sequence" }, path.hops.map((hop, i) => {
            const isLast = i === path.hops.length - 1;
            const handler = hop.kind === "principal" && onFocusPrincipal
                ? () => onFocusPrincipal(hop.id)
                : hop.kind === "group" && onFocusGroup
                    ? () => onFocusGroup(hop.id)
                    : undefined;
            return (React.createElement(HopChip, { key: `${hop.kind}-${hop.id}-${i}`, hop: hop, onClick: handler, isLast: isLast }));
        }))));
};
const OwnershipChainRow = ({ f, onFocusPrincipal, onFocusGroup }) => {
    const sevMeta = SIGNAL_SEVERITY_META[f.severity];
    return (React.createElement("li", { className: cn("flex flex-col gap-1.5 rounded border p-2 text-2xs", f.severity === "critical" && "border-destructive/40 bg-destructive/5", f.severity === "high" && "border-warning/40 bg-warning/5", f.severity === "medium" && "border-secondary/40 bg-muted/30", f.severity === "info" && "border-border bg-card") },
        React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
            React.createElement(Badge, { variant: sevMeta.badgeVariant, className: "text-2xs" }, sevMeta.label),
            React.createElement(Route, { className: "h-3 w-3 text-muted-foreground", "aria-hidden": true }),
            React.createElement("span", { className: "font-medium", title: f.ownerId }, f.ownerDisplayName),
            React.createElement(Badge, { variant: "outline", className: "text-2xs" }, f.ownerType),
            f.isGuest && (React.createElement(Badge, { variant: "warning", className: "text-2xs" }, "Guest")),
            React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                "owns ",
                f.rootGroupDisplayName),
            f.intermediateGroupIds.length > 0 && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" },
                React.createElement(GitBranch, { className: "mr-1 h-3 w-3", "aria-hidden": true }),
                "+",
                f.intermediateGroupIds.length,
                " nested")),
            React.createElement(Badge, { variant: PRIVILEGE_TIER_META[f.terminalTier].badgeVariant, className: "text-2xs" }, f.terminalTier)),
        React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
            React.createElement(HopChip, { hop: {
                    kind: "principal",
                    id: f.ownerId,
                    label: f.ownerDisplayName,
                    principalType: f.ownerType,
                }, onClick: onFocusPrincipal ? () => onFocusPrincipal(f.ownerId) : undefined }),
            React.createElement(HopChip, { hop: {
                    kind: "group",
                    id: f.rootGroupId,
                    label: f.rootGroupDisplayName,
                    detail: "owned",
                }, onClick: onFocusGroup ? () => onFocusGroup(f.rootGroupId) : undefined }),
            f.intermediateGroupIds.map((gid) => (React.createElement(HopChip, { key: gid, hop: {
                    kind: "group",
                    id: gid,
                    label: `Group ${gid.substring(0, 8)}…`,
                    detail: "nested",
                }, onClick: onFocusGroup ? () => onFocusGroup(gid) : undefined }))),
            React.createElement(HopChip, { hop: {
                    kind: "group",
                    id: f.terminalGroupId,
                    label: f.terminalGroupDisplayName,
                    detail: "holds role",
                }, onClick: onFocusGroup ? () => onFocusGroup(f.terminalGroupId) : undefined, isLast: true })),
        f.terminalRoles.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
            React.createElement("span", { className: "text-3xs font-medium uppercase tracking-wider text-muted-foreground" }, "Inherited roles"),
            f.terminalRoles.slice(0, 5).map((r) => (React.createElement(Badge, { key: r, variant: "outline", className: "text-2xs" }, r))),
            f.terminalRoles.length > 5 && (React.createElement("span", { className: "text-3xs italic text-muted-foreground/80" },
                "+",
                f.terminalRoles.length - 5)))),
        React.createElement("p", { className: "text-3xs italic text-muted-foreground" },
            "Revoke the cheapest edge to break the chain \u2014 usually the ownership of ",
            React.createElement("span", { className: "font-mono" }, f.rootGroupDisplayName),
            " ",
            "(one PATCH against the group's owners). Citation:",
            React.createElement("code", { className: "ml-1 font-mono" }, "_bypass_role_grant.md \u00A75.3"),
            "."),
        React.createElement(CopyButton, { value: f.ownerId, ariaLabel: `Copy owner principal id ${f.ownerId}`, className: "self-start" })));
};
/**
 * Root component — renders the BFS path list AND the transitive-ownership
 * detector findings as two sub-sections inside one collapsible card.
 *
 * Renders aria-live so screen readers announce when the path count updates.
 */
export const PathFinderPanel = (props) => {
    const { armed, paths, ownershipChains, totalMatched, onFocusPrincipal, onFocusGroup, defaultOpen = true, } = props;
    const [open, setOpen] = React.useState(defaultOpen);
    const bodyId = React.useId();
    // aria-live announcement — debounced via key so screen readers update.
    const announceText = armed
        ? `Path finder: ${paths.length} ${paths.length === 1 ? "path" : "paths"} discovered, ${ownershipChains.length} ownership ${ownershipChains.length === 1 ? "chain" : "chains"} flagged.`
        : "";
    return (React.createElement(Card, null,
        React.createElement(CardHeader, { className: "cursor-pointer py-3" },
            React.createElement("button", { type: "button", onClick: () => setOpen((o) => !o), className: "group flex w-full items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-expanded": open, "aria-controls": bodyId },
                open ? (React.createElement(ChevronDown, { className: "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground", "aria-hidden": true })) : (React.createElement(ChevronRight, { className: "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground", "aria-hidden": true })),
                React.createElement(Target, { className: "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground", "aria-hidden": true }),
                React.createElement("div", { className: "flex min-w-0 flex-1 flex-col" },
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm", title: "Corpus: _bypass_role_grant.md \u00A75.3, \u00A75.4, \u00A710 + _analysis_specterops.md" },
                        React.createElement("span", null, "Path finder & ownership chains"),
                        armed && paths.length > 0 && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                            paths.length,
                            " ",
                            paths.length === 1 ? "path" : "paths")),
                        ownershipChains.length > 0 && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" },
                            ownershipChains.length,
                            " ownership",
                            " ",
                            ownershipChains.length === 1 ? "chain" : "chains"))),
                    React.createElement(CardDescription, { className: "text-xs" },
                        "BFS shortest-path traversal (principal \u2192 group \u2192 role \u2192 scope) and transitive ownership detection. Citations:",
                        " ",
                        React.createElement("code", { className: "font-mono" }, "_bypass_role_grant.md"),
                        " \u00A75.3, \u00A75.4.")))),
        open && (React.createElement(CardContent, { id: bodyId, className: "flex flex-col gap-3 pt-0" },
            React.createElement("div", { className: "sr-only", "aria-live": "polite", role: "status" }, announceText),
            React.createElement("div", { className: "flex flex-col gap-1" },
                React.createElement("h3", { className: "flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground" },
                    React.createElement(Network, { className: "h-3 w-3", "aria-hidden": true }),
                    "BFS paths",
                    totalMatched > paths.length && (React.createElement("span", { className: "ml-1 italic opacity-80" },
                        "(showing ",
                        paths.length,
                        " of ",
                        totalMatched,
                        ")"))),
                !armed ? (React.createElement("p", { className: "text-2xs text-muted-foreground" }, "Type a principal name (or scope substring) above to run a shortest-path traversal. Hops are drawn from a BFS over the principal \u2192 group \u2192 role \u2192 scope graph, hop budget 5.")) : paths.length === 0 ? (React.createElement(Alert, null,
                    React.createElement(AlertDescription, { className: "text-2xs" }, "No paths found for the current hints. Either the principal has no role-assignment path under the matched scope, or group membership wasn't enumerable for this audit."))) : (React.createElement("ul", { className: "flex flex-col gap-1.5" }, paths.map((p, i) => (React.createElement(PathRow, { key: `${p.hops.map((h) => h.id).join(">")}-${i}`, path: p, onFocusPrincipal: onFocusPrincipal, onFocusGroup: onFocusGroup })))))),
            React.createElement("div", { className: "flex flex-col gap-1" },
                React.createElement("h3", { className: "flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground" },
                    React.createElement(Layers, { className: "h-3 w-3", "aria-hidden": true }),
                    "Transitive ownership chains",
                    React.createElement(Badge, { variant: "outline", className: "text-3xs" }, "_bypass_role_grant.md \u00A75.3 + \u00A75.4")),
                ownershipChains.length === 0 ? (React.createElement("p", { className: "text-2xs text-muted-foreground" }, "No transitive ownership chains detected (or role-assignable groups + transitive members haven't been enumerated yet \u2014 run Signal B and the probe above).")) : (React.createElement("ul", { className: "flex flex-col gap-1.5" }, ownershipChains.map((f) => (React.createElement(OwnershipChainRow, { key: `${f.ownerId}-${f.terminalGroupId}`, f: f, onFocusPrincipal: onFocusPrincipal, onFocusGroup: onFocusGroup })))))),
            React.createElement("p", { className: "text-3xs italic text-muted-foreground" },
                React.createElement(Shield, { className: "mr-1 inline h-3 w-3 opacity-60", "aria-hidden": true }),
                "Read-only traversal of the operator's tenant. No POSTs are issued. Defensive analog: SpecterOps/AzureHound",
                " ",
                React.createElement("code", { className: "font-mono" }, "MATCH p=shortestPath(...)"),
                " ",
                "Cypher queries.")))));
};
//# sourceMappingURL=path-finder-panel.js.map