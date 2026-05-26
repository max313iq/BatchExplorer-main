/**
 * Tenant Graph Panel — collapsible "trust topology" view for the Azure
 * Accounts page.
 *
 * Renders the relationship between signed-in accounts, the tenants
 * those accounts can reach, and the subscriptions owned by each tenant.
 * It is NOT a generic graph viewer (we have no graph deps available —
 * source-only repo) — it's a structured list-of-cards built from
 * `buildTenantGraph()` in `azure-accounts-intel.ts`, with each tenant
 * card showing:
 *
 *   - tenant label + GUID + default domain
 *   - home accounts (rendered as "Native:" pills)
 *   - guest accounts (rendered as "Guest:" pills) — corresponds to the
 *     account holding a token for a tenant OTHER than its homeTenantId,
 *     which is exactly the B2B-guest abuse footprint described in
 *     `New folder/_bypass_tenant_switch.md §2 "Guest Invitation Abuse"`.
 *   - subscription count for that tenant
 *   - "Guest-only" badge when NO signed-in account claims this tenant
 *     as home — those are tenants the operator only reaches via a
 *     guest invitation or a Lighthouse / GDAP delegation, which is the
 *     "stale guest with role" footprint in §2.4 of the same playbook.
 *
 * No new imports outside the components/ui + lucide-react stack the
 * rest of the azure-accounts page already uses. No new shared
 * components, no new hooks, no edits outside this directory.
 */
import * as React from "react";
import { AlertTriangle, Crown, Database, Globe2, Layers, Network, ShieldAlert, ShieldCheck, Users, } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CopyButton } from "../shared/copy-button";
import { buildTenantGraph, } from "./azure-accounts-intel";
function truncateMiddle(value, head = 8, tail = 4) {
    if (!value || value.length <= head + tail + 1)
        return value;
    return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
/**
 * Resolve a friendly account label (display name → username → tenant
 * suffix → truncated GUID). Used in the pills attached to each tenant
 * card.
 */
function accountLabel(account) {
    if (account.name && account.name !== account.username)
        return account.name;
    if (account.username)
        return account.username;
    return truncateMiddle(account.homeAccountId, 8, 4);
}
export const TenantGraphPanel = ({ accounts, cloudByAccount, crossTenantByAccount, onOpenAccount, className, }) => {
    const accountsById = React.useMemo(() => {
        const map = new Map();
        for (const a of accounts)
            map.set(a.homeAccountId, a);
        return map;
    }, [accounts]);
    const graph = React.useMemo(() => buildTenantGraph(accounts), [accounts]);
    // Pre-compute a tenant→"any account active here" flag — drives the
    // "currently active" outline on the card. An operator can land here
    // because their account's `activeTenantId` matches the tenant, OR
    // because the account has no override and the tenant IS its home.
    // This is the same logic the row dropdown's "Active" badge uses.
    const activeTenantIds = React.useMemo(() => {
        var _a;
        const set = new Set();
        for (const a of accounts) {
            set.add((_a = a.activeTenantId) !== null && _a !== void 0 ? _a : a.tenantId);
        }
        return set;
    }, [accounts]);
    if (graph.nodes.length === 0) {
        return (React.createElement(Card, { className: cn("flex items-center gap-3 px-4 py-4", className) },
            React.createElement(Network, { className: "h-4 w-4 text-muted-foreground", "aria-hidden": true }),
            React.createElement("p", { className: "text-xs text-muted-foreground" }, "No tenants discovered yet \u2014 sign in to one or more accounts to render the tenant graph.")));
    }
    return (React.createElement(Card, { className: cn("flex flex-col gap-3 px-4 py-3", className), role: "region", "aria-label": "Tenant trust graph" },
        React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
            React.createElement("h3", { className: "m-0 inline-flex items-center gap-1.5 text-sm font-semibold" },
                React.createElement(Network, { className: "h-3.5 w-3.5 text-primary", "aria-hidden": true }),
                "Tenant graph",
                React.createElement(Badge, { variant: "info", className: "px-1.5 py-0 text-2xs" },
                    graph.tenantCount,
                    " tenant",
                    graph.tenantCount === 1 ? "" : "s")),
            React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" },
                graph.accountCount,
                " account",
                graph.accountCount === 1 ? "" : "s",
                " \u00B7",
                " ",
                graph.subscriptionCount,
                " subscription",
                graph.subscriptionCount === 1 ? "" : "s",
                graph.multiTenantAccountCount > 0 && (React.createElement(React.Fragment, null,
                    " ",
                    "\u00B7 ",
                    graph.multiTenantAccountCount,
                    " multi-tenant account",
                    graph.multiTenantAccountCount === 1 ? "" : "s")))),
        React.createElement("ul", { role: "list", className: "flex flex-col gap-2" }, graph.nodes.map((node) => (React.createElement(TenantGraphCard, { key: node.tenantId, node: node, accountsById: accountsById, cloudByAccount: cloudByAccount, crossTenantByAccount: crossTenantByAccount, isActive: activeTenantIds.has(node.tenantId), onOpenAccount: onOpenAccount })))),
        React.createElement("p", { className: "m-0 text-[10px] text-muted-foreground" },
            "Cross-tenant guest tokens, sovereign-cloud sign-ins, and \"stale guest\" tenants are flagged inline. See ",
            React.createElement("code", null, "New folder/_bypass_tenant_switch.md \u00A72, \u00A78"),
            ".")));
};
const TenantGraphCard = ({ node, accountsById, cloudByAccount, crossTenantByAccount, isActive, onOpenAccount, }) => {
    // Split accounts into "native" (this tenant is their home) and "guest"
    // (this tenant is a non-home in the account's tenants list) so the
    // pill rows read naturally.
    const native = [];
    const guest = [];
    for (const id of node.accountHomeAccountIds) {
        const a = accountsById.get(id);
        if (!a)
            continue;
        if (a.tenantId === node.tenantId)
            native.push(a);
        else
            guest.push(a);
    }
    return (React.createElement("li", { role: "listitem", className: cn("rounded-md border border-border bg-card/70 px-3 py-2 transition-colors duration-150 motion-reduce:transition-none", isActive && "border-primary/50 bg-primary/5") },
        React.createElement("div", { className: "flex flex-wrap items-start gap-2" },
            React.createElement("div", { className: "min-w-0 flex-1" },
                React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
                    node.guestOnly ? (React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("span", { "aria-label": "Guest-only tenant" },
                                React.createElement(ShieldAlert, { className: "h-3.5 w-3.5 text-warning", "aria-hidden": true }))),
                        React.createElement(TooltipContent, { side: "top" }, "No signed-in account claims this tenant as home \u2014 only reachable through B2B guest invites or Lighthouse / GDAP delegations."))) : (React.createElement(ShieldCheck, { className: "h-3.5 w-3.5 text-success", "aria-hidden": true })),
                    React.createElement("span", { className: "truncate text-xs font-medium text-foreground", title: node.tenantId }, node.label),
                    node.defaultDomain && node.defaultDomain !== node.label && (React.createElement("span", { className: "truncate text-[10px] text-muted-foreground" },
                        "\u00B7 ",
                        node.defaultDomain)),
                    isActive && (React.createElement(Badge, { variant: "success", className: "px-1 py-0 text-[9px]" }, "Active")),
                    node.guestOnly && (React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("span", null,
                                React.createElement(Badge, { variant: "warning", className: "px-1 py-0 text-[9px]" }, "Guest-only"))),
                        React.createElement(TooltipContent, { side: "top" },
                            "Tenant reachable only via cross-tenant trust \u2014 review for stale guest invitations (cf.",
                            " ",
                            React.createElement("code", null, "_bypass_tenant_switch.md \u00A72.4"),
                            ").")))),
                React.createElement("div", { className: "mt-0.5 flex items-center gap-1.5" },
                    React.createElement("code", { className: "font-mono text-[10px] text-muted-foreground" }, truncateMiddle(node.tenantId, 8, 4)),
                    React.createElement(CopyButton, { value: node.tenantId, ariaLabel: `Copy tenant id ${node.label}` }))),
            React.createElement("div", { className: "flex flex-wrap items-center gap-1.5 text-[10px]" },
                node.subscriptions.length > 0 && (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("span", { className: "inline-flex items-center gap-0.5 rounded-sm bg-muted/40 px-1.5 py-0.5 text-foreground/80" },
                            React.createElement(Database, { className: "h-2.5 w-2.5", "aria-hidden": true }),
                            node.subscriptions.length)),
                    React.createElement(TooltipContent, { side: "top" },
                        node.subscriptions.length,
                        " subscription",
                        node.subscriptions.length === 1 ? "" : "s",
                        " owned by this tenant."))),
                node.homeAccountsCount > 0 && (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("span", { className: "inline-flex items-center gap-0.5 rounded-sm bg-info/15 px-1.5 py-0.5 text-info" },
                            React.createElement(Crown, { className: "h-2.5 w-2.5", "aria-hidden": true }),
                            node.homeAccountsCount)),
                    React.createElement(TooltipContent, { side: "top" },
                        node.homeAccountsCount,
                        " signed-in account",
                        node.homeAccountsCount === 1 ? "" : "s",
                        " whose HOME tenant is this one."))),
                node.guestAccountsCount > 0 && (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("span", { className: "inline-flex items-center gap-0.5 rounded-sm bg-warning/15 px-1.5 py-0.5 text-warning" },
                            React.createElement(Users, { className: "h-2.5 w-2.5", "aria-hidden": true }),
                            node.guestAccountsCount)),
                    React.createElement(TooltipContent, { side: "top" },
                        node.guestAccountsCount,
                        " signed-in account",
                        node.guestAccountsCount === 1 ? "" : "s",
                        " reach this tenant only as a guest (B2B invite, Lighthouse, etc.)."))))),
        (native.length > 0 || guest.length > 0) && (React.createElement("div", { className: "mt-2 flex flex-col gap-1.5" },
            native.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
                React.createElement("span", { className: "text-[10px] uppercase tracking-wider text-muted-foreground" }, "Native"),
                native.map((a) => {
                    const cloud = cloudByAccount[a.homeAccountId];
                    return (React.createElement(AccountChip, { key: a.homeAccountId, account: a, cloud: cloud, isCrossTenant: false, onClick: () => onOpenAccount(a.homeAccountId) }));
                }))),
            guest.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
                React.createElement("span", { className: "text-[10px] uppercase tracking-wider text-warning" }, "Guest"),
                guest.map((a) => {
                    var _a;
                    const cloud = cloudByAccount[a.homeAccountId];
                    const xt = crossTenantByAccount[a.homeAccountId];
                    // Only flag the chip cross-tenant when the account's
                    // CURRENT active tenant is this tenant (not just "the
                    // account has guest membership somewhere"). That keeps
                    // the warning honest and actionable.
                    const flagCrossTenant = (xt === null || xt === void 0 ? void 0 : xt.activeTenantId) === node.tenantId;
                    return (React.createElement(AccountChip, { key: a.homeAccountId, account: a, cloud: cloud, isCrossTenant: flagCrossTenant, stale: (_a = xt === null || xt === void 0 ? void 0 : xt.staleAssociation) !== null && _a !== void 0 ? _a : false, onClick: () => onOpenAccount(a.homeAccountId) }));
                })))))));
};
const AccountChip = ({ account, cloud, isCrossTenant, stale, onClick, }) => {
    const label = accountLabel(account);
    const showCloud = cloud && cloud.kind !== "commercial" && cloud.kind !== "unknown";
    return (React.createElement(Tooltip, null,
        React.createElement(TooltipTrigger, { asChild: true },
            React.createElement("button", { type: "button", onClick: onClick, className: cn("inline-flex max-w-[180px] items-center gap-1 truncate rounded-sm border px-1.5 py-0.5 text-[10px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none", isCrossTenant
                    ? "border-warning/60 bg-warning/10 text-warning hover:bg-warning/20"
                    : "border-border bg-card hover:bg-muted/40"), "aria-label": `Open account ${label}` },
                stale ? (React.createElement(AlertTriangle, { className: "h-2.5 w-2.5 shrink-0", "aria-hidden": true })) : showCloud ? (React.createElement(Globe2, { className: "h-2.5 w-2.5 shrink-0", "aria-hidden": true })) : (React.createElement(Layers, { className: "h-2.5 w-2.5 shrink-0 opacity-70", "aria-hidden": true })),
                React.createElement("span", { className: "truncate" }, label),
                showCloud && cloud && (React.createElement("span", { className: "ml-0.5 rounded-sm bg-foreground/10 px-1 py-0 text-[9px] uppercase tracking-wider" }, cloud.label)))),
        React.createElement(TooltipContent, { side: "top" },
            React.createElement("div", { className: "flex max-w-[260px] flex-col gap-0.5 text-[11px]" },
                React.createElement("span", { className: "font-medium" }, label),
                account.username && account.username !== label && (React.createElement("span", { className: "text-muted-foreground" }, account.username)),
                stale && (React.createElement("span", { className: "text-warning" }, "Active tenant id not present in the account's discovered tenants list \u2014 likely a stale B2B / Lighthouse association.")),
                isCrossTenant && !stale && (React.createElement("span", null, "Account is signed into a tenant OTHER than its home \u2014 cross- tenant guest token in active use.")),
                cloud && cloud.kind !== "commercial" && cloud.kind !== "unknown" && (React.createElement("span", { className: "text-muted-foreground" }, cloud.description)),
                React.createElement("span", { className: "mt-1 text-[10px] text-muted-foreground/80" }, "Click to open this account's drawer.")))));
};
const BUCKET_LEVEL = {
    fresh: 5,
    warm: 4,
    cool: 3,
    stale: 2,
    ancient: 1,
};
const BUCKET_TONE = {
    fresh: "bg-success",
    warm: "bg-success/70",
    cool: "bg-warning/70",
    stale: "bg-warning",
    ancient: "bg-destructive/80",
};
export const TokenAgeBars = ({ bucket, ageLabel, className, }) => {
    const level = BUCKET_LEVEL[bucket];
    const tone = BUCKET_TONE[bucket];
    return (React.createElement("span", { role: "img", "aria-label": `Token age bucket: ${bucket} (${ageLabel})`, className: cn("inline-flex items-end gap-0.5 align-middle", className) },
        [1, 2, 3, 4, 5].map((i) => (React.createElement("span", { key: i, "aria-hidden": true, className: cn("block w-0.5 rounded-sm", i <= level ? tone : "bg-muted/40"), style: { height: `${4 + i * 2}px` } }))),
        React.createElement("span", { className: "ml-1 text-[10px] tabular-nums text-muted-foreground" }, ageLabel)));
};
//# sourceMappingURL=tenant-graph-panel.js.map