import { __awaiter } from "tslib";
/**
 * Role Assignment Visualizer — defensive RBAC audit page.
 *
 * Stormspotter-inspired (Microsoft's Azure Red Team graph tool) but
 * purpose-built for tenant ADMINS auditing THEIR OWN environment:
 *
 *   1. Operator picks an account + one-or-more accessible subscriptions.
 *   2. For each picked sub, we hit
 *      `Microsoft.Authorization/roleAssignments` at the sub scope and
 *      `Microsoft.Authorization/roleDefinitions` (with permissions
 *      included — see `fetchRoleDefinitionsWithPermissions` below).
 *   3. Principal display names are resolved via Graph
 *      `directoryObjects/getByIds` per the sub's tenant.
 *   4. For every GROUP principal that holds a critical-tier role, we
 *      best-effort enumerate transitive members via
 *      `groups/{id}/transitiveMembers` so group-mediated inheritance
 *      lights up in the escalation column. Permission failures degrade
 *      gracefully (the group simply doesn't expand) — never block the
 *      page render.
 *   5. Helpers classify everything into tiers + detect escalation
 *      patterns; the page is just rendering.
 *
 * Audit: every probe writes a single `role_graph_probe` audit-log entry
 * with the per-sub assignment + principal + escalation counts. Failures
 * land in the same entry under `status: "failure"`.
 *
 * NO graph library — we render the principal → role → scope hierarchy
 * as a collapsible Tailwind tree. The visual cues are tier badges +
 * escalation alerts inline so the operator can spot risk at a glance.
 */
import * as React from "react";
import { AlertTriangle, Bookmark, CheckCircle2, ChevronDown, ChevronRight, Crown, Filter, Keyboard, Key, Loader2, Network, RefreshCw, Rows3, Rows4, Save, Search, Shield, ShieldAlert, ShieldCheck, Target, Trash2, User, Users, UserX, X, Zap, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { cn, formatNumber, pluralize } from "@/lib/utils";
import { getActiveTenant, getGraphTokenForAccount } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog } from "../../services/audit-log";
import { getPrincipalsByIds, listSubscriptionRoleAssignments, } from "../../services";
import { useMultiRegionState } from "../../store/store-context";
import { CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu } from "../shared/export-menu";
import { PageHeader } from "../shared/page-header";
import { SignInRequired } from "../shared/sign-in-required";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import { ADMIN_TIER_GRAPH_APP_ROLES, applyFilters, auditRoleAssignableGroups, classifyRoleTier, classifyScopeLevel, computeDefenderSignalScore, computeStats, describeScope, detectAppAdminEscalation, detectCustomRoleWritePrivesc, detectOwnershipChains, findShortestPath, groupByPrincipal, PRIVILEGE_TIER_META, summarizeCredentialSurface, } from "./role-graph-helpers";
import { DefenderSignalsPanel } from "./defender-signals-panel";
import { PathFinderPanel } from "./path-finder-panel";
const ARM_BASE = "https://management.azure.com";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const ARM_ROLE_API = "2022-04-01";
const PRINCIPAL_TYPE_OPTIONS = [
    "User",
    "Group",
    "ServicePrincipal",
    "Application",
];
/** Friendly principal-type → Lucide icon mapping. */
function principalIcon(type) {
    if (type === "User")
        return User;
    if (type === "Group")
        return Users;
    if (type === "ServicePrincipal" || type === "Application")
        return Shield;
    return Key;
}
/**
 * Fetch role definitions WITH permissions for one subscription.
 *
 * The existing `listSubscriptionRoleDefinitions` helper strips
 * `properties.permissions` to keep its surface small for the Sub
 * Manager picker — but the tier classifier here needs those actions
 * to evaluate CUSTOM roles. We use a plain fetch (NOT modifying the
 * service file per the page constraints) to read the same endpoint
 * with the full permissions payload.
 *
 * Pagination is handled via `@odata.nextLink` walks; failures throw
 * so the caller can record the audit failure entry.
 */
function fetchRoleDefinitionsWithPermissions(subscriptionId, armToken, signal) {
    var _a, _b, _c, _d, _e, _f, _g;
    return __awaiter(this, void 0, void 0, function* () {
        const initialUrl = `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
            `/providers/Microsoft.Authorization/roleDefinitions` +
            `?api-version=${ARM_ROLE_API}`;
        const out = [];
        let url = initialUrl;
        while (url) {
            if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                throw new Error("Aborted");
            const resp = yield fetch(url, Object.assign({ headers: {
                    Authorization: `Bearer ${armToken}`,
                    Accept: "application/json",
                } }, (signal ? { signal } : {})));
            if (!resp.ok) {
                let msg = `ARM roleDefinitions failed: ${resp.status}`;
                try {
                    const body = (yield resp.json());
                    if ((_a = body === null || body === void 0 ? void 0 : body.error) === null || _a === void 0 ? void 0 : _a.message)
                        msg = body.error.message;
                }
                catch (_h) {
                    /* ignore */
                }
                throw new Error(msg);
            }
            const body = (yield resp.json());
            for (const r of (_b = body.value) !== null && _b !== void 0 ? _b : []) {
                if (!r.name)
                    continue;
                out.push({
                    id: r.name,
                    name: (_d = (_c = r.properties) === null || _c === void 0 ? void 0 : _c.roleName) !== null && _d !== void 0 ? _d : r.name,
                    type: (_e = r.properties) === null || _e === void 0 ? void 0 : _e.type,
                    permissions: ((_g = (_f = r.properties) === null || _f === void 0 ? void 0 : _f.permissions) !== null && _g !== void 0 ? _g : []).map((p) => {
                        var _a, _b, _c, _d;
                        return ({
                            actions: (_a = p.actions) !== null && _a !== void 0 ? _a : [],
                            notActions: (_b = p.notActions) !== null && _b !== void 0 ? _b : [],
                            dataActions: (_c = p.dataActions) !== null && _c !== void 0 ? _c : [],
                            notDataActions: (_d = p.notDataActions) !== null && _d !== void 0 ? _d : [],
                        });
                    }),
                });
            }
            url = body["@odata.nextLink"];
        }
        return out;
    });
}
/**
 * Best-effort enumeration of a group's transitive members via Graph.
 *
 * We deliberately swallow per-group errors (returning an empty array)
 * because the calling page must NEVER hard-fail if it can't see one
 * group — operators commonly run this with a service principal that
 * has subscription Reader but no Graph Group.Read.All consent. Worst
 * case: group-mediated escalation simply doesn't light up, and the
 * UI shows the group as a flat principal row.
 */
function fetchGroupTransitiveMembers(groupId, tenantId, graphToken, signal) {
    var _a, _b, _c, _d, _e, _f;
    return __awaiter(this, void 0, void 0, function* () {
        // The endpoint accepts simple `$select` to limit fields. Tenant id
        // is encoded into the graph base, NOT the URL path — Graph routes
        // by token tenant. We pass tenantId to the audit string only.
        void tenantId;
        const url = `${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}/transitiveMembers` +
            `?$select=id,displayName,userPrincipalName,mail`;
        const out = [];
        let next = url;
        while (next) {
            if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                return out;
            try {
                const resp = yield fetch(next, Object.assign({ headers: {
                        Authorization: `Bearer ${graphToken}`,
                        Accept: "application/json",
                    } }, (signal ? { signal } : {})));
                if (!resp.ok) {
                    // Soft-fail: insufficient privileges, etc. Return whatever we
                    // collected so far (typically empty).
                    return out;
                }
                const body = (yield resp.json());
                for (const m of (_a = body.value) !== null && _a !== void 0 ? _a : []) {
                    const id = String((_b = m.id) !== null && _b !== void 0 ? _b : "");
                    if (!id)
                        continue;
                    const odata = String((_c = m["@odata.type"]) !== null && _c !== void 0 ? _c : "").toLowerCase();
                    const type = odata.includes("user")
                        ? "User"
                        : odata.includes("group")
                            ? "Group"
                            : odata.includes("serviceprincipal")
                                ? "ServicePrincipal"
                                : "Unknown";
                    out.push({
                        id,
                        displayName: (_e = (_d = m.displayName) !== null && _d !== void 0 ? _d : m.userPrincipalName) !== null && _e !== void 0 ? _e : id,
                        type,
                        signInName: (_f = m.userPrincipalName) !== null && _f !== void 0 ? _f : m.mail,
                    });
                }
                next = body["@odata.nextLink"];
            }
            catch (_g) {
                return out; // soft fail: never throw
            }
        }
        return out;
    });
}
// ---------------------------------------------------------------------------
// Supplementary defender-signal Graph fetchers
//
// These power Signals B, C, D from the corpus (`_bypass_role_grant.md` §5,
// §3.5, §4.x). They are LOAD-ON-DEMAND — the operator clicks the panel's
// "Enumerate" button to trigger them, so a normal probe doesn't pay the
// extra Graph cost when the user only wants role-graph results.
//
// COORDINATOR: these endpoints aren't in the existing graph-service helper
// surface. Rather than expand the shared service in this scoped edit, we
// inline the fetchers here. If a future change adds them to graph-service,
// re-route these calls through the service.
// ---------------------------------------------------------------------------
/**
 * Enumerate role-assignable groups + their owners (Signal B).
 *
 * Corpus: `_bypass_role_grant.md` §5.1 + §5.3 — these groups can hold Entra
 * directory roles, and the OWNERS inherit the group's role with no
 * role-grant audit event firing. The detector ranks severity based on
 * whether the group holds a Tier-0 role AND has non-Tier-0 owners.
 */
function fetchRoleAssignableGroupsWithOwners(graphToken, signal) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    return __awaiter(this, void 0, void 0, function* () {
        const initialUrl = `${GRAPH_BASE}/groups` +
            `?$filter=isAssignableToRole eq true` +
            `&$select=id,displayName,isAssignableToRoleEnabled`;
        const groups = [];
        let next = initialUrl;
        // Step 1: enumerate role-assignable groups.
        while (next) {
            if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                throw new Error("Aborted");
            const resp = yield fetch(next, Object.assign({ headers: {
                    Authorization: `Bearer ${graphToken}`,
                    Accept: "application/json",
                } }, (signal ? { signal } : {})));
            if (!resp.ok) {
                const errBody = (yield resp.json().catch(() => ({})));
                throw new Error((_b = (_a = errBody === null || errBody === void 0 ? void 0 : errBody.error) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : `Graph role-assignable groups failed: ${resp.status}`);
            }
            const body = (yield resp.json());
            for (const g of (_c = body.value) !== null && _c !== void 0 ? _c : []) {
                if (!g.id)
                    continue;
                groups.push({ id: g.id, displayName: (_d = g.displayName) !== null && _d !== void 0 ? _d : g.id });
            }
            next = body["@odata.nextLink"];
        }
        // Step 2: for each group, fetch owners. We cap concurrency by walking
        // sequentially — group-counts are usually small (single digits) and we
        // want predictable throttling behaviour.
        const out = [];
        for (const g of groups) {
            if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                break;
            const ownersUrl = `${GRAPH_BASE}/groups/${encodeURIComponent(g.id)}/owners` +
                `?$select=id,displayName,userPrincipalName,mail`;
            const owners = [];
            try {
                const resp = yield fetch(ownersUrl, Object.assign({ headers: {
                        Authorization: `Bearer ${graphToken}`,
                        Accept: "application/json",
                    } }, (signal ? { signal } : {})));
                if (resp.ok) {
                    const body = (yield resp.json());
                    for (const o of (_e = body.value) !== null && _e !== void 0 ? _e : []) {
                        const id = String((_f = o.id) !== null && _f !== void 0 ? _f : "");
                        if (!id)
                            continue;
                        const odata = String((_g = o["@odata.type"]) !== null && _g !== void 0 ? _g : "").toLowerCase();
                        const type = odata.includes("user")
                            ? "User"
                            : odata.includes("serviceprincipal")
                                ? "ServicePrincipal"
                                : odata.includes("group")
                                    ? "Group"
                                    : "Unknown";
                        owners.push({
                            id,
                            displayName: (_j = (_h = o.displayName) !== null && _h !== void 0 ? _h : o.userPrincipalName) !== null && _j !== void 0 ? _j : id,
                            type,
                            signInName: (_k = o.userPrincipalName) !== null && _k !== void 0 ? _k : o.mail,
                        });
                    }
                }
                // Soft-fail on per-group permission errors so the panel still
                // renders for the groups we CAN see.
            }
            catch (_l) {
                /* soft-fail per group */
            }
            out.push({ id: g.id, displayName: g.displayName, owners });
        }
        return out;
    });
}
/**
 * Enumerate Application Administrator + Cloud Application Administrator
 * holders AND service principals that hold admin-tier Graph permissions
 * (Signal C).
 *
 * Corpus: `_bypass_role_grant.md` §3.5 — App Admin can `addKey` to ANY app
 * including apps already granted high-tier Graph scopes
 * (`RoleManagement.ReadWrite.Directory` et al). Detecting this combo is
 * the canonical stealth-GA chain detection.
 *
 * Endpoints used (read-only):
 *   GET /v1.0/directoryRoles
 *   GET /v1.0/directoryRoles/{id}/members
 *   GET /v1.0/servicePrincipals?$filter=appId eq '00000003-0000-0000-c000-000000000046'
 *     (the Microsoft Graph SP — whose appRoles[] is the canonical scope list)
 *   GET /v1.0/servicePrincipals/{ms-graph-id}/appRoleAssignedTo
 */
function fetchAppAdminEscalationData(graphToken, signal) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    return __awaiter(this, void 0, void 0, function* () {
        // The two directoryRole ids we care about. These are well-known and
        // STABLE across all Entra tenants (commercial + sovereign).
        const APP_ADMIN_TEMPLATE = "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3";
        const CLOUD_APP_ADMIN_TEMPLATE = "158c047a-c907-4556-b7ef-446551a6b5f7";
        // 1) GET /directoryRoles — filter client-side to App-Admin variants.
        const rolesResp = yield fetch(`${GRAPH_BASE}/directoryRoles` +
            `?$select=id,displayName,roleTemplateId`, Object.assign({ headers: {
                Authorization: `Bearer ${graphToken}`,
                Accept: "application/json",
            } }, (signal ? { signal } : {})));
        if (!rolesResp.ok) {
            throw new Error(`Graph directoryRoles failed: ${rolesResp.status}`);
        }
        const rolesBody = (yield rolesResp.json());
        const targetRoles = ((_a = rolesBody.value) !== null && _a !== void 0 ? _a : []).filter((r) => {
            var _a, _b;
            return ((_a = r.roleTemplateId) !== null && _a !== void 0 ? _a : "").toLowerCase() ===
                APP_ADMIN_TEMPLATE.toLowerCase() ||
                ((_b = r.roleTemplateId) !== null && _b !== void 0 ? _b : "").toLowerCase() ===
                    CLOUD_APP_ADMIN_TEMPLATE.toLowerCase();
        });
        const appAdminPrincipals = [];
        // 2) For each target role, enumerate members.
        for (const role of targetRoles) {
            if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                break;
            if (!role.id)
                continue;
            try {
                const membersResp = yield fetch(`${GRAPH_BASE}/directoryRoles/${encodeURIComponent(role.id)}/members` +
                    `?$select=id,displayName,userPrincipalName,mail`, Object.assign({ headers: {
                        Authorization: `Bearer ${graphToken}`,
                        Accept: "application/json",
                    } }, (signal ? { signal } : {})));
                if (!membersResp.ok)
                    continue;
                const membersBody = (yield membersResp.json());
                for (const m of (_b = membersBody.value) !== null && _b !== void 0 ? _b : []) {
                    const id = String((_c = m.id) !== null && _c !== void 0 ? _c : "");
                    if (!id)
                        continue;
                    const odata = String((_d = m["@odata.type"]) !== null && _d !== void 0 ? _d : "").toLowerCase();
                    const type = odata.includes("user")
                        ? "User"
                        : odata.includes("serviceprincipal")
                            ? "ServicePrincipal"
                            : odata.includes("group")
                                ? "Group"
                                : "Unknown";
                    appAdminPrincipals.push({
                        id,
                        displayName: (_f = (_e = m.displayName) !== null && _e !== void 0 ? _e : m.userPrincipalName) !== null && _f !== void 0 ? _f : id,
                        type,
                        signInName: (_g = m.userPrincipalName) !== null && _g !== void 0 ? _g : m.mail,
                        roleName: (_h = role.displayName) !== null && _h !== void 0 ? _h : "Application Administrator",
                    });
                }
            }
            catch (_p) {
                /* soft-fail per role */
            }
        }
        // 3) Enumerate high-priv SPs via Microsoft Graph SP's `appRoleAssignedTo`.
        const highPrivSps = [];
        try {
            const msGraphAppId = "00000003-0000-0000-c000-000000000046";
            const spResp = yield fetch(`${GRAPH_BASE}/servicePrincipals` +
                `?$filter=appId eq '${msGraphAppId}'` +
                `&$select=id,appRoles`, Object.assign({ headers: {
                    Authorization: `Bearer ${graphToken}`,
                    Accept: "application/json",
                } }, (signal ? { signal } : {})));
            if (spResp.ok) {
                const spBody = (yield spResp.json());
                const msGraphSp = (_j = spBody.value) === null || _j === void 0 ? void 0 : _j[0];
                if (msGraphSp === null || msGraphSp === void 0 ? void 0 : msGraphSp.id) {
                    // Build appRoleId -> scope-value map (the actual permission string).
                    const roleValueById = new Map();
                    for (const r of (_k = msGraphSp.appRoles) !== null && _k !== void 0 ? _k : []) {
                        if (r.id && r.value)
                            roleValueById.set(r.id, r.value);
                    }
                    // Enumerate every SP that has been granted one of these appRoles.
                    let next = `${GRAPH_BASE}/servicePrincipals/${encodeURIComponent(msGraphSp.id)}` +
                        `/appRoleAssignedTo` +
                        `?$select=id,appRoleId,principalId,principalDisplayName,principalType`;
                    // We aggregate roles per principal.
                    const byPrincipal = new Map();
                    while (next) {
                        if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                            break;
                        const r = yield fetch(next, Object.assign({ headers: {
                                Authorization: `Bearer ${graphToken}`,
                                Accept: "application/json",
                            } }, (signal ? { signal } : {})));
                        if (!r.ok)
                            break;
                        const body = (yield r.json());
                        for (const ar of (_l = body.value) !== null && _l !== void 0 ? _l : []) {
                            const scope = ar.appRoleId
                                ? roleValueById.get(ar.appRoleId)
                                : undefined;
                            if (!scope || !ADMIN_TIER_GRAPH_APP_ROLES.has(scope))
                                continue;
                            const pid = ar.principalId;
                            if (!pid)
                                continue;
                            const entry = (_m = byPrincipal.get(pid)) !== null && _m !== void 0 ? _m : {
                                displayName: (_o = ar.principalDisplayName) !== null && _o !== void 0 ? _o : pid,
                                appRoles: new Set(),
                            };
                            entry.appRoles.add(scope);
                            byPrincipal.set(pid, entry);
                        }
                        next = body["@odata.nextLink"];
                    }
                    for (const [pid, v] of byPrincipal.entries()) {
                        highPrivSps.push({
                            id: pid,
                            displayName: v.displayName,
                            appRoles: Array.from(v.appRoles),
                        });
                    }
                }
            }
        }
        catch (_q) {
            /* soft-fail */
        }
        return { appAdminPrincipals, highPrivSps };
    });
}
/**
 * Enumerate credential metadata for the union of:
 *   - SPs we already discovered as role-assignment principals.
 *   - SPs known to be high-priv (Signal C result, if available).
 *
 * Corpus: `_bypass_role_grant.md` §4.1, §4.2 (the addPassword / addKey
 * persistence primitives). We surface `passwordCredentials.length`,
 * `keyCredentials.length`, and the newest `startDateTime` so the page
 * can flag credentials minted inside the recency window.
 *
 * COORDINATOR: needs baseline snapshot to diff — without one, the page can
 * only show within-window recency. A future baseline service would
 * unlock proper CHANGE detection matching corpus item 5 more closely.
 */
function fetchSpCredentialSurface(graphToken, spIds, highPrivSpIds, signal) {
    var _a, _b, _c;
    return __awaiter(this, void 0, void 0, function* () {
        // De-dupe + cap to keep the page responsive — defensive surface, not
        // exhaustive inventory.
        const unique = Array.from(new Set(spIds.filter(Boolean))).slice(0, 200);
        const out = [];
        for (const id of unique) {
            if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                break;
            try {
                // Try servicePrincipals first (the most common case for our probe
                // input — RBAC assignments name servicePrincipal object ids, not app
                // ids). Fall back to applications if it 404s.
                let resp = yield fetch(`${GRAPH_BASE}/servicePrincipals/${encodeURIComponent(id)}` +
                    `?$select=id,displayName,passwordCredentials,keyCredentials`, Object.assign({ headers: {
                        Authorization: `Bearer ${graphToken}`,
                        Accept: "application/json",
                    } }, (signal ? { signal } : {})));
                if (resp.status === 404) {
                    resp = yield fetch(`${GRAPH_BASE}/applications/${encodeURIComponent(id)}` +
                        `?$select=id,displayName,passwordCredentials,keyCredentials`, Object.assign({ headers: {
                            Authorization: `Bearer ${graphToken}`,
                            Accept: "application/json",
                        } }, (signal ? { signal } : {})));
                }
                if (!resp.ok)
                    continue;
                const body = (yield resp.json());
                const pwd = (_a = body.passwordCredentials) !== null && _a !== void 0 ? _a : [];
                const keys = (_b = body.keyCredentials) !== null && _b !== void 0 ? _b : [];
                const newestPwdEnd = pwd
                    .map((c) => c.endDateTime)
                    .filter((x) => !!x)
                    .sort()
                    .pop();
                const newestKeyEnd = keys
                    .map((c) => c.endDateTime)
                    .filter((x) => !!x)
                    .sort()
                    .pop();
                const newestStart = [...pwd, ...keys]
                    .map((c) => c.startDateTime)
                    .filter((x) => !!x)
                    .sort()
                    .pop();
                out.push({
                    spId: id,
                    displayName: (_c = body.displayName) !== null && _c !== void 0 ? _c : id,
                    passwordCredentialCount: pwd.length,
                    keyCredentialCount: keys.length,
                    newestPasswordEnd: newestPwdEnd,
                    newestKeyEnd: newestKeyEnd,
                    newestCredentialStart: newestStart,
                    isHighPriv: highPrivSpIds.has(id),
                });
            }
            catch (_d) {
                /* soft-fail per SP */
            }
        }
        return out;
    });
}
// ---------------------------------------------------------------------------
// Tier badge — uses the variant mapping from PRIVILEGE_TIER_META.
// ---------------------------------------------------------------------------
const TierBadge = ({ tier, className, }) => {
    const meta = PRIVILEGE_TIER_META[tier];
    return (React.createElement(Badge, { variant: meta.badgeVariant, className: cn("text-2xs", className), title: meta.description },
        tier === "critical" && (React.createElement(ShieldAlert, { className: "mr-1 h-3 w-3", "aria-hidden": true })),
        tier === "privileged" && (React.createElement(Crown, { className: "mr-1 h-3 w-3", "aria-hidden": true })),
        tier === "write" && React.createElement(Zap, { className: "mr-1 h-3 w-3", "aria-hidden": true }),
        tier === "readonly" && React.createElement(ShieldCheck, { className: "mr-1 h-3 w-3", "aria-hidden": true }),
        meta.label));
};
// ---------------------------------------------------------------------------
// Escalation alert row inside an expanded principal.
// ---------------------------------------------------------------------------
const EscalationRow = ({ finding }) => {
    const variant = finding.category === "direct" ? "destructive" : "warning";
    return (React.createElement(Alert, { variant: variant === "destructive" ? "destructive" : undefined, className: cn("border", variant === "destructive" &&
            "border-destructive/40 bg-destructive/10 text-destructive", variant === "warning" &&
            "border-warning/40 bg-warning/10 text-warning") },
        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
        React.createElement(AlertDescription, null,
            React.createElement("div", { className: "text-xs font-medium" }, finding.headline),
            React.createElement("p", { className: "m-0 mt-0.5 text-2xs opacity-90" }, finding.detail),
            finding.viaPrincipalId && (React.createElement("p", { className: "m-0 mt-0.5 font-mono text-2xs opacity-70" },
                "via ",
                finding.viaPrincipalId.substring(0, 8),
                "\u2026")))));
};
// ---------------------------------------------------------------------------
// Single principal "node" — collapsible header + expanded assignment list.
// ---------------------------------------------------------------------------
/**
 * One principal "node" in the tree.
 *
 * Memoized with React.memo because on large tenants the principal list can
 * be in the hundreds of rows; without memo, every toggle of one row's
 * `expanded` state would re-render every other row (the parent re-renders
 * all children, but each PrincipalNode's inputs are stable shallow-equal
 * across toggles that don't affect it).
 */
const PrincipalNodeBase = ({ summary, expanded, onToggle, isPathHighlight, credentialFinding, compact, selected, onSelectToggle, }) => {
    var _a;
    const Icon = principalIcon(summary.principalType);
    const meta = PRIVILEGE_TIER_META[summary.highestTier];
    const accentTint = isPathHighlight
        ? "border-primary/60 bg-primary/5 ring-2 ring-primary/40"
        : summary.highestTier === "critical"
            ? "border-destructive/40 bg-destructive/5"
            : summary.highestTier === "privileged"
                ? "border-warning/40 bg-warning/5"
                : summary.hasEscalation
                    ? "border-warning/40 bg-warning/5"
                    : "border-border bg-card";
    return (React.createElement("div", { className: cn("overflow-hidden rounded-md border", accentTint, selected && "ring-2 ring-primary") },
        React.createElement("div", { className: "group/copy relative flex items-center" },
            onSelectToggle && (React.createElement("span", { className: "pl-2" },
                React.createElement(Checkbox, { checked: !!selected, onCheckedChange: () => onSelectToggle(), "aria-label": `Select ${summary.displayName}` }))),
            React.createElement("button", { type: "button", onClick: onToggle, className: cn("flex w-full flex-wrap items-center gap-2 text-left text-xs transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", compact ? "px-2 py-1" : "px-3 py-2"), "aria-expanded": expanded, "aria-controls": `principal-body-${summary.principalId}` },
                expanded ? (React.createElement(ChevronDown, { className: "h-3.5 w-3.5 shrink-0", "aria-hidden": true })) : (React.createElement(ChevronRight, { className: "h-3.5 w-3.5 shrink-0", "aria-hidden": true })),
                React.createElement(Icon, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground", "aria-hidden": true }),
                React.createElement("span", { className: "flex min-w-0 flex-1 flex-col" },
                    React.createElement("span", { className: "flex flex-wrap items-center gap-1 truncate font-medium" },
                        React.createElement("span", { className: "truncate" }, summary.displayName),
                        summary.isGuest && (React.createElement(Badge, { variant: "warning", className: "ml-1 text-2xs" },
                            React.createElement(UserX, { className: "mr-1 h-3 w-3", "aria-hidden": true }),
                            "Guest")),
                        summary.hasEscalation && (React.createElement(Badge, { variant: "destructive", className: "ml-1 text-2xs" },
                            React.createElement(AlertTriangle, { className: "mr-1 h-3 w-3", "aria-hidden": true }),
                            "Escalation"))),
                    React.createElement("span", { className: "flex flex-wrap items-center gap-1 text-2xs text-muted-foreground" },
                        summary.signInName && (React.createElement("span", { className: "truncate font-mono" }, summary.signInName)),
                        summary.signInName && React.createElement("span", { className: "opacity-60" }, "\u00B7"),
                        React.createElement("span", { className: "font-mono opacity-70", title: summary.principalId },
                            summary.principalId.substring(0, 8),
                            "\u2026"))),
                React.createElement(Badge, { variant: "secondary", className: "text-2xs" }, summary.principalType),
                React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                    summary.assignmentCount,
                    " ",
                    summary.assignmentCount === 1 ? "role" : "roles"),
                credentialFinding && (React.createElement(Badge, { variant: credentialFinding.isRecent && credentialFinding.isHighPriv
                        ? "destructive"
                        : credentialFinding.isRecent
                            ? "warning"
                            : "outline", className: "text-2xs", title: credentialFinding.isRecent
                        ? `Newest credential minted ${(_a = credentialFinding.daysSinceNewestCredential) !== null && _a !== void 0 ? _a : "?"} day(s) ago — within recency window.`
                        : `${credentialFinding.passwordCredentialCount} pwd / ${credentialFinding.keyCredentialCount} key credentials.` },
                    React.createElement(Key, { className: "mr-1 h-3 w-3", "aria-hidden": true }),
                    credentialFinding.passwordCredentialCount +
                        credentialFinding.keyCredentialCount,
                    " ",
                    "cred",
                    credentialFinding.isRecent && " · recent")),
                React.createElement(TierBadge, { tier: summary.highestTier }),
                React.createElement("span", { className: "sr-only" },
                    "highest tier: ",
                    meta.label,
                    " (",
                    meta.description,
                    ")")),
            React.createElement("span", { className: "absolute right-2 top-1/2 -translate-y-1/2" },
                React.createElement(CopyButton, { value: summary.principalId, ariaLabel: `Copy principal id ${summary.principalId}` }))),
        expanded && (React.createElement("div", { id: `principal-body-${summary.principalId}`, className: "flex flex-col gap-2 border-t border-border/60 bg-background/40 p-2" },
            summary.escalations.length > 0 && (React.createElement("div", { className: "flex flex-col gap-1" }, summary.escalations.map((f, idx) => (React.createElement(EscalationRow, { key: `${f.category}-${idx}`, finding: f }))))),
            React.createElement("ul", { className: "flex flex-col gap-1" }, summary.assignments.map((a) => (React.createElement(AssignmentRow, { key: a.assignmentId, assignment: a })))),
            summary.groupMembers && summary.groupMembers.length > 0 && (React.createElement("details", { className: "rounded border border-border/60 bg-muted/30 p-2 text-2xs" },
                React.createElement("summary", { className: "cursor-pointer font-medium text-muted-foreground" },
                    "Transitive group members (",
                    summary.groupMembers.length,
                    ")"),
                React.createElement("ul", { className: "mt-1.5 flex flex-col gap-0.5" },
                    summary.groupMembers.slice(0, 50).map((m) => {
                        const MIcon = principalIcon(m.type);
                        return (React.createElement("li", { key: m.id, className: "flex items-center gap-1.5", title: m.id },
                            React.createElement(MIcon, { className: "h-3 w-3 text-muted-foreground", "aria-hidden": true }),
                            React.createElement("span", { className: "truncate" }, m.displayName),
                            m.signInName && (React.createElement("span", { className: "truncate font-mono text-muted-foreground/80" }, m.signInName))));
                    }),
                    summary.groupMembers.length > 50 && (React.createElement("li", { className: "italic text-muted-foreground/80" },
                        "\u2026 and ",
                        summary.groupMembers.length - 50,
                        " more")))))))));
};
// React.memo wraps the body — re-renders only when one of the inputs changes.
// summary identity is stable across unrelated toggles (it's keyed in the
// parent's summaries memo by principalId).
const PrincipalNode = React.memo(PrincipalNodeBase);
const AssignmentRow = ({ assignment, }) => {
    return (React.createElement("li", { className: "group/copy flex flex-wrap items-center gap-1.5 rounded border border-border/40 bg-card/40 px-2 py-1 text-2xs" },
        React.createElement(TierBadge, { tier: assignment.tier }),
        React.createElement("span", { className: "truncate font-medium", title: `Role definition id ${assignment.roleDefinitionId}` }, assignment.roleName),
        React.createElement(CopyButton, { value: assignment.roleDefinitionId, ariaLabel: `Copy role definition id ${assignment.roleDefinitionId}` }),
        React.createElement("span", { className: "opacity-60" }, "@"),
        React.createElement(Badge, { variant: "outline", className: "text-2xs", title: assignment.scope }, describeScope(assignment.scope)),
        React.createElement(CopyButton, { value: assignment.scope, ariaLabel: `Copy scope ${assignment.scope}` }),
        assignment.subscriptionDisplayName && (React.createElement("span", { className: "truncate text-muted-foreground" },
            "in ",
            assignment.subscriptionDisplayName)),
        assignment.atSubScope ? (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "at scope")) : (React.createElement(Badge, { variant: "secondary", className: "text-2xs" }, "inherited")),
        assignment.createdOn && (React.createElement("span", { className: "ml-auto font-mono text-3xs opacity-70", title: assignment.createdOn }, assignment.createdOn.slice(0, 10)))));
};
const SubscriptionPicker = ({ options, selected, onToggle, onToggleAll, disabled }) => {
    const allSelected = options.length > 0 && options.every((o) => selected.has(o.subscriptionId));
    return (React.createElement("div", { className: "flex flex-col gap-1.5" },
        React.createElement("div", { className: "flex items-center justify-between gap-2" },
            React.createElement("span", { className: "text-2xs font-medium uppercase tracking-wider text-muted-foreground" },
                "Subscriptions (",
                selected.size,
                "/",
                options.length,
                ")"),
            React.createElement(Button, { type: "button", size: "sm", variant: "ghost", className: "h-6 px-2 text-2xs", onClick: () => onToggleAll(!allSelected), disabled: disabled || options.length === 0 }, allSelected ? "Clear all" : "Select all")),
        React.createElement("div", { className: "max-h-48 overflow-y-auto rounded border border-border bg-background/40 p-1.5" }, options.length === 0 ? (React.createElement("p", { className: "px-1 py-2 text-2xs text-muted-foreground" }, "No subscriptions discovered for this account.")) : (options.map((o) => {
            const isChecked = selected.has(o.subscriptionId);
            return (React.createElement("label", { key: o.subscriptionId, className: cn("flex items-center gap-2 rounded px-1.5 py-1 text-2xs hover:bg-accent/30", isChecked && "bg-accent/20") },
                React.createElement(Checkbox, { checked: isChecked, disabled: disabled, onCheckedChange: () => onToggle(o.subscriptionId), "aria-label": `Audit subscription ${o.displayName}` }),
                React.createElement("span", { className: "flex min-w-0 flex-1 flex-col" },
                    React.createElement("span", { className: "truncate font-medium" }, o.displayName),
                    React.createElement("span", { className: "truncate font-mono text-3xs text-muted-foreground" }, o.subscriptionId))));
        })))));
};
// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------
export const RoleGraphPage = ({ onNavigate }) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const state = useMultiRegionState();
    const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    const activeAccounts = React.useMemo(() => azureAccounts.filter((a) => a.status === "active" && !!a.homeAccountId && !!a.tenantId), [azureAccounts]);
    // -------- Account picker --------
    const [accountId, setAccountId] = React.useState("");
    React.useEffect(() => {
        if (activeAccounts.length === 0) {
            if (accountId)
                setAccountId("");
            return;
        }
        if (!activeAccounts.some((a) => a.homeAccountId === accountId)) {
            setAccountId(activeAccounts[0].homeAccountId);
        }
    }, [activeAccounts, accountId]);
    const account = React.useMemo(() => { var _a; return (_a = activeAccounts.find((a) => a.homeAccountId === accountId)) !== null && _a !== void 0 ? _a : null; }, [activeAccounts, accountId]);
    // -------- ARM-token tracker (drives TokenExpiryBadge) --------
    const armTokenTracker = useArmToken(account === null || account === void 0 ? void 0 : account.homeAccountId, account ? resolveActiveTenantId(account) : undefined);
    // -------- Subscription picker --------
    const subscriptionOptions = React.useMemo(() => {
        if (!account)
            return [];
        return account.subscriptions
            .filter((s) => s.state === "Enabled" || s.state === "Warned")
            .map((s) => ({
            subscriptionId: s.subscriptionId,
            displayName: s.displayName || s.subscriptionId,
            tenantId: s.tenantId,
        }));
    }, [account]);
    const [selectedSubs, setSelectedSubs] = React.useState(() => new Set());
    // When the account changes, reset to "auto-pick all subs (max 5)".
    React.useEffect(() => {
        if (!account) {
            setSelectedSubs(new Set());
            return;
        }
        const ids = subscriptionOptions
            .slice(0, 5)
            .map((o) => o.subscriptionId);
        setSelectedSubs(new Set(ids));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [account === null || account === void 0 ? void 0 : account.homeAccountId, subscriptionOptions.length]);
    const toggleSub = React.useCallback((id) => {
        setSelectedSubs((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }, []);
    const toggleAllSubs = React.useCallback((selectAll) => {
        if (selectAll) {
            setSelectedSubs(new Set(subscriptionOptions.map((o) => o.subscriptionId)));
        }
        else {
            setSelectedSubs(new Set());
        }
    }, [subscriptionOptions]);
    // -------- Probe state --------
    const [probing, setProbing] = React.useState(false);
    const [probeError, setProbeError] = React.useState(null);
    const [probeWarnings, setProbeWarnings] = React.useState([]);
    const [probedAt, setProbedAt] = React.useState(null);
    const [subResults, setSubResults] = React.useState([]);
    const [groupMembers, setGroupMembers] = React.useState(() => new Map());
    const abortRef = React.useRef(null);
    const runProbe = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _m;
        if (!account)
            return;
        const targets = Array.from(selectedSubs)
            .map((id) => subscriptionOptions.find((o) => o.subscriptionId === id))
            .filter((o) => !!o)
            .map((o) => ({
            subscriptionId: o.subscriptionId,
            displayName: o.displayName,
            tenantId: o.tenantId,
        }));
        if (targets.length === 0) {
            setProbeError("Pick at least one subscription to audit.");
            return;
        }
        // Cancel any in-flight probe before starting a new one.
        (_m = abortRef.current) === null || _m === void 0 ? void 0 : _m.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setProbing(true);
        setProbeError(null);
        setProbeWarnings([]);
        setSubResults([]);
        setGroupMembers(new Map());
        const warnings = [];
        const results = [];
        try {
            // ARM token from the active tenant — useArmToken's value is already
            // following the operator's active tenant, but if it hasn't acquired
            // yet we fall back to a one-shot refresh via the tracker.
            let armToken = armTokenTracker.token;
            if (!armToken) {
                armToken = yield armTokenTracker.refresh();
            }
            if (!armToken) {
                throw new Error("Couldn't acquire an ARM token for the picked account.");
            }
            // ---- Per-sub probes (sequential to play nice with throttling) ----
            for (const tgt of targets) {
                if (ctrl.signal.aborted)
                    return;
                const r = {
                    subscriptionId: tgt.subscriptionId,
                    displayName: tgt.displayName,
                    tenantId: tgt.tenantId,
                    assignments: [],
                    roleDefs: [],
                    principals: [],
                };
                try {
                    const [assignments, roleDefs] = yield Promise.all([
                        listSubscriptionRoleAssignments(tgt.subscriptionId, armToken),
                        fetchRoleDefinitionsWithPermissions(tgt.subscriptionId, armToken, ctrl.signal),
                    ]);
                    r.assignments = assignments;
                    r.roleDefs = roleDefs;
                    // Resolve principals via Graph in the sub's tenant.
                    try {
                        const graphToken = yield getGraphTokenForAccount(account.homeAccountId, tgt.tenantId);
                        const ids = Array.from(new Set(assignments.map((a) => a.principalId).filter(Boolean)));
                        r.principals = yield getPrincipalsByIds(tgt.tenantId, ids, graphToken);
                    }
                    catch (graphErr) {
                        warnings.push(`Graph principals not resolved for ${tgt.displayName}: ${graphErr instanceof Error ? graphErr.message : String(graphErr)}`);
                    }
                }
                catch (subErr) {
                    r.error =
                        subErr instanceof Error ? subErr.message : String(subErr);
                    warnings.push(`${tgt.displayName}: ${r.error}`);
                }
                results.push(r);
            }
            // ---- Group-mediated probe: best-effort transitive members for
            //      every GROUP principal whose highest tier is critical. We
            //      compute the tiers first via the helper to keep this scope-
            //      aware, then walk the union of crit-tier groups. ----
            const allPrincipals = new Map();
            for (const r of results) {
                for (const p of r.principals) {
                    if (!allPrincipals.has(p.id))
                        allPrincipals.set(p.id, p);
                }
            }
            const criticalGroupIds = new Set();
            for (const r of results) {
                const roleById = new Map(r.roleDefs.map((d) => [d.id, d]));
                for (const a of r.assignments) {
                    const tier = classifyRoleTier(roleById.get(a.roleDefinitionId), a.roleDefinitionId, a.scope);
                    if (tier !== "critical")
                        continue;
                    const principal = allPrincipals.get(a.principalId);
                    const isGroup = (principal === null || principal === void 0 ? void 0 : principal.type) === "Group" || a.principalType === "Group";
                    if (isGroup)
                        criticalGroupIds.add(a.principalId);
                }
            }
            const memberMap = new Map();
            if (criticalGroupIds.size > 0) {
                // Use the FIRST target's tenant for the Graph token — group
                // resolution is normally only meaningful when all subs share a
                // tenant. For multi-tenant cases we still try the first; the
                // soft-failing fetcher returns [] which the UI handles.
                const firstTenant = targets[0].tenantId;
                try {
                    const graphToken = yield getGraphTokenForAccount(account.homeAccountId, firstTenant);
                    // Cap concurrent group probes to avoid hammering Graph if the
                    // tenant has many critical-group assignments.
                    const groupIds = Array.from(criticalGroupIds);
                    for (let i = 0; i < groupIds.length; i++) {
                        if (ctrl.signal.aborted)
                            break;
                        const gId = groupIds[i];
                        const members = yield fetchGroupTransitiveMembers(gId, firstTenant, graphToken, ctrl.signal);
                        if (members.length > 0)
                            memberMap.set(gId, members);
                    }
                }
                catch (gErr) {
                    warnings.push(`Group membership expansion partially skipped: ${gErr instanceof Error ? gErr.message : String(gErr)}`);
                }
            }
            if (ctrl.signal.aborted)
                return;
            setSubResults(results);
            setGroupMembers(memberMap);
            setProbeWarnings(warnings);
            setProbedAt(new Date().toISOString());
            setProbing(false);
            // NOTE: Per the page brief the probe itself is read-only enumeration
            // and not a state-changing action for OUR app, so we deliberately do
            // NOT call auditLog.record() for probes. Audit firing is reserved for
            // filter mutations (see recordFilterMutation() below).
        }
        catch (err) {
            if (ctrl.signal.aborted)
                return;
            const msg = err instanceof Error ? err.message : String(err);
            setProbeError(msg);
            setProbing(false);
            // Probes are not audited (read-only enumeration); see note above.
        }
    }), [account, selectedSubs, subscriptionOptions, armTokenTracker]);
    // Cancel in-flight probe on unmount.
    React.useEffect(() => {
        return () => {
            var _a;
            (_a = abortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
        };
    }, []);
    // -------- Build summaries via helpers (memoised) --------
    const summaries = React.useMemo(() => {
        var _a;
        if (subResults.length === 0)
            return [];
        // Flatten + tier-classify every assignment, joined with the sub's
        // display name for friendly export rows.
        const flatAssignments = [];
        const principalLookup = new Map();
        for (const r of subResults) {
            const roleById = new Map(r.roleDefs.map((d) => [d.id, d]));
            const roleNameById = new Map(r.roleDefs.map((d) => [d.id, d.name]));
            // Track this sub's scope so we know "at sub scope" without leaking
            // into a closure scope from elsewhere.
            const subScope = `/subscriptions/${r.subscriptionId}`.toLowerCase();
            for (const a of r.assignments) {
                const def = roleById.get(a.roleDefinitionId);
                const tier = classifyRoleTier(def, a.roleDefinitionId, a.scope);
                flatAssignments.push({
                    assignmentId: a.id,
                    roleDefinitionId: a.roleDefinitionId,
                    roleName: (_a = roleNameById.get(a.roleDefinitionId)) !== null && _a !== void 0 ? _a : a.roleDefinitionId,
                    tier,
                    scope: a.scope,
                    scopeLevel: classifyScopeLevel(a.scope),
                    atSubScope: a.scope.toLowerCase() === subScope ||
                        a.scope.toLowerCase().startsWith(`${subScope}/`),
                    createdOn: a.createdOn,
                    subscriptionId: r.subscriptionId,
                    subscriptionDisplayName: r.displayName,
                    principalId: a.principalId,
                    principalType: a.principalType,
                });
            }
            for (const p of r.principals) {
                if (!principalLookup.has(p.id)) {
                    principalLookup.set(p.id, {
                        displayName: p.displayName,
                        type: p.type,
                        signInName: p.signInName,
                    });
                }
            }
        }
        return groupByPrincipal({
            assignments: flatAssignments,
            principalLookup,
            groupMembersByGroupId: groupMembers,
        });
    }, [subResults, groupMembers]);
    // -------- Filters (URL-persisted via useUrlState) --------
    //
    // Filter state is kept in the URL search-params so an operator can
    // bookmark / share a focused view ("here are all critical-tier guests on
    // sub X"). Each filter mutation also records a single `role_graph_filter`
    // audit-log row — per the page brief, raw probes are read-only and not
    // audited, but filter changes ARE worth recording because a stripped-
    // down view can change what an operator overlooks during a review.
    const URL_KEYS = React.useMemo(() => [
        "q",
        "tier",
        "ptype",
        "esc",
        "scope",
        "focusPrincipal",
        "focusScope",
    ], []);
    const URL_INITIAL = React.useMemo(() => ({
        q: "",
        tier: [],
        ptype: [],
        esc: "all",
        scope: "all",
        focusPrincipal: "",
        focusScope: "",
    }), []);
    const [urlState, setUrlState] = useUrlState(URL_INITIAL, {
        keys: URL_KEYS,
        replace: true,
    });
    // Project the URL state into the typed `RoleGraphFilters` shape consumed by
    // the helpers — the helpers don't know about path-finder; that's overlay-only.
    const filters = React.useMemo(() => {
        var _a, _b, _c, _d, _e;
        const tierVals = ((_a = urlState.tier) !== null && _a !== void 0 ? _a : []).filter((t) => t === "critical" || t === "privileged" || t === "write" || t === "readonly");
        const escVal = ((_b = urlState.esc) !== null && _b !== void 0 ? _b : "all");
        const scopeVal = ((_c = urlState.scope) !== null && _c !== void 0 ? _c : "all");
        return {
            search: (_d = urlState.q) !== null && _d !== void 0 ? _d : "",
            tiers: tierVals,
            principalTypes: (_e = urlState.ptype) !== null && _e !== void 0 ? _e : [],
            escalation: [
                "all",
                "any",
                "direct",
                "groupMediated",
                "crossTenantGuest",
            ].includes(escVal)
                ? escVal
                : "all",
            scope: ["all", "subscription", "resourceGroup", "resource"].includes(scopeVal)
                ? scopeVal
                : "all",
        };
    }, [urlState]);
    // ---- Filter-mutation audit (only fires on user-initiated changes) ----
    // Each kind/value pair is reduced to one audit row. We deliberately do
    // NOT audit `useUrlState` rehydration on mount (that's not a mutation),
    // so we route every change through `recordFilterMutation` from inside
    // the toggle callbacks.
    const recordFilterMutation = React.useCallback((kind, value) => {
        var _a;
        if (!account)
            return;
        auditLog.record({
            actor: account.username,
            action: `role_graph_filter_${kind}`,
            target: (_a = getActiveTenant(account.homeAccountId)) !== null && _a !== void 0 ? _a : "no-tenant",
            status: "success",
            details: { value },
        });
    }, [account]);
    // Debounce search-typing audit so we record ONE row per filter
    // intent instead of one row per keystroke. Other filter mutations
    // (tier toggle, scope select) audit synchronously because they're
    // already one click = one mutation.
    const searchAuditTimerRef = React.useRef(null);
    React.useEffect(() => {
        return () => {
            if (searchAuditTimerRef.current) {
                clearTimeout(searchAuditTimerRef.current);
            }
        };
    }, []);
    const updateFilter = React.useCallback((patch) => {
        var _a;
        setUrlState((prev) => {
            const next = {};
            if (patch.search !== undefined)
                next.q = patch.search;
            if (patch.tiers !== undefined)
                next.tier = patch.tiers;
            if (patch.principalTypes !== undefined)
                next.ptype = patch.principalTypes;
            if (patch.escalation !== undefined)
                next.esc = patch.escalation;
            if (patch.scope !== undefined)
                next.scope = patch.scope;
            void prev;
            return next;
        });
        const keys = Object.keys(patch);
        const headKey = (_a = keys[0]) !== null && _a !== void 0 ? _a : "unknown";
        // Debounce on search to avoid spamming audit-log on every keystroke.
        if (headKey === "search" && keys.length === 1) {
            if (searchAuditTimerRef.current) {
                clearTimeout(searchAuditTimerRef.current);
            }
            const value = patch.search;
            searchAuditTimerRef.current = setTimeout(() => {
                recordFilterMutation("search", value);
            }, 500);
            return;
        }
        recordFilterMutation(headKey, patch);
    }, [setUrlState, recordFilterMutation]);
    const toggleTierFilter = React.useCallback((t) => {
        setUrlState((prev) => {
            var _a;
            const arr = (_a = prev.tier) !== null && _a !== void 0 ? _a : [];
            const next = arr.includes(t)
                ? arr.filter((x) => x !== t)
                : [...arr, t];
            return { tier: next };
        });
        recordFilterMutation("tier", t);
    }, [setUrlState, recordFilterMutation]);
    const togglePrincipalType = React.useCallback((pt) => {
        setUrlState((prev) => {
            var _a;
            const arr = (_a = prev.ptype) !== null && _a !== void 0 ? _a : [];
            const next = arr.includes(pt)
                ? arr.filter((x) => x !== pt)
                : [...arr, pt];
            return { ptype: next };
        });
        recordFilterMutation("ptype", pt);
    }, [setUrlState, recordFilterMutation]);
    const clearFilters = React.useCallback(() => {
        setUrlState({
            q: "",
            tier: [],
            ptype: [],
            esc: "all",
            scope: "all",
            focusPrincipal: "",
            focusScope: "",
        });
        recordFilterMutation("clear", true);
    }, [setUrlState, recordFilterMutation]);
    const filteredSummaries = React.useMemo(() => applyFilters(summaries, filters), [summaries, filters]);
    // -------- Path-finder overlay --------
    //
    // The operator picks a principal hint + a scope hint, and we highlight
    // every principal that holds an assignment under the matching scope.
    // This is overlay-only — it doesn't change which rows render (that's the
    // filter's job), it just visually emphasizes the matched principals so
    // the "path" between them and a target scope is unambiguous at a glance.
    const focusPrincipal = ((_b = urlState.focusPrincipal) !== null && _b !== void 0 ? _b : "").toLowerCase();
    const focusScope = ((_c = urlState.focusScope) !== null && _c !== void 0 ? _c : "").toLowerCase();
    const pathHighlightIds = React.useMemo(() => {
        var _a;
        if (!focusPrincipal && !focusScope)
            return new Set();
        const out = new Set();
        for (const s of filteredSummaries) {
            const principalMatch = focusPrincipal
                ? s.principalId.toLowerCase().includes(focusPrincipal) ||
                    s.displayName.toLowerCase().includes(focusPrincipal) ||
                    ((_a = s.signInName) !== null && _a !== void 0 ? _a : "").toLowerCase().includes(focusPrincipal)
                : true;
            if (!principalMatch)
                continue;
            const scopeMatch = focusScope
                ? s.assignments.some((a) => a.scope.toLowerCase().includes(focusScope))
                : true;
            if (scopeMatch)
                out.add(s.principalId);
        }
        return out;
    }, [filteredSummaries, focusPrincipal, focusScope]);
    const [presets, setPresets] = usePersistedState("role-graph:presets", [], { version: 1 });
    const [presetName, setPresetName] = React.useState("");
    const saveCurrentPreset = React.useCallback(() => {
        const name = presetName.trim();
        if (!name)
            return;
        setPresets((prev) => {
            var _a, _b, _c, _d, _e, _f, _g;
            const filtered = prev.filter((p) => p.name !== name);
            return [
                ...filtered,
                {
                    name,
                    state: {
                        q: (_a = urlState.q) !== null && _a !== void 0 ? _a : "",
                        tier: (_b = urlState.tier) !== null && _b !== void 0 ? _b : [],
                        ptype: (_c = urlState.ptype) !== null && _c !== void 0 ? _c : [],
                        esc: (_d = urlState.esc) !== null && _d !== void 0 ? _d : "all",
                        scope: (_e = urlState.scope) !== null && _e !== void 0 ? _e : "all",
                        focusPrincipal: (_f = urlState.focusPrincipal) !== null && _f !== void 0 ? _f : "",
                        focusScope: (_g = urlState.focusScope) !== null && _g !== void 0 ? _g : "",
                    },
                    savedAt: new Date().toISOString(),
                },
            ];
        });
        setPresetName("");
        recordFilterMutation("preset_save", name);
    }, [presetName, urlState, setPresets, recordFilterMutation]);
    const loadPreset = React.useCallback((name) => {
        const preset = presets.find((p) => p.name === name);
        if (!preset)
            return;
        setUrlState(preset.state);
        recordFilterMutation("preset_load", name);
    }, [presets, setUrlState, recordFilterMutation]);
    const deletePreset = React.useCallback((name) => {
        setPresets((prev) => prev.filter((p) => p.name !== name));
        recordFilterMutation("preset_delete", name);
    }, [setPresets, recordFilterMutation]);
    // -------- Expansion state --------
    const [expanded, setExpanded] = React.useState(() => new Set());
    const toggleExpanded = React.useCallback((id) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }, []);
    // Auto-expand all escalation-flagged principals on initial render so the
    // operator sees risk without clicking. Subsequent toggles are user-driven.
    // Use `useAbortableEffect` so the synchronous body short-circuits cleanly
    // if `summaries` changes between renders mid-tear-down.
    useAbortableEffect((signal) => {
        if (summaries.length === 0)
            return;
        if (signal.aborted)
            return;
        const next = new Set();
        for (const s of summaries) {
            if (s.hasEscalation)
                next.add(s.principalId);
        }
        setExpanded(next);
    }, [summaries]);
    // -------- Summary stats --------
    const stats = React.useMemo(() => computeStats(summaries), [summaries]);
    const filteredStats = React.useMemo(() => computeStats(filteredSummaries), [filteredSummaries]);
    // -------- Defender-signal data sources (Signals A/B/C/D) --------
    //
    // Signal A (custom-role privesc) is purely derived from existing probe data
    // and re-computes on every change. Signals B/C/D require supplementary
    // Graph reads — load-on-demand to avoid paying that cost on every probe.
    //
    // Citations:
    //   _bypass_role_grant.md §8.1 (A), §5.1/§5.3 (B), §3.5 (C), §4.1/§4.2 (D)
    //   _AZURE_BYPASS_PLAYBOOK.md Top-30 items 23-26 + Defender Audit 4-5
    const principalLookup = React.useMemo(() => {
        const m = new Map();
        for (const r of subResults) {
            for (const p of r.principals) {
                if (!m.has(p.id)) {
                    m.set(p.id, {
                        displayName: p.displayName,
                        type: p.type,
                        signInName: p.signInName,
                    });
                }
            }
        }
        return m;
    }, [subResults]);
    // ----- Signal A: derived synchronously from probe data -----
    const customRoleFindings = React.useMemo(() => {
        if (subResults.length === 0)
            return [];
        return detectCustomRoleWritePrivesc({
            subResults: subResults.map((r) => ({
                subscriptionId: r.subscriptionId,
                displayName: r.displayName,
                roleDefs: r.roleDefs,
                assignments: r.assignments.map((a) => ({
                    id: a.id,
                    principalId: a.principalId,
                    principalType: a.principalType,
                    roleDefinitionId: a.roleDefinitionId,
                    scope: a.scope,
                })),
            })),
            principalLookup,
        });
    }, [subResults, principalLookup]);
    // ----- Signal B: role-assignable groups + owners (load-on-demand) -----
    //
    // Each signal owns its OWN abort controller — a shared controller used to
    // cancel B's in-flight fetch when the operator clicked C, dropping B's
    // progress on the floor. Per-signal refs let all three signals load
    // concurrently when the operator wants the full picture.
    const [roleAssignableGroupFindings, setRoleAssignableGroupFindings] = React.useState(null);
    const [roleAssignableGroupsLoading, setRoleAssignableGroupsLoading] = React.useState(false);
    const [roleAssignableGroupsWarning, setRoleAssignableGroupsWarning] = React.useState(null);
    const signalBAbortRef = React.useRef(null);
    const signalCAbortRef = React.useRef(null);
    const signalDAbortRef = React.useRef(null);
    // Raw role-assignable groups + owners — also feeds the ownership-chain
    // detector below (which lives in helpers, not the page).
    const [rawRoleAssignableGroups, setRawRoleAssignableGroups] = React.useState([]);
    const loadRoleAssignableGroups = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _o, _p;
        if (!account || subResults.length === 0)
            return;
        const firstTenant = (_o = subResults[0]) === null || _o === void 0 ? void 0 : _o.tenantId;
        if (!firstTenant)
            return;
        (_p = signalBAbortRef.current) === null || _p === void 0 ? void 0 : _p.abort();
        const ctrl = new AbortController();
        signalBAbortRef.current = ctrl;
        setRoleAssignableGroupsLoading(true);
        setRoleAssignableGroupsWarning(null);
        try {
            const graphToken = yield getGraphTokenForAccount(account.homeAccountId, firstTenant);
            const groups = yield fetchRoleAssignableGroupsWithOwners(graphToken, ctrl.signal);
            if (ctrl.signal.aborted)
                return;
            // Stash the raw groups so the ownership-chain detector can run without
            // a second fetch.
            setRawRoleAssignableGroups(groups);
            const findings = auditRoleAssignableGroups({ groups, summaries });
            setRoleAssignableGroupFindings(findings);
        }
        catch (err) {
            if (ctrl.signal.aborted)
                return;
            setRoleAssignableGroupFindings([]);
            setRoleAssignableGroupsWarning(err instanceof Error ? err.message : String(err));
        }
        finally {
            if (!ctrl.signal.aborted)
                setRoleAssignableGroupsLoading(false);
        }
    }), [account, subResults, summaries]);
    // ----- Signal C: App Admin escalation paths (load-on-demand) -----
    const [appAdminFindings, setAppAdminFindings] = React.useState(null);
    const [appAdminLoading, setAppAdminLoading] = React.useState(false);
    const [appAdminWarning, setAppAdminWarning] = React.useState(null);
    // Cache high-priv SP id set so Signal D can re-use it without refetching.
    const [highPrivSpIds, setHighPrivSpIds] = React.useState(() => new Set());
    const loadAppAdmin = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _q, _r;
        if (!account || subResults.length === 0)
            return;
        const firstTenant = (_q = subResults[0]) === null || _q === void 0 ? void 0 : _q.tenantId;
        if (!firstTenant)
            return;
        (_r = signalCAbortRef.current) === null || _r === void 0 ? void 0 : _r.abort();
        const ctrl = new AbortController();
        signalCAbortRef.current = ctrl;
        setAppAdminLoading(true);
        setAppAdminWarning(null);
        try {
            const graphToken = yield getGraphTokenForAccount(account.homeAccountId, firstTenant);
            const data = yield fetchAppAdminEscalationData(graphToken, ctrl.signal);
            if (ctrl.signal.aborted)
                return;
            setHighPrivSpIds(new Set(data.highPrivSps.map((s) => s.id)));
            const findings = detectAppAdminEscalation({
                appAdminPrincipals: data.appAdminPrincipals,
                highPrivSps: data.highPrivSps,
            });
            setAppAdminFindings(findings);
        }
        catch (err) {
            if (ctrl.signal.aborted)
                return;
            setAppAdminFindings([]);
            setAppAdminWarning(err instanceof Error ? err.message : String(err));
        }
        finally {
            if (!ctrl.signal.aborted)
                setAppAdminLoading(false);
        }
    }), [account, subResults]);
    // ----- Signal D: SP credential surface (load-on-demand) -----
    const [credentialSurfaceFindings, setCredentialSurfaceFindings] = React.useState(null);
    const [credentialSurfaceLoading, setCredentialSurfaceLoading] = React.useState(false);
    const [credentialSurfaceWarning, setCredentialSurfaceWarning] = React.useState(null);
    const loadCredentialSurface = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _s, _t;
        if (!account || subResults.length === 0)
            return;
        const firstTenant = (_s = subResults[0]) === null || _s === void 0 ? void 0 : _s.tenantId;
        if (!firstTenant)
            return;
        (_t = signalDAbortRef.current) === null || _t === void 0 ? void 0 : _t.abort();
        const ctrl = new AbortController();
        signalDAbortRef.current = ctrl;
        setCredentialSurfaceLoading(true);
        setCredentialSurfaceWarning(null);
        try {
            const graphToken = yield getGraphTokenForAccount(account.homeAccountId, firstTenant);
            // Collect SP-typed principals from the existing probe (RBAC role
            // holders) AND any high-priv SP ids we already cached from Signal C.
            const spIds = new Set();
            for (const r of subResults) {
                for (const p of r.principals) {
                    if (p.type === "ServicePrincipal" ||
                        p.type === "Application") {
                        spIds.add(p.id);
                    }
                }
            }
            for (const id of highPrivSpIds)
                spIds.add(id);
            const summary = yield fetchSpCredentialSurface(graphToken, Array.from(spIds), highPrivSpIds, ctrl.signal);
            if (ctrl.signal.aborted)
                return;
            const findings = summarizeCredentialSurface(summary);
            setCredentialSurfaceFindings(findings);
        }
        catch (err) {
            if (ctrl.signal.aborted)
                return;
            setCredentialSurfaceFindings([]);
            setCredentialSurfaceWarning(err instanceof Error ? err.message : String(err));
        }
        finally {
            if (!ctrl.signal.aborted)
                setCredentialSurfaceLoading(false);
        }
    }), [account, subResults, highPrivSpIds]);
    // Cancel in-flight signal fetches when the page unmounts. Per-signal abort
    // refs so loaders don't cancel each other when the operator clicks more
    // than one Enumerate button.
    React.useEffect(() => {
        return () => {
            var _a, _b, _c;
            (_a = signalBAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
            (_b = signalCAbortRef.current) === null || _b === void 0 ? void 0 : _b.abort();
            (_c = signalDAbortRef.current) === null || _c === void 0 ? void 0 : _c.abort();
        };
    }, []);
    // Reset signal findings whenever the probe restarts — stale rows from
    // the previous probe would confuse the operator.
    React.useEffect(() => {
        setRoleAssignableGroupFindings(null);
        setRoleAssignableGroupsWarning(null);
        setRawRoleAssignableGroups([]);
        setAppAdminFindings(null);
        setAppAdminWarning(null);
        setHighPrivSpIds(new Set());
        setCredentialSurfaceFindings(null);
        setCredentialSurfaceWarning(null);
    }, [subResults]);
    // ----- Aggregate defender-signal counts + risk score -----
    const defenderCounts = React.useMemo(() => {
        const countBy = (arr, sev) => (arr ? arr.filter((f) => f.severity === sev).length : 0);
        return {
            customRolePrivescCritical: countBy(customRoleFindings, "critical"),
            customRolePrivescHigh: countBy(customRoleFindings, "high"),
            roleAssignableGroupCritical: countBy(roleAssignableGroupFindings, "critical"),
            roleAssignableGroupHigh: countBy(roleAssignableGroupFindings, "high"),
            appAdminEscalationCritical: countBy(appAdminFindings, "critical"),
            appAdminEscalationHigh: countBy(appAdminFindings, "high"),
            credentialSurfaceCritical: countBy(credentialSurfaceFindings, "critical"),
            credentialSurfaceHigh: countBy(credentialSurfaceFindings, "high"),
        };
    }, [
        customRoleFindings,
        roleAssignableGroupFindings,
        appAdminFindings,
        credentialSurfaceFindings,
    ]);
    const defenderScore = React.useMemo(() => computeDefenderSignalScore(defenderCounts), [defenderCounts]);
    // Per-principal credential lookup powers the inline "cred / recent" badge
    // on each PrincipalNode header. Keyed by lowercased principal id to be
    // robust against ARM/Graph's mixed-case GUID return values.
    // Citation: _bypass_role_grant.md §4.1, §4.2.
    const credentialFindingsByPrincipalId = React.useMemo(() => {
        const m = new Map();
        for (const f of credentialSurfaceFindings !== null && credentialSurfaceFindings !== void 0 ? credentialSurfaceFindings : []) {
            m.set(f.spId.toLowerCase(), f);
        }
        // Return a wrapper that also looks up by un-lowered id for callers that
        // pass the principal id verbatim (PrincipalNode does).
        return {
            get(id) {
                return m.get(id.toLowerCase());
            },
        };
    }, [credentialSurfaceFindings]);
    // -------- BFS path finder + transitive ownership chain --------
    //
    // The path-finder runs entirely client-side from the data the probe
    // already produced — no extra Graph reads. It surfaces every group/role
    // hop between a hint principal and a hint scope, including nested groups
    // (corpus: _bypass_role_grant.md §5.3, §5.4 + §10 chain map).
    //
    // The ownership-chain detector runs over whatever Signal B raw data is
    // present + the existing transitive-members map. When Signal B hasn't been
    // loaded, the detector silently returns []. The result feeds the
    // PathFinderPanel below.
    const armedPathFinder = ((_e = (_d = urlState.focusPrincipal) === null || _d === void 0 ? void 0 : _d.length) !== null && _e !== void 0 ? _e : 0) > 0 ||
        ((_g = (_f = urlState.focusScope) === null || _f === void 0 ? void 0 : _f.length) !== null && _g !== void 0 ? _g : 0) > 0;
    const foundPaths = React.useMemo(() => {
        var _a, _b;
        if (!armedPathFinder)
            return [];
        return findShortestPath({
            principalQuery: (_a = urlState.focusPrincipal) !== null && _a !== void 0 ? _a : "",
            scopeQuery: (_b = urlState.focusScope) !== null && _b !== void 0 ? _b : "",
            summaries,
            groupMembersByGroupId: groupMembers,
            maxPaths: 25,
        });
    }, [
        armedPathFinder,
        urlState.focusPrincipal,
        urlState.focusScope,
        summaries,
        groupMembers,
    ]);
    const ownershipChains = React.useMemo(() => {
        if (rawRoleAssignableGroups.length === 0)
            return [];
        return detectOwnershipChains({
            groups: rawRoleAssignableGroups,
            summaries,
            groupMembersByGroupId: groupMembers,
        });
    }, [rawRoleAssignableGroups, summaries, groupMembers]);
    // -------- Density toggle (compact/comfy) — persisted across reloads --------
    const [densityCompact, setDensityCompact] = usePersistedState("role-graph:density-compact", false, { version: 1 });
    // -------- Multi-select for batch export / pivot --------
    const [multiSelectMode, setMultiSelectMode] = React.useState(false);
    const [selectedPrincipals, setSelectedPrincipals] = React.useState(() => new Set());
    const toggleSelectPrincipal = React.useCallback((id) => {
        setSelectedPrincipals((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }, []);
    const clearSelection = React.useCallback(() => {
        setSelectedPrincipals(new Set());
    }, []);
    // Clear selection when we leave multi-select mode.
    React.useEffect(() => {
        if (!multiSelectMode)
            clearSelection();
    }, [multiSelectMode, clearSelection]);
    // -------- Hotkeys: `f` focuses path finder, `c` collapses all --------
    const pathFinderInputRef = React.useRef(null);
    React.useEffect(() => {
        function onKey(e) {
            var _a;
            // Ignore when typing in a field — never steal `f` from a search box.
            const t = e.target;
            if (t &&
                (t.tagName === "INPUT" ||
                    t.tagName === "TEXTAREA" ||
                    t.tagName === "SELECT" ||
                    t.isContentEditable)) {
                return;
            }
            if (e.metaKey || e.ctrlKey || e.altKey)
                return;
            if (e.key === "f" || e.key === "F") {
                e.preventDefault();
                (_a = pathFinderInputRef.current) === null || _a === void 0 ? void 0 : _a.focus();
            }
            else if (e.key === "c" || e.key === "C") {
                e.preventDefault();
                setExpanded(new Set());
            }
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
    // -------- Path-finder text-input debouncing --------
    //
    // The URL search params are the source of truth (so a link/share is the
    // exact view), but rewriting search params on EVERY keystroke caused
    // visible jank when the operator typed quickly. We mirror to a local
    // shadow value and push to the URL after 250ms idle.
    const [pathPrincipalDraft, setPathPrincipalDraft] = React.useState((_h = urlState.focusPrincipal) !== null && _h !== void 0 ? _h : "");
    const [pathScopeDraft, setPathScopeDraft] = React.useState((_j = urlState.focusScope) !== null && _j !== void 0 ? _j : "");
    // Sync drafts when URL changes externally (preset load / clear).
    React.useEffect(() => {
        var _a;
        setPathPrincipalDraft((_a = urlState.focusPrincipal) !== null && _a !== void 0 ? _a : "");
    }, [urlState.focusPrincipal]);
    React.useEffect(() => {
        var _a;
        setPathScopeDraft((_a = urlState.focusScope) !== null && _a !== void 0 ? _a : "");
    }, [urlState.focusScope]);
    const pathDebounceRef = React.useRef(null);
    const commitPathDraft = React.useCallback((which, value) => {
        if (pathDebounceRef.current)
            clearTimeout(pathDebounceRef.current);
        pathDebounceRef.current = setTimeout(() => {
            setUrlState(which === "principal"
                ? { focusPrincipal: value }
                : { focusScope: value });
        }, 250);
    }, [setUrlState]);
    React.useEffect(() => {
        return () => {
            if (pathDebounceRef.current)
                clearTimeout(pathDebounceRef.current);
        };
    }, []);
    // -------- Export columns --------
    const exportRows = React.useMemo(() => {
        var _a, _b;
        const rows = [];
        for (const s of filteredSummaries) {
            for (const a of s.assignments) {
                rows.push({
                    principalId: s.principalId,
                    displayName: s.displayName,
                    principalType: s.principalType,
                    signInName: (_a = s.signInName) !== null && _a !== void 0 ? _a : "",
                    isGuest: s.isGuest,
                    highestTier: s.highestTier,
                    assignmentCount: s.assignmentCount,
                    escalationCategories: s.escalations
                        .map((e) => e.category)
                        .join("|"),
                    role: a.roleName,
                    scope: a.scope,
                    scopeLevel: a.scopeLevel,
                    subscription: (_b = a.subscriptionDisplayName) !== null && _b !== void 0 ? _b : a.subscriptionId,
                    atSubScope: a.atSubScope,
                    tier: a.tier,
                });
            }
        }
        return rows;
    }, [filteredSummaries]);
    const exportColumns = React.useMemo(() => [
        { header: "principalId", accessor: (r) => r.principalId },
        { header: "displayName", accessor: (r) => r.displayName },
        { header: "principalType", accessor: (r) => r.principalType },
        { header: "signInName", accessor: (r) => r.signInName },
        { header: "isGuest", accessor: (r) => r.isGuest },
        { header: "highestTier", accessor: (r) => r.highestTier },
        { header: "assignmentCount", accessor: (r) => r.assignmentCount },
        {
            header: "escalationCategories",
            accessor: (r) => r.escalationCategories,
        },
        { header: "role", accessor: (r) => r.role },
        { header: "tier", accessor: (r) => r.tier },
        { header: "scope", accessor: (r) => r.scope },
        { header: "scopeLevel", accessor: (r) => r.scopeLevel },
        { header: "subscription", accessor: (r) => r.subscription },
        { header: "atSubScope", accessor: (r) => r.atSubScope },
    ], []);
    const exportMetadata = React.useMemo(() => ({
        page: "role-graph",
        generatedAt: new Date().toISOString(),
        account: account ? account.username : null,
        subscriptionsAudited: Array.from(selectedSubs),
        probedAt,
        filters,
        summary: filteredStats,
        escalationDetail: filteredSummaries
            .filter((s) => s.hasEscalation)
            .map((s) => ({
            principalId: s.principalId,
            displayName: s.displayName,
            escalations: s.escalations,
        })),
    }), [
        account,
        selectedSubs,
        probedAt,
        filters,
        filteredStats,
        filteredSummaries,
    ]);
    // -------- Global tenant-switch listener --------
    useTenantChange(undefined, (detail) => {
        const candidate = detail.homeAccountId;
        if (!activeAccounts.some((a) => a.homeAccountId === candidate))
            return;
        if (accountId === candidate)
            return;
        setAccountId(candidate);
    });
    // -------- Render: sign-in gate --------
    if (activeAccounts.length === 0) {
        return (React.createElement("div", { className: "flex flex-col gap-4" },
            React.createElement(PageHeader, { title: "Role Assignment Visualizer", description: "Audit who holds what RBAC role at what scope across your subscriptions \u2014 Stormspotter-style attack-graph analysis for defenders." }),
            React.createElement(SignInRequired, { whatYouCantDo: "Audit role assignments", why: "an Azure account with reader access on the subscription(s) you want to audit", onNavigate: onNavigate })));
    }
    // -------- Render: main page --------
    const hasFilters = !!filters.search ||
        filters.tiers.length > 0 ||
        filters.principalTypes.length > 0 ||
        filters.escalation !== "all" ||
        filters.scope !== "all";
    return (React.createElement("div", { className: "flex flex-col gap-4" },
        React.createElement(PageHeader, { title: "Role Assignment Visualizer", description: "Audit who holds what RBAC role at what scope across your subscriptions. Privilege tiers, escalation paths, and group-mediated inheritance \u2014 surfaced for defensive auditing." },
            React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => {
                    void armTokenTracker.refresh();
                }, needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth({
                    loginHint: account === null || account === void 0 ? void 0 : account.username,
                }) }),
            probedAt && (React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                React.createElement(Network, { className: "mr-1 h-3 w-3", "aria-hidden": true }),
                "Last probe: ",
                new Date(probedAt).toLocaleTimeString()))),
        React.createElement(Card, null,
            React.createElement(CardHeader, null,
                React.createElement(CardTitle, { className: "text-sm" }, "Audit scope"),
                React.createElement(CardDescription, { className: "text-xs" }, "Pick the account + subscription(s) you want to audit. We read role assignments + role definitions at the subscription scope (including inherited rows) and resolve principal display names via Graph.")),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "grid grid-cols-1 gap-3 md:grid-cols-2" },
                    React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement("label", { htmlFor: "role-graph-account", className: "text-2xs font-medium uppercase tracking-wider text-muted-foreground" }, "Account"),
                        React.createElement(Select, { value: accountId, onValueChange: (v) => setAccountId(v), disabled: activeAccounts.length === 0 || probing },
                            React.createElement(SelectTrigger, { id: "role-graph-account", className: "text-xs" },
                                React.createElement(SelectValue, { placeholder: "Pick a signed-in account" })),
                            React.createElement(SelectContent, null, activeAccounts.map((a) => (React.createElement(SelectItem, { key: a.homeAccountId, value: a.homeAccountId },
                                React.createElement("span", { className: "flex flex-col" },
                                    React.createElement("span", { className: "font-medium" }, a.name || a.username),
                                    React.createElement("span", { className: "text-2xs text-muted-foreground" },
                                        a.username,
                                        " \u00B7",
                                        " ",
                                        pluralize(a.subscriptions.length, "subscription")))))))),
                        account && (React.createElement("p", { className: "text-3xs text-muted-foreground" },
                            "Active tenant:",
                            " ",
                            React.createElement("span", { className: "font-mono" }, (_k = getActiveTenant(account.homeAccountId)) !== null && _k !== void 0 ? _k : resolveActiveTenantId(account))))),
                    React.createElement(SubscriptionPicker, { options: subscriptionOptions, selected: selectedSubs, onToggle: toggleSub, onToggleAll: toggleAllSubs, disabled: probing || !account })),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: () => void runProbe(), disabled: probing || selectedSubs.size === 0 || !account, "aria-label": "Run audit probe" },
                        probing ? (React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin motion-reduce:animate-none" })) : (React.createElement(RefreshCw, { className: "h-3.5 w-3.5", "aria-hidden": true })),
                        probing
                            ? "Probing…"
                            : probedAt
                                ? "Re-run probe"
                                : "Run probe"),
                    probing && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => { var _a; return (_a = abortRef.current) === null || _a === void 0 ? void 0 : _a.abort(); } }, "Cancel")),
                    React.createElement(ExportMenu, { rows: exportRows, columns: exportColumns, filename: `role-graph-${(_l = account === null || account === void 0 ? void 0 : account.username) !== null && _l !== void 0 ? _l : "audit"}`, jsonMetadata: exportMetadata, disabled: probing, label: "Export" }),
                    probedAt && (React.createElement("span", { className: "text-2xs text-muted-foreground" }, summaries.length === 0
                        ? "No assignments returned."
                        : `${formatNumber(summaries.length)} ${pluralize(summaries.length, "principal")} across ${pluralize(subResults.length, "subscription")}`))),
                probeError && (React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertTriangle, { className: "h-4 w-4" }),
                    React.createElement(AlertDescription, { className: "text-xs" }, probeError))),
                probeWarnings.length > 0 && (React.createElement(Alert, null,
                    React.createElement(AlertTriangle, { className: "h-4 w-4" }),
                    React.createElement(AlertDescription, null,
                        React.createElement("div", { className: "text-xs font-medium" },
                            "Partial probe \u2014 ",
                            probeWarnings.length,
                            " ",
                            pluralize(probeWarnings.length, "warning")),
                        React.createElement("ul", { className: "ml-4 mt-1 list-disc text-2xs" },
                            probeWarnings.slice(0, 5).map((w, i) => (React.createElement("li", { key: i }, w))),
                            probeWarnings.length > 5 && (React.createElement("li", null,
                                "\u2026 and ",
                                probeWarnings.length - 5,
                                " more")))))))),
        (probedAt || probing) && (React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Audit summary" },
            React.createElement(SummaryStatItem, { label: "Assignments", value: stats.totalAssignments, hint: hasFilters
                    ? `${formatNumber(filteredStats.totalAssignments)} after filter`
                    : undefined }),
            React.createElement(SummaryStatItem, { label: "Unique principals", value: stats.uniquePrincipals, hint: hasFilters
                    ? `${formatNumber(filteredStats.uniquePrincipals)} after filter`
                    : undefined }),
            React.createElement(SummaryStatItem, { label: "Tier 0 (critical)", value: stats.tier0Count, tone: stats.tier0Count > 0 ? "destructive" : "muted" }),
            React.createElement(SummaryStatItem, { label: "Tier 1 (privileged)", value: stats.tier1Count, tone: stats.tier1Count > 0 ? "warning" : "muted" }),
            React.createElement(SummaryStatItem, { label: "Escalation paths", value: stats.escalationCount, tone: stats.escalationCount > 0 ? "destructive" : "muted" }),
            React.createElement(SummaryStatItem, { label: "Privileged guests", value: stats.guestPrivilegedCount, tone: stats.guestPrivilegedCount > 0 ? "warning" : "muted" }))),
        probedAt && summaries.length > 0 && (React.createElement(Card, null,
            React.createElement(CardContent, { className: "flex flex-col gap-3 pt-4" },
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement("div", { className: "relative flex-1 min-w-[200px]" },
                        React.createElement(Search, { className: "absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" }),
                        React.createElement(Input, { value: filters.search, onChange: (e) => updateFilter({ search: e.target.value }), placeholder: "Search by name, UPN, principal id, or role\u2026", className: "h-8 pl-7 text-xs", "aria-label": "Filter principals" }),
                        filters.search && (React.createElement("button", { type: "button", onClick: () => updateFilter({ search: "" }), className: "absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground", "aria-label": "Clear search" },
                            React.createElement(X, { className: "h-3 w-3" })))),
                    React.createElement(Select, { value: filters.escalation, onValueChange: (v) => updateFilter({
                            escalation: v,
                        }) },
                        React.createElement(SelectTrigger, { className: "h-8 w-44 text-xs" },
                            React.createElement(SelectValue, { placeholder: "Escalation status" })),
                        React.createElement(SelectContent, null,
                            React.createElement(SelectItem, { value: "all" }, "Any escalation status"),
                            React.createElement(SelectItem, { value: "any" }, "Any escalation finding"),
                            React.createElement(SelectItem, { value: "direct" }, "Direct elevation"),
                            React.createElement(SelectItem, { value: "groupMediated" }, "Group-mediated"),
                            React.createElement(SelectItem, { value: "crossTenantGuest" }, "Cross-tenant guest"))),
                    React.createElement(Select, { value: filters.scope, onValueChange: (v) => updateFilter({ scope: v }) },
                        React.createElement(SelectTrigger, { className: "h-8 w-44 text-xs" },
                            React.createElement(SelectValue, { placeholder: "Scope" })),
                        React.createElement(SelectContent, null,
                            React.createElement(SelectItem, { value: "all" }, "Any scope"),
                            React.createElement(SelectItem, { value: "subscription" }, "Subscription scope"),
                            React.createElement(SelectItem, { value: "resourceGroup" }, "Resource-group scope"),
                            React.createElement(SelectItem, { value: "resource" }, "Resource scope"))),
                    hasFilters && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: clearFilters, className: "h-8 px-2 text-2xs" }, "Clear filters"))),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement("span", { className: "flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground" },
                        React.createElement(Filter, { className: "h-3 w-3", "aria-hidden": true }),
                        "Tier"),
                    ["critical", "privileged", "write", "readonly"].map((t) => {
                        const meta = PRIVILEGE_TIER_META[t];
                        const active = filters.tiers.includes(t);
                        return (React.createElement("button", { key: t, type: "button", onClick: () => toggleTierFilter(t), className: "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full", "aria-pressed": active },
                            React.createElement(Badge, { variant: active ? meta.badgeVariant : "outline", className: cn("cursor-pointer text-2xs", !active && "opacity-60") }, meta.label)));
                    }),
                    React.createElement("span", { className: "ml-3 flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground" }, "Type"),
                    PRINCIPAL_TYPE_OPTIONS.map((pt) => {
                        const active = filters.principalTypes.includes(pt);
                        return (React.createElement("button", { key: pt, type: "button", onClick: () => togglePrincipalType(pt), className: "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full", "aria-pressed": active },
                            React.createElement(Badge, { variant: active ? "default" : "outline", className: cn("cursor-pointer text-2xs", !active && "opacity-60") }, pt)));
                    })),
                React.createElement("div", { className: "flex flex-col gap-2 border-t border-border/40 pt-3", role: "group", "aria-label": "Path finder and saved presets" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement("span", { className: "flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground" },
                            React.createElement(Target, { className: "h-3 w-3", "aria-hidden": true }),
                            "Path finder"),
                        React.createElement(Input, { ref: pathFinderInputRef, value: pathPrincipalDraft, onChange: (e) => {
                                setPathPrincipalDraft(e.target.value);
                                commitPathDraft("principal", e.target.value);
                            }, onBlur: (e) => e.target.value &&
                                recordFilterMutation("focusPrincipal", e.target.value), placeholder: "Principal id / name / UPN\u2026   (press f)", className: "h-8 max-w-[260px] text-xs", "aria-label": "Path-finder principal hint (hotkey f)" }),
                        React.createElement(Input, { value: pathScopeDraft, onChange: (e) => {
                                setPathScopeDraft(e.target.value);
                                commitPathDraft("scope", e.target.value);
                            }, onBlur: (e) => e.target.value &&
                                recordFilterMutation("focusScope", e.target.value), placeholder: "Target scope substring (e.g. /resourceGroups/prod-rg)", className: "h-8 max-w-[320px] text-xs font-mono", "aria-label": "Path-finder scope hint" }),
                        (urlState.focusPrincipal || urlState.focusScope) && (React.createElement(React.Fragment, null,
                            React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                                pathHighlightIds.size,
                                " ",
                                pathHighlightIds.size === 1 ? "match" : "matches"),
                            foundPaths.length > 0 && (React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                                foundPaths.length,
                                " ",
                                foundPaths.length === 1 ? "path" : "paths")),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => {
                                    setPathPrincipalDraft("");
                                    setPathScopeDraft("");
                                    setUrlState({
                                        focusPrincipal: "",
                                        focusScope: "",
                                    });
                                    recordFilterMutation("focusClear", true);
                                }, className: "h-8 px-2 text-2xs", "aria-label": "Clear path-finder" },
                                React.createElement(X, { className: "h-3 w-3" }),
                                "Clear"))),
                        React.createElement("span", { className: "ml-1 hidden items-center gap-1 text-3xs text-muted-foreground md:inline-flex", title: "Hotkey: press f to focus this input, c to collapse all" },
                            React.createElement(Keyboard, { className: "h-3 w-3", "aria-hidden": true }),
                            React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 font-mono text-3xs" }, "f"),
                            "focus,",
                            React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 font-mono text-3xs" }, "c"),
                            "collapse")),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement("span", { className: "flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground" },
                            React.createElement(Bookmark, { className: "h-3 w-3", "aria-hidden": true }),
                            "Saved views"),
                        React.createElement(Input, { value: presetName, onChange: (e) => setPresetName(e.target.value), onKeyDown: (e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    saveCurrentPreset();
                                }
                            }, placeholder: "Preset name\u2026", className: "h-8 max-w-[180px] text-xs", "aria-label": "Preset name" }),
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: saveCurrentPreset, disabled: !presetName.trim(), className: "h-8 px-2 text-2xs", "aria-label": "Save current filters as preset" },
                            React.createElement(Save, { className: "h-3 w-3", "aria-hidden": true }),
                            "Save"),
                        presets.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "list", "aria-label": "Saved presets" }, presets.map((p) => (React.createElement("span", { key: p.name, role: "listitem", className: "inline-flex items-center gap-1 rounded border border-border/60 bg-muted/30 px-1.5 py-0.5 text-2xs", title: `Saved ${p.savedAt}` },
                            React.createElement("button", { type: "button", className: "font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", onClick: () => loadPreset(p.name), "aria-label": `Load preset ${p.name}` }, p.name),
                            React.createElement("button", { type: "button", onClick: () => deletePreset(p.name), className: "text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": `Delete preset ${p.name}` },
                                React.createElement(Trash2, { className: "h-3 w-3", "aria-hidden": true })))))))))))),
        subResults.some((r) => !!r.error) && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(AlertTriangle, { className: "h-4 w-4" }),
            React.createElement(AlertDescription, null,
                React.createElement("div", { className: "text-xs font-medium" },
                    subResults.filter((r) => !!r.error).length,
                    " subscription",
                    subResults.filter((r) => !!r.error).length === 1 ? "" : "s",
                    " ",
                    "failed"),
                React.createElement("ul", { className: "ml-4 mt-1 list-disc text-2xs" }, subResults
                    .filter((r) => !!r.error)
                    .map((r) => (React.createElement("li", { key: r.subscriptionId },
                    React.createElement("span", { className: "font-medium" }, r.displayName),
                    ":",
                    " ",
                    r.error))))))),
        probing && summaries.length === 0 && (React.createElement("div", { className: "mt-1" },
            React.createElement(SkeletonLoader, { variant: "table", rows: 4, columns: 3 }))),
        probedAt && !probing && summaries.length === 0 && !probeError && (React.createElement(EmptyState, { icon: Network, title: "No role assignments returned", description: "Either the picked subscriptions have no role assignments visible to the audit account, or every sub probe failed. Check the per-sub errors above." })),
        summaries.length > 0 && filteredSummaries.length === 0 && (React.createElement(EmptyState, { icon: Search, title: "No principals match your filters", description: "Clear filters to see all principals from the last probe.", action: {
                label: "Clear filters",
                onClick: clearFilters,
                icon: X,
            } })),
        !probedAt && !probing && (React.createElement(EmptyState, { icon: Shield, title: "Run a probe to see the role graph", description: "Pick one or more subscriptions above and click Run probe. Results are session-local \u2014 nothing is persisted server-side.", action: {
                label: "Run probe",
                onClick: () => void runProbe(),
                icon: RefreshCw,
            } })),
        probedAt && summaries.length > 0 && (React.createElement(DefenderSignalsPanel, { customRoleFindings: customRoleFindings, roleAssignableGroupFindings: roleAssignableGroupFindings, roleAssignableGroupsLoading: roleAssignableGroupsLoading, onLoadRoleAssignableGroups: () => void loadRoleAssignableGroups(), roleAssignableGroupsWarning: roleAssignableGroupsWarning, appAdminFindings: appAdminFindings, appAdminLoading: appAdminLoading, onLoadAppAdmin: () => void loadAppAdmin(), appAdminWarning: appAdminWarning, credentialSurfaceFindings: credentialSurfaceFindings, credentialSurfaceLoading: credentialSurfaceLoading, onLoadCredentialSurface: () => void loadCredentialSurface(), credentialSurfaceWarning: credentialSurfaceWarning, counts: defenderCounts, score: defenderScore.score, scoreLabel: defenderScore.label })),
        probedAt && summaries.length > 0 &&
            (armedPathFinder || ownershipChains.length > 0) && (React.createElement(PathFinderPanel, { armed: armedPathFinder, paths: foundPaths, ownershipChains: ownershipChains, totalMatched: foundPaths.length, onFocusPrincipal: (id) => {
                setPathPrincipalDraft(id);
                setUrlState({ focusPrincipal: id });
                // Auto-expand the matched principal so the operator can see the
                // direct assignments without an extra click.
                setExpanded((prev) => {
                    const next = new Set(prev);
                    next.add(id);
                    return next;
                });
                recordFilterMutation("pathFocus", id);
            }, onFocusGroup: (id) => {
                setPathPrincipalDraft(id);
                setUrlState({ focusPrincipal: id });
                recordFilterMutation("pathFocusGroup", id);
            } })),
        filteredSummaries.length > 0 && (React.createElement("div", { className: "flex flex-col gap-2" },
            React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
                React.createElement("h2", { className: "text-sm font-semibold" },
                    "Principals (",
                    formatNumber(filteredSummaries.length),
                    ")",
                    multiSelectMode && selectedPrincipals.size > 0 && (React.createElement(Badge, { variant: "secondary", className: "ml-2 text-2xs" },
                        selectedPrincipals.size,
                        " selected"))),
                React.createElement("div", { className: "flex flex-wrap gap-1", role: "toolbar", "aria-label": "Principal-tree controls" },
                    React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 px-2 text-2xs", onClick: () => setDensityCompact(!densityCompact), "aria-pressed": densityCompact, title: `Switch to ${densityCompact ? "comfy" : "compact"} density` },
                        densityCompact ? (React.createElement(Rows4, { className: "h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(Rows3, { className: "h-3.5 w-3.5", "aria-hidden": true })),
                        densityCompact ? "Comfy" : "Compact"),
                    React.createElement(Button, { type: "button", variant: multiSelectMode ? "default" : "ghost", size: "sm", className: "h-7 px-2 text-2xs", onClick: () => setMultiSelectMode((v) => !v), "aria-pressed": multiSelectMode, title: "Toggle multi-select for batch export / pivot" }, "Multi-select"),
                    multiSelectMode && selectedPrincipals.size > 0 && (React.createElement(React.Fragment, null,
                        React.createElement(ExportMenu, { rows: exportRows.filter((r) => selectedPrincipals.has(r.principalId)), columns: exportColumns, filename: `role-graph-selection-${selectedPrincipals.size}`, jsonMetadata: Object.assign(Object.assign({}, exportMetadata), { selection: Array.from(selectedPrincipals) }), label: `Export ${selectedPrincipals.size}` }),
                        onNavigate && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "h-7 px-2 text-2xs", onClick: () => {
                                // Pivot to the privileged-audit page — the parent
                                // page-router doesn't currently accept selection state,
                                // so the cross-page handoff is just a navigate. The
                                // selection itself is preserved in the page state if
                                // the operator navigates back.
                                // COORDINATOR: when the page-router accepts a query
                                // string for selection, replace this with a path that
                                // carries the selected principal ids so privileged-audit
                                // can hydrate to the same set.
                                onNavigate("privileged-audit");
                                recordFilterMutation("pivotPrivilegedAudit", selectedPrincipals.size);
                            }, title: "Open privileged-audit page (selection is kept here)" }, "Pivot to privileged-audit")),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 px-2 text-2xs", onClick: clearSelection },
                            "Clear (",
                            selectedPrincipals.size,
                            ")"))),
                    React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 px-2 text-2xs", onClick: () => setExpanded(new Set(filteredSummaries.map((s) => s.principalId))) }, "Expand all"),
                    React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 px-2 text-2xs", onClick: () => setExpanded(new Set()), "aria-keyshortcuts": "c" }, "Collapse all"))),
            React.createElement("div", { className: "flex flex-col gap-1.5" }, filteredSummaries.map((s) => (React.createElement(PrincipalNode, { key: s.principalId, summary: s, expanded: expanded.has(s.principalId), onToggle: () => toggleExpanded(s.principalId), isPathHighlight: pathHighlightIds.has(s.principalId), credentialFinding: credentialFindingsByPrincipalId.get(s.principalId), compact: densityCompact, selected: multiSelectMode ? selectedPrincipals.has(s.principalId) : undefined, onSelectToggle: multiSelectMode
                    ? () => toggleSelectPrincipal(s.principalId)
                    : undefined })))),
            filteredStats.tier0Count === 0 &&
                filteredStats.tier1Count === 0 &&
                filteredStats.escalationCount === 0 && (React.createElement(Alert, null,
                React.createElement(CheckCircle2, { className: "h-4 w-4" }),
                React.createElement(AlertDescription, { className: "text-xs" },
                    "No critical or privileged tier assignments and no escalation paths found in this view. Filters: ",
                    hasFilters ? "active" : "none",
                    ".")))))));
};
//# sourceMappingURL=role-graph-page.js.map