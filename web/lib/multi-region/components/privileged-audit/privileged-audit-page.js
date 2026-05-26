import { __awaiter } from "tslib";
/**
 * Privileged Users & Shadow Admin Auditor — defensive port of the
 * concepts from CyberArk's SkyArk into the tenant-admin WebUI.
 *
 * Goal: surface every principal in the operator's active tenant that
 * holds a directory role, including the assignments that the Azure-
 * portal "Roles & administrators" blade hides — group-mediated
 * memberships, service-principal-held roles, and cross-tenant guest
 * privileges. The page is read-only by design (defensive auditing,
 * not privilege management).
 *
 * Sections (matches the spec):
 *   A. Top stat row — totals per tier, shadow-admin / SP / guest counts.
 *   B. Privileged identity list — every holder, with tier badge, role
 *      list, assignment-path chips, deep-link to portal, expandable
 *      per-role detail.
 *   C. Shadow admin paths — every non-direct escalation route as a
 *      "Alice → via group GA-Owners → Global Admin (Tier 0)" row.
 *      Privileged Role Administrators destructive Alert at the top.
 *   D. Groups holding privileged roles — direct vs transitive member
 *      counts, "high blast radius" callout for Tier 0 groups > 10
 *      transitive members.
 *   E. Service principals with privileged roles — flag suspicious
 *      newcomers (recent createdDateTime + Tier 0 role).
 *
 * Hard constraints honoured:
 *   - New files only (under components/privileged-audit/).
 *   - No edits to services / auth / store / page-router / sidebar-nav.
 *   - No new npm deps.
 *   - All probes read-only — no POST/PATCH/DELETE.
 *   - Pagination handled via `@odata.nextLink`.
 *   - Graph permission failures degrade per-probe with inline warnings
 *     rather than blanking the whole page.
 */
import * as React from "react";
import { AlertTriangle, Bomb, ChevronDown, ChevronRight, Clock, EyeOff, ExternalLink, Filter as FilterIcon, GitBranch, KeyRound, RefreshCw, Search, ShieldAlert, ShieldCheck, Sparkles, Ticket, Users, } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, downloadJson, formatRelativeTime } from "@/lib/utils";
import { decodeJwtClaimsUnsafe, getActiveTenant, getGraphTokenForAccount, } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { auditLog } from "../../services/audit-log";
import { getPrincipalsByIds, } from "../../services/graph-service";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useUrlState } from "../../hooks/use-url-state";
import { useMultiRegionState } from "../../store/store-context";
import { CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { DataTable, } from "../shared/enhanced-table";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import { ASSIGNMENT_PATH_META, EMPTY_WATCHLIST, HIGH_PRIV_GRAPH_APP_ROLES, MICROSOFT_GRAPH_APP_ID, MIXED_CHAIN_WINDOW_MS, PRIVILEGED_AUDIT_ACTION_PREFIX, RECENT_CREDENTIAL_WINDOW_MS, RECENT_TAP_WINDOW_MS, ROLE_DIRECTORY_SYNC_ACCOUNTS, SEVERITY_META, SIGNAL_RISK_WEIGHTS, STALE_THRESHOLD_MS, TIER0_WATCHLIST_STORAGE_KEY_PREFIX, TIER_META, buildMixedChainFindings, classifyRole, compareByRiskScoreWithSignals, compareByTierThenName, computeWatchlistDrift, gradeFederatedCredential, gradeHighPrivGraphPermission, gradePimEligibility, gradePimGroupEligibility, gradeSyncAccount, gradeTapIssuance, hasShadowAdminPath, highestTier, isExternalUpn, isHighBlastRadiusGroup, isPrivilegedRoleAdmin, isPublicFederationIssuer, isStalePrincipal, looksLikeSyncAccount, portalDeepLink, riskScore, roleDeepLink, } from "./privileged-audit-helpers";
import { useShortcut } from "../../hooks/use-shortcut";
// ===========================================================================
// Constants
// ===========================================================================
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
/**
 * Blast-radius threshold: Tier 0 groups with more transitive members
 * than this trigger the "high blast radius" highlight in section D.
 * Matches the spec.
 */
const HIGH_BLAST_RADIUS_THRESHOLD = 10;
/**
 * "Recently created" window for service principals. SkyArk highlights
 * SPs that hold high-privilege roles AND were created in the last
 * 30 days as a "fresh implant" indicator.
 */
const RECENT_SP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const EMPTY_DATASET = {
    principals: [],
    shadowPaths: [],
    groups: [],
    servicePrincipals: [],
    warnings: [],
    activatedRoleCount: 0,
    highPrivGraphPermissions: [],
    federatedCredentials: [],
    pimEligibilities: [],
    tapIssuances: [],
    syncAccountFindings: [],
    pimGroupEligibilities: [],
    mixedChainFindings: [],
};
// ===========================================================================
// Graph wrappers (page-local — keeps the spec's "no services edits" rule).
// ===========================================================================
/**
 * Authorization + content-negotiation headers for every direct Graph
 * call this page makes. We deliberately do NOT route through
 * `services/graph-service` for endpoints it doesn't already cover, so
 * the spec's "services unchanged" rule holds.
 */
function graphHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
    };
}
/**
 * Drain every page of a Graph collection. `@odata.nextLink` is followed
 * until exhausted, so the auditor never silently truncates after the
 * first 100 / 999 rows.
 */
function fetchAllPages(startUrl, token, signal) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const out = [];
        let url = startUrl;
        while (url) {
            if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                throw new DOMException("aborted", "AbortError");
            const response = yield fetch(url, Object.assign({ headers: graphHeaders(token) }, (signal ? { signal } : {})));
            if (!response.ok) {
                const body = yield response.json().catch(() => ({}));
                const inner = body === null || body === void 0 ? void 0 : body.error;
                const msg = (_a = inner === null || inner === void 0 ? void 0 : inner.message) !== null && _a !== void 0 ? _a : `Graph request failed (${response.status})`;
                const err = new Error(msg);
                err.status = response.status;
                throw err;
            }
            const data = (yield response.json());
            if (Array.isArray(data.value))
                out.push(...data.value);
            url = data["@odata.nextLink"];
        }
        return out;
    });
}
/**
 * Map a Graph member object's `@odata.type` discriminator to one of
 * our internal `PrincipalType` enum values.
 */
function odataTypeToPrincipalType(raw) {
    const lower = String(raw !== null && raw !== void 0 ? raw : "").toLowerCase();
    if (lower.endsWith(".user"))
        return "User";
    if (lower.endsWith(".group"))
        return "Group";
    if (lower.endsWith(".serviceprincipal"))
        return "ServicePrincipal";
    return "Unknown";
}
/**
 * Run the full privileged-audit probe against a tenant. The function
 * is fail-soft: individual sub-probes that fail (Graph 403 because
 * `Directory.Read.All` isn't granted, etc.) produce a warning rather
 * than aborting the entire run.
 */
function probeTenant(tenantId, token, signal) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11;
    return __awaiter(this, void 0, void 0, function* () {
        const warnings = [];
        // ---- 1. Enumerate activated directory roles ----------------------------
        let roles = [];
        try {
            const raw = yield fetchAllPages(`${GRAPH_BASE}/directoryRoles?$select=id,displayName,roleTemplateId`, token, signal);
            roles = raw.map((r) => {
                var _a, _b, _c;
                const templateId = String((_a = r.roleTemplateId) !== null && _a !== void 0 ? _a : "");
                const displayName = String((_b = r.displayName) !== null && _b !== void 0 ? _b : "");
                return {
                    id: String((_c = r.id) !== null && _c !== void 0 ? _c : ""),
                    roleTemplateId: templateId,
                    displayName,
                    tier: classifyRole(templateId, displayName),
                };
            });
        }
        catch (err) {
            warnings.push({
                id: "directoryRoles",
                message: `Could not enumerate directory roles. Graph said: ${err.message}. ` +
                    "Make sure the signed-in account has Directory.Read.All (delegated).",
            });
            return Object.assign(Object.assign({}, EMPTY_DATASET), { warnings });
        }
        // ---- 2. Direct membership snapshot per role ----------------------------
        // We fetch each role's direct member list in parallel. A per-role
        // failure (e.g. a transient 503) becomes a warning but does NOT abort
        // the overall probe.
        const directMembersByRole = new Map();
        yield Promise.allSettled(roles.map((role) => __awaiter(this, void 0, void 0, function* () {
            try {
                const raw = yield fetchAllPages(`${GRAPH_BASE}/directoryRoles/${encodeURIComponent(role.id)}/members?$select=id`, token, signal);
                directMembersByRole.set(role.id, raw.map((m) => {
                    var _a;
                    return ({
                        id: String((_a = m.id) !== null && _a !== void 0 ? _a : ""),
                        type: odataTypeToPrincipalType(m["@odata.type"]),
                    });
                }));
            }
            catch (err) {
                warnings.push({
                    id: `members:${role.id}`,
                    message: `Members of "${role.displayName}" not loaded (${err.message}).`,
                });
                directMembersByRole.set(role.id, []);
            }
        })));
        // ---- 3. Resolve every direct member to (type, displayName, signIn) -----
        // Use the existing batched directoryObjects/getByIds helper so we don't
        // re-implement the chunking; it tolerates missing/deleted ids.
        const allDirectMemberIds = new Set();
        for (const list of directMembersByRole.values()) {
            for (const m of list) {
                if (m.id)
                    allDirectMemberIds.add(m.id);
            }
        }
        let resolvedDirect = [];
        try {
            resolvedDirect = yield getPrincipalsByIds(tenantId, Array.from(allDirectMemberIds), token);
        }
        catch (err) {
            warnings.push({
                id: "resolve-direct",
                message: `Could not resolve some role members to names (${err.message}).`,
            });
        }
        const resolvedById = new Map();
        for (const p of resolvedDirect)
            resolvedById.set(p.id, p);
        // ---- 4. Expand every directly-assigned Group into transitive members ---
        // We collect a `Group → roles[]` index and a `Group → members[]` index in
        // parallel, then fan-out shadow-admin paths from there.
        const directGroupIds = new Set();
        for (const list of directMembersByRole.values()) {
            for (const m of list) {
                if (m.type === "Group" && m.id)
                    directGroupIds.add(m.id);
            }
        }
        // `Group → role list` index for the section-D table.
        const rolesByGroup = new Map();
        for (const role of roles) {
            const members = (_a = directMembersByRole.get(role.id)) !== null && _a !== void 0 ? _a : [];
            for (const m of members) {
                if (m.type !== "Group")
                    continue;
                const list = (_b = rolesByGroup.get(m.id)) !== null && _b !== void 0 ? _b : [];
                list.push({ role });
                rolesByGroup.set(m.id, list);
            }
        }
        // `Group → transitive member ids` index for the shadow-admin fan-out.
        const transitiveMembersByGroup = new Map();
        yield Promise.allSettled(Array.from(directGroupIds).map((gid) => __awaiter(this, void 0, void 0, function* () {
            try {
                const raw = yield fetchAllPages(`${GRAPH_BASE}/groups/${encodeURIComponent(gid)}/transitiveMembers?$select=id,displayName,userPrincipalName,mail,accountEnabled`, token, signal);
                const list = raw.map((m) => {
                    var _a, _b, _c, _d, _e;
                    return ({
                        id: String((_a = m.id) !== null && _a !== void 0 ? _a : ""),
                        type: odataTypeToPrincipalType(m["@odata.type"]),
                        displayName: (_c = (_b = m.displayName) !== null && _b !== void 0 ? _b : m.userPrincipalName) !== null && _c !== void 0 ? _c : String((_d = m.id) !== null && _d !== void 0 ? _d : ""),
                        signInName: (_e = m.userPrincipalName) !== null && _e !== void 0 ? _e : m.mail,
                    });
                });
                transitiveMembersByGroup.set(gid, list);
            }
            catch (err) {
                warnings.push({
                    id: `transitive:${gid}`,
                    message: `Group ${gid.slice(0, 8)}… transitive members not enumerated (${err.message}).`,
                });
                transitiveMembersByGroup.set(gid, []);
            }
        })));
        const byId = new Map();
        const upsertPrincipal = (base, enabled) => {
            var _a;
            const existing = byId.get(base.id);
            if (existing)
                return existing;
            const next = {
                id: base.id,
                type: (_a = base.type) !== null && _a !== void 0 ? _a : "Unknown",
                displayName: base.displayName,
                signInName: base.signInName,
                enabled,
                isExternal: isExternalUpn(base.signInName),
                assignments: [],
            };
            byId.set(base.id, next);
            return next;
        };
        // Direct user + SP assignments.
        for (const role of roles) {
            const directMembers = (_c = directMembersByRole.get(role.id)) !== null && _c !== void 0 ? _c : [];
            for (const m of directMembers) {
                if (m.type !== "User" && m.type !== "ServicePrincipal")
                    continue;
                const resolved = (_d = resolvedById.get(m.id)) !== null && _d !== void 0 ? _d : {
                    id: m.id,
                    type: m.type,
                    displayName: m.id,
                    signInName: undefined,
                };
                const principal = upsertPrincipal(resolved);
                const isGuest = principal.isExternal && m.type === "User";
                principal.assignments.push({
                    roleId: role.id,
                    roleTemplateId: role.roleTemplateId,
                    roleDisplayName: role.displayName,
                    tier: role.tier,
                    path: m.type === "ServicePrincipal" ? "sp" : isGuest ? "guest" : "direct",
                });
            }
        }
        // Group-mediated assignments: every transitive USER member of a group
        // that holds a role inherits that role through the group.
        for (const [groupId, transitive] of transitiveMembersByGroup.entries()) {
            const groupRoles = (_e = rolesByGroup.get(groupId)) !== null && _e !== void 0 ? _e : [];
            if (groupRoles.length === 0)
                continue;
            const groupResolved = resolvedById.get(groupId);
            const groupName = (_f = groupResolved === null || groupResolved === void 0 ? void 0 : groupResolved.displayName) !== null && _f !== void 0 ? _f : groupId;
            for (const member of transitive) {
                // Only users are surfaced as shadow admins through groups; nested
                // groups are still walked (transitiveMembers handles that) but the
                // group-node itself is shown in section D, not section B.
                if (member.type !== "User" && member.type !== "ServicePrincipal") {
                    continue;
                }
                const principal = upsertPrincipal(member);
                for (const { role } of groupRoles) {
                    principal.assignments.push({
                        roleId: role.id,
                        roleTemplateId: role.roleTemplateId,
                        roleDisplayName: role.displayName,
                        tier: role.tier,
                        path: "group",
                        viaGroupId: groupId,
                        viaGroupName: groupName,
                    });
                }
            }
        }
        // ---- 6. Dedup, derive computed fields ----------------------------------
        const principalsAll = [];
        for (const draft of byId.values()) {
            // Dedup assignments on (roleId, path, viaGroupId) so a user that's
            // both a direct member AND transitive via 3 groups gets at most one
            // row per (role, source) pair.
            const seen = new Set();
            const deduped = [];
            for (const a of draft.assignments) {
                const key = `${a.roleId}::${a.path}::${(_g = a.viaGroupId) !== null && _g !== void 0 ? _g : ""}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                deduped.push(a);
            }
            const topTier = highestTier(deduped);
            const principal = Object.assign(Object.assign({}, draft), { assignments: deduped, topTier, isShadowAdmin: hasShadowAdminPath(deduped, draft.isExternal), isServicePrincipal: draft.type === "ServicePrincipal" });
            principalsAll.push(principal);
        }
        principalsAll.sort(compareByTierThenName);
        // ---- 7. Shadow-admin paths (section C) ---------------------------------
        const shadowPaths = [];
        for (const p of principalsAll) {
            for (const a of p.assignments) {
                if (a.path === "direct" && !p.isExternal)
                    continue;
                const id = `${p.id}::${a.roleId}::${a.path}::${(_h = a.viaGroupId) !== null && _h !== void 0 ? _h : ""}`;
                let via;
                if (a.path === "group") {
                    via = `via group "${(_k = (_j = a.viaGroupName) !== null && _j !== void 0 ? _j : a.viaGroupId) !== null && _k !== void 0 ? _k : "unknown"}"`;
                }
                else if (a.path === "sp") {
                    via = "service-principal assignment";
                }
                else if (a.path === "guest") {
                    via = "guest / cross-tenant assignment";
                }
                else {
                    // Direct + external: principal is a guest user assigned directly.
                    via = "direct assignment to guest";
                }
                shadowPaths.push({
                    id,
                    principalId: p.id,
                    principalDisplayName: p.displayName,
                    principalType: p.type,
                    principalSignInName: p.signInName,
                    path: a.path,
                    via,
                    viaGroupId: a.viaGroupId,
                    viaGroupName: a.viaGroupName,
                    roleId: a.roleId,
                    roleTemplateId: a.roleTemplateId,
                    roleDisplayName: a.roleDisplayName,
                    tier: a.tier,
                });
            }
        }
        // Sort: lowest tier order first (Tier 0 to the top), then by name.
        shadowPaths.sort((a, b) => {
            const ta = TIER_META[a.tier].order;
            const tb = TIER_META[b.tier].order;
            if (ta !== tb)
                return ta - tb;
            return a.principalDisplayName.localeCompare(b.principalDisplayName, undefined, { sensitivity: "base" });
        });
        // ---- 8. Groups holding privileged roles (section D) --------------------
        //
        // Per-group `isAssignableToRole` is fetched in parallel so the Signal G
        // (PIM-for-Groups eligibility) detector can join against the group facts
        // and flag eligibilities on role-assignable groups. Citation:
        //   `_bypass_staged_pim.md` §6 "Group-Based PIM" — eligibility on an
        //    isAssignableToRole=true group is the canonical 3-layer indirection.
        const isAssignableByGroup = new Map();
        yield Promise.allSettled(Array.from(rolesByGroup.keys()).map((gid) => __awaiter(this, void 0, void 0, function* () {
            try {
                const r = yield fetch(`${GRAPH_BASE}/groups/${encodeURIComponent(gid)}?$select=id,isAssignableToRole`, Object.assign({ headers: graphHeaders(token) }, (signal ? { signal } : {})));
                if (!r.ok)
                    return;
                const d = (yield r.json());
                if (typeof d.isAssignableToRole === "boolean") {
                    isAssignableByGroup.set(gid, d.isAssignableToRole);
                }
            }
            catch (_15) {
                /* swallow — isAssignableToRole is decoration; PIM-G detector
                   will still emit findings but won't flag the group-shape lift. */
            }
        })));
        const groupsOut = [];
        for (const [groupId, list] of rolesByGroup.entries()) {
            const resolved = resolvedById.get(groupId);
            const transitive = (_l = transitiveMembersByGroup.get(groupId)) !== null && _l !== void 0 ? _l : [];
            const userMembers = transitive.filter((m) => m.type === "User");
            const summarisedRoles = list.map(({ role }) => ({
                roleId: role.id,
                roleTemplateId: role.roleTemplateId,
                roleDisplayName: role.displayName,
                tier: role.tier,
            }));
            const topTier = summarisedRoles.length
                ? summarisedRoles.reduce((acc, r) => {
                    return TIER_META[r.tier].order < TIER_META[acc].order ? r.tier : acc;
                }, "other")
                : "other";
            groupsOut.push({
                id: groupId,
                displayName: (_m = resolved === null || resolved === void 0 ? void 0 : resolved.displayName) !== null && _m !== void 0 ? _m : groupId,
                roles: summarisedRoles,
                transitiveUserCount: userMembers.length,
                transitiveTotalCount: transitive.length,
                topTier,
                transitiveMemberIds: transitive.map((m) => m.id),
            });
        }
        groupsOut.sort((a, b) => {
            const ta = TIER_META[a.topTier].order;
            const tb = TIER_META[b.topTier].order;
            if (ta !== tb)
                return ta - tb;
            return b.transitiveUserCount - a.transitiveUserCount;
        });
        // ---- 9. Service principals holding roles (section E) -------------------
        // We need createdDateTime for the "recent + privileged" callout. Fetch
        // it per-SP on demand because the directoryObjects/getByIds call
        // doesn't return it.
        const spIds = principalsAll
            .filter((p) => p.type === "ServicePrincipal")
            .map((p) => p.id);
        const createdById = new Map();
        yield Promise.allSettled(spIds.map((id) => __awaiter(this, void 0, void 0, function* () {
            try {
                const url = `${GRAPH_BASE}/servicePrincipals/${encodeURIComponent(id)}?$select=createdDateTime,appId,accountEnabled`;
                const response = yield fetch(url, Object.assign({ headers: graphHeaders(token) }, (signal ? { signal } : {})));
                if (!response.ok)
                    return;
                const data = (yield response.json());
                if (data.createdDateTime)
                    createdById.set(id, data.createdDateTime);
            }
            catch (_16) {
                /* swallow — SP metadata is optional context */
            }
        })));
        const servicePrincipals = principalsAll
            .filter((p) => p.type === "ServicePrincipal")
            .map((p) => (Object.assign(Object.assign({}, p), { createdDateTime: createdById.get(p.id) })));
        // =========================================================================
        // Corpus-derived detection signals (read-only enumeration).
        //
        // The four signals A/B/C/D are all reads against the operator's OWN tenant.
        // No POST / PATCH / DELETE is issued — the page never invokes addKey /
        // addPassword / federated-cred / role-grant / TAP-issue / PIM-create.
        //
        // Master reference: `_AZURE_BYPASS_PLAYBOOK.md` §"Critical Defender
        //                   Audit Surface" items 3, 4, 5, 6, 7.
        //
        // COORDINATOR: privileged-audit invokes several Graph endpoints not yet
        // exposed by services/graph-service. If/when graph-service grows wrappers
        // for these we should route through them (matches the existing pattern
        // for `directoryRoles/.../members` which we also fetch direct here):
        //   - GET /servicePrincipals/{graphSpObjectId}/appRoleAssignedTo
        //   - GET /servicePrincipals/{id} (passwordCredentials,keyCredentials,...)
        //   - GET /applications?$filter=appId eq '{appId}'
        //   - GET /applications/{id}/federatedIdentityCredentials
        //   - GET /roleManagement/directory/roleEligibilityScheduleRequests
        //   - GET /users/{id}/authentication/temporaryAccessPassMethods
        // =========================================================================
        // ---- Signal A — High-privilege Graph permissions on SPs ----------------
        //
        // Citation:
        //   `_bypass_role_grant.md` §3.1 (Application.ReadWrite.All → addKey on
        //     Microsoft Graph SP → app-only with RoleManagement.ReadWrite.Directory
        //     → self-assign Global Administrator)
        //   `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #23
        //
        // Detection wire-up:
        //   1. Resolve Microsoft Graph SP object id.
        //   2. GET /servicePrincipals/{graphId}/appRoleAssignedTo — every SP
        //      Microsoft Graph has granted an app-role TO.
        //   3. Filter on the well-known appRoleIds in HIGH_PRIV_GRAPH_APP_ROLES.
        //   4. For each principal: fetch passwordCredentials + keyCredentials to
        //      score the "recent credential" companion signal (audit item #5 in
        //      the master playbook: addKey / addPassword detection).
        let highPrivGraphPermissions = [];
        try {
            // Resolve the Microsoft Graph SP object id by appId.
            const graphLookup = yield fetchAllPages(`${GRAPH_BASE}/servicePrincipals?` +
                `$filter=appId eq '${MICROSOFT_GRAPH_APP_ID}'&$select=id`, token, signal);
            const graphSpObjectId = graphLookup.length
                ? String((_p = (_o = graphLookup[0]) === null || _o === void 0 ? void 0 : _o.id) !== null && _p !== void 0 ? _p : "")
                : "";
            if (!graphSpObjectId) {
                warnings.push({
                    id: "signal-a:no-graph-sp",
                    message: "Microsoft Graph service principal not resolvable — Signal A " +
                        "(high-privilege Graph permissions) is empty until that completes.",
                });
            }
            else {
                const assignedTo = yield fetchAllPages(`${GRAPH_BASE}/servicePrincipals/${encodeURIComponent(graphSpObjectId)}` +
                    `/appRoleAssignedTo?$select=id,principalId,principalDisplayName,principalType,appRoleId,createdDateTime` +
                    `&$top=999`, token, signal);
                // Group by principalId; we only care about SP principals here.
                const perPrincipal = new Map();
                for (const row of assignedTo) {
                    const appRoleId = String((_q = row.appRoleId) !== null && _q !== void 0 ? _q : "");
                    const permName = HIGH_PRIV_GRAPH_APP_ROLES.get(appRoleId);
                    if (!permName)
                        continue;
                    const principalType = String((_r = row.principalType) !== null && _r !== void 0 ? _r : "");
                    if (principalType !== "ServicePrincipal")
                        continue;
                    const principalId = String((_s = row.principalId) !== null && _s !== void 0 ? _s : "");
                    if (!principalId)
                        continue;
                    const list = (_t = perPrincipal.get(principalId)) !== null && _t !== void 0 ? _t : [];
                    list.push({
                        assignmentId: String((_u = row.id) !== null && _u !== void 0 ? _u : ""),
                        appRoleId,
                        permissionName: permName,
                        createdDateTime: (_v = row.createdDateTime) !== null && _v !== void 0 ? _v : undefined,
                        principalDisplayName: String((_w = row.principalDisplayName) !== null && _w !== void 0 ? _w : ""),
                    });
                    perPrincipal.set(principalId, list);
                }
                // Hydrate each SP with name/appId/credential counts.
                const now = Date.now();
                const findings = [];
                yield Promise.allSettled(Array.from(perPrincipal.entries()).map(([spId, perms]) => __awaiter(this, void 0, void 0, function* () {
                    var _17, _18, _19, _20;
                    let spName = (_18 = (_17 = perms[0]) === null || _17 === void 0 ? void 0 : _17.principalDisplayName) !== null && _18 !== void 0 ? _18 : spId;
                    let appId;
                    let signInAudience;
                    let createdDateTime;
                    let pwdCount = 0;
                    let keyCount = 0;
                    let mostRecent = null;
                    try {
                        const url = `${GRAPH_BASE}/servicePrincipals/${encodeURIComponent(spId)}` +
                            `?$select=id,displayName,appId,signInAudience,createdDateTime,passwordCredentials,keyCredentials`;
                        const r = yield fetch(url, Object.assign({ headers: graphHeaders(token) }, (signal ? { signal } : {})));
                        if (r.ok) {
                            const d = (yield r.json());
                            if (d.displayName)
                                spName = d.displayName;
                            appId = d.appId;
                            signInAudience = d.signInAudience;
                            createdDateTime = d.createdDateTime;
                            const pwds = (_19 = d.passwordCredentials) !== null && _19 !== void 0 ? _19 : [];
                            const keys = (_20 = d.keyCredentials) !== null && _20 !== void 0 ? _20 : [];
                            pwdCount = pwds.length;
                            keyCount = keys.length;
                            for (const c of [...pwds, ...keys]) {
                                if (!c.startDateTime)
                                    continue;
                                const ts = new Date(c.startDateTime).getTime();
                                if (!Number.isFinite(ts))
                                    continue;
                                if (mostRecent === null || ts > mostRecent)
                                    mostRecent = ts;
                            }
                        }
                    }
                    catch (_21) {
                        /* swallow — SP detail is optional context for the finding */
                    }
                    const hasRecent = mostRecent !== null && now - mostRecent <= RECENT_CREDENTIAL_WINDOW_MS;
                    findings.push({
                        id: `sigA:${spId}`,
                        servicePrincipalId: spId,
                        servicePrincipalDisplayName: spName,
                        appId,
                        signInAudience,
                        servicePrincipalCreatedDateTime: createdDateTime,
                        permissions: perms.map((p) => ({
                            assignmentId: p.assignmentId,
                            appRoleId: p.appRoleId,
                            permissionName: p.permissionName,
                            createdDateTime: p.createdDateTime,
                        })),
                        passwordCredentialCount: pwdCount,
                        keyCredentialCount: keyCount,
                        hasRecentCredential: hasRecent,
                        mostRecentCredentialAt: mostRecent !== null
                            ? new Date(mostRecent).toISOString()
                            : undefined,
                    });
                })));
                // Sort: criticals first (recent cred + canonical perm), then perm count.
                findings.sort((a, b) => {
                    const sa = gradeHighPrivGraphPermission(a) === "critical"
                        ? 0
                        : gradeHighPrivGraphPermission(a) === "high"
                            ? 1
                            : 2;
                    const sb = gradeHighPrivGraphPermission(b) === "critical"
                        ? 0
                        : gradeHighPrivGraphPermission(b) === "high"
                            ? 1
                            : 2;
                    if (sa !== sb)
                        return sa - sb;
                    return b.permissions.length - a.permissions.length;
                });
                highPrivGraphPermissions = findings;
            }
        }
        catch (err) {
            warnings.push({
                id: "signal-a:failed",
                message: `Signal A (high-privilege Graph permissions) probe failed: ${err.message}. Needs Application.Read.All / Directory.Read.All on Microsoft Graph.`,
            });
        }
        // ---- Signal B — Federated identity credentials on privileged SPs --------
        //
        // Citation:
        //   `_bypass_role_grant.md` §6 (WIF federated credential = role-grant bypass)
        //   `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #17 + audit item #6
        //
        // Detection wire-up:
        //   - For every SP that surfaced in Signal A (highest-leverage SPs in the
        //     tenant), resolve its parent application object, then enumerate
        //     /applications/{appObjectId}/federatedIdentityCredentials.
        //   - Flag any federated credential whose issuer host matches the
        //     curated PUBLIC_FEDERATION_ISSUER_HOSTS list.
        let federatedCredentials = [];
        try {
            const findings = [];
            const targets = highPrivGraphPermissions.map((f) => ({
                spId: f.servicePrincipalId,
                spName: f.servicePrincipalDisplayName,
                appId: f.appId,
            }));
            yield Promise.allSettled(targets.map((t) => __awaiter(this, void 0, void 0, function* () {
                var _22, _23, _24, _25, _26, _27;
                if (!t.appId)
                    return;
                // Resolve parent application object id (federated creds live on
                // /applications, not /servicePrincipals).
                let appObjectId;
                try {
                    const u = `${GRAPH_BASE}/applications?` +
                        `$filter=appId eq '${encodeURIComponent(t.appId)}'&$select=id`;
                    const r = yield fetch(u, Object.assign({ headers: graphHeaders(token) }, (signal ? { signal } : {})));
                    if (r.ok) {
                        const d = (yield r.json());
                        appObjectId = (_23 = (_22 = d.value) === null || _22 === void 0 ? void 0 : _22[0]) === null || _23 === void 0 ? void 0 : _23.id;
                    }
                }
                catch (_28) {
                    /* swallow — app may live in a partner tenant (no local app obj) */
                }
                if (!appObjectId)
                    return;
                try {
                    const fic = yield fetchAllPages(`${GRAPH_BASE}/applications/${encodeURIComponent(appObjectId)}` +
                        `/federatedIdentityCredentials`, token, signal);
                    for (const row of fic) {
                        const issuer = String((_24 = row.issuer) !== null && _24 !== void 0 ? _24 : "");
                        const subject = String((_25 = row.subject) !== null && _25 !== void 0 ? _25 : "");
                        const audiences = Array.isArray(row.audiences)
                            ? row.audiences
                            : [];
                        findings.push({
                            id: `sigB:${t.spId}:${(_26 = row.id) !== null && _26 !== void 0 ? _26 : subject}`,
                            servicePrincipalId: t.spId,
                            servicePrincipalDisplayName: t.spName,
                            applicationObjectId: appObjectId,
                            name: String((_27 = row.name) !== null && _27 !== void 0 ? _27 : "(unnamed)"),
                            issuer,
                            subject,
                            audiences,
                            isPublicIssuer: isPublicFederationIssuer(issuer),
                        });
                    }
                }
                catch (_29) {
                    /* swallow — Application.Read.All required; degrade quietly */
                }
            })));
            if (findings.length === 0 && targets.length > 0) {
                // Couldn't enumerate any — caller probably lacks Application.Read.All
                // on /applications/{id}/federatedIdentityCredentials. Surface a hint
                // so the empty card doesn't read as a clean bill of health.
                warnings.push({
                    id: "signal-b:permission",
                    message: "Signal B (federated identity credentials) did not enumerate any " +
                        "credentials. If your high-privilege SPs use WIF, the signed-in " +
                        "account likely needs Application.Read.All to read " +
                        "/applications/{id}/federatedIdentityCredentials.",
                });
            }
            findings.sort((a, b) => {
                // Public issuer first, then by name.
                if (a.isPublicIssuer !== b.isPublicIssuer) {
                    return a.isPublicIssuer ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });
            federatedCredentials = findings;
        }
        catch (err) {
            warnings.push({
                id: "signal-b:failed",
                message: `Signal B (federated identity credentials) probe failed: ${err.message}.`,
            });
        }
        // ---- Signal C — PIM eligibility with `noExpiration` ---------------------
        //
        // Citation:
        //   `_bypass_staged_pim.md` §5.1 "The 'time bomb'" — PRA briefly compromised,
        //     plant `noExpiration` eligibility for attacker user, then let the PRA
        //     compromise be remediated. Eligibility persists.
        //   `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #27 + audit item #7
        //
        // Detection wire-up:
        //   GET /roleManagement/directory/roleEligibilityScheduleRequests
        //   (we deliberately read the *requests* endpoint not the *schedules*
        //   endpoint, because the requests endpoint preserves createdDateTime
        //   and is the closest read-only equivalent of the POST that creates
        //   the eligibility — audit-event #7 in the master playbook).
        //   If the *requests* endpoint 403s we degrade to *schedules*.
        let pimEligibilities = [];
        const knownRoleIdByTemplate = new Map();
        for (const role of roles) {
            knownRoleIdByTemplate.set(role.roleTemplateId, role);
        }
        const buildPimFinding = (row) => {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            const principalId = String((_a = row.principalId) !== null && _a !== void 0 ? _a : "");
            const roleTemplateId = String((_b = row.roleDefinitionId) !== null && _b !== void 0 ? _b : "");
            if (!principalId || !roleTemplateId)
                return null;
            const schedule = ((_c = row.scheduleInfo) !== null && _c !== void 0 ? _c : {});
            const expiration = ((_d = schedule.expiration) !== null && _d !== void 0 ? _d : {});
            const typeRaw = String((_e = expiration.type) !== null && _e !== void 0 ? _e : "").toLowerCase();
            const expirationKind = typeRaw === "noexpiration"
                ? "noExpiration"
                : typeRaw === "afterdatetime"
                    ? "afterDateTime"
                    : typeRaw === "afterduration"
                        ? "afterDuration"
                        : "unknown";
            const role = knownRoleIdByTemplate.get(roleTemplateId);
            const tier = (_f = role === null || role === void 0 ? void 0 : role.tier) !== null && _f !== void 0 ? _f : classifyRole(roleTemplateId, undefined);
            const principalResolved = resolvedById.get(principalId);
            const principalType = principalResolved
                ? ((_g = principalResolved.type) !== null && _g !== void 0 ? _g : "Unknown")
                : "Unknown";
            return {
                id: `sigC:${String((_h = row.id) !== null && _h !== void 0 ? _h : `${principalId}::${roleTemplateId}`)}`,
                principalId,
                principalDisplayName: principalResolved === null || principalResolved === void 0 ? void 0 : principalResolved.displayName,
                principalSignInName: principalResolved === null || principalResolved === void 0 ? void 0 : principalResolved.signInName,
                principalType,
                roleTemplateId,
                roleDisplayName: role === null || role === void 0 ? void 0 : role.displayName,
                tier,
                expirationKind,
                endDateTime: expiration.endDateTime,
                duration: expiration.duration,
                createdDateTime: row.createdDateTime,
                isCriticalTimeBomb: expirationKind === "noExpiration" && tier === "tier0",
            };
        };
        try {
            const eligibilityIdsToResolve = new Set();
            let raw = [];
            try {
                raw = yield fetchAllPages(`${GRAPH_BASE}/roleManagement/directory/roleEligibilityScheduleRequests` +
                    `?$select=id,principalId,roleDefinitionId,status,action,scheduleInfo,createdDateTime` +
                    `&$filter=status eq 'Provisioned'`, token, signal);
            }
            catch (_12) {
                // Fallback: the *schedules* endpoint (current state, not historical
                // request log). Some tenants don't grant RoleEligibilitySchedule.Read.All
                // on the requests endpoint specifically.
                raw = yield fetchAllPages(`${GRAPH_BASE}/roleManagement/directory/roleEligibilitySchedules` +
                    `?$select=id,principalId,roleDefinitionId,scheduleInfo,createdDateTime`, token, signal);
            }
            const findings = [];
            for (const row of raw) {
                const f = buildPimFinding(row);
                if (f)
                    findings.push(f);
                const pid = String((_x = row.principalId) !== null && _x !== void 0 ? _x : "");
                if (pid && !resolvedById.has(pid))
                    eligibilityIdsToResolve.add(pid);
            }
            // Best-effort resolve of any principal we haven't seen before.
            if (eligibilityIdsToResolve.size > 0) {
                try {
                    const extra = yield getPrincipalsByIds(tenantId, Array.from(eligibilityIdsToResolve), token);
                    for (const p of extra) {
                        resolvedById.set(p.id, p);
                        // Patch already-built findings with the resolved name.
                        for (const f of findings) {
                            if (f.principalId === p.id) {
                                f.principalDisplayName = p.displayName;
                                f.principalSignInName = p.signInName;
                                f.principalType =
                                    (_y = p.type) !== null && _y !== void 0 ? _y : f.principalType;
                            }
                        }
                    }
                }
                catch (_13) {
                    /* swallow — display name is decoration */
                }
            }
            // Sort: criticals first, then noExpiration, then by tier order.
            findings.sort((a, b) => {
                if (a.isCriticalTimeBomb !== b.isCriticalTimeBomb) {
                    return a.isCriticalTimeBomb ? -1 : 1;
                }
                const sa = a.expirationKind === "noExpiration" ? 0 : 1;
                const sb = b.expirationKind === "noExpiration" ? 0 : 1;
                if (sa !== sb)
                    return sa - sb;
                return TIER_META[a.tier].order - TIER_META[b.tier].order;
            });
            pimEligibilities = findings;
        }
        catch (err) {
            warnings.push({
                id: "signal-c:failed",
                message: `Signal C (PIM eligibility) probe failed: ${err.message}. Needs RoleEligibilitySchedule.Read.Directory or RoleManagement.Read.Directory.`,
            });
        }
        // ---- Signal D — Recent TAP issuances to privileged users ----------------
        //
        // Citation:
        //   `_AZURE_BYPASS_PLAYBOOK.md` "Critical Defender Audit Surface" #3
        //                              + Top-30 #13
        //
        // Detection wire-up: for every USER principal that already surfaced in
        // sections B/C, GET /users/{id}/authentication/temporaryAccessPassMethods.
        // The endpoint is read-only and returns whatever TAP method(s) the user
        // currently has on their account. Sees admin-issued TAPs (Auth Admin /
        // Priv Auth Admin) — the canonical MFA-equivalent persistence vector.
        let tapIssuances = [];
        try {
            const privilegedUsers = principalsAll.filter((p) => p.type === "User");
            const now = Date.now();
            const findings = [];
            yield Promise.allSettled(privilegedUsers.map((u) => __awaiter(this, void 0, void 0, function* () {
                var _30, _31, _32;
                try {
                    const r = yield fetch(`${GRAPH_BASE}/users/${encodeURIComponent(u.id)}` +
                        `/authentication/temporaryAccessPassMethods`, Object.assign({ headers: graphHeaders(token) }, (signal ? { signal } : {})));
                    if (!r.ok) {
                        // 404 means "no TAP" which is the expected default; only
                        // promote to a warning on 4xx-not-404 (permission missing).
                        if (r.status !== 404 && r.status !== 200) {
                            if (r.status === 401 || r.status === 403) {
                                warnings.push({
                                    id: `signal-d:perm:${u.id}`,
                                    message: `Signal D (TAP issuance) needs UserAuthenticationMethod.Read.All ` +
                                        `to read /users/${u.id.slice(0, 8)}…/authentication/temporaryAccessPassMethods.`,
                                });
                            }
                        }
                        return;
                    }
                    const data = (yield r.json());
                    for (const tap of (_30 = data.value) !== null && _30 !== void 0 ? _30 : []) {
                        const startMs = tap.startDateTime
                            ? new Date(tap.startDateTime).getTime()
                            : NaN;
                        const isRecent = Number.isFinite(startMs) &&
                            now - startMs <= RECENT_TAP_WINDOW_MS;
                        const isTopTier = u.topTier === "tier0" || u.topTier === "tier1";
                        findings.push({
                            id: `sigD:${u.id}:${(_31 = tap.id) !== null && _31 !== void 0 ? _31 : "tap"}`,
                            userId: u.id,
                            userDisplayName: u.displayName,
                            userPrincipalName: u.signInName,
                            userTier: u.topTier,
                            tapId: String((_32 = tap.id) !== null && _32 !== void 0 ? _32 : ""),
                            startDateTime: tap.startDateTime,
                            lifetimeInMinutes: tap.lifetimeInMinutes,
                            isUsable: tap.isUsable,
                            methodUsabilityReason: tap.methodUsabilityReason,
                            isRecentToTierZero: isRecent && isTopTier,
                        });
                    }
                }
                catch (_33) {
                    /* swallow — per-user TAP query failures are not page-level */
                }
            })));
            findings.sort((a, b) => {
                // Critical-on-T0 first, then any T0, then T1, then by time.
                const sa = gradeTapIssuance(a) === "critical" ? 0 : 1;
                const sb = gradeTapIssuance(b) === "critical" ? 0 : 1;
                if (sa !== sb)
                    return sa - sb;
                const ta = TIER_META[a.userTier].order;
                const tb = TIER_META[b.userTier].order;
                if (ta !== tb)
                    return ta - tb;
                const aT = a.startDateTime ? new Date(a.startDateTime).getTime() : 0;
                const bT = b.startDateTime ? new Date(b.startDateTime).getTime() : 0;
                return bT - aT;
            });
            tapIssuances = findings;
        }
        catch (err) {
            warnings.push({
                id: "signal-d:failed",
                message: `Signal D (TAP issuance) probe failed: ${err.message}. Needs UserAuthenticationMethod.Read.All.`,
            });
        }
        // ---- Signal E — AAD Connect / Cloud Sync sync-account drift ------------
        //
        // Citation:
        //   `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #19 (AAD Connect `Sync_*` decrypt →
        //      bidirectional forest control)
        //   `_bypass_mixed_chains.md` chain #1 (the full kill-chain)
        //   `_analysis_dirkjanm.md` adconnectdump
        //
        // Detection: any principal in the privileged-identity index whose
        // display-name / sign-in-name matches the canonical sync-account pattern
        // (`Sync_*`, `MSOL_*`, `ADToAADSyncServiceAccount`, "On-Premises Directory
        //  Synchronization Service Account") is a candidate. We then split its
        // roles into "canonical" (Directory Synchronization Accounts only) vs
        // "drift" (any other privileged role); any drift role triggers the
        // finding. Sync accounts holding T0 are critical — that is exactly the
        // "compromise-bidirectional-forest" shape the playbook calls out.
        const syncAccountFindings = [];
        for (const p of principalsAll) {
            if (!looksLikeSyncAccount(p.displayName, p.signInName))
                continue;
            // De-dup roles by template id — we only care about which roles, not
            // through how many paths the sync account ended up holding them.
            const uniqRoles = new Map();
            for (const a of p.assignments) {
                if (!uniqRoles.has(a.roleTemplateId)) {
                    uniqRoles.set(a.roleTemplateId, {
                        roleTemplateId: a.roleTemplateId,
                        roleDisplayName: a.roleDisplayName,
                        tier: a.tier,
                    });
                }
            }
            const allRoles = Array.from(uniqRoles.values()).map((r) => (Object.assign(Object.assign({}, r), { isCanonical: r.roleTemplateId === ROLE_DIRECTORY_SYNC_ACCOUNTS })));
            const driftRoles = allRoles.filter((r) => !r.isCanonical);
            const topDriftTier = driftRoles.length
                ? driftRoles.reduce((acc, r) => TIER_META[r.tier].order < TIER_META[acc].order ? r.tier : acc, "other")
                : "other";
            syncAccountFindings.push({
                id: `sigE:${p.id}`,
                principalId: p.id,
                principalDisplayName: p.displayName,
                principalSignInName: p.signInName,
                principalType: p.type,
                roles: allRoles,
                hasDriftRole: driftRoles.length > 0,
                topDriftTier,
            });
        }
        // Sort: drift findings first, T0 drift to the top, then by name.
        syncAccountFindings.sort((a, b) => {
            if (a.hasDriftRole !== b.hasDriftRole)
                return a.hasDriftRole ? -1 : 1;
            const oa = TIER_META[a.topDriftTier].order;
            const ob = TIER_META[b.topDriftTier].order;
            if (oa !== ob)
                return oa - ob;
            return a.principalDisplayName.localeCompare(b.principalDisplayName, undefined, { sensitivity: "base" });
        });
        // ---- Signal G — PIM-for-Groups eligibility on role-assignable groups ---
        //
        // Citation:
        //   `_bypass_staged_pim.md` §6 (Group-Based PIM):
        //     POST /v1.0/identityGovernance/privilegedAccess/group/eligibilityScheduleRequests
        //     with accessId=member; activator inherits any role the group holds.
        //   `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #28.
        //
        // We read the schedules endpoint (current eligible state). Failures
        // degrade gracefully because PIMforGroups isn't enabled in every tenant.
        let pimGroupEligibilities = [];
        try {
            const raw = yield fetchAllPages(`${GRAPH_BASE}/identityGovernance/privilegedAccess/group/eligibilitySchedules` +
                `?$select=id,principalId,groupId,accessId,scheduleInfo,createdDateTime`, token, signal);
            const idsToResolve = new Set();
            for (const row of raw) {
                const pid = String((_z = row.principalId) !== null && _z !== void 0 ? _z : "");
                if (pid && !resolvedById.has(pid))
                    idsToResolve.add(pid);
            }
            if (idsToResolve.size > 0) {
                try {
                    const extra = yield getPrincipalsByIds(tenantId, Array.from(idsToResolve), token);
                    for (const e of extra)
                        resolvedById.set(e.id, e);
                }
                catch (_14) {
                    /* swallow */
                }
            }
            const groupById = new Map(groupsOut.map((g) => [g.id, g]));
            const findings = [];
            for (const row of raw) {
                const principalId = String((_0 = row.principalId) !== null && _0 !== void 0 ? _0 : "");
                const groupId = String((_1 = row.groupId) !== null && _1 !== void 0 ? _1 : "");
                if (!principalId || !groupId)
                    continue;
                const group = groupById.get(groupId);
                // We surface every eligibility but score it as "info" when the group
                // doesn't hold a privileged role — that way operators can still see
                // the inventory but they aren't drowned in non-actionable rows.
                const groupRoles = (_2 = group === null || group === void 0 ? void 0 : group.roles.map((r) => ({
                    roleTemplateId: r.roleTemplateId,
                    roleDisplayName: r.roleDisplayName,
                    tier: r.tier,
                }))) !== null && _2 !== void 0 ? _2 : [];
                const topTier = (_3 = group === null || group === void 0 ? void 0 : group.topTier) !== null && _3 !== void 0 ? _3 : "other";
                const schedule = ((_4 = row.scheduleInfo) !== null && _4 !== void 0 ? _4 : {});
                const expiration = ((_5 = schedule.expiration) !== null && _5 !== void 0 ? _5 : {});
                const typeRaw = String((_6 = expiration.type) !== null && _6 !== void 0 ? _6 : "").toLowerCase();
                const expirationKind = typeRaw === "noexpiration"
                    ? "noExpiration"
                    : typeRaw === "afterdatetime"
                        ? "afterDateTime"
                        : typeRaw === "afterduration"
                            ? "afterDuration"
                            : "unknown";
                const principalResolved = resolvedById.get(principalId);
                const isAssignable = (_7 = isAssignableByGroup.get(groupId)) !== null && _7 !== void 0 ? _7 : false;
                findings.push({
                    id: `sigG:${(_8 = row.id) !== null && _8 !== void 0 ? _8 : `${principalId}::${groupId}`}`,
                    principalId,
                    principalDisplayName: principalResolved === null || principalResolved === void 0 ? void 0 : principalResolved.displayName,
                    principalSignInName: principalResolved === null || principalResolved === void 0 ? void 0 : principalResolved.signInName,
                    principalType: (_9 = principalResolved === null || principalResolved === void 0 ? void 0 : principalResolved.type) !== null && _9 !== void 0 ? _9 : "Unknown",
                    groupId,
                    groupDisplayName: (_10 = group === null || group === void 0 ? void 0 : group.displayName) !== null && _10 !== void 0 ? _10 : groupId,
                    isAssignableToRole: isAssignable,
                    groupRoles,
                    topTier,
                    expirationKind,
                    endDateTime: expiration.endDateTime,
                    duration: expiration.duration,
                    createdDateTime: row.createdDateTime,
                    isCriticalTimeBomb: expirationKind === "noExpiration" && topTier === "tier0",
                });
            }
            // Critical first, then T0, then by name.
            findings.sort((a, b) => {
                if (a.isCriticalTimeBomb !== b.isCriticalTimeBomb) {
                    return a.isCriticalTimeBomb ? -1 : 1;
                }
                const oa = TIER_META[a.topTier].order;
                const ob = TIER_META[b.topTier].order;
                if (oa !== ob)
                    return oa - ob;
                return a.groupDisplayName.localeCompare(b.groupDisplayName);
            });
            pimGroupEligibilities = findings;
        }
        catch (err) {
            // PIM-for-Groups isn't enabled / Graph permission missing — best-effort.
            // 404 is the common case ("identityGovernance not present"); we only
            // emit a warning when the failure looks permission-related.
            const msg = (_11 = err.message) !== null && _11 !== void 0 ? _11 : "";
            const status = err.status;
            if (status === 401 || status === 403) {
                warnings.push({
                    id: "signal-g:perm",
                    message: "Signal G (PIM-for-Groups eligibility) requires " +
                        "PrivilegedAccess.Read.AzureADGroup or RoleManagement.Read.All. " +
                        "PIM-for-Groups inventory is therefore empty.",
                });
            }
            else if (status !== 404 && msg) {
                warnings.push({
                    id: "signal-g:failed",
                    message: `Signal G probe failed: ${msg}.`,
                });
            }
        }
        // ---- Signal F — Mixed-chain correlation -------------------------------
        //
        // Citation: `_bypass_mixed_chains.md` — composing primitives is the
        // attacker's actual workflow; two indicators on the same principal inside
        // MIXED_CHAIN_WINDOW_MS is the kill-chain signature. Pure / deterministic
        // — produced by combining the already-collected A/B/C/D arrays.
        const principalIndex = new Map();
        for (const p of principalsAll)
            principalIndex.set(p.id, p);
        const mixedChainFindings = buildMixedChainFindings(highPrivGraphPermissions, federatedCredentials, pimEligibilities, tapIssuances, principalIndex, MIXED_CHAIN_WINDOW_MS);
        return {
            principals: principalsAll,
            shadowPaths,
            groups: groupsOut,
            servicePrincipals,
            warnings,
            activatedRoleCount: roles.length,
            highPrivGraphPermissions,
            federatedCredentials,
            pimEligibilities,
            tapIssuances,
            syncAccountFindings,
            pimGroupEligibilities,
            mixedChainFindings,
        };
    });
}
// ===========================================================================
// Sub-components — tier badge, assignment chip, etc.
// ===========================================================================
const TierBadge = ({ tier, compact, }) => {
    const meta = TIER_META[tier];
    return (React.createElement(Badge, { variant: meta.badgeVariant, className: cn(compact ? "px-1.5 py-0" : undefined), title: meta.description }, compact ? meta.label.split(" — ")[0] : meta.label));
};
const PathBadge = ({ path }) => {
    const meta = ASSIGNMENT_PATH_META[path];
    return (React.createElement(Badge, { variant: meta.badgeVariant, title: meta.description }, meta.label));
};
// ===========================================================================
// Page component
// ===========================================================================
export const PrivilegedAuditPage = () => {
    var _a, _b, _c, _d, _e, _f;
    const state = useMultiRegionState();
    const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    // Spec: auto-uses the primary signed-in account's active tenant.
    const primaryAccount = azureAccounts[0];
    const tenantId = (_c = (_b = ((primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId)
        ? getActiveTenant(primaryAccount.homeAccountId)
        : null)) !== null && _b !== void 0 ? _b : (primaryAccount ? resolveActiveTenantId(primaryAccount) : "")) !== null && _c !== void 0 ? _c : "";
    // Tracks mount state so async resolutions (token acquisition, probe fetch)
    // never call setState after unmount. Flipped in a cleanup effect at the
    // top of the page so it's defined before any callback closes over it.
    const mountedRef = React.useRef(true);
    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    // -------------------------------------------------------------------------
    // Graph token tracking — manual because there's no useGraphToken hook
    // analogous to useArmToken. The badge needs `secondsUntilExpiry`, so we
    // decode the JWT `exp` claim ourselves.
    // -------------------------------------------------------------------------
    const [graphToken, setGraphToken] = React.useState(null);
    const [graphTokenExpiresAt, setGraphTokenExpiresAt] = React.useState(null);
    const [graphTokenLoading, setGraphTokenLoading] = React.useState(false);
    const [graphTokenError, setGraphTokenError] = React.useState(null);
    const [nowTick, setNowTick] = React.useState(() => Math.floor(Date.now() / 1000));
    const acquireGraphToken = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!(primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId) || !tenantId) {
            if (mountedRef.current) {
                setGraphToken(null);
                setGraphTokenExpiresAt(null);
            }
            return null;
        }
        if (mountedRef.current) {
            setGraphTokenLoading(true);
            setGraphTokenError(null);
        }
        try {
            const t = yield getGraphTokenForAccount(primaryAccount.homeAccountId, tenantId);
            const claims = decodeJwtClaimsUnsafe(t);
            const exp = typeof (claims === null || claims === void 0 ? void 0 : claims.exp) === "number" ? claims.exp : null;
            if (mountedRef.current) {
                setGraphToken(t);
                setGraphTokenExpiresAt(exp);
            }
            return t;
        }
        catch (err) {
            if (mountedRef.current) {
                setGraphTokenError(err instanceof Error ? err.message : String(err));
                setGraphToken(null);
                setGraphTokenExpiresAt(null);
            }
            return null;
        }
        finally {
            if (mountedRef.current) {
                setGraphTokenLoading(false);
            }
        }
    }), [primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId, tenantId]);
    React.useEffect(() => {
        void acquireGraphToken();
    }, [acquireGraphToken]);
    // Tick the badge clock once per second only while a token's outstanding.
    // The interval cleans up on unmount AND when either dep falls to null —
    // no stray timer keeps the page mounted in the React profiler.
    React.useEffect(() => {
        if (!graphToken || !graphTokenExpiresAt)
            return;
        const id = window.setInterval(() => setNowTick(Math.floor(Date.now() / 1000)), 1000);
        return () => window.clearInterval(id);
    }, [graphToken, graphTokenExpiresAt]);
    const graphSecondsUntilExpiry = graphTokenExpiresAt ? Math.max(0, graphTokenExpiresAt - nowTick) : null;
    // -------------------------------------------------------------------------
    // Dataset state + probe lifecycle
    // -------------------------------------------------------------------------
    const [dataset, setDataset] = React.useState(EMPTY_DATASET);
    const [status, setStatus] = React.useState("idle");
    const [error, setError] = React.useState(null);
    const [lastProbedAt, setLastProbedAt] = React.useState(null);
    // Sequence so a slow stale probe can't overwrite a fresher one (tenant
    // switch while a probe is in flight). Paired with an `AbortController`
    // stored in a ref so unmount AND newer probes cancel in-flight fetches —
    // before this, the controller was a local in the callback, so neither
    // unmount nor "Re-probe" cancelled the previous run's network work.
    const probeSeqRef = React.useRef(0);
    const probeAbortRef = React.useRef(null);
    // Abort any in-flight probe on unmount to prevent setState-after-unmount
    // and stop leaking Graph requests when the user navigates away mid-probe.
    React.useEffect(() => {
        return () => {
            var _a;
            (_a = probeAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
            probeAbortRef.current = null;
        };
    }, []);
    const runProbe = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _g;
        if (!tenantId)
            return;
        const token = graphToken !== null && graphToken !== void 0 ? graphToken : (yield acquireGraphToken());
        if (!token) {
            if (mountedRef.current) {
                setError("Could not acquire a Microsoft Graph token for this tenant.");
                setStatus("error");
            }
            return;
        }
        // Cancel any previous in-flight probe before starting a new one.
        (_g = probeAbortRef.current) === null || _g === void 0 ? void 0 : _g.abort();
        const abort = new AbortController();
        probeAbortRef.current = abort;
        const mySeq = ++probeSeqRef.current;
        if (mountedRef.current) {
            setStatus("loading");
            setError(null);
        }
        try {
            const data = yield probeTenant(tenantId, token, abort.signal);
            // Drop stale results when a newer probe has started OR the page
            // unmounted while we were in flight.
            if (!mountedRef.current || mySeq !== probeSeqRef.current)
                return;
            setDataset(data);
            setLastProbedAt(new Date().toISOString());
            setStatus("ok");
            // NOTE: Per the page brief the probe itself is read-only enumeration
            // and not a state-changing action for OUR app, so we deliberately do
            // NOT call auditLog.record() here. Audit firing is reserved for
            // filter mutations (see useAuditFilters() below).
        }
        catch (err) {
            if (err.name === "AbortError")
                return;
            if (!mountedRef.current || mySeq !== probeSeqRef.current)
                return;
            const msg = err instanceof Error ? err.message : String(err);
            setError(msg);
            setStatus("error");
        }
    }), [tenantId, graphToken, acquireGraphToken]);
    // Auto-run the probe the first time we have a token + tenant. Using
    // `useAbortableEffect` here means the effect-owned `AbortSignal` cancels
    // any in-flight enumeration if the page unmounts before the manual
    // controller is even installed. The probeStartedRef guard prevents a
    // tenant-change refresh (which manually drives runProbe) from racing
    // with the initial auto-run.
    const probeStartedRef = React.useRef(false);
    useAbortableEffect((signal) => __awaiter(void 0, void 0, void 0, function* () {
        if (probeStartedRef.current)
            return;
        if (!tenantId || !graphToken)
            return;
        probeStartedRef.current = true;
        // runProbe installs its own AbortController in probeAbortRef so it
        // can be cancelled by future re-probes. We also subscribe the
        // effect-owned signal so unmount during the initial probe aborts
        // the in-flight controller proactively.
        const onAbort = () => { var _a; return (_a = probeAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort(); };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            yield runProbe();
        }
        finally {
            signal.removeEventListener("abort", onAbort);
        }
    }), [tenantId, graphToken, runProbe]);
    const URL_KEYS = React.useMemo(() => ["tier", "type", "path", "shadow", "sort", "q"], []);
    const [urlState, setUrlState] = useUrlState({
        tier: [],
        type: [],
        path: [],
        shadow: "",
        sort: "risk",
        q: "",
    }, { keys: URL_KEYS, replace: true });
    const tierFilters = React.useMemo(() => new Set(urlState.tier.filter((t) => t in TIER_META)), [urlState.tier]);
    const typeFilters = React.useMemo(() => new Set(urlState.type.filter((t) => t === "User" ||
        t === "Group" ||
        t === "ServicePrincipal" ||
        t === "Unknown")), [urlState.type]);
    const pathFilters = React.useMemo(() => new Set(urlState.path.filter((p) => p === "direct" || p === "group" || p === "sp" || p === "guest")), [urlState.path]);
    const shadowOnly = urlState.shadow === "1";
    const sortMode = urlState.sort === "tier" ? "tier" : "risk";
    const searchTerm = urlState.q;
    // ENHANCEMENT — persisted "show only stale members (no activity 90d)"
    // filter. Operators leave this on during weekly hygiene sweeps.
    const [staleOnly, setStaleOnly] = usePersistedState("privileged-audit:stale-only", false);
    // Memoized + stable audit hook for filter-mutation events. Per the brief,
    // the probe itself is read-only enumeration (no audit), but filter
    // mutations ARE worth recording because a stripped-down view can change
    // what an operator overlooks during a review.
    const recordFilterMutation = React.useCallback((kind, value) => {
        var _a;
        auditLog.record({
            actor: (_a = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username) !== null && _a !== void 0 ? _a : "unknown",
            action: `privileged_audit_filter_${kind}`,
            target: tenantId || "no-tenant",
            status: "success",
            details: { value },
        });
    }, [primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username, tenantId]);
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
    const toggleTypeFilter = React.useCallback((t) => {
        setUrlState((prev) => {
            var _a;
            const arr = (_a = prev.type) !== null && _a !== void 0 ? _a : [];
            const next = arr.includes(t)
                ? arr.filter((x) => x !== t)
                : [...arr, t];
            return { type: next };
        });
        recordFilterMutation("type", t);
    }, [setUrlState, recordFilterMutation]);
    const togglePathFilter = React.useCallback((p) => {
        setUrlState((prev) => {
            var _a;
            const arr = (_a = prev.path) !== null && _a !== void 0 ? _a : [];
            const next = arr.includes(p)
                ? arr.filter((x) => x !== p)
                : [...arr, p];
            return { path: next };
        });
        recordFilterMutation("path", p);
    }, [setUrlState, recordFilterMutation]);
    const setShadowOnly = React.useCallback((v) => {
        setUrlState({ shadow: v ? "1" : "" });
        recordFilterMutation("shadow_only", v);
    }, [setUrlState, recordFilterMutation]);
    const setStaleOnlyAudited = React.useCallback((v) => {
        setStaleOnly(v);
        recordFilterMutation("stale_only", v);
    }, [setStaleOnly, recordFilterMutation]);
    const setSortMode = React.useCallback((mode) => {
        setUrlState({ sort: mode });
        recordFilterMutation("sort", mode);
    }, [setUrlState, recordFilterMutation]);
    const setSearchTerm = React.useCallback((s) => {
        setUrlState({ q: s });
    }, [setUrlState]);
    const onClearFilters = React.useCallback(() => {
        setUrlState({
            tier: [],
            type: [],
            path: [],
            shadow: "",
            q: "",
            // intentionally NOT resetting `sort` — operators expect their sort
            // preference to survive a "clear filters" click.
        });
        recordFilterMutation("clear", null);
    }, [setUrlState, recordFilterMutation]);
    // -------------------------------------------------------------------------
    // Per-principal corpus-signal uplift — fold the four signals into the
    // risk score so flagged principals sort up the matrix.
    //
    // Citation: `_AZURE_BYPASS_PLAYBOOK.md` "Critical Defender Audit Surface" —
    // active indicators outweigh static role tier.
    // -------------------------------------------------------------------------
    const signalLiftById = React.useMemo(() => {
        const lift = new Map();
        const add = (id, sev) => {
            var _a;
            const cur = (_a = lift.get(id)) !== null && _a !== void 0 ? _a : 0;
            lift.set(id, cur + SIGNAL_RISK_WEIGHTS[sev]);
        };
        // Signal A — every SP holding a high-priv Graph permission earns
        // uplift on its OWN principal row (SPs appear in section E).
        for (const f of dataset.highPrivGraphPermissions) {
            add(f.servicePrincipalId, gradeHighPrivGraphPermission(f));
        }
        // Signal B — federated cred uplifts the SP it lives under. We pass
        // "addKey recent" by joining against Signal A's hasRecentCredential.
        const recentCredSet = new Set(dataset.highPrivGraphPermissions
            .filter((f) => f.hasRecentCredential)
            .map((f) => f.servicePrincipalId));
        for (const f of dataset.federatedCredentials) {
            add(f.servicePrincipalId, gradeFederatedCredential(f, recentCredSet.has(f.servicePrincipalId)));
        }
        // Signal C — PIM eligibility lifts the principal directly.
        for (const f of dataset.pimEligibilities) {
            add(f.principalId, gradePimEligibility(f));
        }
        // Signal D — TAP issuance lifts the user it was issued to.
        for (const f of dataset.tapIssuances) {
            add(f.userId, gradeTapIssuance(f));
        }
        // Signal E — sync-account drift lifts the sync principal so it sorts to
        // the top of the matrix when it holds non-canonical roles.
        for (const f of dataset.syncAccountFindings) {
            if (f.hasDriftRole)
                add(f.principalId, gradeSyncAccount(f));
        }
        // Signal G — PIM-for-Groups eligibility lifts the eligible principal
        // (NOT the group — the principal is the one with latent privilege).
        for (const f of dataset.pimGroupEligibilities) {
            add(f.principalId, gradePimGroupEligibility(f));
        }
        // Signal F — Mixed-chain temporal correlation. Adds on top of the
        // individual contributors because the corpus framing treats temporal
        // coincidence as a force-multiplier beyond any single indicator.
        for (const f of dataset.mixedChainFindings) {
            add(f.principalId, f.severity);
        }
        return lift;
    }, [
        dataset.highPrivGraphPermissions,
        dataset.federatedCredentials,
        dataset.pimEligibilities,
        dataset.tapIssuances,
        dataset.syncAccountFindings,
        dataset.pimGroupEligibilities,
        dataset.mixedChainFindings,
    ]);
    // -------------------------------------------------------------------------
    // Derived per-section views
    // -------------------------------------------------------------------------
    // Pre-sort principals by the chosen sort mode. The sort is the heaviest
    // operation (full array copy + comparator) so we hoist it out of
    // `filteredPrincipals` and recompute only when the dataset or mode change.
    const sortedPrincipals = React.useMemo(() => {
        const copy = dataset.principals.slice();
        if (sortMode === "risk") {
            copy.sort(compareByRiskScoreWithSignals(signalLiftById));
        }
        else {
            copy.sort(compareByTierThenName);
        }
        return copy;
    }, [dataset.principals, sortMode, signalLiftById]);
    // Snapshot now() once per render so isStalePrincipal isn't re-evaluating
    // Date.now() inside .filter() on every principal.
    const probeNow = React.useMemo(() => Date.now(), [dataset.principals]);
    const filteredPrincipals = React.useMemo(() => {
        const q = searchTerm.trim().toLowerCase();
        return sortedPrincipals.filter((p) => {
            var _a;
            if (tierFilters.size > 0 && !tierFilters.has(p.topTier))
                return false;
            if (typeFilters.size > 0 && !typeFilters.has(p.type))
                return false;
            if (pathFilters.size > 0) {
                const has = p.assignments.some((a) => pathFilters.has(a.path));
                if (!has)
                    return false;
            }
            if (shadowOnly && !p.isShadowAdmin)
                return false;
            if (staleOnly && !isStalePrincipal(p, probeNow))
                return false;
            if (q) {
                const hay = `${p.displayName} ${(_a = p.signInName) !== null && _a !== void 0 ? _a : ""} ${p.id}`.toLowerCase();
                if (!hay.includes(q))
                    return false;
            }
            return true;
        });
    }, [
        sortedPrincipals,
        tierFilters,
        typeFilters,
        pathFilters,
        shadowOnly,
        staleOnly,
        searchTerm,
        probeNow,
    ]);
    const summary = React.useMemo(() => {
        let tier0 = 0;
        let tier1 = 0;
        let groupMediated = 0;
        let guestPrivileged = 0;
        let spPrivileged = 0;
        for (const p of dataset.principals) {
            if (p.topTier === "tier0")
                tier0++;
            if (p.topTier === "tier1")
                tier1++;
            if (p.assignments.some((a) => a.path === "group"))
                groupMediated++;
            if (p.isExternal && (p.topTier === "tier0" || p.topTier === "tier1")) {
                guestPrivileged++;
            }
            if (p.type === "ServicePrincipal")
                spPrivileged++;
        }
        return {
            total: dataset.principals.length,
            tier0,
            tier1,
            groupMediated,
            guestPrivileged,
            spPrivileged,
        };
    }, [dataset.principals]);
    // Privileged Role Administrators — flagged separately because they can
    // self-elevate to Global Admin without anyone noticing in the standard
    // "Global Administrators" view.
    const privilegedRoleAdmins = React.useMemo(() => dataset.principals.filter((p) => p.assignments.some((a) => isPrivilegedRoleAdmin(a.roleTemplateId))), [dataset.principals]);
    // -------------------------------------------------------------------------
    // Tier-0 Watchlist — operator-curated set of principals to monitor for
    // drift between probes. Persisted per-tenant in localStorage so that
    // adding "expected break-glass account" once survives reloads.
    //
    // The watchlist is INTENTIONALLY separate from the auto-detected Tier-0
    // set (every T0 holder is already shown in section B). It's an operator
    // override layer: "I want to know if THIS principal's roles change between
    // probes" — useful for break-glass accounts, vetted SPs, post-incident
    // monitoring of a previously-compromised principal, etc.
    // -------------------------------------------------------------------------
    // The watchlist + captured-roles maps are stored under a SINGLE storage
    // key with the tenant id as the inner map key, NOT as part of the storage
    // key itself. Reason: usePersistedState's persist effect fires on key
    // change, which means switching tenants with the live in-memory state
    // would otherwise overwrite the new tenant's persisted slot with the old
    // tenant's data (race between key change and value reset). The
    // tenant-indexed map avoids that race entirely.
    const [watchlistByTenant, setWatchlistByTenant] = usePersistedState(TIER0_WATCHLIST_STORAGE_KEY_PREFIX, {}, { version: 1 });
    const [watchlistRolesByTenant, setWatchlistRolesByTenant] = usePersistedState(`${TIER0_WATCHLIST_STORAGE_KEY_PREFIX}:roles`, {}, { version: 1 });
    const watchlist = React.useMemo(() => { var _a; return (_a = watchlistByTenant[tenantId]) !== null && _a !== void 0 ? _a : EMPTY_WATCHLIST; }, [watchlistByTenant, tenantId]);
    const setWatchlist = React.useCallback((updater) => {
        setWatchlistByTenant((prev) => {
            var _a;
            const current = (_a = prev[tenantId]) !== null && _a !== void 0 ? _a : EMPTY_WATCHLIST;
            const next = typeof updater === "function"
                ? updater(current)
                : updater;
            return Object.assign(Object.assign({}, prev), { [tenantId]: next });
        });
    }, [setWatchlistByTenant, tenantId]);
    const watchlistCapturedRoles = React.useMemo(() => { var _a; return (_a = watchlistRolesByTenant[tenantId]) !== null && _a !== void 0 ? _a : {}; }, [watchlistRolesByTenant, tenantId]);
    const setWatchlistCapturedRoles = React.useCallback((updater) => {
        setWatchlistRolesByTenant((prev) => {
            var _a;
            const current = (_a = prev[tenantId]) !== null && _a !== void 0 ? _a : {};
            const next = typeof updater === "function"
                ? updater(current)
                : updater;
            return Object.assign(Object.assign({}, prev), { [tenantId]: next });
        });
    }, [setWatchlistRolesByTenant, tenantId]);
    const capturedRolesByPrincipalId = React.useMemo(() => {
        const m = new Map();
        for (const [k, v] of Object.entries(watchlistCapturedRoles)) {
            m.set(k, new Set(v));
        }
        return m;
    }, [watchlistCapturedRoles]);
    const watchlistDrift = React.useMemo(() => computeWatchlistDrift(watchlist, dataset.principals, capturedRolesByPrincipalId), [watchlist, dataset.principals, capturedRolesByPrincipalId]);
    const watchlistIds = React.useMemo(() => new Set(watchlist.entries.map((e) => e.principalId)), [watchlist]);
    const addToWatchlist = React.useCallback((principal, note) => {
        var _a;
        setWatchlist((prev) => {
            if (prev.entries.some((e) => e.principalId === principal.id)) {
                return prev;
            }
            const newEntry = {
                principalId: principal.id,
                capturedDisplayName: principal.displayName,
                capturedSignInName: principal.signInName,
                capturedTier: principal.topTier,
                addedAt: new Date().toISOString(),
                note,
            };
            return { entries: [...prev.entries, newEntry] };
        });
        setWatchlistCapturedRoles((prev) => (Object.assign(Object.assign({}, prev), { [principal.id]: Array.from(new Set(principal.assignments.map((a) => a.roleTemplateId))) })));
        auditLog.record({
            actor: (_a = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username) !== null && _a !== void 0 ? _a : "unknown",
            action: `${PRIVILEGED_AUDIT_ACTION_PREFIX}watchlist_add`,
            target: principal.id,
            status: "success",
            details: { displayName: principal.displayName, note },
        });
    }, [setWatchlist, setWatchlistCapturedRoles, primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username]);
    const removeFromWatchlist = React.useCallback((principalId) => {
        var _a;
        setWatchlist((prev) => ({
            entries: prev.entries.filter((e) => e.principalId !== principalId),
        }));
        setWatchlistCapturedRoles((prev) => {
            const next = Object.assign({}, prev);
            delete next[principalId];
            return next;
        });
        auditLog.record({
            actor: (_a = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username) !== null && _a !== void 0 ? _a : "unknown",
            action: `${PRIVILEGED_AUDIT_ACTION_PREFIX}watchlist_remove`,
            target: principalId,
            status: "success",
        });
    }, [setWatchlist, setWatchlistCapturedRoles, primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username]);
    // -------------------------------------------------------------------------
    // Audit-log mirror — feeds the per-principal timeline inside expanded
    // assignment-detail rows. We subscribe to the auditLog singleton and
    // re-render the page when a privileged-audit event lands so the timeline
    // updates live (filter mutations, watchlist add/remove, signal exports).
    // The subscription is read-only — we never write through this view.
    // -------------------------------------------------------------------------
    const [auditMirror, setAuditMirror] = React.useState(() => auditLog.getEntries(200));
    React.useEffect(() => {
        const refresh = () => {
            if (!mountedRef.current)
                return;
            setAuditMirror(auditLog.getEntries(200));
        };
        refresh();
        return auditLog.subscribe((e) => e.action.startsWith(PRIVILEGED_AUDIT_ACTION_PREFIX), refresh);
    }, []);
    const auditEventsByTarget = React.useMemo(() => {
        var _a;
        const m = new Map();
        for (const e of auditMirror) {
            const list = (_a = m.get(e.target)) !== null && _a !== void 0 ? _a : [];
            list.push(e);
            m.set(e.target, list);
        }
        return m;
    }, [auditMirror]);
    // -------------------------------------------------------------------------
    // Critical-finding count for the ARIA-live region. Recomputes from the
    // signal arrays; a change is announced to screen-reader users via the
    // <output> below the page header.
    // -------------------------------------------------------------------------
    const criticalFindingCount = React.useMemo(() => {
        let n = 0;
        for (const f of dataset.highPrivGraphPermissions)
            if (gradeHighPrivGraphPermission(f) === "critical")
                n++;
        const recentCredSet = new Set(dataset.highPrivGraphPermissions
            .filter((f) => f.hasRecentCredential)
            .map((f) => f.servicePrincipalId));
        for (const f of dataset.federatedCredentials)
            if (gradeFederatedCredential(f, recentCredSet.has(f.servicePrincipalId)) === "critical")
                n++;
        for (const f of dataset.pimEligibilities)
            if (gradePimEligibility(f) === "critical")
                n++;
        for (const f of dataset.tapIssuances)
            if (gradeTapIssuance(f) === "critical")
                n++;
        for (const f of dataset.syncAccountFindings)
            if (gradeSyncAccount(f) === "critical")
                n++;
        for (const f of dataset.pimGroupEligibilities)
            if (gradePimGroupEligibility(f) === "critical")
                n++;
        for (const f of dataset.mixedChainFindings)
            if (f.severity === "critical")
                n++;
        return n;
    }, [
        dataset.highPrivGraphPermissions,
        dataset.federatedCredentials,
        dataset.pimEligibilities,
        dataset.tapIssuances,
        dataset.syncAccountFindings,
        dataset.pimGroupEligibilities,
        dataset.mixedChainFindings,
    ]);
    // -------------------------------------------------------------------------
    // Hotkey commands. Live in a ref so the Section B list can call them
    // without dragging the entire callback chain through props. Per the
    // brief: `c` collapses all expanded; `e` exports the critical-findings
    // subset only.
    // -------------------------------------------------------------------------
    const collapseAllRef = React.useRef(null);
    const exportCriticalRef = React.useRef(null);
    useShortcut("c", () => { var _a; return (_a = collapseAllRef.current) === null || _a === void 0 ? void 0 : _a.call(collapseAllRef); }, {
        allowInInputs: false,
        preventDefault: false,
    });
    useShortcut("e", () => { var _a; return (_a = exportCriticalRef.current) === null || _a === void 0 ? void 0 : _a.call(exportCriticalRef); }, {
        allowInInputs: false,
        preventDefault: false,
    });
    // Live tenant-change propagation. This page auto-targets the primary
    // signed-in account's active tenant, so when that account's active tenant
    // changes elsewhere in the app, drop the stale Graph token, abort any
    // in-flight probe (otherwise we'd write tenant-A results into tenant-B's
    // dataset), and re-acquire fresh credentials.
    const onTenantChange = React.useCallback((detail) => {
        var _a;
        const candidate = detail.homeAccountId;
        if (!azureAccounts.some((a) => a.homeAccountId === candidate))
            return;
        if ((primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId) !== candidate)
            return;
        if (detail.tenantId === tenantId)
            return;
        (_a = probeAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
        probeAbortRef.current = null;
        setGraphToken(null);
        setGraphTokenExpiresAt(null);
        setDataset(EMPTY_DATASET);
        probeStartedRef.current = false;
        void acquireGraphToken();
    }, [azureAccounts, primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId, tenantId, acquireGraphToken]);
    useTenantChange(undefined, onTenantChange);
    // -------------------------------------------------------------------------
    // Render guards (no account / no tenant)
    // -------------------------------------------------------------------------
    if (!primaryAccount) {
        return (React.createElement("section", { className: "flex flex-col gap-4" },
            React.createElement(PageHeader, { title: "Privileged Audit", description: "Discover privileged identities, group-mediated escalations, service principals with roles, and guest privileges in your active tenant. Read-only Graph probes only." }),
            React.createElement(EmptyState, { icon: ShieldAlert, title: "Sign in to an Azure account first", description: "The Privileged Audit page needs a signed-in account with Directory.Read.All against the tenant you want to audit." })));
    }
    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------
    const tenantLabel = (_f = (_e = (_d = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.tenants) === null || _d === void 0 ? void 0 : _d.find((t) => t.tenantId === tenantId)) === null || _e === void 0 ? void 0 : _e.displayName) !== null && _f !== void 0 ? _f : tenantId;
    const loading = status === "loading";
    return (React.createElement("section", { className: "flex flex-col gap-4" },
        React.createElement(PageHeader, { title: "Privileged Audit", description: "SkyArk-inspired defensive auditor. Enumerates every directory role holder in the active tenant, including indirect (group-mediated), service-principal, and guest paths that the portal's role blade hides." },
            React.createElement(TokenExpiryBadge, { secondsUntilExpiry: graphSecondsUntilExpiry, loading: graphTokenLoading, onRefresh: () => void acquireGraphToken() }),
            React.createElement(Button, { type: "button", size: "sm", variant: "outline", onClick: () => void runProbe(), disabled: loading || !graphToken, "aria-label": "Re-run the privileged audit probe" },
                React.createElement(RefreshCw, { className: cn("h-3.5 w-3.5", loading && "animate-spin"), "aria-hidden": true }),
                loading ? "Probing…" : "Re-probe")),
        React.createElement(TenantHeaderCard, { tenantId: tenantId, tenantLabel: tenantLabel, username: primaryAccount.username, activatedRoleCount: dataset.activatedRoleCount, lastProbedAt: lastProbedAt }),
        graphTokenError && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(KeyRound, { className: "h-4 w-4" }),
            React.createElement(AlertTitle, null, "Could not acquire a Graph token"),
            React.createElement(AlertDescription, null, graphTokenError))),
        error && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(AlertTriangle, { className: "h-4 w-4" }),
            React.createElement(AlertTitle, null, "Probe failed"),
            React.createElement(AlertDescription, null, error))),
        dataset.warnings.length > 0 && (React.createElement(Alert, { variant: "warning" },
            React.createElement(AlertTriangle, { className: "h-4 w-4" }),
            React.createElement(AlertTitle, null,
                "Partial data (",
                dataset.warnings.length,
                ")"),
            React.createElement(AlertDescription, null,
                "Some Graph sub-probes degraded. Results below may be incomplete.",
                React.createElement("ul", { className: "mt-1 list-disc pl-5 text-xs" },
                    dataset.warnings.slice(0, 5).map((w) => (React.createElement("li", { key: w.id }, w.message))),
                    dataset.warnings.length > 5 && (React.createElement("li", null,
                        "+ ",
                        dataset.warnings.length - 5,
                        " more\u2026")))))),
        React.createElement("p", { className: "sr-only", role: "status", "aria-live": "polite", "aria-atomic": "true" }, loading
            ? "Privileged audit probing…"
            : criticalFindingCount === 0
                ? "Privileged audit complete. No critical findings."
                : `Privileged audit complete. ${criticalFindingCount} critical finding${criticalFindingCount === 1 ? "" : "s"}.`),
        React.createElement(SummaryStatsRow, { summary: summary, loading: loading }),
        React.createElement(Tier0WatchlistCard, { watchlist: watchlist, drift: watchlistDrift, onRemove: removeFromWatchlist }),
        React.createElement(FiltersBar, { tierFilters: tierFilters, typeFilters: typeFilters, pathFilters: pathFilters, shadowOnly: shadowOnly, staleOnly: staleOnly, sortMode: sortMode, searchTerm: searchTerm, principals: dataset.principals, onToggleTier: toggleTierFilter, onToggleType: toggleTypeFilter, onTogglePath: togglePathFilter, onShadowOnlyChange: setShadowOnly, onStaleOnlyChange: setStaleOnlyAudited, onSortModeChange: setSortMode, onSearchTermChange: setSearchTerm, onClear: onClearFilters }),
        React.createElement(PrivilegedIdentityList, { principals: filteredPrincipals, tenantId: tenantId, loading: loading, tenantTotal: dataset.principals.length, dataset: dataset, summary: summary, signalLiftById: signalLiftById, watchlistIds: watchlistIds, onAddToWatchlist: addToWatchlist, onRemoveFromWatchlist: removeFromWatchlist, auditEventsByTarget: auditEventsByTarget, collapseAllRef: collapseAllRef, exportCriticalRef: exportCriticalRef, criticalFindingCount: criticalFindingCount }),
        React.createElement(CorpusDetectionSignalsCard, { dataset: dataset, loading: loading }),
        React.createElement(ShadowAdminPathsPanel, { paths: dataset.shadowPaths, privilegedRoleAdmins: privilegedRoleAdmins, loading: loading }),
        React.createElement(GroupsHoldingRolesCard, { groups: dataset.groups, loading: loading }),
        React.createElement(ServicePrincipalsCard, { sps: dataset.servicePrincipals, loading: loading })));
};
// ===========================================================================
// Section: tenant header card
// ===========================================================================
const TenantHeaderCard = ({ tenantId, tenantLabel, username, activatedRoleCount, lastProbedAt }) => (React.createElement(Card, null,
    React.createElement(CardHeader, { className: "flex flex-row flex-wrap items-start justify-between gap-2 space-y-0" },
        React.createElement("div", { className: "min-w-0" },
            React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                React.createElement(ShieldCheck, { className: "h-4 w-4 text-info" }),
                tenantLabel),
            React.createElement(CardDescription, { className: "group/copy flex items-center gap-1.5 font-mono text-2xs" },
                tenantId || "no tenant",
                tenantId && React.createElement(CopyButton, { value: tenantId }))),
        React.createElement("div", { className: "flex flex-col items-end gap-0.5 text-2xs text-muted-foreground" },
            React.createElement("span", null,
                "Signed in as ",
                username),
            React.createElement("span", null,
                activatedRoleCount,
                " activated directory role",
                activatedRoleCount === 1 ? "" : "s"),
            lastProbedAt && (React.createElement("span", null,
                "Last probe: ",
                formatRelativeTime(lastProbedAt)))))));
// ===========================================================================
// Section A: summary stats row
// ===========================================================================
const SummaryStatsRow = ({ summary, loading }) => (React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Privileged audit summary" },
    React.createElement(SummaryStatItem, { label: "Total privileged", value: loading ? "…" : summary.total }),
    React.createElement(SummaryStatItem, { label: "Tier 0 \u2014 Global", value: loading ? "…" : summary.tier0, tone: "destructive", hint: "Global / Privileged Role Admin" }),
    React.createElement(SummaryStatItem, { label: "Tier 1 \u2014 Sensitive", value: loading ? "…" : summary.tier1, tone: "warning" }),
    React.createElement(SummaryStatItem, { label: "Via group", value: loading ? "…" : summary.groupMediated, tone: "info", hint: "Shadow admins" }),
    React.createElement(SummaryStatItem, { label: "Guest-privileged", value: loading ? "…" : summary.guestPrivileged, tone: "destructive", hint: "Cross-tenant T0/T1" }),
    React.createElement(SummaryStatItem, { label: "SP-privileged", value: loading ? "…" : summary.spPrivileged, tone: "info", hint: "Workload identities" })));
const FiltersBar = ({ tierFilters, typeFilters, pathFilters, shadowOnly, staleOnly, sortMode, searchTerm, principals, onToggleTier, onToggleType, onTogglePath, onShadowOnlyChange, onStaleOnlyChange, onSortModeChange, onSearchTermChange, onClear, }) => {
    // Counts per filter value, for the chip badges.
    const tierCounts = React.useMemo(() => {
        const c = {
            tier0: 0,
            tier1: 0,
            tier2: 0,
            tier3: 0,
            other: 0,
        };
        for (const p of principals)
            c[p.topTier]++;
        return c;
    }, [principals]);
    const typeCounts = React.useMemo(() => {
        const c = {
            User: 0,
            Group: 0,
            ServicePrincipal: 0,
            Unknown: 0,
        };
        for (const p of principals)
            c[p.type]++;
        return c;
    }, [principals]);
    const pathCounts = React.useMemo(() => {
        const c = {
            direct: 0,
            group: 0,
            sp: 0,
            guest: 0,
        };
        for (const p of principals) {
            const seen = new Set();
            for (const a of p.assignments) {
                if (seen.has(a.path))
                    continue;
                seen.add(a.path);
                c[a.path]++;
            }
        }
        return c;
    }, [principals]);
    const activeFilterCount = tierFilters.size +
        typeFilters.size +
        pathFilters.size +
        (shadowOnly ? 1 : 0) +
        (staleOnly ? 1 : 0) +
        (searchTerm.trim() ? 1 : 0);
    return (React.createElement(Card, null,
        React.createElement(CardContent, { className: "flex flex-col gap-3 p-3" },
            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                React.createElement(FilterIcon, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
                React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Filters"),
                React.createElement("div", { className: "ml-auto flex items-center gap-2" },
                    React.createElement("div", { role: "radiogroup", "aria-label": "Sort mode", className: "inline-flex rounded-md border border-border bg-card p-0.5 text-2xs" },
                        React.createElement("button", { type: "button", role: "radio", "aria-checked": sortMode === "risk", onClick: () => onSortModeChange("risk"), className: cn("rounded px-2 py-0.5 transition-colors", sortMode === "risk"
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:text-foreground"), title: "Sort by composite risk score \u2014 highest privilege first" }, "Risk"),
                        React.createElement("button", { type: "button", role: "radio", "aria-checked": sortMode === "tier", onClick: () => onSortModeChange("tier"), className: cn("rounded px-2 py-0.5 transition-colors", sortMode === "tier"
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:text-foreground"), title: "Sort strictly by tier (T0 \u2192 T3), then by display name" }, "Tier")),
                    React.createElement("label", { className: "flex items-center gap-1.5 text-2xs text-muted-foreground" },
                        React.createElement("input", { type: "checkbox", checked: shadowOnly, onChange: (e) => onShadowOnlyChange(e.target.checked), "aria-label": "Show only shadow admins", className: "h-3.5 w-3.5 rounded border-border" }),
                        React.createElement(Sparkles, { className: "h-3 w-3 text-warning", "aria-hidden": true }),
                        "Shadow only",
                        React.createElement(InfoTooltip, { content: "Anything other than a Direct user assignment \u2014 group-mediated, service-principal, or guest paths." })),
                    React.createElement("label", { className: "flex items-center gap-1.5 text-2xs text-muted-foreground" },
                        React.createElement("input", { type: "checkbox", checked: staleOnly, onChange: (e) => onStaleOnlyChange(e.target.checked), "aria-label": "Show only stale members (no activity in 90 days)", className: "h-3.5 w-3.5 rounded border-border" }),
                        React.createElement(Clock, { className: "h-3 w-3 text-info", "aria-hidden": true }),
                        "Stale only",
                        React.createElement(InfoTooltip, { content: `Best-effort: SPs whose createdDateTime is older than ${Math.round(STALE_THRESHOLD_MS / (24 * 60 * 60 * 1000))} days, and users with no resolvable UPN. signInActivity from Graph would give a precise number but requires AuditLog.Read.All which this page deliberately does not demand.` })),
                    activeFilterCount > 0 && (React.createElement(Button, { type: "button", size: "sm", variant: "ghost", onClick: onClear, "aria-label": "Clear all filters" },
                        React.createElement(EyeOff, { className: "h-3.5 w-3.5" }),
                        "Clear (",
                        activeFilterCount,
                        ")")))),
            React.createElement("div", { className: "flex flex-wrap gap-1.5" },
                React.createElement(ChipGroupLabel, null, "Tier"),
                Object.keys(TIER_META).map((t) => {
                    var _a;
                    return (React.createElement(FilterChip, { key: t, active: tierFilters.has(t), onClick: () => onToggleTier(t), tooltip: TIER_META[t].description }, (_a = TIER_META[t].label.split(" — ")[0]) !== null && _a !== void 0 ? _a : TIER_META[t].label,
                        React.createElement("span", { className: "ml-1 text-2xs opacity-70" }, tierCounts[t])));
                })),
            React.createElement("div", { className: "flex flex-wrap gap-1.5" },
                React.createElement(ChipGroupLabel, null, "Type"),
                ["User", "Group", "ServicePrincipal"].map((t) => (React.createElement(FilterChip, { key: t, active: typeFilters.has(t), onClick: () => onToggleType(t) },
                    t === "ServicePrincipal" ? "Service principal" : t,
                    React.createElement("span", { className: "ml-1 text-2xs opacity-70" }, typeCounts[t]))))),
            React.createElement("div", { className: "flex flex-wrap gap-1.5" },
                React.createElement(ChipGroupLabel, null, "Assignment path"),
                Object.keys(ASSIGNMENT_PATH_META).map((p) => (React.createElement(FilterChip, { key: p, active: pathFilters.has(p), onClick: () => onTogglePath(p), tooltip: ASSIGNMENT_PATH_META[p].description },
                    ASSIGNMENT_PATH_META[p].label,
                    React.createElement("span", { className: "ml-1 text-2xs opacity-70" }, pathCounts[p]))))),
            React.createElement("label", { className: "relative block" },
                React.createElement(Search, { className: "pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                React.createElement(Input, { type: "search", placeholder: "Search by name, UPN, or object id\u2026", value: searchTerm, onChange: (e) => onSearchTermChange(e.target.value), className: "pl-8", "aria-label": "Search privileged identities" })))));
};
const ChipGroupLabel = ({ children, }) => (React.createElement("span", { className: "self-center pr-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground" }, children));
const FilterChip = ({ active, onClick, tooltip, children }) => (React.createElement("button", { type: "button", onClick: onClick, title: tooltip, "aria-pressed": active, className: cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-2xs font-medium transition-colors", active
        ? "border-primary bg-primary/15 text-primary"
        : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground") }, children));
// ===========================================================================
// Section B: privileged identity list
// ===========================================================================
/**
 * Build the principal-export column list. We pass the per-principal corpus
 * signal-lift map in so the exported "Risk score" column matches the value
 * used to sort the on-screen table.
 */
function principalExportColumns(signalLiftById) {
    return [
        { header: "Display name", accessor: (p) => p.displayName },
        { header: "Type", accessor: (p) => p.type },
        { header: "Sign-in name", accessor: (p) => { var _a; return (_a = p.signInName) !== null && _a !== void 0 ? _a : ""; } },
        { header: "Object id", accessor: (p) => p.id },
        { header: "Top tier", accessor: (p) => TIER_META[p.topTier].label },
        {
            header: "Risk score",
            accessor: (p) => { var _a; return riskScore(p, (_a = signalLiftById.get(p.id)) !== null && _a !== void 0 ? _a : 0); },
        },
        {
            header: "Signal lift",
            accessor: (p) => { var _a; return (_a = signalLiftById.get(p.id)) !== null && _a !== void 0 ? _a : 0; },
        },
        {
            header: "Roles",
            accessor: (p) => Array.from(new Set(p.assignments.map((a) => a.roleDisplayName))).join("; "),
        },
        {
            header: "Role template ids",
            accessor: (p) => Array.from(new Set(p.assignments.map((a) => a.roleTemplateId))).join("; "),
        },
        {
            header: "Assignment paths",
            accessor: (p) => Array.from(new Set(p.assignments.map((a) => a.path))).join("; "),
        },
        { header: "Shadow admin", accessor: (p) => (p.isShadowAdmin ? "yes" : "no") },
        { header: "Guest", accessor: (p) => (p.isExternal ? "yes" : "no") },
        { header: "Stale (heuristic)", accessor: (p) => (isStalePrincipal(p) ? "yes" : "no") },
    ];
}
const PrivilegedIdentityList = ({ principals, tenantId, tenantTotal, loading, dataset, summary, signalLiftById, watchlistIds, onAddToWatchlist, onRemoveFromWatchlist, auditEventsByTarget, collapseAllRef, exportCriticalRef, criticalFindingCount, }) => {
    const [expanded, setExpanded] = React.useState(() => new Set());
    const toggleExpand = React.useCallback((id) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }, []);
    // Wire the parent's hotkey refs to a stable "collapse all" handler.
    // The hotkey 'c' is owned by the parent (useShortcut('c')) — we just
    // install the implementation here so the parent doesn't need access to
    // the expanded Set. Cleanup uses pointer-equality so we only NULL the
    // slot if our handler is still the one installed.
    React.useEffect(() => {
        const handler = () => setExpanded(new Set());
        collapseAllRef.current = handler;
        return () => {
            if (collapseAllRef.current === handler) {
                collapseAllRef.current = null;
            }
        };
    }, [collapseAllRef]);
    // For JSON export we want EVERYTHING (paths, summary stats, partial-data
    // warnings, AND the corpus-derived detection signals A/B/C/D) so the file
    // is self-contained per the spec.
    const exportPayload = React.useMemo(() => ({
        tenantId,
        probedAt: new Date().toISOString(),
        summary,
        shadowAdminPaths: dataset.shadowPaths,
        groupsHoldingRoles: dataset.groups,
        servicePrincipals: dataset.servicePrincipals,
        warnings: dataset.warnings,
        corpusSignals: {
            // See privileged-audit-helpers.ts header for the corpus citations.
            // The seven-signal set: A (Graph perms), B (FIC), C (PIM elig),
            // D (TAP), E (sync drift), F (mixed chains), G (PIM-for-Groups).
            A_highPrivGraphPermissions: dataset.highPrivGraphPermissions,
            B_federatedCredentials: dataset.federatedCredentials,
            C_pimEligibilities: dataset.pimEligibilities,
            D_tapIssuances: dataset.tapIssuances,
            E_syncAccountFindings: dataset.syncAccountFindings,
            F_mixedChainFindings: dataset.mixedChainFindings,
            G_pimGroupEligibilities: dataset.pimGroupEligibilities,
        },
    }), [tenantId, summary, dataset]);
    // Build the principal export columns lazily so the "Risk score" column
    // matches the on-screen value (base + corpus signal lift).
    const exportColumns = React.useMemo(() => principalExportColumns(signalLiftById), [signalLiftById]);
    // -------------------------------------------------------------------------
    // Hotkey: 'e' → export critical findings only.
    //
    // Composes a focused subset of the JSON export — only critical-graded
    // findings across all 7 corpus signals, plus the critical-tagged
    // mixed-chain rows. The download is silent (no menu) so an operator on
    // call can grab the incident-handoff blob with one keystroke.
    // -------------------------------------------------------------------------
    React.useEffect(() => {
        const handler = () => {
            const recentCredSet = new Set(dataset.highPrivGraphPermissions
                .filter((f) => f.hasRecentCredential)
                .map((f) => f.servicePrincipalId));
            const payload = {
                tenantId,
                exportedAt: new Date().toISOString(),
                kind: "privileged-audit-critical-only",
                criticalCount: criticalFindingCount,
                signals: {
                    A_highPrivGraphPermissions: dataset.highPrivGraphPermissions.filter((f) => gradeHighPrivGraphPermission(f) === "critical"),
                    B_federatedCredentials: dataset.federatedCredentials.filter((f) => gradeFederatedCredential(f, recentCredSet.has(f.servicePrincipalId)) === "critical"),
                    C_pimEligibilities: dataset.pimEligibilities.filter((f) => gradePimEligibility(f) === "critical"),
                    D_tapIssuances: dataset.tapIssuances.filter((f) => gradeTapIssuance(f) === "critical"),
                    E_syncAccountFindings: dataset.syncAccountFindings.filter((f) => gradeSyncAccount(f) === "critical"),
                    F_mixedChainFindings: dataset.mixedChainFindings.filter((f) => f.severity === "critical"),
                    G_pimGroupEligibilities: dataset.pimGroupEligibilities.filter((f) => gradePimGroupEligibility(f) === "critical"),
                },
            };
            const stamp = new Date().toISOString().slice(0, 10);
            downloadJson(`privileged-audit-critical-${stamp}.json`, payload);
            auditLog.record({
                actor: "hotkey",
                action: `${PRIVILEGED_AUDIT_ACTION_PREFIX}export_critical`,
                target: tenantId || "no-tenant",
                status: "success",
                details: { count: criticalFindingCount },
            });
        };
        exportCriticalRef.current = handler;
        return () => {
            if (exportCriticalRef.current === handler) {
                exportCriticalRef.current = null;
            }
        };
    }, [
        exportCriticalRef,
        dataset.highPrivGraphPermissions,
        dataset.federatedCredentials,
        dataset.pimEligibilities,
        dataset.tapIssuances,
        dataset.syncAccountFindings,
        dataset.pimGroupEligibilities,
        dataset.mixedChainFindings,
        tenantId,
        criticalFindingCount,
    ]);
    const columns = React.useMemo(() => [
        {
            id: "expand",
            header: "",
            width: "w-8",
            cell: (p) => (React.createElement("button", { type: "button", onClick: () => toggleExpand(p.id), "aria-label": expanded.has(p.id) ? "Collapse details" : "Expand details", className: "inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" }, expanded.has(p.id) ? (React.createElement(ChevronDown, { className: "h-3 w-3" })) : (React.createElement(ChevronRight, { className: "h-3 w-3" })))),
        },
        {
            id: "identity",
            header: "Identity",
            sort: (a, b) => a.displayName.localeCompare(b.displayName, undefined, {
                sensitivity: "base",
            }),
            cell: (p) => (React.createElement("div", { className: "group/copy flex min-w-0 flex-col" },
                React.createElement("span", { className: "truncate text-sm font-medium text-foreground" }, p.displayName),
                p.signInName && (React.createElement("span", { className: "truncate font-mono text-2xs text-muted-foreground" }, p.signInName)),
                React.createElement("span", { className: "flex items-center gap-1 font-mono text-3xs text-muted-foreground/70" },
                    p.id,
                    React.createElement(CopyButton, { value: p.id })))),
            csv: (p) => p.displayName,
        },
        {
            id: "type",
            header: "Type",
            width: "w-24",
            sort: (a, b) => a.type.localeCompare(b.type),
            cell: (p) => (React.createElement(Badge, { variant: p.type === "ServicePrincipal" ? "info" : "outline" }, p.type === "ServicePrincipal" ? "SP" : p.type)),
        },
        {
            id: "tier",
            header: "Tier",
            width: "w-36",
            sort: (a, b) => TIER_META[a.topTier].order - TIER_META[b.topTier].order,
            cell: (p) => React.createElement(TierBadge, { tier: p.topTier, compact: true }),
        },
        {
            id: "roles",
            header: "Roles",
            cell: (p) => {
                const unique = Array.from(new Map(p.assignments.map((a) => [a.roleId, a.roleDisplayName])).entries());
                return (React.createElement("div", { className: "flex flex-wrap gap-1" },
                    unique.slice(0, 3).map(([id, name]) => (React.createElement(Badge, { key: id, variant: "secondary", title: name }, name))),
                    unique.length > 3 && (React.createElement(Badge, { variant: "outline" },
                        "+",
                        unique.length - 3))));
            },
        },
        {
            id: "paths",
            header: "Path",
            width: "w-44",
            cell: (p) => {
                const paths = Array.from(new Set(p.assignments.map((a) => a.path)));
                return (React.createElement("div", { className: "flex flex-wrap gap-1" }, paths.map((path) => (React.createElement(PathBadge, { key: path, path: path })))));
            },
        },
        {
            id: "risk",
            header: "Risk",
            width: "w-16",
            sort: (a, b) => {
                var _a, _b;
                return riskScore(b, (_a = signalLiftById.get(b.id)) !== null && _a !== void 0 ? _a : 0) -
                    riskScore(a, (_b = signalLiftById.get(a.id)) !== null && _b !== void 0 ? _b : 0);
            },
            cell: (p) => {
                var _a;
                const lift = (_a = signalLiftById.get(p.id)) !== null && _a !== void 0 ? _a : 0;
                const base = riskScore(p);
                const total = riskScore(p, lift);
                return (React.createElement("span", { className: cn("tabular-nums text-2xs", lift > 0
                        ? "font-medium text-warning"
                        : "text-muted-foreground"), title: lift > 0
                        ? `Risk ${total.toLocaleString()} = base ${base.toLocaleString()} + corpus-signal lift ${lift.toLocaleString()}. ` +
                            "Lift comes from Signals A/B/C/D — see Corpus Detection Signals card."
                        : "Composite risk score — Tier-weighted (T0=1000, T1=100, T2=10, T3=1) plus shadow/guest/SP modifiers. See helpers.riskScore()." }, total.toLocaleString()));
            },
            csv: (p) => { var _a; return riskScore(p, (_a = signalLiftById.get(p.id)) !== null && _a !== void 0 ? _a : 0); },
        },
        {
            id: "activity",
            header: "Activity",
            width: "w-24",
            cell: (p) => {
                // Graph's signInActivity endpoint would give us a true last-sign-in
                // stamp but requires AuditLog.Read.All which this page deliberately
                // doesn't demand. We surface our best-effort "stale" heuristic
                // instead (see isStalePrincipal()) so the value is at least
                // honestly labelled.
                const stale = isStalePrincipal(p);
                if (stale) {
                    return (React.createElement(Badge, { variant: "warning", title: "Stale by heuristic \u2014 see filter tooltip" }, "Stale"));
                }
                if (p.type === "ServicePrincipal" && p.createdDateTime) {
                    return (React.createElement("span", { className: "text-2xs text-muted-foreground", title: `Created ${p.createdDateTime}` }, formatRelativeTime(p.createdDateTime)));
                }
                return React.createElement("span", { className: "text-2xs text-muted-foreground" }, "\u2014");
            },
        },
        {
            id: "watch",
            header: "",
            width: "w-8",
            cell: (p) => {
                const watched = watchlistIds.has(p.id);
                return (React.createElement("button", { type: "button", onClick: () => watched ? onRemoveFromWatchlist(p.id) : onAddToWatchlist(p), className: cn("inline-flex h-6 w-6 items-center justify-center rounded", watched
                        ? "text-warning hover:bg-warning/15"
                        : "text-muted-foreground/60 hover:bg-muted hover:text-foreground"), title: watched
                        ? "Remove from Tier-0 Watchlist — stop monitoring drift"
                        : "Add to Tier-0 Watchlist — alert on tier or role changes between probes", "aria-label": watched
                        ? `Remove ${p.displayName} from watchlist`
                        : `Add ${p.displayName} to watchlist`, "aria-pressed": watched },
                    React.createElement(Sparkles, { className: cn("h-3 w-3", watched ? "fill-warning/30" : ""), "aria-hidden": true })));
            },
        },
        {
            id: "actions",
            header: "",
            width: "w-12",
            cell: (p) => (React.createElement("a", { href: portalDeepLink(tenantId, p), target: "_blank", rel: "noopener noreferrer", className: "inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground", title: "Open in Azure portal", "aria-label": `Open ${p.displayName} in the Azure portal` },
                React.createElement(ExternalLink, { className: "h-3 w-3" }))),
        },
    ], [
        tenantId,
        expanded,
        signalLiftById,
        toggleExpand,
        watchlistIds,
        onAddToWatchlist,
        onRemoveFromWatchlist,
    ]);
    return (React.createElement(Card, null,
        React.createElement(CardHeader, { className: "flex flex-row flex-wrap items-end justify-between gap-2 space-y-0" },
            React.createElement("div", { className: "min-w-0" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Users, { className: "h-4 w-4 text-info" }),
                    " Privileged identities",
                    React.createElement(InfoTooltip, { content: "Every user / group / service-principal that holds at least one activated directory role in the tenant \u2014 direct or transitive. Press `c` to collapse all expanded rows; press `e` to export critical findings only." })),
                React.createElement(CardDescription, { className: "flex flex-wrap items-center gap-2" },
                    "Showing ",
                    principals.length,
                    " of ",
                    tenantTotal,
                    " privileged identities.",
                    React.createElement("span", { className: "hidden text-3xs text-muted-foreground/80 sm:inline" },
                        React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 font-mono text-3xs" }, "c"),
                        " ",
                        "collapse all,",
                        " ",
                        React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 font-mono text-3xs" }, "e"),
                        " ",
                        "export critical (",
                        criticalFindingCount,
                        ")"))),
            React.createElement(ExportMenu, { rows: principals, columns: exportColumns, filename: "privileged-audit", jsonMetadata: exportPayload })),
        React.createElement(CardContent, null,
            React.createElement(DataTable, { tableId: "privileged-audit-identities", rows: principals, columns: columns, rowKey: (p) => p.id, loading: loading, 
                // Rows arrive pre-sorted by the parent (risk score by default,
                // strict tier order when sortMode === "tier"). Letting DataTable
                // apply an initialSort would fight the parent ordering, so we
                // omit it and only honour explicit per-column clicks by the user.
                empty: loading ? (React.createElement(Skeleton, { className: "h-12 w-full" })) : (React.createElement(EmptyState, { icon: ShieldCheck, title: tenantTotal === 0
                        ? "No privileged identities found"
                        : "No identities match the current filters", description: tenantTotal === 0
                        ? "Either the tenant has no activated directory roles, or the signed-in account lacks Directory.Read.All."
                        : "Try clearing some chips or the search term.", size: "compact" })) }),
            principals
                .filter((p) => expanded.has(p.id))
                .map((p) => {
                var _a, _b;
                return (React.createElement(ExpandedAssignmentDetail, { key: `exp-${p.id}`, principal: p, tenantId: tenantId, signalLift: (_a = signalLiftById.get(p.id)) !== null && _a !== void 0 ? _a : 0, auditEvents: (_b = auditEventsByTarget.get(p.id)) !== null && _b !== void 0 ? _b : [], isWatched: watchlistIds.has(p.id), onAddToWatchlist: onAddToWatchlist, onRemoveFromWatchlist: onRemoveFromWatchlist }));
            }))));
};
const ExpandedAssignmentDetail = React.memo(({ principal, tenantId, signalLift = 0, auditEvents = [], isWatched = false, onAddToWatchlist, onRemoveFromWatchlist, }) => {
    // Most-recent first, then cap at 8 — the timeline is meant to give
    // immediate context, not a full audit dump (that lives on the
    // audit-log page).
    const recentEvents = React.useMemo(() => auditEvents
        .slice()
        .sort((a, b) => new Date(b.timestamp).getTime() -
        new Date(a.timestamp).getTime())
        .slice(0, 8), [auditEvents]);
    return (React.createElement("div", { className: "mt-2 rounded-md border border-dashed border-border bg-muted/30 p-3", role: "region", "aria-label": `Assignment detail for ${principal.displayName}` },
        React.createElement("div", { className: "mb-2 flex flex-wrap items-center justify-between gap-2 text-2xs" },
            React.createElement("div", { className: "flex items-center gap-2" },
                React.createElement("span", { className: "font-semibold uppercase tracking-wider text-muted-foreground" }, "Every role this principal holds"),
                React.createElement("span", { className: cn("rounded px-1.5 py-0.5 tabular-nums text-3xs", signalLift > 0
                        ? "bg-warning/15 text-warning"
                        : "bg-muted text-muted-foreground"), title: signalLift > 0
                        ? `Risk ${riskScore(principal, signalLift).toLocaleString()} = base ${riskScore(principal).toLocaleString()} + corpus-signal lift ${signalLift.toLocaleString()}.`
                        : "Composite risk score (see Risk column tooltip)" },
                    "risk ",
                    riskScore(principal, signalLift).toLocaleString()),
                isWatched && (React.createElement(Badge, { variant: "warning", title: "On Tier-0 Watchlist \u2014 drift between probes will be flagged." }, "Watched"))),
            React.createElement("div", { className: "flex items-center gap-2" },
                onAddToWatchlist && onRemoveFromWatchlist && (React.createElement("button", { type: "button", onClick: () => isWatched
                        ? onRemoveFromWatchlist(principal.id)
                        : onAddToWatchlist(principal), className: "inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 text-3xs text-muted-foreground hover:border-warning/40 hover:text-warning" },
                    React.createElement(Sparkles, { className: cn("h-2.5 w-2.5", isWatched && "fill-warning/30 text-warning"), "aria-hidden": true }),
                    isWatched ? "Unwatch" : "Watch")),
                React.createElement("a", { href: portalDeepLink(tenantId, principal), target: "_blank", rel: "noopener noreferrer", className: "inline-flex items-center gap-1 text-info hover:underline", "aria-label": `Open ${principal.displayName} in the Entra portal` },
                    "Open in Entra ",
                    React.createElement(ExternalLink, { className: "h-3 w-3", "aria-hidden": true })))),
        React.createElement("ul", { className: "flex flex-col gap-1.5" }, principal.assignments.map((a) => {
            var _a;
            return (React.createElement("li", { key: `${a.roleId}::${a.path}::${(_a = a.viaGroupId) !== null && _a !== void 0 ? _a : ""}`, className: "group/copy flex flex-wrap items-center gap-2 text-2xs" },
                React.createElement(TierBadge, { tier: a.tier, compact: true }),
                React.createElement("span", { className: "font-medium text-foreground" }, a.roleDisplayName),
                React.createElement(PathBadge, { path: a.path }),
                a.viaGroupName && (React.createElement("span", { className: "text-muted-foreground" },
                    "via",
                    " ",
                    React.createElement("span", { className: "font-mono" }, a.viaGroupName))),
                React.createElement("span", { className: "ml-auto inline-flex items-center gap-1 font-mono text-3xs text-muted-foreground/70" },
                    a.roleTemplateId.slice(0, 8),
                    "\u2026",
                    React.createElement(CopyButton, { value: a.roleTemplateId }),
                    React.createElement("a", { href: roleDeepLink(tenantId, a.roleId), target: "_blank", rel: "noopener noreferrer", className: "inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground", title: "Open role assignments in the Entra portal", "aria-label": `Open ${a.roleDisplayName} in the Entra portal` },
                        React.createElement(ExternalLink, { className: "h-2.5 w-2.5", "aria-hidden": true })))));
        })),
        recentEvents.length > 0 && (React.createElement("div", { className: "mt-3 border-t border-dashed border-border pt-2" },
            React.createElement("p", { className: "m-0 mb-1 text-3xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Recent actions on this principal"),
            React.createElement("ol", { className: "flex flex-col gap-0.5" }, recentEvents.map((e) => (React.createElement("li", { key: e.id, className: "flex flex-wrap items-center gap-1.5 text-3xs text-muted-foreground" },
                React.createElement("span", { className: "tabular-nums" }, formatRelativeTime(e.timestamp)),
                React.createElement("span", { "aria-hidden": true }, "\u00B7"),
                React.createElement("span", { className: "font-mono" }, e.action.replace(PRIVILEGED_AUDIT_ACTION_PREFIX, "")),
                React.createElement("span", { "aria-hidden": true }, "\u00B7"),
                React.createElement("span", null, e.actor),
                React.createElement(Badge, { variant: e.status === "success" ? "outline" : "destructive" }, e.status)))))))));
});
ExpandedAssignmentDetail.displayName = "ExpandedAssignmentDetail";
// ===========================================================================
// Section C: shadow admin paths panel
// ===========================================================================
const SHADOW_EXPORT_COLUMNS = [
    { header: "Principal", accessor: (p) => p.principalDisplayName },
    { header: "Type", accessor: (p) => p.principalType },
    { header: "Sign-in name", accessor: (p) => { var _a; return (_a = p.principalSignInName) !== null && _a !== void 0 ? _a : ""; } },
    { header: "Via", accessor: (p) => p.via },
    { header: "Role", accessor: (p) => p.roleDisplayName },
    { header: "Tier", accessor: (p) => TIER_META[p.tier].label },
];
const ShadowAdminPathsPanel = ({ paths, privilegedRoleAdmins, loading }) => {
    return (React.createElement(Card, null,
        React.createElement(CardHeader, { className: "flex flex-row flex-wrap items-end justify-between gap-2 space-y-0" },
            React.createElement("div", { className: "min-w-0" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Sparkles, { className: "h-4 w-4 text-warning" }),
                    " Shadow admin paths",
                    React.createElement(InfoTooltip, { content: "Escalation routes that the Azure portal's 'Roles & administrators' blade hides \u2014 group-mediated memberships, service-principal assignments, and cross-tenant guest privileges." })),
                React.createElement(CardDescription, null, paths.length === 0
                    ? "No shadow-admin paths detected."
                    : `${paths.length} escalation path${paths.length === 1 ? "" : "s"} detected.`)),
            React.createElement(ExportMenu, { rows: paths, columns: SHADOW_EXPORT_COLUMNS, filename: "privileged-audit-shadow-paths" })),
        React.createElement(CardContent, { className: "flex flex-col gap-3" },
            privilegedRoleAdmins.length > 0 && (React.createElement(Alert, { variant: "destructive" },
                React.createElement(ShieldAlert, { className: "h-4 w-4" }),
                React.createElement(AlertTitle, null,
                    privilegedRoleAdmins.length,
                    " Privileged Role Administrator",
                    privilegedRoleAdmins.length === 1 ? "" : "s"),
                React.createElement(AlertDescription, null,
                    React.createElement("p", { className: "m-0" }, "Holders of this role can grant Global Administrator to any principal \u2014 including themselves. They are functionally equivalent to Global Admins even when not listed as such."),
                    React.createElement("ul", { className: "mt-1 list-disc pl-5" },
                        privilegedRoleAdmins.slice(0, 10).map((p) => (React.createElement("li", { key: p.id, className: "text-xs" },
                            p.displayName,
                            p.signInName && (React.createElement("span", { className: "ml-1 font-mono text-2xs opacity-70" },
                                "(",
                                p.signInName,
                                ")"))))),
                        privilegedRoleAdmins.length > 10 && (React.createElement("li", null,
                            "+ ",
                            privilegedRoleAdmins.length - 10,
                            " more\u2026")))))),
            loading ? (React.createElement(Skeleton, { className: "h-12 w-full" })) : paths.length === 0 ? (React.createElement(EmptyState, { icon: ShieldCheck, title: "No shadow admin paths", description: "Every privileged assignment in this tenant is a direct user assignment, with no group mediation, service principals, or guest holders. This is the strictest possible configuration.", size: "compact" })) : (React.createElement("ol", { className: "flex flex-col gap-1.5" },
                paths.slice(0, 50).map((p) => (React.createElement("li", { key: p.id, className: cn("flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs", p.tier === "tier0"
                        ? "border-destructive/40 bg-destructive/5"
                        : p.tier === "tier1"
                            ? "border-warning/40 bg-warning/5"
                            : "border-border bg-card") },
                    React.createElement("span", { className: "font-medium text-foreground" }, p.principalDisplayName),
                    React.createElement("span", { className: "text-muted-foreground" }, "\u2192"),
                    React.createElement("span", { className: "text-muted-foreground" }, p.via),
                    React.createElement("span", { className: "text-muted-foreground" }, "\u2192"),
                    React.createElement("span", { className: "font-medium text-foreground" }, p.roleDisplayName),
                    React.createElement(TierBadge, { tier: p.tier, compact: true })))),
                paths.length > 50 && (React.createElement("li", { className: "px-3 py-1 text-2xs text-muted-foreground" },
                    "+ ",
                    paths.length - 50,
                    " more path",
                    paths.length - 50 === 1 ? "" : "s",
                    " (export for full list)")))))));
};
// ===========================================================================
// Section D: groups holding privileged roles
// ===========================================================================
const GROUP_EXPORT_COLUMNS = [
    { header: "Group", accessor: (g) => g.displayName },
    { header: "Group id", accessor: (g) => g.id },
    { header: "Top tier", accessor: (g) => TIER_META[g.topTier].label },
    {
        header: "Roles",
        accessor: (g) => g.roles.map((r) => r.roleDisplayName).join("; "),
    },
    { header: "Transitive users", accessor: (g) => g.transitiveUserCount },
    { header: "Transitive members", accessor: (g) => g.transitiveTotalCount },
    {
        header: "High blast radius",
        accessor: (g) => isHighBlastRadiusGroup(g, HIGH_BLAST_RADIUS_THRESHOLD) ? "yes" : "no",
    },
];
const GroupsHoldingRolesCard = ({ groups, loading }) => {
    const [expanded, setExpanded] = React.useState(() => new Set());
    const toggle = (id) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    };
    return (React.createElement(Card, null,
        React.createElement(CardHeader, { className: "flex flex-row flex-wrap items-end justify-between gap-2 space-y-0" },
            React.createElement("div", { className: "min-w-0" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Users, { className: "h-4 w-4 text-warning" }),
                    " Groups holding privileged roles",
                    React.createElement(InfoTooltip, { content: "Groups that directly hold one or more directory roles. Every transitive user member inherits the role \u2014 they appear as 'via group X' in section B." })),
                React.createElement(CardDescription, null,
                    groups.length,
                    " group",
                    groups.length === 1 ? "" : "s",
                    " hold a directory role.")),
            React.createElement(ExportMenu, { rows: groups, columns: GROUP_EXPORT_COLUMNS, filename: "privileged-audit-groups" })),
        React.createElement(CardContent, null, loading ? (React.createElement(Skeleton, { className: "h-12 w-full" })) : groups.length === 0 ? (React.createElement(EmptyState, { icon: Users, title: "No groups hold a directory role", description: "All privileged assignments in this tenant are made directly to users or service principals \u2014 there is no group-mediated path to investigate.", size: "compact" })) : (React.createElement("ul", { className: "flex flex-col gap-2" }, groups.map((g) => {
            const high = isHighBlastRadiusGroup(g, HIGH_BLAST_RADIUS_THRESHOLD);
            const isOpen = expanded.has(g.id);
            return (React.createElement("li", { key: g.id, className: cn("rounded-md border bg-card", high
                    ? "border-destructive/40 ring-1 ring-destructive/20"
                    : "border-border") },
                React.createElement("button", { type: "button", onClick: () => toggle(g.id), "aria-expanded": isOpen, className: "flex w-full items-center gap-2 px-3 py-2 text-left text-2xs hover:bg-muted/30" },
                    isOpen ? (React.createElement(ChevronDown, { className: "h-3 w-3 shrink-0" })) : (React.createElement(ChevronRight, { className: "h-3 w-3 shrink-0" })),
                    React.createElement("span", { className: "min-w-0 flex-1 truncate font-medium text-foreground" }, g.displayName),
                    React.createElement(TierBadge, { tier: g.topTier, compact: true }),
                    React.createElement(Badge, { variant: "outline" },
                        g.transitiveUserCount,
                        " user",
                        g.transitiveUserCount === 1 ? "" : "s"),
                    high && (React.createElement(Badge, { variant: "destructive" }, "High blast radius"))),
                isOpen && (React.createElement("div", { className: "border-t border-border bg-muted/20 px-3 py-2 text-2xs" },
                    React.createElement("p", { className: "m-0 mb-1 text-muted-foreground" },
                        "Roles held:",
                        " ",
                        g.roles.map((r) => r.roleDisplayName).join(", ")),
                    React.createElement("p", { className: "m-0 text-muted-foreground" },
                        "Transitive members: ",
                        g.transitiveTotalCount,
                        " total (",
                        g.transitiveUserCount,
                        " user",
                        g.transitiveUserCount === 1 ? "" : "s",
                        ")"),
                    g.transitiveMemberIds.length > 0 && (React.createElement("div", { className: "mt-1 flex flex-wrap gap-1" },
                        g.transitiveMemberIds.slice(0, 20).map((id) => (React.createElement("span", { key: id, className: "rounded bg-card px-1.5 py-0.5 font-mono text-3xs text-muted-foreground" },
                            id.slice(0, 8),
                            "\u2026"))),
                        g.transitiveMemberIds.length > 20 && (React.createElement("span", { className: "text-3xs text-muted-foreground" },
                            "+ ",
                            g.transitiveMemberIds.length - 20,
                            " more"))))))));
        }))))));
};
// ===========================================================================
// Section E: service principals with privileged roles
// ===========================================================================
const SP_EXPORT_COLUMNS = [
    { header: "Display name", accessor: (p) => p.displayName },
    { header: "Object id", accessor: (p) => p.id },
    { header: "App id / sign-in", accessor: (p) => { var _a; return (_a = p.signInName) !== null && _a !== void 0 ? _a : ""; } },
    { header: "Top tier", accessor: (p) => TIER_META[p.topTier].label },
    {
        header: "Roles",
        accessor: (p) => Array.from(new Set(p.assignments.map((a) => a.roleDisplayName))).join("; "),
    },
    { header: "Created", accessor: (p) => { var _a; return (_a = p.createdDateTime) !== null && _a !== void 0 ? _a : ""; } },
];
const ServicePrincipalsCard = ({ sps, loading }) => {
    const isFresh = (iso) => {
        if (!iso)
            return false;
        const ms = Date.now() - new Date(iso).getTime();
        return ms < RECENT_SP_WINDOW_MS;
    };
    return (React.createElement(Card, null,
        React.createElement(CardHeader, { className: "flex flex-row flex-wrap items-end justify-between gap-2 space-y-0" },
            React.createElement("div", { className: "min-w-0" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(KeyRound, { className: "h-4 w-4 text-info" }),
                    " Service principals with privileged roles",
                    React.createElement(InfoTooltip, { content: "Workload identities (apps, managed identities, third-party SPNs) that hold a directory role. SkyArk flags recently-created SPs with Tier 0 roles as suspicious 'fresh implants'." })),
                React.createElement(CardDescription, null,
                    sps.length,
                    " service principal",
                    sps.length === 1 ? "" : "s",
                    " hold a directory role.")),
            React.createElement(ExportMenu, { rows: sps, columns: SP_EXPORT_COLUMNS, filename: "privileged-audit-sps" })),
        React.createElement(CardContent, null, loading ? (React.createElement(Skeleton, { className: "h-12 w-full" })) : sps.length === 0 ? (React.createElement(EmptyState, { icon: KeyRound, title: "No service principals hold directory roles", description: "Every directory role in this tenant is assigned to a human identity. This is the recommended configuration for tenants without workload automation.", size: "compact" })) : (React.createElement("ul", { className: "flex flex-col gap-1.5" }, sps.map((p) => {
            const fresh = isFresh(p.createdDateTime);
            const suspicious = fresh && p.topTier === "tier0";
            return (React.createElement("li", { key: p.id, className: cn("flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs", suspicious
                    ? "border-destructive/40 bg-destructive/5"
                    : "border-border bg-card") },
                React.createElement("span", { className: "min-w-0 flex-1 truncate font-medium text-foreground" }, p.displayName),
                React.createElement(TierBadge, { tier: p.topTier, compact: true }),
                p.signInName && (React.createElement("span", { className: "font-mono text-3xs text-muted-foreground" }, p.signInName)),
                p.createdDateTime && (React.createElement("span", { className: cn("text-3xs", fresh ? "text-warning" : "text-muted-foreground") },
                    "Created ",
                    formatRelativeTime(p.createdDateTime))),
                suspicious && (React.createElement(Badge, { variant: "destructive" }, "Recent + Tier 0 \u2014 investigate"))));
        }))))));
};
// ===========================================================================
// Corpus Detection Signals (A/B/C/D) — defensive read-only enumeration.
//
// EVERY finding category below is sourced from the corpus playbooks at
//   C:\Users\baimgprodsesa1\Desktop\New folder\_*.md
// and represents a drift-from-baseline indicator on the operator's OWN
// tenant. None of the cards or rows here invoke offensive primitives —
// the wiring is purely "GET → render → grade severity → sort up the matrix".
// ===========================================================================
const SeverityBadge = ({ severity, }) => {
    const meta = SEVERITY_META[severity];
    return (React.createElement(Badge, { variant: meta.badgeVariant, title: meta.description }, meta.label));
};
const SIGNAL_A_EXPORT_COLUMNS = [
    { header: "SP display name", accessor: (f) => f.servicePrincipalDisplayName },
    { header: "SP object id", accessor: (f) => f.servicePrincipalId },
    { header: "App id", accessor: (f) => { var _a; return (_a = f.appId) !== null && _a !== void 0 ? _a : ""; } },
    { header: "Sign-in audience", accessor: (f) => { var _a; return (_a = f.signInAudience) !== null && _a !== void 0 ? _a : ""; } },
    {
        header: "Permissions",
        accessor: (f) => f.permissions.map((p) => p.permissionName).join("; "),
    },
    { header: "Password credentials", accessor: (f) => f.passwordCredentialCount },
    { header: "Key credentials", accessor: (f) => f.keyCredentialCount },
    {
        header: "Recent credential",
        accessor: (f) => (f.hasRecentCredential ? "yes" : "no"),
    },
    {
        header: "Most recent credential at",
        accessor: (f) => { var _a; return (_a = f.mostRecentCredentialAt) !== null && _a !== void 0 ? _a : ""; },
    },
    {
        header: "Severity",
        accessor: (f) => SEVERITY_META[gradeHighPrivGraphPermission(f)].label,
    },
];
const SIGNAL_B_EXPORT_COLUMNS = [
    { header: "SP display name", accessor: (f) => f.servicePrincipalDisplayName },
    { header: "SP object id", accessor: (f) => f.servicePrincipalId },
    { header: "Federated credential name", accessor: (f) => f.name },
    { header: "Issuer", accessor: (f) => f.issuer },
    { header: "Subject", accessor: (f) => f.subject },
    { header: "Audiences", accessor: (f) => f.audiences.join("; ") },
    {
        header: "Public issuer",
        accessor: (f) => (f.isPublicIssuer ? "yes" : "no"),
    },
];
const SIGNAL_C_EXPORT_COLUMNS = [
    { header: "Principal", accessor: (f) => { var _a; return (_a = f.principalDisplayName) !== null && _a !== void 0 ? _a : f.principalId; } },
    { header: "Principal id", accessor: (f) => f.principalId },
    { header: "Principal type", accessor: (f) => f.principalType },
    { header: "Sign-in name", accessor: (f) => { var _a; return (_a = f.principalSignInName) !== null && _a !== void 0 ? _a : ""; } },
    { header: "Role", accessor: (f) => { var _a; return (_a = f.roleDisplayName) !== null && _a !== void 0 ? _a : f.roleTemplateId; } },
    { header: "Role template id", accessor: (f) => f.roleTemplateId },
    { header: "Tier", accessor: (f) => TIER_META[f.tier].label },
    { header: "Expiration kind", accessor: (f) => f.expirationKind },
    { header: "End date", accessor: (f) => { var _a; return (_a = f.endDateTime) !== null && _a !== void 0 ? _a : ""; } },
    { header: "Duration", accessor: (f) => { var _a; return (_a = f.duration) !== null && _a !== void 0 ? _a : ""; } },
    { header: "Created", accessor: (f) => { var _a; return (_a = f.createdDateTime) !== null && _a !== void 0 ? _a : ""; } },
    {
        header: "Critical time bomb",
        accessor: (f) => (f.isCriticalTimeBomb ? "yes" : "no"),
    },
    {
        header: "Severity",
        accessor: (f) => SEVERITY_META[gradePimEligibility(f)].label,
    },
];
const SIGNAL_D_EXPORT_COLUMNS = [
    { header: "User", accessor: (f) => f.userDisplayName },
    { header: "User id", accessor: (f) => f.userId },
    { header: "UPN", accessor: (f) => { var _a; return (_a = f.userPrincipalName) !== null && _a !== void 0 ? _a : ""; } },
    { header: "User tier", accessor: (f) => TIER_META[f.userTier].label },
    { header: "TAP id", accessor: (f) => f.tapId },
    { header: "Issued at", accessor: (f) => { var _a; return (_a = f.startDateTime) !== null && _a !== void 0 ? _a : ""; } },
    {
        header: "Lifetime minutes",
        accessor: (f) => { var _a; return (_a = f.lifetimeInMinutes) !== null && _a !== void 0 ? _a : ""; },
    },
    { header: "Usable", accessor: (f) => (f.isUsable ? "yes" : "no") },
    {
        header: "Usability reason",
        accessor: (f) => { var _a; return (_a = f.methodUsabilityReason) !== null && _a !== void 0 ? _a : ""; },
    },
    {
        header: "Recent to Tier 0/1",
        accessor: (f) => (f.isRecentToTierZero ? "yes" : "no"),
    },
    {
        header: "Severity",
        accessor: (f) => SEVERITY_META[gradeTapIssuance(f)].label,
    },
];
const CorpusDetectionSignalsCard = ({ dataset, loading }) => {
    const { highPrivGraphPermissions, federatedCredentials, pimEligibilities, tapIssuances, syncAccountFindings, pimGroupEligibilities, mixedChainFindings, } = dataset;
    const total = highPrivGraphPermissions.length +
        federatedCredentials.length +
        pimEligibilities.length +
        tapIssuances.length +
        syncAccountFindings.filter((f) => f.hasDriftRole).length +
        pimGroupEligibilities.length +
        mixedChainFindings.length;
    // Per-signal severity tallies for the top stat row.
    const criticalCount = React.useMemo(() => {
        let n = 0;
        for (const f of highPrivGraphPermissions)
            if (gradeHighPrivGraphPermission(f) === "critical")
                n++;
        const recentCredSet = new Set(highPrivGraphPermissions
            .filter((f) => f.hasRecentCredential)
            .map((f) => f.servicePrincipalId));
        for (const f of federatedCredentials)
            if (gradeFederatedCredential(f, recentCredSet.has(f.servicePrincipalId)) === "critical")
                n++;
        for (const f of pimEligibilities)
            if (gradePimEligibility(f) === "critical")
                n++;
        for (const f of tapIssuances)
            if (gradeTapIssuance(f) === "critical")
                n++;
        for (const f of syncAccountFindings)
            if (gradeSyncAccount(f) === "critical")
                n++;
        for (const f of pimGroupEligibilities)
            if (gradePimGroupEligibility(f) === "critical")
                n++;
        for (const f of mixedChainFindings)
            if (f.severity === "critical")
                n++;
        return n;
    }, [
        highPrivGraphPermissions,
        federatedCredentials,
        pimEligibilities,
        tapIssuances,
        syncAccountFindings,
        pimGroupEligibilities,
        mixedChainFindings,
    ]);
    return (React.createElement(Card, { "aria-labelledby": "corpus-signals-title" },
        React.createElement(CardHeader, { className: "space-y-1" },
            React.createElement(CardTitle, { id: "corpus-signals-title", className: "flex items-center gap-2 text-sm" },
                React.createElement(ShieldAlert, { className: "h-4 w-4 text-destructive" }),
                "Corpus detection signals",
                React.createElement(InfoTooltip, { content: "Seven drift-from-baseline indicators sourced from the cross-tool offensive playbooks. Read-only enumeration only \u2014 every row is a GET against the operator's own tenant. Severity grading mirrors the corpus' own risk framing." })),
            React.createElement(CardDescription, null,
                total,
                " indicator",
                total === 1 ? "" : "s",
                " surfaced",
                criticalCount > 0 && (React.createElement(React.Fragment, null,
                    ", ",
                    React.createElement("span", { className: "font-semibold text-destructive" },
                        criticalCount,
                        " critical"))),
                ". See",
                " ",
                React.createElement("code", { className: "text-3xs" }, "_AZURE_BYPASS_PLAYBOOK.md"),
                " ",
                "\u00A7\"Critical Defender Audit Surface\".")),
        React.createElement(CardContent, { className: "flex flex-col gap-4" },
            React.createElement(SignalFPanel, { findings: dataset.mixedChainFindings, loading: loading }),
            React.createElement(SignalAPanel, { findings: highPrivGraphPermissions, loading: loading }),
            React.createElement(SignalBPanel, { findings: federatedCredentials, companionRecentCredSpIds: new Set(highPrivGraphPermissions
                    .filter((f) => f.hasRecentCredential)
                    .map((f) => f.servicePrincipalId)), loading: loading }),
            React.createElement(SignalCPanel, { findings: pimEligibilities, loading: loading }),
            React.createElement(SignalGPanel, { findings: dataset.pimGroupEligibilities, loading: loading }),
            React.createElement(SignalDPanel, { findings: tapIssuances, loading: loading }),
            React.createElement(SignalEPanel, { findings: dataset.syncAccountFindings, loading: loading }))));
};
// ---- Signal A panel ------------------------------------------------------
const SignalAPanel = ({ findings, loading }) => (React.createElement("section", { className: "rounded-md border border-border bg-card/40 p-3", "aria-labelledby": "signal-a-title" },
    React.createElement("header", { className: "mb-2 flex flex-wrap items-center gap-2" },
        React.createElement(Sparkles, { className: "h-3.5 w-3.5 text-warning", "aria-hidden": true }),
        React.createElement("h3", { id: "signal-a-title", className: "text-2xs font-semibold uppercase tracking-wider" }, "Signal A \u2014 High-privilege Graph permissions on a service principal"),
        React.createElement(InfoTooltip, { content: "Citation: _bypass_role_grant.md \u00A73.1 (canonical chain \u2014 Application.ReadWrite.All \u2192 addKey on Microsoft Graph SP \u2192 app-only Global Admin). Any SP holding Application.ReadWrite.All, RoleManagement.ReadWrite.Directory, AppRoleAssignment.ReadWrite.All, Directory.ReadWrite.All, or Domain.ReadWrite.All is a one-step path to GA." }),
        React.createElement("span", { className: "ml-auto" },
            React.createElement(ExportMenu, { rows: findings, columns: SIGNAL_A_EXPORT_COLUMNS, filename: "privileged-audit-signal-a-graph-perms" }))),
    loading ? (React.createElement(Skeleton, { className: "h-12 w-full" })) : findings.length === 0 ? (React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" }, "No service principals hold the Top-30 Graph escalation permissions. This is the safe baseline.")) : (React.createElement("ul", { className: "flex flex-col gap-1.5" },
        findings.slice(0, 25).map((f) => {
            const sev = gradeHighPrivGraphPermission(f);
            return (React.createElement("li", { key: f.id, className: cn("flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs", sev === "critical"
                    ? "border-destructive/50 bg-destructive/5"
                    : sev === "high"
                        ? "border-warning/40 bg-warning/5"
                        : "border-border bg-card") },
                React.createElement(SeverityBadge, { severity: sev }),
                React.createElement("span", { className: "min-w-0 flex-1 truncate font-medium text-foreground" }, f.servicePrincipalDisplayName),
                React.createElement("div", { className: "flex flex-wrap gap-1" }, f.permissions.map((p) => (React.createElement(Badge, { key: p.appRoleId, variant: "warning", title: p.permissionName }, p.permissionName)))),
                React.createElement(Badge, { variant: "outline", title: "passwordCredentials + keyCredentials" },
                    f.passwordCredentialCount + f.keyCredentialCount,
                    " cred",
                    f.passwordCredentialCount + f.keyCredentialCount === 1 ? "" : "s"),
                f.hasRecentCredential && f.mostRecentCredentialAt && (React.createElement(Badge, { variant: "destructive", title: `Most recent credential at ${f.mostRecentCredentialAt}. Audit item #5 — addKey / addPassword detection.` },
                    "New cred ",
                    formatRelativeTime(f.mostRecentCredentialAt))),
                f.appId && (React.createElement("span", { className: "font-mono text-3xs text-muted-foreground" }, f.appId))));
        }),
        findings.length > 25 && (React.createElement("li", { className: "px-3 py-1 text-2xs text-muted-foreground" },
            "+ ",
            findings.length - 25,
            " more (export for full list)"))))));
// ---- Signal B panel ------------------------------------------------------
const SignalBPanel = ({ findings, companionRecentCredSpIds, loading }) => (React.createElement("section", { className: "rounded-md border border-border bg-card/40 p-3", "aria-labelledby": "signal-b-title" },
    React.createElement("header", { className: "mb-2 flex flex-wrap items-center gap-2" },
        React.createElement(GitBranch, { className: "h-3.5 w-3.5 text-warning", "aria-hidden": true }),
        React.createElement("h3", { id: "signal-b-title", className: "text-2xs font-semibold uppercase tracking-wider" }, "Signal B \u2014 Federated identity credentials on privileged service principals"),
        React.createElement(InfoTooltip, { content: "Citation: _bypass_role_grant.md \u00A76 (Workload Identity Federation as role-grant bypass) + _AZURE_BYPASS_PLAYBOOK.md Top-30 #17. Any federated credential whose issuer is a public OIDC issuer (GitHub Actions, GitLab, CircleCI) on a high-privilege SP is a backdoor \u2014 anyone who controls that pipeline mints SP tokens." }),
        React.createElement("span", { className: "ml-auto" },
            React.createElement(ExportMenu, { rows: findings, columns: SIGNAL_B_EXPORT_COLUMNS, filename: "privileged-audit-signal-b-fed-creds" }))),
    loading ? (React.createElement(Skeleton, { className: "h-12 w-full" })) : findings.length === 0 ? (React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" },
        "No federated credentials on the high-privilege SPs from Signal A. If your privileged SPs use WIF, ensure the signed-in account has",
        " ",
        React.createElement("code", { className: "text-3xs" }, "Application.Read.All"),
        " to enumerate",
        " ",
        React.createElement("code", { className: "text-3xs" }, "/applications/{id}/federatedIdentityCredentials"),
        ".")) : (React.createElement("ul", { className: "flex flex-col gap-1.5" },
        findings.slice(0, 25).map((f) => {
            const sev = gradeFederatedCredential(f, companionRecentCredSpIds.has(f.servicePrincipalId));
            return (React.createElement("li", { key: f.id, className: cn("flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs", sev === "critical"
                    ? "border-destructive/50 bg-destructive/5"
                    : sev === "high"
                        ? "border-warning/40 bg-warning/5"
                        : "border-border bg-card") },
                React.createElement(SeverityBadge, { severity: sev }),
                React.createElement("span", { className: "min-w-0 flex-1 truncate font-medium text-foreground" }, f.servicePrincipalDisplayName),
                React.createElement("span", { className: "font-mono text-3xs text-muted-foreground" }, f.name),
                f.isPublicIssuer && (React.createElement(Badge, { variant: "destructive", title: "Issuer is a public OIDC provider \u2014 anyone controlling that pipeline can mint tokens for this SP." }, "Public issuer")),
                React.createElement("span", { className: "font-mono text-3xs text-muted-foreground", title: `issuer: ${f.issuer}` }, f.issuer),
                React.createElement("span", { className: "font-mono text-3xs text-muted-foreground", title: `subject: ${f.subject}` }, f.subject.length > 64 ? f.subject.slice(0, 61) + "…" : f.subject)));
        }),
        findings.length > 25 && (React.createElement("li", { className: "px-3 py-1 text-2xs text-muted-foreground" },
            "+ ",
            findings.length - 25,
            " more (export for full list)"))))));
// ---- Signal C panel ------------------------------------------------------
const SignalCPanel = ({ findings, loading }) => (React.createElement("section", { className: "rounded-md border border-border bg-card/40 p-3", "aria-labelledby": "signal-c-title" },
    React.createElement("header", { className: "mb-2 flex flex-wrap items-center gap-2" },
        React.createElement(Bomb, { className: "h-3.5 w-3.5 text-destructive", "aria-hidden": true }),
        React.createElement("h3", { id: "signal-c-title", className: "text-2xs font-semibold uppercase tracking-wider" }, "Signal C \u2014 PIM eligibility with no expiration"),
        React.createElement(InfoTooltip, { content: "Citation: _bypass_staged_pim.md \u00A75.1 'The time bomb' + Top-30 #27. Attacker briefly compromises Privileged Role Administrator, plants eligibility for attacker user with scheduleInfo.expiration.type = noExpiration, then PRA compromise is remediated \u2014 eligibility persists. Activation comes weeks later when nobody is watching." }),
        React.createElement("span", { className: "ml-auto" },
            React.createElement(ExportMenu, { rows: findings, columns: SIGNAL_C_EXPORT_COLUMNS, filename: "privileged-audit-signal-c-pim-eligibility" }))),
    loading ? (React.createElement(Skeleton, { className: "h-12 w-full" })) : findings.length === 0 ? (React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" },
        "No PIM eligibility schedules detected. If your tenant uses PIM, ensure",
        " ",
        React.createElement("code", { className: "text-3xs" }, "RoleManagement.Read.Directory"),
        " is granted so this signal can fire.")) : (React.createElement("ul", { className: "flex flex-col gap-1.5" },
        findings.slice(0, 25).map((f) => {
            var _a, _b, _c, _d, _e, _f, _g;
            const sev = gradePimEligibility(f);
            return (React.createElement("li", { key: f.id, className: cn("flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs", f.isCriticalTimeBomb
                    ? "border-destructive/50 bg-destructive/5"
                    : sev === "high"
                        ? "border-warning/40 bg-warning/5"
                        : "border-border bg-card") },
                React.createElement(SeverityBadge, { severity: sev }),
                React.createElement("span", { className: "min-w-0 flex-1 truncate font-medium text-foreground" }, (_a = f.principalDisplayName) !== null && _a !== void 0 ? _a : f.principalId),
                f.principalSignInName && (React.createElement("span", { className: "font-mono text-3xs text-muted-foreground" }, f.principalSignInName)),
                React.createElement(Badge, { variant: "outline" }, f.principalType),
                React.createElement(TierBadge, { tier: f.tier, compact: true }),
                React.createElement("span", { className: "text-2xs text-muted-foreground" }, "eligible for"),
                React.createElement(Badge, { variant: "secondary", title: f.roleTemplateId }, (_b = f.roleDisplayName) !== null && _b !== void 0 ? _b : f.roleTemplateId.slice(0, 8) + "…"),
                React.createElement(Badge, { variant: f.expirationKind === "noExpiration" ? "destructive" : "outline", title: f.expirationKind === "noExpiration"
                        ? "noExpiration matches the corpus 'time bomb' pattern."
                        : f.expirationKind === "afterDateTime"
                            ? `Until ${(_c = f.endDateTime) !== null && _c !== void 0 ? _c : "?"}`
                            : f.expirationKind === "afterDuration"
                                ? `Duration ${(_d = f.duration) !== null && _d !== void 0 ? _d : "?"}`
                                : "Unknown expiration shape" }, f.expirationKind === "noExpiration"
                    ? "noExpiration"
                    : f.expirationKind === "afterDateTime"
                        ? `until ${(_f = (_e = f.endDateTime) === null || _e === void 0 ? void 0 : _e.slice(0, 10)) !== null && _f !== void 0 ? _f : "?"}`
                        : f.expirationKind === "afterDuration"
                            ? (_g = f.duration) !== null && _g !== void 0 ? _g : "duration"
                            : "?"),
                f.createdDateTime && (React.createElement("span", { className: "font-mono text-3xs text-muted-foreground", title: `Eligibility created ${f.createdDateTime}` },
                    "+",
                    formatRelativeTime(f.createdDateTime)))));
        }),
        findings.length > 25 && (React.createElement("li", { className: "px-3 py-1 text-2xs text-muted-foreground" },
            "+ ",
            findings.length - 25,
            " more (export for full list)"))))));
// ---- Signal D panel ------------------------------------------------------
const SignalDPanel = ({ findings, loading }) => (React.createElement("section", { className: "rounded-md border border-border bg-card/40 p-3", "aria-labelledby": "signal-d-title" },
    React.createElement("header", { className: "mb-2 flex flex-wrap items-center gap-2" },
        React.createElement(Ticket, { className: "h-3.5 w-3.5 text-warning", "aria-hidden": true }),
        React.createElement("h3", { id: "signal-d-title", className: "text-2xs font-semibold uppercase tracking-wider" }, "Signal D \u2014 Temporary Access Pass on a privileged user"),
        React.createElement(InfoTooltip, { content: "Citation: _AZURE_BYPASS_PLAYBOOK.md 'Critical Defender Audit Surface' #3 + Top-30 #13. Authentication Administrator can issue a TAP which is MFA-equivalent for the holder. A TAP on a Tier-0 user issued within the last 30 days is a critical persistence indicator." }),
        React.createElement("span", { className: "ml-auto" },
            React.createElement(ExportMenu, { rows: findings, columns: SIGNAL_D_EXPORT_COLUMNS, filename: "privileged-audit-signal-d-tap" }))),
    loading ? (React.createElement(Skeleton, { className: "h-12 w-full" })) : findings.length === 0 ? (React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" },
        "No active Temporary Access Pass found on any privileged user. If TAPs are in use in this tenant, ensure the signed-in account has",
        " ",
        React.createElement("code", { className: "text-3xs" }, "UserAuthenticationMethod.Read.All"),
        " ",
        "to enumerate them.")) : (React.createElement("ul", { className: "flex flex-col gap-1.5" },
        findings.slice(0, 25).map((f) => {
            const sev = gradeTapIssuance(f);
            return (React.createElement("li", { key: f.id, className: cn("flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs", sev === "critical"
                    ? "border-destructive/50 bg-destructive/5"
                    : sev === "high"
                        ? "border-warning/40 bg-warning/5"
                        : "border-border bg-card") },
                React.createElement(SeverityBadge, { severity: sev }),
                React.createElement("span", { className: "min-w-0 flex-1 truncate font-medium text-foreground" }, f.userDisplayName),
                f.userPrincipalName && (React.createElement("span", { className: "font-mono text-3xs text-muted-foreground" }, f.userPrincipalName)),
                React.createElement(TierBadge, { tier: f.userTier, compact: true }),
                f.startDateTime && (React.createElement("span", { className: "font-mono text-3xs text-muted-foreground", title: `Issued at ${f.startDateTime}` },
                    "issued ",
                    formatRelativeTime(f.startDateTime))),
                typeof f.lifetimeInMinutes === "number" && (React.createElement(Badge, { variant: "outline" },
                    f.lifetimeInMinutes,
                    " min lifetime")),
                f.isUsable && (React.createElement(Badge, { variant: "warning", title: "The TAP can be redeemed right now." }, "Usable now")),
                f.isRecentToTierZero && (React.createElement(Badge, { variant: "destructive", title: "TAP within RECENT_TAP_WINDOW_MS on a Tier-0/Tier-1 principal \u2014 investigate." }, "Tier-0 + recent")),
                f.methodUsabilityReason && (React.createElement("span", { className: "text-3xs text-muted-foreground" }, f.methodUsabilityReason))));
        }),
        findings.length > 25 && (React.createElement("li", { className: "px-3 py-1 text-2xs text-muted-foreground" },
            "+ ",
            findings.length - 25,
            " more (export for full list)"))))));
// ===========================================================================
// Tier-0 Watchlist card
//
// Persisted, manually-curated set of object ids the operator wants to
// monitor for drift between probes. Surface drift in the same card so the
// alert is impossible to miss — adding an entry without ever seeing drift
// is just a noisier inventory.
// ===========================================================================
const WATCHLIST_DRIFT_TONE = {
    missing: "destructive",
    "tier-up": "destructive",
    "role-removed": "warning",
    "new-role": "warning",
    "tier-down": "info",
    unchanged: "outline",
};
const Tier0WatchlistCard = ({ watchlist, drift, onRemove }) => {
    // Hide the card entirely when the watchlist is empty — the affordance to
    // ADD lives next to each row in section B so the empty card would just be
    // visual noise on first load.
    if (watchlist.entries.length === 0)
        return null;
    const alertCount = drift.filter((d) => d.kind !== "unchanged").length;
    return (React.createElement(Card, null,
        React.createElement(CardHeader, { className: "flex flex-row flex-wrap items-end justify-between gap-2 space-y-0" },
            React.createElement("div", { className: "min-w-0" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Sparkles, { className: "h-4 w-4 text-warning", "aria-hidden": true }),
                    "Tier-0 Watchlist",
                    React.createElement(InfoTooltip, { content: "Operator-curated principals monitored for drift between probes. Use the bookmark icon next to any row in 'Privileged identities' to add/remove. Drift kinds: principal disappeared, tier escalated, new role gained, role removed." })),
                React.createElement(CardDescription, null,
                    watchlist.entries.length,
                    " watched principal",
                    watchlist.entries.length === 1 ? "" : "s",
                    alertCount > 0 && (React.createElement(React.Fragment, null,
                        ", ",
                        React.createElement("span", { className: "font-semibold text-destructive" },
                            alertCount,
                            " drift alert",
                            alertCount === 1 ? "" : "s"))),
                    "."))),
        React.createElement(CardContent, null,
            React.createElement("ul", { className: "flex flex-col gap-1.5" }, drift.map((d) => {
                var _a, _b;
                return (React.createElement("li", { key: d.entry.principalId, className: cn("flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs", d.kind === "missing" || d.kind === "tier-up"
                        ? "border-destructive/40 bg-destructive/5"
                        : d.kind === "new-role" || d.kind === "role-removed"
                            ? "border-warning/40 bg-warning/5"
                            : d.kind === "tier-down"
                                ? "border-info/40 bg-info/5"
                                : "border-border bg-card") },
                    React.createElement(Badge, { variant: WATCHLIST_DRIFT_TONE[d.kind] }, d.kind === "unchanged" ? "ok" : d.kind),
                    React.createElement("span", { className: "min-w-0 flex-1 truncate font-medium text-foreground" }, d.entry.capturedDisplayName),
                    d.entry.capturedSignInName && (React.createElement("span", { className: "font-mono text-3xs text-muted-foreground" }, d.entry.capturedSignInName)),
                    React.createElement(TierBadge, { tier: (_b = (_a = d.current) === null || _a === void 0 ? void 0 : _a.topTier) !== null && _b !== void 0 ? _b : d.entry.capturedTier, compact: true }),
                    React.createElement("span", { className: "text-muted-foreground" }, d.explanation),
                    d.entry.note && (React.createElement("span", { className: "text-3xs italic text-muted-foreground", title: `Note: ${d.entry.note}` },
                        "\"",
                        d.entry.note,
                        "\"")),
                    React.createElement("span", { className: "font-mono text-3xs text-muted-foreground" },
                        "added ",
                        formatRelativeTime(d.entry.addedAt)),
                    React.createElement("button", { type: "button", onClick: () => onRemove(d.entry.principalId), className: "ml-auto inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive", title: "Remove from watchlist", "aria-label": `Remove ${d.entry.capturedDisplayName} from watchlist` },
                        React.createElement(EyeOff, { className: "h-3 w-3", "aria-hidden": true }))));
            })))));
};
// ===========================================================================
// Signal E panel — AAD Connect / Cloud Sync sync-account drift
// ===========================================================================
const SIGNAL_E_EXPORT_COLUMNS = [
    { header: "Principal", accessor: (f) => f.principalDisplayName },
    { header: "Principal id", accessor: (f) => f.principalId },
    { header: "Type", accessor: (f) => f.principalType },
    { header: "Sign-in name", accessor: (f) => { var _a; return (_a = f.principalSignInName) !== null && _a !== void 0 ? _a : ""; } },
    {
        header: "Roles held",
        accessor: (f) => f.roles.map((r) => `${r.roleDisplayName}${r.isCanonical ? "(canonical)" : ""}`).join("; "),
    },
    { header: "Drift?", accessor: (f) => (f.hasDriftRole ? "yes" : "no") },
    { header: "Top drift tier", accessor: (f) => TIER_META[f.topDriftTier].label },
    { header: "Severity", accessor: (f) => SEVERITY_META[gradeSyncAccount(f)].label },
];
const SignalEPanel = ({ findings, loading }) => {
    const driftFindings = findings.filter((f) => f.hasDriftRole);
    return (React.createElement("section", { className: "rounded-md border border-border bg-card/40 p-3", "aria-labelledby": "signal-e-title" },
        React.createElement("header", { className: "mb-2 flex flex-wrap items-center gap-2" },
            React.createElement(ShieldAlert, { className: "h-3.5 w-3.5 text-destructive", "aria-hidden": true }),
            React.createElement("h3", { id: "signal-e-title", className: "text-2xs font-semibold uppercase tracking-wider" }, "Signal E \u2014 AAD Connect / Cloud Sync sync-account drift"),
            React.createElement(InfoTooltip, { content: "Citation: _AZURE_BYPASS_PLAYBOOK.md Top-30 #19 + _bypass_mixed_chains.md chain #1 + _analysis_dirkjanm.md (adconnectdump). Any principal whose display name matches Sync_*, MSOL_*, ADToAADSyncServiceAccount, or 'On-Premises Directory Synchronization Service Account' is a sync identity. They are expected to hold ONLY the canonical 'Directory Synchronization Accounts' role (template d29b2b05-\u2026). Any other privileged role is drift \u2014 and a compromised sync account is bidirectional forest control per the corpus." }),
            React.createElement("span", { className: "ml-auto" },
                React.createElement(ExportMenu, { rows: findings, columns: SIGNAL_E_EXPORT_COLUMNS, filename: "privileged-audit-signal-e-sync-accounts" }))),
        loading ? (React.createElement(Skeleton, { className: "h-12 w-full" })) : findings.length === 0 ? (React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" },
            "No AAD Connect / Cloud Sync identities detected in this tenant's privileged-role holders. (If you DO use AAD Connect, ensure the sync account's privileged-role membership is enumerable via",
            " ",
            React.createElement("code", { className: "text-3xs" }, "Directory.Read.All"),
            ".)")) : (React.createElement("ul", { className: "flex flex-col gap-1.5" },
            findings.map((f) => {
                const sev = gradeSyncAccount(f);
                return (React.createElement("li", { key: f.id, className: cn("flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs", sev === "critical"
                        ? "border-destructive/50 bg-destructive/5"
                        : sev === "high"
                            ? "border-warning/40 bg-warning/5"
                            : sev === "medium"
                                ? "border-info/40 bg-info/5"
                                : "border-border bg-card") },
                    React.createElement(SeverityBadge, { severity: sev }),
                    React.createElement("span", { className: "min-w-0 flex-1 truncate font-medium text-foreground" }, f.principalDisplayName),
                    f.principalSignInName && (React.createElement("span", { className: "font-mono text-3xs text-muted-foreground" }, f.principalSignInName)),
                    React.createElement(Badge, { variant: "outline" }, f.principalType),
                    React.createElement("div", { className: "flex flex-wrap gap-1" }, f.roles.map((r) => (React.createElement(Badge, { key: r.roleTemplateId, variant: r.isCanonical ? "secondary" : "warning", title: r.isCanonical
                            ? `Canonical sync role — expected on a sync account.`
                            : `Drift role ${TIER_META[r.tier].label} — investigate; sync accounts should hold ONLY the canonical Directory Synchronization Accounts role.` }, r.roleDisplayName)))),
                    f.hasDriftRole && (React.createElement(Badge, { variant: "destructive", title: "Drift detected" },
                        "Drift \u2192 ",
                        TIER_META[f.topDriftTier].label))));
            }),
            driftFindings.length === 0 && findings.length > 0 && (React.createElement("li", { className: "px-3 py-1 text-2xs text-muted-foreground" }, "All sync-shaped principals hold only the canonical sync role \u2014 no drift detected. This is the safe baseline."))))));
};
// ===========================================================================
// Signal F panel — Mixed-chain temporal correlation
// ===========================================================================
const SIGNAL_F_EXPORT_COLUMNS = [
    { header: "Principal", accessor: (f) => f.principalDisplayName },
    { header: "Principal id", accessor: (f) => f.principalId },
    { header: "Type", accessor: (f) => f.principalType },
    { header: "Tier", accessor: (f) => TIER_META[f.principalTier].label },
    { header: "Signals", accessor: (f) => f.indicators.map((i) => i.signal).join(",") },
    {
        header: "Span (hours)",
        accessor: (f) => (f.spanMs / (60 * 60 * 1000)).toFixed(2),
    },
    { header: "Severity", accessor: (f) => SEVERITY_META[f.severity].label },
    {
        header: "Indicators",
        accessor: (f) => f.indicators.map((i) => `${i.signal}@${i.at}:${i.label}`).join(" | "),
    },
];
const SignalFPanel = ({ findings, loading }) => (React.createElement("section", { className: "rounded-md border border-border bg-card/40 p-3", "aria-labelledby": "signal-f-title" },
    React.createElement("header", { className: "mb-2 flex flex-wrap items-center gap-2" },
        React.createElement(Bomb, { className: "h-3.5 w-3.5 text-destructive", "aria-hidden": true }),
        React.createElement("h3", { id: "signal-f-title", className: "text-2xs font-semibold uppercase tracking-wider" }, "Signal F \u2014 Mixed-chain temporal correlation"),
        React.createElement(InfoTooltip, { content: "Citation: _bypass_mixed_chains.md (chain composition is the actual attacker workflow). Fires when \u2265 2 indicators across A/B/C/D/G land on the same principal inside MIXED_CHAIN_WINDOW_MS (24h). One indicator alone is suspicious; two within hours is the kill-chain signature. Critical when \u2265 3 distinct signals or any contributor is critical-graded." }),
        React.createElement("span", { className: "ml-auto" },
            React.createElement(ExportMenu, { rows: findings, columns: SIGNAL_F_EXPORT_COLUMNS, filename: "privileged-audit-signal-f-mixed-chains" }))),
    loading ? (React.createElement(Skeleton, { className: "h-12 w-full" })) : findings.length === 0 ? (React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" },
        "No mixed-chain coincidences detected. Single-signal indicators may still exist below; this card fires only when \u2265 2 of them land on the same principal within ",
        MIXED_CHAIN_WINDOW_MS / (60 * 60 * 1000),
        "h.")) : (React.createElement("ul", { className: "flex flex-col gap-1.5" },
        findings.slice(0, 25).map((f) => (React.createElement("li", { key: f.id, className: cn("flex flex-col gap-1 rounded-md border px-3 py-2 text-2xs", f.severity === "critical"
                ? "border-destructive/50 bg-destructive/5"
                : f.severity === "high"
                    ? "border-warning/40 bg-warning/5"
                    : "border-border bg-card") },
            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                React.createElement(SeverityBadge, { severity: f.severity }),
                React.createElement("span", { className: "min-w-0 flex-1 truncate font-medium text-foreground" }, f.principalDisplayName),
                f.principalSignInName && (React.createElement("span", { className: "font-mono text-3xs text-muted-foreground" }, f.principalSignInName)),
                React.createElement(TierBadge, { tier: f.principalTier, compact: true }),
                React.createElement(Badge, { variant: "warning", title: `Signals ${f.indicators
                        .map((i) => i.signal)
                        .join(" + ")} fired within ${(f.spanMs / (60 * 60 * 1000)).toFixed(1)}h` },
                    f.indicators.map((i) => i.signal).join(" + "),
                    " \u00B7",
                    " ",
                    (f.spanMs / (60 * 60 * 1000)).toFixed(1),
                    "h")),
            React.createElement("ol", { className: "flex flex-wrap gap-x-3 gap-y-0.5 text-3xs text-muted-foreground" }, f.indicators.map((ind, idx) => (React.createElement("li", { key: `${f.id}:ind:${idx}`, className: "flex items-center gap-1" },
                React.createElement("span", { className: "font-mono" },
                    "[",
                    ind.signal,
                    "]"),
                React.createElement("span", null, ind.label),
                React.createElement("span", { "aria-hidden": true }, "\u00B7"),
                React.createElement("span", null, formatRelativeTime(ind.at))))))))),
        findings.length > 25 && (React.createElement("li", { className: "px-3 py-1 text-2xs text-muted-foreground" },
            "+ ",
            findings.length - 25,
            " more chains (export for full list)"))))));
// ===========================================================================
// Signal G panel — PIM-for-Groups eligibility on role-assignable groups
// ===========================================================================
const SIGNAL_G_EXPORT_COLUMNS = [
    {
        header: "Principal",
        accessor: (f) => { var _a; return (_a = f.principalDisplayName) !== null && _a !== void 0 ? _a : f.principalId; },
    },
    { header: "Principal id", accessor: (f) => f.principalId },
    { header: "Principal type", accessor: (f) => f.principalType },
    { header: "Group", accessor: (f) => f.groupDisplayName },
    { header: "Group id", accessor: (f) => f.groupId },
    {
        header: "isAssignableToRole",
        accessor: (f) => (f.isAssignableToRole ? "yes" : "no"),
    },
    {
        header: "Group roles",
        accessor: (f) => f.groupRoles.map((r) => r.roleDisplayName).join("; "),
    },
    { header: "Top tier", accessor: (f) => TIER_META[f.topTier].label },
    { header: "Expiration kind", accessor: (f) => f.expirationKind },
    { header: "End date", accessor: (f) => { var _a; return (_a = f.endDateTime) !== null && _a !== void 0 ? _a : ""; } },
    { header: "Duration", accessor: (f) => { var _a; return (_a = f.duration) !== null && _a !== void 0 ? _a : ""; } },
    { header: "Created", accessor: (f) => { var _a; return (_a = f.createdDateTime) !== null && _a !== void 0 ? _a : ""; } },
    {
        header: "Critical time bomb",
        accessor: (f) => (f.isCriticalTimeBomb ? "yes" : "no"),
    },
    {
        header: "Severity",
        accessor: (f) => SEVERITY_META[gradePimGroupEligibility(f)].label,
    },
];
const SignalGPanel = ({ findings, loading }) => (React.createElement("section", { className: "rounded-md border border-border bg-card/40 p-3", "aria-labelledby": "signal-g-title" },
    React.createElement("header", { className: "mb-2 flex flex-wrap items-center gap-2" },
        React.createElement(GitBranch, { className: "h-3.5 w-3.5 text-warning", "aria-hidden": true }),
        React.createElement("h3", { id: "signal-g-title", className: "text-2xs font-semibold uppercase tracking-wider" }, "Signal G \u2014 PIM-for-Groups eligibility on role-assignable groups"),
        React.createElement(InfoTooltip, { content: "Citation: _bypass_staged_pim.md \u00A76 (PIM for Groups) + _AZURE_BYPASS_PLAYBOOK.md Top-30 #28. Activating PIM-for-Groups eligibility transfers the activator into the group, transitively inheriting any role the group directly holds. The corpus calls this 'three-layer indirection \u2014 breaks most detection logic'. Critical when noExpiration eligibility is held against a group that directly holds a Tier-0 role." }),
        React.createElement("span", { className: "ml-auto" },
            React.createElement(ExportMenu, { rows: findings, columns: SIGNAL_G_EXPORT_COLUMNS, filename: "privileged-audit-signal-g-pim-groups" }))),
    loading ? (React.createElement(Skeleton, { className: "h-12 w-full" })) : findings.length === 0 ? (React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" },
        "No PIM-for-Groups eligibilities detected. (If PIM-for-Groups IS configured, ensure the signed-in account has",
        " ",
        React.createElement("code", { className: "text-3xs" }, "PrivilegedAccess.Read.AzureADGroup"),
        " ",
        "or ",
        React.createElement("code", { className: "text-3xs" }, "RoleManagement.Read.All"),
        ".)")) : (React.createElement("ul", { className: "flex flex-col gap-1.5" },
        findings.slice(0, 25).map((f) => {
            var _a, _b, _c, _d;
            const sev = gradePimGroupEligibility(f);
            return (React.createElement("li", { key: f.id, className: cn("flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs", f.isCriticalTimeBomb
                    ? "border-destructive/50 bg-destructive/5"
                    : sev === "high"
                        ? "border-warning/40 bg-warning/5"
                        : "border-border bg-card") },
                React.createElement(SeverityBadge, { severity: sev }),
                React.createElement("span", { className: "min-w-0 flex-1 truncate font-medium text-foreground" }, (_a = f.principalDisplayName) !== null && _a !== void 0 ? _a : f.principalId),
                f.principalSignInName && (React.createElement("span", { className: "font-mono text-3xs text-muted-foreground" }, f.principalSignInName)),
                React.createElement(Badge, { variant: "outline" }, f.principalType),
                React.createElement("span", { className: "text-2xs text-muted-foreground" }, "eligible for member of"),
                React.createElement(Badge, { variant: "secondary", title: f.groupId }, f.groupDisplayName),
                f.isAssignableToRole && (React.createElement(Badge, { variant: "warning", title: "Group has isAssignableToRole=true \u2014 eligibility on it grants role-assignment-capable membership" }, "role-assignable")),
                f.groupRoles.length > 0 && (React.createElement(TierBadge, { tier: f.topTier, compact: true })),
                React.createElement(Badge, { variant: f.expirationKind === "noExpiration" ? "destructive" : "outline" }, f.expirationKind === "noExpiration"
                    ? "noExpiration"
                    : f.expirationKind === "afterDateTime"
                        ? `until ${(_c = (_b = f.endDateTime) === null || _b === void 0 ? void 0 : _b.slice(0, 10)) !== null && _c !== void 0 ? _c : "?"}`
                        : f.expirationKind === "afterDuration"
                            ? (_d = f.duration) !== null && _d !== void 0 ? _d : "duration"
                            : "?"),
                f.createdDateTime && (React.createElement("span", { className: "font-mono text-3xs text-muted-foreground", title: `Eligibility created ${f.createdDateTime}` },
                    "+",
                    formatRelativeTime(f.createdDateTime)))));
        }),
        findings.length > 25 && (React.createElement("li", { className: "px-3 py-1 text-2xs text-muted-foreground" },
            "+ ",
            findings.length - 25,
            " more (export for full list)"))))));
export default PrivilegedAuditPage;
//# sourceMappingURL=privileged-audit-page.js.map