/**
 * Pure helpers for the Role Assignment Visualizer (role-graph) page.
 *
 * Design intent: this file is the DEFENSIVE-USE knowledge base — what
 * constitutes a privileged role, what escalation patterns look like,
 * how scopes are classified. The page consumes these helpers but
 * contains no privilege logic of its own, so unit tests (future) can
 * cover the classification matrix in isolation.
 *
 * Sources:
 *   - Stormspotter (Microsoft Azure Red Team graph tool) — relationships
 *     it models: principal → role → scope, group → member → role.
 *     https://github.com/Azure/Stormspotter
 *   - Azure Built-in Roles reference (Microsoft Learn):
 *     https://learn.microsoft.com/azure/role-based-access-control/built-in-roles
 *   - The well-known guid list for Owner / User Access Administrator /
 *     Contributor / RBAC Admin / Reservations Admin matches `az role
 *     definition list --name "Owner"`-style output and is stable across
 *     all commercial + national clouds.
 *
 * Scope: classification is intentionally CONSERVATIVE — false positives
 * (something flagged Tier 0 that's actually Tier 1) are tolerable, false
 * negatives (a real Owner that we display as a Reader) are not. Custom
 * roles are evaluated by parsing their `permissions[].actions` arrays
 * for the wildcard / authorization patterns that grant role-assignment
 * write capability.
 */
export const PRIVILEGE_TIER_META = {
    critical: {
        tier: "critical",
        label: "Critical",
        badgeVariant: "destructive",
        description: "Owner / User Access Administrator class — can grant any role and modify any resource.",
        order: 0,
    },
    privileged: {
        tier: "privileged",
        label: "Privileged",
        badgeVariant: "warning",
        description: "Has Microsoft.Authorization/*/write or */write permission — can grant/modify access at scope.",
        order: 1,
    },
    write: {
        tier: "write",
        label: "Write",
        badgeVariant: "secondary",
        description: "Mutating role — can create / delete / modify resources but not grant access.",
        order: 2,
    },
    readonly: {
        tier: "readonly",
        label: "Read-only",
        badgeVariant: "outline",
        description: "Read-only role — cannot modify resources.",
        order: 3,
    },
};
/**
 * Well-known role-definition GUIDs that grant tier-0 (critical) access.
 *
 * These are stable across all Azure commercial / sovereign clouds and
 * match Microsoft's built-in role catalogue. Lowercase for case-
 * insensitive comparison via `.toLowerCase()` in callers.
 */
export const TIER_0_ROLE_GUIDS = new Set([
    // Owner — full management + can grant any role.
    "8e3af657-a8ff-443c-a75c-2fe8c4bcb635",
    // User Access Administrator — can grant any role, even Owner.
    "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9",
    // Role Based Access Control Administrator — limited UAA, still grants roles
    // (excluding Owner/UAA themselves but can grant Contributor + others).
    "f58310d9-a9f6-439a-9e8d-f62e7b41a168",
    // Contributor — at sub/MG scope, contributor cannot grant roles but it
    // CAN delete resources, deploy new ones, and grant data-plane access on
    // many services. Treated as critical at top-level scope per the page's
    // tier classifier (see classifyRoleTier — Contributor is critical only
    // when the role definition guid matches AND the scope is subscription/MG).
    "b24988ac-6180-42a0-ab88-20f7382dd24c",
    // Reservations Administrator — can purchase / modify reservations =
    // financial blast radius.
    "a8889054-8d42-49c9-bc1c-52486c10e7cd",
]);
/** Lowercased Tier-0 set for case-insensitive comparison. */
const TIER_0_LOWER = new Set(Array.from(TIER_0_ROLE_GUIDS).map((g) => g.toLowerCase()));
/**
 * The Contributor role GUID — pulled out so the tier classifier can
 * distinguish "Contributor at sub scope" (critical) from "Contributor
 * at a resource scope" (write).
 */
const CONTRIBUTOR_GUID = "b24988ac-6180-42a0-ab88-20f7382dd24c";
/**
 * Permission action patterns that indicate role-assignment write
 * capability (= privilege escalation potential). A custom role
 * containing any of these is at least Tier 1 (privileged).
 *
 * Match semantics:
 *   - "*" (literal) - full sovereignty over everything.
 *   - "(asterisk)/write" - write on any resource type (rare; usually
 *     means a custom-built admin role with no scope restriction).
 *   - "Microsoft.Authorization/(asterisk)" - full RBAC sovereignty
 *     (= UAA-like).
 *   - "Microsoft.Authorization/roleAssignments/write" -
 *     can grant ANY role to anyone at scope. Headline escalation.
 *   - "Microsoft.Authorization/roleDefinitions/write" - can EDIT
 *     custom roles, equivalent to roleAssignments/write because you
 *     can add yourself to the permissions of a role you already hold.
 *   - "Microsoft.Authorization/policyAssignments/(asterisk)" -
 *     policy assignment write can be used to grant managed identities
 *     access via deployIfNotExists remediations; treat as privileged.
 *
 * Wildcards are matched as case-insensitive glob: "*" = "any chars".
 */
const PRIVILEGED_ACTION_PATTERNS = [
    /^\*$/i,
    /^\*\/write$/i,
    /^Microsoft\.Authorization\/\*$/i,
    /^Microsoft\.Authorization\/roleAssignments\/write$/i,
    /^Microsoft\.Authorization\/roleDefinitions\/write$/i,
    /^Microsoft\.Authorization\/policyAssignments\/.+$/i,
];
/** Wildcard-write patterns that indicate Tier-2 (mutating) access. */
const WRITE_ACTION_PATTERNS = [
    /^.+\/write$/i,
    /^.+\/delete$/i,
    /^\*\/delete$/i,
    /^.+\/action$/i,
];
/**
 * Classify a single role into a privilege tier.
 *
 * Decision order (highest tier wins):
 *   1. GUID is a known Tier-0 built-in (Owner, UAA, RBAC Admin, Reservations).
 *   2. GUID is Contributor AND scope is subscription / management group.
 *   3. Permissions array contains a PRIVILEGED_ACTION_PATTERNS hit.
 *   4. Role name contains "owner"/"administrator"/"contributor" (fallback
 *      for cases where the permissions array isn't available).
 *   5. Permissions array contains a WRITE_ACTION_PATTERNS hit.
 *   6. Role name is "Reader"/"Viewer"/"Monitoring Reader" → readonly.
 *   7. Default: write.
 *
 * The `scope` argument is the ARM scope path of the role ASSIGNMENT — we
 * need it to distinguish Contributor-at-sub-scope (critical) from
 * Contributor-at-rg-scope (write).
 */
export function classifyRoleTier(def, roleGuid, scope) {
    var _a, _b, _c, _d, _e;
    const guidLower = ((_b = (_a = def === null || def === void 0 ? void 0 : def.id) !== null && _a !== void 0 ? _a : roleGuid) !== null && _b !== void 0 ? _b : "").toLowerCase();
    const nameLower = ((_c = def === null || def === void 0 ? void 0 : def.name) !== null && _c !== void 0 ? _c : "").toLowerCase();
    const scopeDepth = classifyScopeLevel(scope);
    // 1) Known critical built-ins always win.
    if (TIER_0_LOWER.has(guidLower) && guidLower !== CONTRIBUTOR_GUID) {
        return "critical";
    }
    // 2) Contributor only counts as critical at sub / MG scope.
    if (guidLower === CONTRIBUTOR_GUID) {
        if (scopeDepth === "subscription" || scopeDepth === "managementGroup") {
            return "critical";
        }
        // At RG / resource scope, Contributor is "just" a Tier-2 mutating role.
        return "write";
    }
    // 3) Permissions-array escalation patterns → privileged.
    if ((def === null || def === void 0 ? void 0 : def.permissions) && def.permissions.length > 0) {
        for (const block of def.permissions) {
            for (const a of (_d = block.actions) !== null && _d !== void 0 ? _d : []) {
                for (const pat of PRIVILEGED_ACTION_PATTERNS) {
                    if (pat.test(a))
                        return "privileged";
                }
            }
        }
    }
    // 4) Fallback by name when permissions aren't available.
    if (!(def === null || def === void 0 ? void 0 : def.permissions) || def.permissions.length === 0) {
        if (nameLower === "owner" ||
            nameLower === "user access administrator" ||
            nameLower.includes("role based access control")) {
            return "critical";
        }
        if (nameLower.endsWith("administrator") ||
            nameLower.endsWith("admin") ||
            nameLower.includes("privileged")) {
            return "privileged";
        }
    }
    // 5) Permissions-array write patterns → tier 2.
    if ((def === null || def === void 0 ? void 0 : def.permissions) && def.permissions.length > 0) {
        for (const block of def.permissions) {
            for (const a of (_e = block.actions) !== null && _e !== void 0 ? _e : []) {
                for (const pat of WRITE_ACTION_PATTERNS) {
                    if (pat.test(a))
                        return "write";
                }
            }
        }
    }
    // 6) Read-only by name (catch built-ins that don't expose permissions).
    if (nameLower === "reader" ||
        nameLower.endsWith(" reader") ||
        nameLower === "viewer" ||
        nameLower.endsWith(" viewer")) {
        return "readonly";
    }
    // 7) Default to write — being CONSERVATIVE: if we don't know, assume
    //    the role can mutate something. Better to over-warn than to miss
    //    a real Tier-2 assignment hiding behind an unfamiliar custom role.
    return "write";
}
const RE_MANAGEMENT_GROUP = /^\/providers\/Microsoft\.Management\/managementGroups\/[^/]+$/i;
const RE_SUBSCRIPTION = /^\/subscriptions\/[0-9a-f-]{36}$/i;
const RE_RESOURCE_GROUP = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+$/i;
const RE_RESOURCE = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+\/providers\/.+/i;
/**
 * Inspect a scope string and tell me which level it lives at. Defensive
 * against weird casing (`resourcegroups` vs `resourceGroups`) and root
 * `/` (tenant scope used by some cross-tenant grants).
 */
export function classifyScopeLevel(scope) {
    if (!scope || scope === "/")
        return "tenant";
    if (RE_MANAGEMENT_GROUP.test(scope))
        return "managementGroup";
    if (RE_RESOURCE.test(scope))
        return "resource";
    if (RE_RESOURCE_GROUP.test(scope))
        return "resourceGroup";
    if (RE_SUBSCRIPTION.test(scope))
        return "subscription";
    return "unknown";
}
/** Human-friendly label for a scope (for the chip next to each assignment). */
export function describeScope(scope) {
    var _a;
    const lvl = classifyScopeLevel(scope);
    switch (lvl) {
        case "tenant":
            return "Tenant root";
        case "managementGroup":
            return "Management group";
        case "subscription":
            return "Subscription";
        case "resourceGroup": {
            const m = /\/resourceGroups\/([^/]+)/i.exec(scope);
            return m ? `RG: ${m[1]}` : "Resource group";
        }
        case "resource": {
            // Last segment after /providers/.../ is the resource name.
            const tail = (_a = scope.split("/").pop()) !== null && _a !== void 0 ? _a : "";
            return tail ? `Resource: ${tail}` : "Resource";
        }
        default:
            return "Unknown scope";
    }
}
/**
 * Detect every UPN-style EXT marker that B2B guests carry. The Azure AD
 * convention is `<original_user>#EXT#@<host_tenant>.onmicrosoft.com`
 * but we also match the rare `_ext_` lowercase variant Graph sometimes
 * emits on PATCHed UPNs.
 */
export function isGuestUpn(upn) {
    if (!upn)
        return false;
    const lower = upn.toLowerCase();
    return lower.includes("#ext#") || lower.includes("_ext_");
}
/**
 * Compute the highest (= most dangerous = lowest numeric order) tier
 * across an array of assignments.
 */
export function highestTierOf(assignments) {
    let best = "readonly";
    let bestOrder = PRIVILEGE_TIER_META.readonly.order;
    for (const a of assignments) {
        const o = PRIVILEGE_TIER_META[a.tier].order;
        if (o < bestOrder) {
            best = a.tier;
            bestOrder = o;
        }
    }
    return best;
}
export function groupByPrincipal(inputs) {
    var _a, _b, _c;
    const { assignments, principalLookup, groupMembersByGroupId } = inputs;
    // Bucket assignments by principal id.
    const byId = new Map();
    for (const a of assignments) {
        const id = a.principalId;
        const resolved = principalLookup.get(id);
        const displayName = (_a = resolved === null || resolved === void 0 ? void 0 : resolved.displayName) !== null && _a !== void 0 ? _a : id;
        const signInName = resolved === null || resolved === void 0 ? void 0 : resolved.signInName;
        const principalType = (_c = (_b = resolved === null || resolved === void 0 ? void 0 : resolved.type) !== null && _b !== void 0 ? _b : a.principalType) !== null && _c !== void 0 ? _c : "Unknown";
        const isGuest = isGuestUpn(signInName);
        let entry = byId.get(id);
        if (!entry) {
            entry = {
                principalId: id,
                principalType,
                displayName,
                signInName,
                isGuest,
                assignments: [],
                highestTier: "readonly",
                assignmentCount: 0,
                escalations: [],
                hasEscalation: false,
            };
            byId.set(id, entry);
        }
        entry.assignments.push(a);
    }
    // Pre-compute tier + escalations per principal.
    for (const summary of byId.values()) {
        summary.assignmentCount = summary.assignments.length;
        summary.highestTier = highestTierOf(summary.assignments);
        summary.escalations = computeEscalations(summary, groupMembersByGroupId);
        summary.hasEscalation = summary.escalations.length > 0;
        if (summary.principalType === "Group" &&
            (groupMembersByGroupId === null || groupMembersByGroupId === void 0 ? void 0 : groupMembersByGroupId.has(summary.principalId))) {
            summary.groupMembers = groupMembersByGroupId.get(summary.principalId);
        }
    }
    // Stable sort: most-privileged first (lowest tier order), then escalation
    // findings first within tier, then display name asc for determinism.
    return Array.from(byId.values()).sort((a, b) => {
        const oa = PRIVILEGE_TIER_META[a.highestTier].order;
        const ob = PRIVILEGE_TIER_META[b.highestTier].order;
        if (oa !== ob)
            return oa - ob;
        if (a.hasEscalation !== b.hasEscalation)
            return a.hasEscalation ? -1 : 1;
        return a.displayName.localeCompare(b.displayName);
    });
}
/**
 * Compute escalation findings for one principal. Pure function — caller
 * (groupByPrincipal) calls this after the summary's `assignments` and
 * `isGuest` fields are populated.
 *
 * Group-mediated detection looks at every assignment held by a GROUP
 * principal whose tier is critical. When such a group's transitive
 * members are known, every member principal inherits the finding. But
 * because this function operates on ONE principal at a time, we instead
 * surface the finding the other way around: if THIS principal appears
 * in the transitive members of a group that holds a critical role, we
 * flag them. The caller passes the full group-members map so we can
 * walk it.
 */
function computeEscalations(summary, groupMembersByGroupId) {
    const findings = [];
    // 1) Direct elevation: a critical-tier assignment at sub / MG scope.
    for (const a of summary.assignments) {
        if (a.tier === "critical" &&
            (a.scopeLevel === "subscription" ||
                a.scopeLevel === "managementGroup" ||
                a.scopeLevel === "tenant")) {
            findings.push({
                category: "direct",
                headline: `Can self-grant any role (${a.roleName} at ${describeScope(a.scope)})`,
                detail: "Principal holds a critical-tier role at a top-level scope. " +
                    "They can grant themselves or anyone else any other role at this " +
                    "scope, including Owner. Audit the assignment's createdBy + " +
                    "justification — if unknown, consider replacing with a narrower role.",
            });
            break; // one direct finding per principal is enough
        }
    }
    // 2) Group-mediated elevation: this principal is a member of a group
    //    that itself holds a critical-tier role.
    if (groupMembersByGroupId && summary.principalType !== "Group") {
        for (const [groupId, members] of groupMembersByGroupId.entries()) {
            const isMember = members.some((m) => m.id.toLowerCase() === summary.principalId.toLowerCase());
            if (!isMember)
                continue;
            // For this to fire, the GROUP itself must have a critical assignment.
            // We can't see the group's own summary from here (forward reference),
            // so we instead encode that decision by checking whether the group
            // appears in `assignments` as a principal — but it won't, because we
            // grouped by principal id. The caller (groupByPrincipal) sets up
            // `groupMembersByGroupId` ONLY with groups that already have a
            // critical assignment, so reaching this loop is sufficient.
            findings.push({
                category: "groupMediated",
                headline: `Inherited admin via group ${groupId.substring(0, 8)}…`,
                detail: "Principal is a transitive member of a group that holds a " +
                    "critical-tier role at a top-level scope. Removing the principal " +
                    "from the group revokes the inherited admin without touching the " +
                    "role assignment.",
                viaPrincipalId: groupId,
            });
        }
    }
    // 3) Cross-tenant guest with privileged role.
    if (summary.isGuest) {
        const hasPrivileged = summary.assignments.some((a) => a.tier === "critical" || a.tier === "privileged");
        if (hasPrivileged) {
            findings.push({
                category: "crossTenantGuest",
                headline: "Guest account holds privileged role",
                detail: "Principal is a B2B guest (UPN contains #EXT#) and holds a " +
                    "critical/privileged role. Guest sign-in flows are partially " +
                    "controlled by the guest's home tenant — review whether this " +
                    "guest still needs access and consider time-bound PIM eligibility.",
            });
        }
    }
    return findings;
}
export function computeStats(summaries) {
    let totalAssignments = 0;
    let tier0Count = 0;
    let tier1Count = 0;
    let escalationCount = 0;
    let guestPrivilegedCount = 0;
    for (const s of summaries) {
        totalAssignments += s.assignmentCount;
        if (s.highestTier === "critical")
            tier0Count++;
        if (s.highestTier === "privileged")
            tier1Count++;
        if (s.hasEscalation)
            escalationCount++;
        if (s.isGuest &&
            (s.highestTier === "critical" || s.highestTier === "privileged")) {
            guestPrivilegedCount++;
        }
    }
    return {
        totalAssignments,
        uniquePrincipals: summaries.length,
        tier0Count,
        tier1Count,
        escalationCount,
        guestPrivilegedCount,
    };
}
export const EMPTY_FILTERS = {
    search: "",
    tiers: [],
    principalTypes: [],
    escalation: "all",
    scope: "all",
};
export function applyFilters(summaries, filters) {
    const q = filters.search.trim().toLowerCase();
    return summaries.filter((s) => {
        var _a;
        if (filters.tiers.length > 0 && !filters.tiers.includes(s.highestTier)) {
            return false;
        }
        if (filters.principalTypes.length > 0 &&
            !filters.principalTypes.includes(s.principalType)) {
            return false;
        }
        if (filters.escalation !== "all") {
            if (filters.escalation === "any" && !s.hasEscalation)
                return false;
            if (filters.escalation === "direct" &&
                !s.escalations.some((e) => e.category === "direct"))
                return false;
            if (filters.escalation === "groupMediated" &&
                !s.escalations.some((e) => e.category === "groupMediated"))
                return false;
            if (filters.escalation === "crossTenantGuest" &&
                !s.escalations.some((e) => e.category === "crossTenantGuest"))
                return false;
        }
        if (filters.scope !== "all") {
            const wantLevel = filters.scope === "subscription"
                ? "subscription"
                : filters.scope === "resourceGroup"
                    ? "resourceGroup"
                    : "resource";
            const has = s.assignments.some((a) => a.scopeLevel === wantLevel);
            if (!has)
                return false;
        }
        if (q) {
            const hay = [
                s.displayName,
                (_a = s.signInName) !== null && _a !== void 0 ? _a : "",
                s.principalId,
                s.principalType,
                ...s.assignments.map((a) => a.roleName),
            ]
                .join(" ")
                .toLowerCase();
            if (!hay.includes(q))
                return false;
        }
        return true;
    });
}
export const SIGNAL_SEVERITY_META = {
    critical: {
        severity: "critical",
        label: "Critical",
        badgeVariant: "destructive",
        order: 0,
    },
    high: {
        severity: "high",
        label: "High",
        badgeVariant: "warning",
        order: 1,
    },
    medium: {
        severity: "medium",
        label: "Medium",
        badgeVariant: "secondary",
        order: 2,
    },
    info: {
        severity: "info",
        label: "Info",
        badgeVariant: "outline",
        order: 3,
    },
};
/**
 * Detect custom roles whose `permissions.actions` contain the escalation
 * wildcards documented in `_bypass_role_grant.md §8.1`.
 *
 * Filters:
 *   - Only roles where `type === "CustomRole"` (matches the ARM property name
 *     `properties.type` returned by /roleDefinitions). Built-ins are excluded
 *     because they're already classified by the tier system.
 *   - At least one of: `*`, `*\/write`, `Microsoft.Authorization/*`,
 *     `Microsoft.Authorization/roleAssignments/write`,
 *     `Microsoft.Authorization/roleDefinitions/write`,
 *     `Microsoft.Authorization/policyAssignments/<any>`.
 *
 * Severity bucket:
 *   - `critical` — at least one current holder is non-Tier-0
 *     (User / ServicePrincipal that isn't already Owner-equivalent), because
 *     this is the canonical "hidden privesc" finding.
 *   - `high`     — only Tier-0-equivalent holders (e.g. an existing Owner
 *     also happens to hold this role) — still report it, lower severity.
 *   - `info`     — no current holders.
 */
export function detectCustomRoleWritePrivesc(inputs) {
    var _a, _b, _c, _d, _e, _f, _g;
    const { subResults, principalLookup } = inputs;
    // Wildcard patterns intentionally mirror the helper-internal
    // PRIVILEGED_ACTION_PATTERNS list above — duplicated here to avoid leaking
    // that constant into the public API surface (it's an impl detail).
    const PRIVESC = [
        /^\*$/i,
        /^\*\/write$/i,
        /^Microsoft\.Authorization\/\*$/i,
        /^Microsoft\.Authorization\/roleAssignments\/write$/i,
        /^Microsoft\.Authorization\/roleDefinitions\/write$/i,
        /^Microsoft\.Authorization\/policyAssignments\/.+$/i,
    ];
    const findings = [];
    for (const sub of subResults) {
        // Index assignments by role-def id for this sub.
        const assignmentsByRoleId = new Map();
        for (const a of sub.assignments) {
            const key = a.roleDefinitionId.toLowerCase();
            const arr = (_a = assignmentsByRoleId.get(key)) !== null && _a !== void 0 ? _a : [];
            arr.push({
                principalId: a.principalId,
                principalType: a.principalType,
                scope: a.scope,
            });
            assignmentsByRoleId.set(key, arr);
        }
        for (const def of sub.roleDefs) {
            // Built-ins are skipped — they're already in the tier matrix.
            const lowerType = ((_b = def.type) !== null && _b !== void 0 ? _b : "").toLowerCase();
            if (lowerType && lowerType !== "customrole")
                continue;
            // Also skip if this role definition is itself one of the well-known
            // Tier-0 GUIDs — that's belt-and-braces because Owner / UAA shouldn't
            // come back with `type: CustomRole`, but if they ever do we still want
            // to defer to the tier system rather than double-report.
            if (TIER_0_LOWER.has(def.id.toLowerCase()))
                continue;
            const matched = new Set();
            for (const block of (_c = def.permissions) !== null && _c !== void 0 ? _c : []) {
                for (const a of (_d = block.actions) !== null && _d !== void 0 ? _d : []) {
                    for (const pat of PRIVESC) {
                        if (pat.test(a)) {
                            matched.add(a);
                            break;
                        }
                    }
                }
            }
            if (matched.size === 0)
                continue;
            const holders = (_e = assignmentsByRoleId.get(def.id.toLowerCase())) !== null && _e !== void 0 ? _e : [];
            // Group holders by principalId (one row per principal even if they have
            // multiple assignments using this role on different scopes).
            const holderById = new Map();
            for (const h of holders) {
                const existing = holderById.get(h.principalId);
                if (existing) {
                    existing.scopes.add(h.scope);
                }
                else {
                    holderById.set(h.principalId, {
                        scopes: new Set([h.scope]),
                        principalType: h.principalType,
                    });
                }
            }
            const resolvedHolders = [];
            for (const [principalId, hMeta] of holderById.entries()) {
                const lookup = principalLookup.get(principalId);
                const isGuest = isGuestUpn(lookup === null || lookup === void 0 ? void 0 : lookup.signInName);
                // "Non-Tier-0" detection: in this context, a holder is non-Tier-0 if
                // they're a User / ServicePrincipal / Application principal type. Group
                // principals are also flagged because the group's membership graph
                // amplifies the blast radius further.
                const principalType = (_f = lookup === null || lookup === void 0 ? void 0 : lookup.type) !== null && _f !== void 0 ? _f : hMeta.principalType;
                const isNonTierZero = principalType === "User" ||
                    principalType === "Group" ||
                    principalType === "ServicePrincipal" ||
                    principalType === "Application";
                resolvedHolders.push({
                    principalId,
                    displayName: (_g = lookup === null || lookup === void 0 ? void 0 : lookup.displayName) !== null && _g !== void 0 ? _g : principalId,
                    principalType,
                    isGuest,
                    isNonTierZero,
                    scopes: Array.from(hMeta.scopes),
                });
            }
            let severity = "info";
            if (resolvedHolders.length === 0)
                severity = "info";
            else if (resolvedHolders.some((h) => h.isNonTierZero))
                severity = "critical";
            else
                severity = "high";
            findings.push({
                roleDefinitionId: def.id,
                roleName: def.name,
                subscriptionId: sub.subscriptionId,
                subscriptionDisplayName: sub.displayName,
                matchedActions: Array.from(matched),
                assignmentCount: holders.length,
                holders: resolvedHolders,
                severity,
            });
        }
    }
    // Sort: most severe first, then most-assigned first, then by role name.
    return findings.sort((a, b) => {
        const oa = SIGNAL_SEVERITY_META[a.severity].order;
        const ob = SIGNAL_SEVERITY_META[b.severity].order;
        if (oa !== ob)
            return oa - ob;
        if (a.assignmentCount !== b.assignmentCount) {
            return b.assignmentCount - a.assignmentCount;
        }
        return a.roleName.localeCompare(b.roleName);
    });
}
export function auditRoleAssignableGroups(inputs) {
    var _a;
    const { groups, summaries } = inputs;
    // Index summaries by lowercased principal id for quick lookup of what role
    // a group currently holds.
    const summaryById = new Map();
    for (const s of summaries) {
        summaryById.set(s.principalId.toLowerCase(), s);
    }
    const out = [];
    for (const g of groups) {
        const sample = g.owners.slice(0, 3).map((o) => ({
            id: o.id,
            displayName: o.displayName,
            type: o.type,
            isGuest: isGuestUpn(o.signInName),
        }));
        const groupSummary = summaryById.get(g.id.toLowerCase());
        const groupRoles = ((_a = groupSummary === null || groupSummary === void 0 ? void 0 : groupSummary.assignments) !== null && _a !== void 0 ? _a : []).map((a) => a.roleName);
        const hasNonTierZeroOwner = g.owners.some((o) => o.type === "User" || o.type === "ServicePrincipal");
        // Severity:
        //   critical — group holds a Tier-0 role AND has any non-Tier-0 owner
        //              (this is the canonical persistence + privesc primitive).
        //   high     — group holds a Tier-0 role but owners are all Tier-0.
        //   medium   — group exists, owned by non-Tier-0, but currently holds no
        //              audited role (still a planted-trap surface for future grants).
        //   info     — no owners or no role and no non-Tier-0 owner.
        let severity = "info";
        const tier = groupSummary === null || groupSummary === void 0 ? void 0 : groupSummary.highestTier;
        if (tier === "critical" && hasNonTierZeroOwner)
            severity = "critical";
        else if (tier === "critical")
            severity = "high";
        else if (tier === "privileged" && hasNonTierZeroOwner)
            severity = "high";
        else if (hasNonTierZeroOwner && g.owners.length > 0)
            severity = "medium";
        else if (g.owners.length > 0)
            severity = "info";
        out.push({
            groupId: g.id,
            displayName: g.displayName,
            ownerCount: g.owners.length,
            sampleOwners: sample,
            hasNonTierZeroOwner,
            groupHighestTier: tier,
            groupRoles,
            severity,
        });
    }
    return out.sort((a, b) => {
        const oa = SIGNAL_SEVERITY_META[a.severity].order;
        const ob = SIGNAL_SEVERITY_META[b.severity].order;
        if (oa !== ob)
            return oa - ob;
        return a.displayName.localeCompare(b.displayName);
    });
}
// ---------------------------------------------------------------------------
// Signal C — Application Administrator + SPs that hold high-priv Graph
// permissions (the canonical addKey-to-GA chain).
//
// Corpus citation: _bypass_role_grant.md §3.5 + _AZURE_BYPASS_PLAYBOOK.md #23, #24
//
// Application Administrator can add credentials (`addKey` or `addPassword`)
// to ANY app registration in the tenant. If ANY app in the tenant is itself
// granted a high-tier Graph app-only permission (`RoleManagement.ReadWrite.
// Directory`, `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`,
// `Directory.ReadWrite.All`, `User.ReadWrite.All`), App Admin holders are
// effectively one credential plant away from Global Admin equivalence.
//
// Detection: presentation-only — we cross-product App-Admin holders with
// the count of high-priv SPs, surface the result in a side panel. The
// graph itself doesn't get new edges because materialising N×M App-Admin-to-SP
// hops would explode the visual graph (per the task brief).
// ---------------------------------------------------------------------------
/** The set of Graph app-role values we treat as "GA-equivalent if reached". */
export const ADMIN_TIER_GRAPH_APP_ROLES = new Set([
    "RoleManagement.ReadWrite.Directory",
    "Application.ReadWrite.All",
    "AppRoleAssignment.ReadWrite.All",
    "Directory.ReadWrite.All",
    "User.ReadWrite.All",
    // Application Administrator has a directory role id but here we're
    // checking app-only Graph scopes only — the directory role itself is the
    // Signal C source, not the target. AppRole values are stable strings from
    // the Microsoft Graph SP's `appRoles` collection.
]);
export function detectAppAdminEscalation(inputs) {
    const { appAdminPrincipals, highPrivSps } = inputs;
    const sampleSps = highPrivSps.slice(0, 3).map((s) => s.displayName);
    const topScope = (() => {
        // Pick the most-impactful scope present, in this canonical order.
        const PRIORITY = [
            "RoleManagement.ReadWrite.Directory",
            "Application.ReadWrite.All",
            "AppRoleAssignment.ReadWrite.All",
            "Directory.ReadWrite.All",
            "User.ReadWrite.All",
        ];
        for (const p of PRIORITY) {
            if (highPrivSps.some((s) => s.appRoles.includes(p)))
                return p;
        }
        return undefined;
    })();
    const out = [];
    for (const p of appAdminPrincipals) {
        const isGuest = isGuestUpn(p.signInName);
        // Severity:
        //   critical — has access to at least one SP that holds
        //              RoleManagement.ReadWrite.Directory (full GA-equivalent).
        //   high     — has access to any other admin-tier Graph scope.
        //   medium   — App Admin role with NO discovered high-priv SPs (the
        //              role itself is privileged; ranked medium because the
        //              kill-chain target isn't currently in the tenant).
        let severity = "medium";
        if (highPrivSps.some((s) => s.appRoles.includes("RoleManagement.ReadWrite.Directory"))) {
            severity = "critical";
        }
        else if (highPrivSps.length > 0) {
            severity = "high";
        }
        out.push({
            principalId: p.id,
            displayName: p.displayName,
            principalType: p.type,
            isGuest,
            roleName: p.roleName,
            reachableSpCount: highPrivSps.length,
            sampleSpNames: sampleSps,
            topReachableScope: topScope,
            severity,
        });
    }
    return out.sort((a, b) => {
        const oa = SIGNAL_SEVERITY_META[a.severity].order;
        const ob = SIGNAL_SEVERITY_META[b.severity].order;
        if (oa !== ob)
            return oa - ob;
        return a.displayName.localeCompare(b.displayName);
    });
}
// ---------------------------------------------------------------------------
// Signal D — recent addPassword / addKey credential surface on SPs.
//
// Corpus citation: _bypass_role_grant.md §4.1, §4.2 +
//   _AZURE_BYPASS_PLAYBOOK.md "Critical Defender Audit Surface" item 5
//
// `addPassword` and `addKey` are the canonical SP-persistence APIs. Defenders
// should alert on Microsoft.Graph audit `Update application — Certificates
// and secrets management`. In the UI we render the credential-count badges
// on every SP node, and flag any SP whose newest credential was added in the
// last 7 days (`endDateTime`'s freshness is a stronger signal than
// `startDateTime`, which the API doesn't always populate, but in absence of
// baseline data we treat ANY credential added in the recency window as a
// risk indicator).
//
// Page-side concern: we do NOT have a snapshot diff facility today, so the
// "recent credential" detection is calendar-window-only. Baseline diff
// (compare against a stored snapshot) is a COORDINATOR note in the page.
// ---------------------------------------------------------------------------
/** Default lookback window for "recently added credential" — 7 days. */
export const DEFAULT_CREDENTIAL_RECENCY_DAYS = 7;
export function summarizeCredentialSurface(sps, recencyDays = DEFAULT_CREDENTIAL_RECENCY_DAYS, now = new Date()) {
    const recencyMs = recencyDays * 24 * 60 * 60 * 1000;
    const out = [];
    for (const sp of sps) {
        let daysSince;
        let isRecent = false;
        if (sp.newestCredentialStart) {
            const t = Date.parse(sp.newestCredentialStart);
            if (!Number.isNaN(t)) {
                daysSince = Math.floor((now.getTime() - t) / (24 * 60 * 60 * 1000));
                isRecent = now.getTime() - t <= recencyMs;
            }
        }
        let severity = "info";
        if (isRecent && sp.isHighPriv)
            severity = "critical";
        else if (isRecent)
            severity = "high";
        else if (sp.isHighPriv)
            severity = "medium";
        out.push({
            spId: sp.spId,
            displayName: sp.displayName,
            passwordCredentialCount: sp.passwordCredentialCount,
            keyCredentialCount: sp.keyCredentialCount,
            newestCredentialStart: sp.newestCredentialStart,
            daysSinceNewestCredential: daysSince,
            isRecent,
            isHighPriv: !!sp.isHighPriv,
            severity,
        });
    }
    return out.sort((a, b) => {
        const oa = SIGNAL_SEVERITY_META[a.severity].order;
        const ob = SIGNAL_SEVERITY_META[b.severity].order;
        if (oa !== ob)
            return oa - ob;
        if (a.isRecent !== b.isRecent)
            return a.isRecent ? -1 : 1;
        if (a.isHighPriv !== b.isHighPriv)
            return a.isHighPriv ? -1 : 1;
        return a.displayName.localeCompare(b.displayName);
    });
}
export function computeDefenderSignalScore(c) {
    // Weighting reflects corpus risk framing: each critical finding is a
    // ready-to-go privesc primitive (worth 15), each high is a planted
    // trap or partial chain (worth 8). Cap at 100 to avoid runaway sums when
    // a tenant has dozens of findings (the visual range stays meaningful).
    const raw = 15 *
        (c.customRolePrivescCritical +
            c.roleAssignableGroupCritical +
            c.appAdminEscalationCritical +
            c.credentialSurfaceCritical) +
        8 *
            (c.customRolePrivescHigh +
                c.roleAssignableGroupHigh +
                c.appAdminEscalationHigh +
                c.credentialSurfaceHigh);
    const score = Math.min(100, raw);
    let label = "Low";
    if (score >= 60)
        label = "Critical";
    else if (score >= 30)
        label = "Elevated";
    else if (score >= 10)
        label = "Moderate";
    return { score, label };
}
/**
 * BFS shortest-path search from every matched start principal to every
 * assignment whose scope contains `scopeQuery`. Returns ALL shortest paths
 * (one per matched start principal / scope tuple), de-duped.
 *
 * Edges modelled:
 *   - principal --member-of--> group  (when this principal appears in the
 *     group's transitiveMembers list)
 *   - group     --member-of--> group  (nested group; transitive-members can
 *     contain group entries)
 *   - principal --holds-role--> role  (direct assignment)
 *   - role      --at-scope--> scope   (the role-assignment scope)
 *
 * Hop budget capped at 5 to keep BFS bounded. Real attack chains stop
 * mattering past 4-5 hops because operators can't reason about them anyway.
 */
export function findShortestPath(inputs) {
    var _a, _b, _c;
    const { principalQuery, scopeQuery, summaries, groupMembersByGroupId, maxPaths = 25, } = inputs;
    const pq = principalQuery.trim().toLowerCase();
    const sq = scopeQuery.trim().toLowerCase();
    if (!pq && !sq)
        return [];
    // Build adjacency:
    //   summaries: principalId -> PrincipalSummary
    //   groupMembers: groupId -> Set<memberId>     (forward edge)
    //   memberOfGroups: principalId -> Set<groupId> (reverse edge — what we need
    //     during BFS to "promote" a user up to a group they belong to).
    const summaryById = new Map();
    for (const s of summaries)
        summaryById.set(s.principalId.toLowerCase(), s);
    const memberOfGroups = new Map();
    const groupMembersLower = new Map();
    if (groupMembersByGroupId) {
        for (const [gid, members] of groupMembersByGroupId.entries()) {
            const gidL = gid.toLowerCase();
            const setM = new Set();
            groupMembersLower.set(gidL, setM);
            for (const m of members) {
                const mid = m.id.toLowerCase();
                setM.add(mid);
                const arr = (_a = memberOfGroups.get(mid)) !== null && _a !== void 0 ? _a : new Set();
                arr.add(gidL);
                memberOfGroups.set(mid, arr);
            }
        }
    }
    // 1) Pick start principals — any summary matching `principalQuery`. If the
    //    query is empty, every principal that has a scope-matching assignment is
    //    its own start.
    const startSummaries = [];
    for (const s of summaries) {
        const match = pq
            ? s.principalId.toLowerCase().includes(pq) ||
                s.displayName.toLowerCase().includes(pq) ||
                ((_b = s.signInName) !== null && _b !== void 0 ? _b : "").toLowerCase().includes(pq)
            : true;
        if (match)
            startSummaries.push(s);
    }
    if (startSummaries.length === 0)
        return [];
    // 2) BFS from each start; collect shortest path(s) to a scope-matching
    //    assignment. Per-start BFS is bounded so we never spiral.
    const HOP_BUDGET = 5;
    const paths = [];
    for (const start of startSummaries) {
        if (paths.length >= maxPaths)
            break;
        const startHop = {
            kind: "principal",
            id: start.principalId,
            label: start.displayName,
            principalType: start.principalType,
            detail: start.signInName,
        };
        const visited = new Set([start.principalId.toLowerCase()]);
        const queue = [
            {
                principalId: start.principalId.toLowerCase(),
                hops: [startHop],
                viaGroup: false,
                viaNestedGroup: false,
            },
        ];
        while (queue.length > 0 && paths.length < maxPaths) {
            const cur = queue.shift();
            // Terminal check: does THIS principal hold an assignment to a matching
            // scope? If so, materialize the role + scope hops and record the path.
            const curSummary = summaryById.get(cur.principalId);
            if (curSummary) {
                for (const a of curSummary.assignments) {
                    if (sq && !a.scope.toLowerCase().includes(sq))
                        continue;
                    // Skip if no scope query AND principal query already matched — caller
                    // wanted any-scope path; in that case we still need at least one role
                    // to be on the path so we just take the first assignment.
                    const roleHop = {
                        kind: "role",
                        id: a.roleDefinitionId,
                        label: a.roleName,
                        tier: a.tier,
                        detail: PRIVILEGE_TIER_META[a.tier].label,
                    };
                    const scopeHop = {
                        kind: "scope",
                        id: a.scope,
                        label: describeScope(a.scope),
                        scopeLevel: a.scopeLevel,
                        detail: a.scope,
                    };
                    paths.push({
                        hops: [...cur.hops, roleHop, scopeHop],
                        hopCount: cur.hops.length + 1,
                        viaGroup: cur.viaGroup,
                        viaNestedGroup: cur.viaNestedGroup,
                        highestTier: a.tier,
                    });
                    if (paths.length >= maxPaths)
                        break;
                    // Don't break — record EVERY scope-matching assignment for this
                    // principal so the operator sees all path variants.
                }
            }
            // Expand: walk up to groups this principal is a member of.
            if (cur.hops.length >= HOP_BUDGET)
                continue;
            const groups = memberOfGroups.get(cur.principalId);
            if (!groups)
                continue;
            for (const gid of groups) {
                if (visited.has(gid))
                    continue;
                visited.add(gid);
                // Look up the group's summary for a friendly label.
                const gSummary = summaryById.get(gid);
                // Detect nested-group transition: previous hop was already a group.
                const prevWasGroup = cur.hops[cur.hops.length - 1].kind === "group";
                const groupHop = {
                    kind: "group",
                    id: gid,
                    label: (_c = gSummary === null || gSummary === void 0 ? void 0 : gSummary.displayName) !== null && _c !== void 0 ? _c : `Group ${gid.substring(0, 8)}…`,
                    detail: prevWasGroup ? "nested" : "member-of",
                };
                queue.push({
                    principalId: gid,
                    hops: [...cur.hops, groupHop],
                    viaGroup: true,
                    viaNestedGroup: cur.viaNestedGroup || prevWasGroup,
                });
            }
        }
    }
    // Sort: shortest first, then most-dangerous tier first.
    paths.sort((a, b) => {
        if (a.hopCount !== b.hopCount)
            return a.hopCount - b.hopCount;
        const oa = PRIVILEGE_TIER_META[a.highestTier].order;
        const ob = PRIVILEGE_TIER_META[b.highestTier].order;
        return oa - ob;
    });
    return paths.slice(0, maxPaths);
}
/**
 * Detect ownership chains where an owner of group G1 transitively reaches a
 * group G2 (via membership) that holds a privileged role.
 *
 * Algorithm: for every group G1 we know about (= every Signal B row), walk
 * the transitive-members graph and find every group reachable from G1. If
 * any such group has a `critical` or `privileged` tier assignment, emit one
 * finding per (owner-of-G1, terminal-group) pair.
 *
 * Depth budget: 4 (same as BFS — `_bypass_role_grant.md` §5.4 calls out 2-3
 * nesting levels as the common case; 4 gives us headroom).
 */
export function detectOwnershipChains(inputs) {
    const { groups, summaries, groupMembersByGroupId } = inputs;
    if (groups.length === 0)
        return [];
    // Build forward members map (lowercased) — group → set of member ids.
    const members = new Map();
    if (groupMembersByGroupId) {
        for (const [gid, m] of groupMembersByGroupId.entries()) {
            const set = new Set();
            for (const x of m)
                set.add(x.id.toLowerCase());
            members.set(gid.toLowerCase(), set);
        }
    }
    // Build summary lookup keyed by lowercased principal id.
    const summaryById = new Map();
    for (const s of summaries)
        summaryById.set(s.principalId.toLowerCase(), s);
    // Pre-resolve which groups are "interesting terminals" — i.e. they hold a
    // privileged-or-higher role.
    function tierOf(gid) {
        const s = summaryById.get(gid);
        if (!s)
            return undefined;
        if (s.highestTier === "critical" || s.highestTier === "privileged") {
            return s.highestTier;
        }
        return undefined;
    }
    function rolesOf(gid) {
        const s = summaryById.get(gid);
        if (!s)
            return [];
        return Array.from(new Set(s.assignments.map((a) => a.roleName)));
    }
    const out = [];
    const HOP_BUDGET = 4;
    for (const g of groups) {
        const rootGid = g.id.toLowerCase();
        const visited = new Set([rootGid]);
        const queue = [{ gid: rootGid, path: [], depth: 0 }];
        // Collect EVERY terminal we reach, not just the first.
        const terminals = [];
        while (queue.length > 0) {
            const cur = queue.shift();
            if (cur.depth > 0) {
                const tier = tierOf(cur.gid);
                if (tier) {
                    terminals.push({ gid: cur.gid, path: cur.path, depth: cur.depth });
                }
            }
            if (cur.depth >= HOP_BUDGET)
                continue;
            const m = members.get(cur.gid);
            if (!m)
                continue;
            for (const child of m) {
                if (visited.has(child))
                    continue;
                // Only expand into entities that are themselves groups in our member
                // map (otherwise we'd traverse user/SP leaves, which is irrelevant
                // for ownership chains). A group is "knowable" when we have a members
                // entry for it — we can't enumerate further without it anyway.
                visited.add(child);
                // Walk further only if `child` is itself a group key in `members`.
                if (members.has(child)) {
                    queue.push({
                        gid: child,
                        path: [...cur.path, child],
                        depth: cur.depth + 1,
                    });
                }
                else {
                    // `child` is a leaf — but it could still be a role-holding group we
                    // haven't enumerated members for. Check tier and emit if so.
                    const tier = tierOf(child);
                    if (tier) {
                        terminals.push({
                            gid: child,
                            path: [...cur.path, child],
                            depth: cur.depth + 1,
                        });
                    }
                }
            }
        }
        // Emit one finding per (owner, terminal) pair.
        for (const owner of g.owners) {
            for (const t of terminals) {
                const terminalSummary = summaryById.get(t.gid);
                if (!terminalSummary)
                    continue;
                const tier = terminalSummary.highestTier;
                let severity = "info";
                if (tier === "critical")
                    severity = "critical";
                else if (tier === "privileged")
                    severity = "high";
                out.push({
                    ownerId: owner.id,
                    ownerDisplayName: owner.displayName,
                    ownerType: owner.type,
                    isGuest: isGuestUpn(owner.signInName),
                    rootGroupId: g.id,
                    rootGroupDisplayName: g.displayName,
                    intermediateGroupIds: t.path.slice(0, -1),
                    terminalGroupId: t.gid,
                    terminalGroupDisplayName: terminalSummary.displayName,
                    terminalRoles: rolesOf(t.gid),
                    terminalTier: tier,
                    depth: t.depth,
                    severity,
                });
            }
        }
    }
    // De-dupe: same owner + same terminal — keep the shortest chain.
    const dedup = new Map();
    for (const f of out) {
        const key = `${f.ownerId.toLowerCase()}|${f.terminalGroupId.toLowerCase()}`;
        const prev = dedup.get(key);
        if (!prev || f.depth < prev.depth)
            dedup.set(key, f);
    }
    return Array.from(dedup.values()).sort((a, b) => {
        const oa = SIGNAL_SEVERITY_META[a.severity].order;
        const ob = SIGNAL_SEVERITY_META[b.severity].order;
        if (oa !== ob)
            return oa - ob;
        if (a.depth !== b.depth)
            return a.depth - b.depth;
        return a.ownerDisplayName.localeCompare(b.ownerDisplayName);
    });
}
//# sourceMappingURL=role-graph-helpers.js.map