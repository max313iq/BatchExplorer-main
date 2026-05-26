/**
 * Pure helpers for the Privileged Users & Shadow Admin Auditor page.
 *
 * Inspired by CyberArk's SkyArk: enumerate every principal that holds —
 * directly or transitively — a directory role in the tenant, classify
 * the role into a tier (Microsoft's privileged role tiering), and flag
 * "shadow admin" escalation paths that aren't obvious from the
 * Azure-portal "Roles & administrators" blade alone.
 *
 *   - Direct       — User assigned the role directly.
 *   - Group-       — A Group holds the role; every transitive member of
 *      mediated      the group inherits it. SkyArk catches these because
 *                    operators rarely inspect group memberships.
 *   - Service      — A Service Principal (managed identity / app SPN)
 *      principal     holds the role. High-blast-radius if the app is
 *                    third-party or has wide API permissions.
 *   - Guest        — An external user (`#EXT#` in UPN) holding a
 *                    Tier 0/1 role. Cross-tenant privileged access often
 *                    survives departure from the partner organization.
 *
 * All exports are pure / side-effect-free so the page can unit-test
 * tier classification and shadow-admin detection without spinning up a
 * Graph mock.
 */
import { __rest } from "tslib";
import { ROLE_AUTHENTICATION_ADMIN, ROLE_DIRECTORY_READER, ROLE_GLOBAL_ADMIN, ROLE_GLOBAL_READER, ROLE_HELPDESK_ADMIN, ROLE_PRIVILEGED_AUTH_ADMIN, ROLE_USER_ADMIN, } from "../../services/graph-service";
export const TIER_META = {
    tier0: {
        label: "Tier 0 — Global",
        description: "Full directory control. Can manage every other role and grant any permission. Includes Global Administrator and Privileged Role Administrator.",
        order: 0,
        badgeVariant: "destructive",
        statTone: "destructive",
    },
    tier1: {
        label: "Tier 1 — Sensitive",
        description: "High blast radius. Can manage authentication methods, user passwords, or workload identities. Includes Authentication, User, Application, and Cloud Application Administrators.",
        order: 1,
        badgeVariant: "warning",
        statTone: "warning",
    },
    tier2: {
        label: "Tier 2 — Operational",
        description: "Day-to-day admin. Helpdesk, password, groups, license, directory-write operations. Limited blast radius but plentiful escalation primitives.",
        order: 2,
        badgeVariant: "info",
        statTone: "info",
    },
    tier3: {
        label: "Tier 3 — Read",
        description: "Read-only operators. Includes Global Reader, Directory Reader, Security Reader, Reports Reader. Cannot mutate state.",
        order: 3,
        badgeVariant: "secondary",
        statTone: "muted",
    },
    other: {
        label: "Other",
        description: "Directory role not recognised by this tool's classification table. Treat as 'investigate' until it can be added to the tier map.",
        order: 4,
        badgeVariant: "outline",
        statTone: "muted",
    },
};
/**
 * Tier 0 — full directory control.
 *
 * Privileged Role Administrator earns Tier 0 because it can grant
 * Global Administrator to any principal, which makes it functionally
 * equivalent. SkyArk highlights this exact pivot explicitly.
 *
 * Partner Tier2 Support (`e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8`) sits
 * here because Microsoft support engineers can be elevated to global-
 * admin equivalent inside customer tenants.
 */
const TIER0_TEMPLATE_IDS = new Set([
    ROLE_GLOBAL_ADMIN,
    "e8611ab8-c189-46e8-94e1-60213ab1f814",
    "e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8", // Partner Tier2 Support
]);
/**
 * Tier 1 — high-impact identity / app management. Anything in this set
 * can either reset another user's credentials, mint workload identities,
 * or own app-permission grants that escalate to Graph admin scopes.
 */
const TIER1_TEMPLATE_IDS = new Set([
    ROLE_PRIVILEGED_AUTH_ADMIN,
    ROLE_AUTHENTICATION_ADMIN,
    ROLE_USER_ADMIN,
    "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
    "158c047a-c907-4556-b7ef-446551a6b5f7",
    "29232cdf-9323-42fd-ade2-1d097af3e4de",
    "f28a1f50-f6e7-4571-818b-6a12f2af6b6c",
    "966707d0-3269-4727-9be2-8c3a10f19b9d", // Password Administrator (Tier 1 because it's coupled with user-admin escalation in many tenants)
]);
/**
 * Tier 2 — operational helpdesk / license / group admin roles. Each
 * one is bounded but plentiful enough that compromised holders are a
 * cheap pivot to a Tier 1 target.
 */
const TIER2_TEMPLATE_IDS = new Set([
    ROLE_HELPDESK_ADMIN,
    "9360feb5-f418-4baa-8175-e2a00bac4301",
    "fdd7a751-b60b-444a-984c-02652fe8fa1c",
    "4d6ac14f-3453-41d0-bef9-a3e0c569773a", // License Administrator
]);
/**
 * Tier 3 — read-only. Still privileged enough to enumerate every user,
 * group, role and policy in the tenant — exactly the data SkyArk needs
 * to operate — but they cannot mutate state.
 */
const TIER3_TEMPLATE_IDS = new Set([
    ROLE_GLOBAL_READER,
    ROLE_DIRECTORY_READER,
    "5d6b6bb7-de71-4623-b4af-96380a352509",
    "4a5d8f65-41da-4de4-8968-e035b65339cf", // Reports Reader
]);
/**
 * Fallback classification by lower-case displayName for tenants where
 * a role's template-id isn't in our hardcoded set (e.g. preview roles
 * Microsoft hasn't published a stable GUID for, or custom roles whose
 * name follows the standard convention).
 */
const TIER_BY_DISPLAY_NAME = [
    // Tier 0 ─────────────────────────────────────────────────────────────
    [/^global admin/i, "tier0"],
    [/^company admin/i, "tier0"],
    [/^privileged role admin/i, "tier0"],
    [/^partner tier ?2 support/i, "tier0"],
    // Tier 1 ─────────────────────────────────────────────────────────────
    [/^privileged authentication admin/i, "tier1"],
    [/^authentication admin/i, "tier1"],
    [/^user admin/i, "tier1"],
    [/^application admin/i, "tier1"],
    [/^cloud application admin/i, "tier1"],
    [/^exchange (admin|recipient admin)/i, "tier1"],
    [/^sharepoint admin/i, "tier1"],
    [/^password admin/i, "tier1"],
    [/^conditional access admin/i, "tier1"],
    [/^security admin/i, "tier1"],
    // Tier 2 ─────────────────────────────────────────────────────────────
    [/^helpdesk admin/i, "tier2"],
    [/^directory writers?/i, "tier2"],
    [/^groups admin/i, "tier2"],
    [/^license admin/i, "tier2"],
    [/^teams admin/i, "tier2"],
    [/^intune admin/i, "tier2"],
    // Tier 3 ─────────────────────────────────────────────────────────────
    [/^global reader/i, "tier3"],
    [/^directory reader/i, "tier3"],
    [/^security reader/i, "tier3"],
    [/^reports reader/i, "tier3"],
    [/^message center reader/i, "tier3"],
    [/^reader$/i, "tier3"],
];
/**
 * Classify a directory role into one of the four tiers. Falls back to
 * `"other"` for unknown roles so the UI never crashes when Microsoft
 * adds a new built-in role between releases.
 */
export function classifyRole(roleTemplateId, displayName) {
    if (roleTemplateId) {
        if (TIER0_TEMPLATE_IDS.has(roleTemplateId))
            return "tier0";
        if (TIER1_TEMPLATE_IDS.has(roleTemplateId))
            return "tier1";
        if (TIER2_TEMPLATE_IDS.has(roleTemplateId))
            return "tier2";
        if (TIER3_TEMPLATE_IDS.has(roleTemplateId))
            return "tier3";
    }
    if (displayName) {
        for (const [pattern, tier] of TIER_BY_DISPLAY_NAME) {
            if (pattern.test(displayName))
                return tier;
        }
    }
    return "other";
}
/**
 * True when the role's template id matches Privileged Role Administrator —
 * a role that can grant Global Administrator to any principal. SkyArk
 * flags this as a "stealth Global Admin" because the holder doesn't
 * appear in the Global Admin list itself.
 */
export const ROLE_PRIVILEGED_ROLE_ADMIN = "e8611ab8-c189-46e8-94e1-60213ab1f814";
export function isPrivilegedRoleAdmin(templateId) {
    return templateId === ROLE_PRIVILEGED_ROLE_ADMIN;
}
export const ASSIGNMENT_PATH_META = {
    direct: {
        label: "Direct",
        description: "User is a direct member of the directory role.",
        badgeVariant: "secondary",
    },
    group: {
        label: "Via group",
        description: "Principal inherits the role transitively through group membership. Frequently overlooked because the principal does not appear in the role's direct member list.",
        badgeVariant: "warning",
    },
    sp: {
        label: "Service principal",
        description: "A workload identity (app, managed identity, third-party service principal) holds the role. Compromise can persist beyond any human admin's departure.",
        badgeVariant: "info",
    },
    guest: {
        label: "Guest",
        description: "External (cross-tenant) user holds the role. Privileged access often outlives the business relationship that originally granted it.",
        badgeVariant: "destructive",
    },
};
// ===========================================================================
// UPN / classification helpers
// ===========================================================================
/**
 * True when the UPN looks like a B2B guest. The canonical guest UPN
 * shape is `<displayemail>_<homedomain>#EXT#@<thistenant>.onmicrosoft.com`
 * so the `#EXT#` substring is a reliable signal.
 */
export function isExternalUpn(upn) {
    if (!upn)
        return false;
    return upn.toUpperCase().includes("#EXT#");
}
/**
 * Pick the principal's "highest-privilege" tier across all its
 * assignments. Returns "other" if the principal has no assignments.
 */
export function highestTier(assignments) {
    if (assignments.length === 0)
        return "other";
    let best = "other";
    let bestOrder = TIER_META.other.order;
    for (const a of assignments) {
        const order = TIER_META[a.tier].order;
        if (order < bestOrder) {
            best = a.tier;
            bestOrder = order;
        }
    }
    return best;
}
/**
 * True when the assignment list constitutes a "shadow admin" path —
 * i.e. anything that's not a plain Direct user assignment. SP and
 * Group paths both qualify; Guest-Direct also qualifies because the
 * principal is external.
 */
export function hasShadowAdminPath(assignments, isExternal) {
    if (isExternal)
        return true;
    return assignments.some((a) => a.path !== "direct");
}
// ===========================================================================
// Deep-link builder
// ===========================================================================
/**
 * Compose a deep link into the Azure portal that opens the principal's
 * Entra-ID profile blade in the correct tenant. Works for users; for
 * groups + SPs we degrade to the directory-object lookup which the
 * portal will resolve into the appropriate blade.
 */
export function portalDeepLink(tenantId, principal) {
    const base = "https://portal.azure.com";
    if (principal.type === "User") {
        return (`${base}/#@${encodeURIComponent(tenantId)}` +
            `/blade/Microsoft_AAD_IAM/UserDetailsMenuBlade/Profile/userId/` +
            encodeURIComponent(principal.id));
    }
    if (principal.type === "Group") {
        return (`${base}/#@${encodeURIComponent(tenantId)}` +
            `/blade/Microsoft_AAD_IAM/GroupDetailsMenuBlade/Overview/groupId/` +
            encodeURIComponent(principal.id));
    }
    if (principal.type === "ServicePrincipal") {
        return (`${base}/#@${encodeURIComponent(tenantId)}` +
            `/blade/Microsoft_AAD_IAM/ManagedAppMenuBlade/Overview/objectId/` +
            encodeURIComponent(principal.id));
    }
    return (`${base}/#@${encodeURIComponent(tenantId)}` +
        `/blade/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/Overview`);
}
/**
 * True when a group is a "high blast radius" target — Tier 0 role
 * AND > `threshold` transitive members. Default threshold matches the
 * spec (10).
 */
export function isHighBlastRadiusGroup(group, threshold = 10) {
    return group.topTier === "tier0" && group.transitiveUserCount > threshold;
}
// ===========================================================================
// Sorting helpers
// ===========================================================================
/** Tier-then-name sort comparator used by the privileged-identity list. */
export function compareByTierThenName(a, b) {
    const oa = TIER_META[a.topTier].order;
    const ob = TIER_META[b.topTier].order;
    if (oa !== ob)
        return oa - ob;
    return a.displayName.localeCompare(b.displayName, undefined, {
        sensitivity: "base",
    });
}
// ===========================================================================
// Risk score (highest-privilege-first ordering)
// ===========================================================================
/**
 * Stale-membership window. A principal whose newest known activity timestamp
 * (we use `createdDateTime` for SPs as the best-available proxy) is older
 * than this is flagged as "stale" by the operator filter chip. Matches the
 * SkyArk / MicroBurst "90-day inactive admin" heuristic.
 *
 * Note: Graph's `signInActivity` endpoint would give us a true last-sign-in
 * stamp, but it requires `AuditLog.Read.All` which we deliberately do NOT
 * demand — the page degrades to "createdDateTime > 90d ago" for SPs and
 * shows "unknown" for everyone else.
 */
export const STALE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * Numerical risk score for sorting. Higher = more privileged.
 *
 * Composition:
 *   - 1000 per Tier-0 role (irreducible — one is enough to dominate).
 *   - 100 per Tier-1 role.
 *   - 10 per Tier-2 role.
 *   - 1 per Tier-3 role.
 *   - +500 if the principal is a guest holding any T0/T1 role.
 *   - +200 if any assignment is non-direct (shadow-admin lift).
 *   - +50 if the principal is a service principal.
 *
 * The score is deliberately bucketed (powers of ten between tiers) so it
 * always ranks T0 above any number of T3 holders, no matter how many.
 */
export function riskScore(principal, signalLift) {
    const weights = {
        tier0: 1000,
        tier1: 100,
        tier2: 10,
        tier3: 1,
        other: 0,
    };
    // Unique roles by id — a principal holding the same role through three
    // groups should not score 3x for it.
    const uniqueRoleTiers = new Map();
    for (const a of principal.assignments) {
        uniqueRoleTiers.set(a.roleId, a.tier);
    }
    let score = 0;
    for (const tier of uniqueRoleTiers.values())
        score += weights[tier];
    if (principal.isExternal &&
        (principal.topTier === "tier0" || principal.topTier === "tier1")) {
        score += 500;
    }
    if (principal.isShadowAdmin)
        score += 200;
    if (principal.isServicePrincipal)
        score += 50;
    // Corpus-derived signal uplift — see SIGNAL_RISK_WEIGHTS in this file
    // for the rationale (critical=1500 to dominate any T0 baseline). Caller
    // sums the SIGNAL_RISK_WEIGHTS[severity] across every active finding
    // for the principal and passes the total here. Optional so existing
    // call-sites that don't yet track signals stay correct.
    if (typeof signalLift === "number" && Number.isFinite(signalLift)) {
        score += Math.max(0, signalLift);
    }
    return score;
}
/**
 * Lookup-driven comparator factory. Sorts highest-risk principals first
 * while accounting for the corpus-signal uplift the caller already
 * computed per principal. When no lookup is provided behaves identically
 * to `compareByRiskScore`.
 *
 * Citation rationale: `_AZURE_BYPASS_PLAYBOOK.md` "Critical Defender
 * Audit Surface" — active indicators outweigh static role tier.
 */
export function compareByRiskScoreWithSignals(signalLiftById) {
    return (a, b) => {
        var _a, _b;
        const ra = riskScore(a, (_a = signalLiftById.get(a.id)) !== null && _a !== void 0 ? _a : 0);
        const rb = riskScore(b, (_b = signalLiftById.get(b.id)) !== null && _b !== void 0 ? _b : 0);
        if (ra !== rb)
            return rb - ra;
        return a.displayName.localeCompare(b.displayName, undefined, {
            sensitivity: "base",
        });
    };
}
/**
 * Risk-then-name comparator. Sorts highest-risk principals first.
 */
export function compareByRiskScore(a, b) {
    const ra = riskScore(a);
    const rb = riskScore(b);
    if (ra !== rb)
        return rb - ra; // desc — highest risk first
    return a.displayName.localeCompare(b.displayName, undefined, {
        sensitivity: "base",
    });
}
/**
 * Best-effort "stale" heuristic. Returns true when:
 *   - For SPs: `createdDateTime` is older than `STALE_THRESHOLD_MS`.
 *   - For Users: no signInName (orphaned / partially-resolved) AND not a
 *     guest. Guests are intentionally excluded because we already flag
 *     them via the `isExternal` channel.
 *
 * When we can't make a confident determination (no timestamp, no name
 * shape), we conservatively return false to avoid hiding fresh principals.
 */
export function isStalePrincipal(principal, now = Date.now()) {
    if (principal.type === "ServicePrincipal" && principal.createdDateTime) {
        const ts = new Date(principal.createdDateTime).getTime();
        if (!Number.isFinite(ts))
            return false;
        return now - ts > STALE_THRESHOLD_MS;
    }
    if (principal.type === "User" && !principal.signInName && !principal.isExternal) {
        return true;
    }
    return false;
}
// ===========================================================================
// Role-scoped portal deep-link
// ===========================================================================
/**
 * Portal deep-link to the "Assignments" blade of a specific directory role.
 * Useful for "open this role in the portal" affordances next to the role
 * chip in the expanded assignment-detail list.
 */
export function roleDeepLink(tenantId, roleId) {
    const base = "https://portal.azure.com";
    return (`${base}/#@${encodeURIComponent(tenantId)}` +
        `/blade/Microsoft_AAD_IAM/RoleMenuBlade/AdminRoles/roleId/` +
        encodeURIComponent(roleId));
}
// ===========================================================================
// Corpus-derived detection signals (defensive enumeration only)
//
// All four signal types below are READ-ONLY drift-from-baseline indicators.
// They were wired in after re-reading the curated playbooks at:
//   C:\Users\baimgprodsesa1\Desktop\New folder\_AZURE_BYPASS_PLAYBOOK.md
//     §"Critical Defender Audit Surface" items 3, 4, 5, 6, 7.
//
// Per Top-30 across the corpus:
//   A. App-role + addKey chain          — Top-30 #23 / #9
//   B. Federated identity credentials   — Top-30 #17
//   C. PIM noExpiration eligibility     — Top-30 #27
//   D. Temporary Access Pass issuance   — Top-30 #13
//
// These are NEVER invoked — the page consumes them via read-only Graph
// enumeration and surfaces deltas to the operator. No `addKey`,
// `addPassword`, role-grant, TAP-issue, or PIM-create primitives are
// reachable from this page.
// ===========================================================================
/**
 * Microsoft Graph SP app-id (well-known). Holding any "RW" Graph app-role
 * on this principal is the canonical takeover lever — see
 * `_bypass_role_grant.md` §3.1 "Application.ReadWrite.All → app-only GA".
 */
export const MICROSOFT_GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
/**
 * App-role (Graph permission) ids on the Microsoft Graph SP that, when
 * held by any third-party SP, light up the canonical
 *   `Application.ReadWrite.All` → `addKey` on Graph SP → app-only GA
 * chain. These are the well-known appRoleId GUIDs Microsoft publishes on
 * the Graph manifest.
 *
 * Citation (chain end-to-end):
 *   `_bypass_role_grant.md` §3.1, §3.2, §3.3
 *   `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #23
 *
 * Tooling references (curated index):
 *   - `dafthack/GraphRunner/GraphRunner.ps1`  — `Invoke-InjectOAuthApp`
 *   - `Gerenios/AADInternals/MSGraphAPI.ps1`  — `New-AADIntApplication`
 *   - `dirkjanm/ROADtools/roadlib/auth.py`    — FOCI / app-role enumeration
 */
export const HIGH_PRIV_GRAPH_APP_ROLES = new Map([
    // Application.ReadWrite.All
    ["1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9", "Application.ReadWrite.All"],
    // RoleManagement.ReadWrite.Directory
    ["9e3f62cf-ca93-4989-b6ce-bf83c28f9fe8", "RoleManagement.ReadWrite.Directory"],
    // Directory.ReadWrite.All
    ["19dbc75e-c2e2-444c-a770-ec69d8559fc7", "Directory.ReadWrite.All"],
    // AppRoleAssignment.ReadWrite.All
    ["06b708a9-e830-4db3-a914-8e69da51d44f", "AppRoleAssignment.ReadWrite.All"],
    // Domain.ReadWrite.All
    ["7e05723c-0bb0-42da-be95-ae9f08a6e53c", "Domain.ReadWrite.All"],
]);
/**
 * Window for "recent" credential-write detection on a privileged SP.
 * Anything added inside this window is flagged as "addKey/addPassword
 * sentinel" — matches Defender audit item 5 in the master playbook.
 */
export const RECENT_CREDENTIAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Window for "recent" TAP issuance to a privileged user. The master
 * playbook (item 3) treats this as the critical Defender audit signal
 * for "Issue temporary access pass".
 */
export const RECENT_TAP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * OIDC issuer hosts that the corpus flags as "public clouds where a
 * federated credential maps to a low-trust principal". Pointing a
 * privileged SP at one of these is the WIF backdoor pattern from
 * `_bypass_tenant_switch.md` / `_bypass_role_grant.md` §6.
 */
export const PUBLIC_FEDERATION_ISSUER_HOSTS = [
    // GitHub Actions (the canonical WIF abuse example in
    // `_bypass_role_grant.md` §6 — anyone with workflow-write on the linked
    // repo mints SP tokens).
    "token.actions.githubusercontent.com",
    "vstoken.actions.githubusercontent.com",
    // GitLab CI/CD
    "gitlab.com",
    // CircleCI
    "circleci.com",
    "oidc.circleci.com",
    // Buildkite — single-tenant cluster OIDC
    "agent.buildkite.com",
    // BitBucket Pipelines
    "api.bitbucket.org",
    // Terraform Cloud / HCP Terraform — single-tenant TFC OIDC
    "app.terraform.io",
    // Spacelift
    "spacelift.io",
    // AWS STS (cross-cloud federation to Entra)
    "sts.amazonaws.com",
    // Google identity-pool issuer (workforce federation back to Entra)
    "accounts.google.com",
    "iam.googleapis.com",
    // Atlassian Bamboo / Forge
    "api.atlassian.com",
    // CodeFresh OIDC issuer
    "oidc.codefresh.io",
    // Cloudflare Zero Trust public OIDC
    "cloudflareaccess.com",
    // JumpCloud — public OIDC IdP
    "oauth.id.jumpcloud.com",
    // ngrok hosted OIDC (red-team / dev tunnels)
    "oidc.ngrok.com",
];
// ===========================================================================
// Signal E — AAD Connect / Cloud-Sync directory-synchronization accounts
//
// Citation:
//   `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #19 (AAD Connect `Sync_*` decrypt →
//      bidirectional forest control)
//   `_bypass_mixed_chains.md` chain #1, steps 1–9 (Get-AADIntSyncCredentials
//      → DCSync → Cross-Tenant Sync push)
//   `_analysis_dirkjanm.md` (adconnectdump)
//
// What we detect: any principal that holds a privileged directory role AND
// whose display name / sign-in name matches the on-prem-sync-account shape
// AADInternals / adconnectdump target. The role-tier itself is informational;
// the OUTLIER pattern is the sync-account principal showing up as the
// principal_id on a Tier-0/Tier-1 role assignment, because the canonical
// architecture for AAD Connect Sync is for the cloud-sync account to hold
// only the built-in "Directory Synchronization Accounts" role (template id
// `d29b2b05-8046-44ba-8758-1e26182fcf32`) — anything else is drift.
// ===========================================================================
/**
 * Well-known role template id for "Directory Synchronization Accounts" — the
 * role that AAD Connect Sync's cloud-side service account holds by design.
 * Holders of THIS role are expected to be a Sync_* SP; holders of any OTHER
 * privileged role with a sync-account-shaped name are the drift indicator.
 */
export const ROLE_DIRECTORY_SYNC_ACCOUNTS = "d29b2b05-8046-44ba-8758-1e26182fcf32";
/**
 * Display-name / UPN patterns the corpus tooling uses for the cloud-side
 * sync account. AAD Connect creates `Sync_<source>_<hash>@<tenant>.onmicrosoft.com`;
 * Cloud Sync creates `ADToAADSyncServiceAccount@<tenant>...`; on-prem MSOL
 * accounts use `MSOL_<hash>` (rare but seen on legacy DirSync).
 */
const SYNC_ACCOUNT_PATTERNS = [
    /^sync_/i,
    /^msol_/i,
    /adtoaadsyncserviceaccount/i,
    /on-?premises directory synchronization/i,
];
/**
 * True when the principal looks like an AAD Connect / Cloud Sync service
 * account based on its display name OR sign-in name (UPN / appId).
 */
export function looksLikeSyncAccount(displayName, signInName) {
    const hay = `${displayName !== null && displayName !== void 0 ? displayName : ""} ${signInName !== null && signInName !== void 0 ? signInName : ""}`;
    return SYNC_ACCOUNT_PATTERNS.some((re) => re.test(hay));
}
/**
 * Severity for a sync-account finding. A sync account holding the canonical
 * Directory Sync Accounts role only is informational; any additional T0 role
 * is critical; T1/T2 are high/medium.
 *
 * Citation: `_AZURE_BYPASS_PLAYBOOK.md` #19 — the corpus framing is that a
 * compromised sync account is "bidirectional forest control", so we lift
 * severity aggressively when ANY non-canonical privileged role is held.
 */
export function gradeSyncAccount(finding) {
    if (!finding.hasDriftRole)
        return "info";
    if (finding.topDriftTier === "tier0")
        return "critical";
    if (finding.topDriftTier === "tier1")
        return "high";
    if (finding.topDriftTier === "tier2")
        return "medium";
    return "info";
}
// ===========================================================================
// Signal F — Mixed-chain temporal correlation
//
// Citation:
//   `_bypass_mixed_chains.md` — chain composition primitives (recent
//   credential write + TAP issuance + PIM eligibility within a tight window
//   on the same principal is the kill-chain signature).
//   `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #23 + #13.
//
// Detection: any principal that exhibits two or more critical-grade indicators
// (Signal A recent-cred, Signal C noExpiration PIM, Signal D recent-TAP)
// inside MIXED_CHAIN_WINDOW_MS. The temporal coincidence is the alarm — one
// indicator alone is suspicious; two on the same principal within hours is
// the kill chain firing.
// ===========================================================================
/**
 * Coincidence window for the mixed-chain detector. Anything tighter than 24h
 * is the corpus "kill-chain firing" signature.
 */
export const MIXED_CHAIN_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Build mixed-chain findings from the four single-signal sets. Each input
 * is the already-graded finding array; we collapse them into per-principal
 * indicator streams and emit a MixedChainFinding when ≥ 2 indicators fall
 * inside MIXED_CHAIN_WINDOW_MS.
 *
 * Pure: returns sorted findings, no I/O.
 */
export function buildMixedChainFindings(highPrivGraphPermissions, federatedCredentials, pimEligibilities, tapIssuances, principalIndex, windowMs = MIXED_CHAIN_WINDOW_MS) {
    var _a, _b, _c, _d, _e, _f;
    const indicators = [];
    // Signal A — when the SP has a recent credential add we treat the credential
    // start time as the indicator timestamp.
    for (const f of highPrivGraphPermissions) {
        if (!f.hasRecentCredential || !f.mostRecentCredentialAt)
            continue;
        indicators.push({
            principalId: f.servicePrincipalId,
            signal: "A",
            at: f.mostRecentCredentialAt,
            label: `Recent credential add on SP "${f.servicePrincipalDisplayName}"`,
            severity: gradeHighPrivGraphPermission(f),
        });
    }
    // Signal B — federated credential on a SP whose Signal A also recently
    // received a credential. We use createdDateTime is not exposed for FIC, so
    // we conservatively skip B from the temporal chain unless the SP also has
    // recent credentials — in which case we use that timestamp.
    const recentCredTsBySp = new Map();
    for (const f of highPrivGraphPermissions) {
        if (f.hasRecentCredential && f.mostRecentCredentialAt) {
            recentCredTsBySp.set(f.servicePrincipalId, f.mostRecentCredentialAt);
        }
    }
    for (const f of federatedCredentials) {
        if (!f.isPublicIssuer)
            continue;
        const ts = recentCredTsBySp.get(f.servicePrincipalId);
        if (!ts)
            continue;
        indicators.push({
            principalId: f.servicePrincipalId,
            signal: "B",
            at: ts,
            label: `Public-issuer federated credential "${f.name}" on same SP`,
            severity: gradeFederatedCredential(f, true),
        });
    }
    // Signal C — PIM eligibility createdDateTime is the indicator timestamp.
    for (const f of pimEligibilities) {
        if (!f.createdDateTime)
            continue;
        indicators.push({
            principalId: f.principalId,
            signal: "C",
            at: f.createdDateTime,
            label: `PIM eligibility ${f.expirationKind === "noExpiration" ? "(noExpiration) " : ""}for ${(_a = f.roleDisplayName) !== null && _a !== void 0 ? _a : "(role)"}`,
            severity: gradePimEligibility(f),
        });
    }
    // Signal D — TAP startDateTime is the indicator timestamp.
    for (const f of tapIssuances) {
        if (!f.startDateTime)
            continue;
        indicators.push({
            principalId: f.userId,
            signal: "D",
            at: f.startDateTime,
            label: `TAP issued (${(_b = f.lifetimeInMinutes) !== null && _b !== void 0 ? _b : "?"} min lifetime)`,
            severity: gradeTapIssuance(f),
        });
    }
    // Group by principal, sort each list by timestamp, sliding-window detect.
    const byPrincipal = new Map();
    for (const ind of indicators) {
        const list = (_c = byPrincipal.get(ind.principalId)) !== null && _c !== void 0 ? _c : [];
        list.push(ind);
        byPrincipal.set(ind.principalId, list);
    }
    const out = [];
    for (const [principalId, list] of byPrincipal.entries()) {
        if (list.length < 2)
            continue;
        list.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
        // Find any windowMs-window covering ≥ 2 indicators on distinct signal letters.
        let lo = 0;
        for (let hi = 1; hi < list.length; hi++) {
            const hiT = new Date(list[hi].at).getTime();
            while (lo < hi && hiT - new Date(list[lo].at).getTime() > windowMs) {
                lo++;
            }
            const slice = list.slice(lo, hi + 1);
            const distinctSignals = new Set(slice.map((x) => x.signal));
            if (distinctSignals.size >= 2) {
                const principal = principalIndex.get(principalId);
                const spanMs = new Date(slice[slice.length - 1].at).getTime() -
                    new Date(slice[0].at).getTime();
                // Composite severity: critical if any contributor is critical or 3+
                // distinct signals; high if any high; else medium.
                const hasCritical = slice.some((x) => x.severity === "critical");
                const hasHigh = slice.some((x) => x.severity === "high");
                const severity = hasCritical || distinctSignals.size >= 3
                    ? "critical"
                    : hasHigh
                        ? "high"
                        : "medium";
                out.push({
                    id: `mixed:${principalId}:${lo}:${hi}`,
                    principalId,
                    principalDisplayName: (_d = principal === null || principal === void 0 ? void 0 : principal.displayName) !== null && _d !== void 0 ? _d : principalId,
                    principalSignInName: principal === null || principal === void 0 ? void 0 : principal.signInName,
                    principalType: (_e = principal === null || principal === void 0 ? void 0 : principal.type) !== null && _e !== void 0 ? _e : "Unknown",
                    principalTier: (_f = principal === null || principal === void 0 ? void 0 : principal.topTier) !== null && _f !== void 0 ? _f : "other",
                    indicators: slice.map((_a) => {
                        var { principalId: _id } = _a, rest = __rest(_a, ["principalId"]);
                        return rest;
                    }),
                    severity,
                    spanMs,
                });
                // Advance lo past this window to avoid duplicate emissions on the
                // same group of indicators (one chain per principal is enough).
                lo = hi + 1;
            }
        }
    }
    // Sort: critical first, then narrower spans first (tighter coincidence
    // is more alarming), then by principal display name.
    out.sort((a, b) => {
        const sevOrder = {
            critical: 0,
            high: 1,
            medium: 2,
            info: 3,
        };
        const sa = sevOrder[a.severity];
        const sb = sevOrder[b.severity];
        if (sa !== sb)
            return sa - sb;
        if (a.spanMs !== b.spanMs)
            return a.spanMs - b.spanMs;
        return a.principalDisplayName.localeCompare(b.principalDisplayName, undefined, { sensitivity: "base" });
    });
    return out;
}
/**
 * Severity for a PIM-for-Groups finding. noExpiration + T0 group = critical;
 * any T0 group = high; T1 group = medium; otherwise info.
 */
export function gradePimGroupEligibility(finding) {
    if (finding.isCriticalTimeBomb)
        return "critical";
    if (finding.topTier === "tier0")
        return "high";
    if (finding.topTier === "tier1")
        return "medium";
    return "info";
}
/**
 * Best-effort parse of an OIDC issuer URL down to its hostname. Tolerates
 * issuers stored without a scheme (some tenants record `github.com` not
 * `https://github.com`).
 */
export function issuerHost(issuer) {
    if (!issuer)
        return "";
    const trimmed = issuer.trim();
    if (!trimmed)
        return "";
    try {
        return new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
    }
    catch (_a) {
        return trimmed.toLowerCase();
    }
}
/**
 * True when `issuer` resolves to a host in PUBLIC_FEDERATION_ISSUER_HOSTS.
 * Used by Signal B grading.
 */
export function isPublicFederationIssuer(issuer) {
    const host = issuerHost(issuer);
    if (!host)
        return false;
    return PUBLIC_FEDERATION_ISSUER_HOSTS.some((h) => host === h || host.endsWith("." + h));
}
export const SEVERITY_META = {
    critical: {
        label: "Critical",
        description: "Matches a high-confidence corpus indicator on a Tier-0 principal. Investigate today.",
        badgeVariant: "destructive",
    },
    high: {
        label: "High",
        description: "Matches a corpus indicator on a Tier-0/Tier-1 principal, or a Tier-0 indicator with recency.",
        badgeVariant: "warning",
    },
    medium: {
        label: "Medium",
        description: "Drift-from-baseline indicator that warrants periodic review.",
        badgeVariant: "info",
    },
    info: {
        label: "Info",
        description: "Worth keeping in inventory; no immediate action implied.",
        badgeVariant: "secondary",
    },
};
/**
 * Severity for a Signal-A finding (high-privilege Graph permissions on SP).
 *
 * - critical when there's a recent credential ON TOP OF Application.RW.All
 *   or RoleManagement.RW.Directory (the canonical chain about to fire).
 * - high when the SP holds a chainable permission set.
 * - medium otherwise (single permission, no recent cred).
 */
export function gradeHighPrivGraphPermission(finding) {
    const names = new Set(finding.permissions.map((p) => p.permissionName));
    const isCanonicalChain = names.has("Application.ReadWrite.All") ||
        names.has("RoleManagement.ReadWrite.Directory") ||
        names.has("AppRoleAssignment.ReadWrite.All");
    if (isCanonicalChain && finding.hasRecentCredential)
        return "critical";
    if (isCanonicalChain)
        return "high";
    if (names.size >= 2)
        return "high";
    return "medium";
}
/**
 * Severity for a Signal-B finding (federated credentials).
 *
 * Public OIDC issuer on a high-privilege SP is the WIF backdoor shape —
 * `_bypass_role_grant.md` §6. Tagged "high" by default; "critical" when
 * combined with a recent credential add on the same SP (caller passes
 * `companionAddKeyRecent`).
 */
export function gradeFederatedCredential(finding, companionAddKeyRecent) {
    if (finding.isPublicIssuer && companionAddKeyRecent)
        return "critical";
    if (finding.isPublicIssuer)
        return "high";
    return "medium";
}
/**
 * Severity for a Signal-C finding (PIM eligibility).
 *
 * `noExpiration` on Tier-0 is the time-bomb pattern from
 * `_bypass_staged_pim.md` §5.1 — always critical.
 */
export function gradePimEligibility(finding) {
    if (finding.expirationKind === "noExpiration") {
        if (finding.tier === "tier0")
            return "critical";
        if (finding.tier === "tier1")
            return "high";
        return "medium";
    }
    if (finding.tier === "tier0")
        return "medium";
    return "info";
}
/**
 * Severity for a Signal-D finding (recent TAP).
 *
 * A TAP issued to a Tier-0 principal in the last 30 days is the canonical
 * "MFA-equivalent persistence pass" pattern — `_AZURE_BYPASS_PLAYBOOK.md`
 * item 3.
 */
export function gradeTapIssuance(finding) {
    if (finding.isRecentToTierZero && finding.userTier === "tier0") {
        return "critical";
    }
    if (finding.userTier === "tier0" || finding.userTier === "tier1") {
        return "high";
    }
    return "medium";
}
/**
 * Per-signal risk uplift folded into the matrix scoring so flagged
 * principals sort up the privileged-identity list. Each weight is
 * deliberately bucketed (powers-of-ten between severities) so a single
 * critical indicator always outranks any pile of mediums.
 *
 * The numbers below intentionally land between the existing T0 (1000)
 * and T1 (100) tiers used by `riskScore` so a critical indicator on a
 * Tier-1 principal still escalates above a Tier-0 with no findings —
 * matching the corpus framing where active indicators of compromise
 * trump static role tier.
 */
export const SIGNAL_RISK_WEIGHTS = {
    critical: 1500,
    high: 400,
    medium: 60,
    info: 5,
};
// ===========================================================================
// Operator-curated Tier-0 watchlist
//
// The Tier-0 watchlist is a manually-maintained set of object ids the
// operator wants to monitor for drift between probes — added during a probe
// review, persisted in localStorage, used to surface a "watched principal
// changed / disappeared / gained roles" alert on the next probe.
//
// This complements (does NOT replace) the auto-detected Tier-0 set. Common
// uses:
//   - A new SP that the operator vetted: add to watchlist so any future role
//     change is flagged.
//   - An emergency break-glass account: keep on the watchlist to catch
//     unintended role removal.
//   - A guest admin who was supposed to leave: flag dropouts.
// ===========================================================================
/**
 * localStorage key prefix for the watchlist. Tenant-id is appended so each
 * tenant maintains its own list. Schema versioned via usePersistedState.
 */
export const TIER0_WATCHLIST_STORAGE_KEY_PREFIX = "privileged-audit:watchlist";
export const EMPTY_WATCHLIST = { entries: [] };
/**
 * Compute the drift kind for each watchlist entry against the current probe.
 * Roles are compared by template id; tier is compared by `TIER_META.order`.
 *
 * Pure: no side effects, no I/O.
 */
export function computeWatchlistDrift(watchlist, currentPrincipals, capturedRolesByPrincipalId) {
    const byId = new Map(currentPrincipals.map((p) => [p.id, p]));
    const out = [];
    for (const entry of watchlist.entries) {
        const current = byId.get(entry.principalId);
        if (!current) {
            out.push({
                entry,
                current: undefined,
                kind: "missing",
                explanation: "Watched principal not present in current probe — it was deleted, " +
                    "lost all privileged roles, or moved tenants.",
            });
            continue;
        }
        const prevOrder = TIER_META[entry.capturedTier].order;
        const nowOrder = TIER_META[current.topTier].order;
        if (nowOrder < prevOrder) {
            out.push({
                entry,
                current,
                kind: "tier-up",
                explanation: `Tier escalated: ${TIER_META[entry.capturedTier].label} → ${TIER_META[current.topTier].label}`,
            });
            continue;
        }
        if (nowOrder > prevOrder) {
            out.push({
                entry,
                current,
                kind: "tier-down",
                explanation: `Tier de-escalated: ${TIER_META[entry.capturedTier].label} → ${TIER_META[current.topTier].label}`,
            });
            continue;
        }
        const captured = capturedRolesByPrincipalId.get(entry.principalId);
        if (captured) {
            const currentRoleIds = new Set(current.assignments.map((a) => a.roleTemplateId));
            const added = [];
            const removed = [];
            for (const r of currentRoleIds)
                if (!captured.has(r))
                    added.push(r);
            for (const r of captured)
                if (!currentRoleIds.has(r))
                    removed.push(r);
            if (added.length > 0) {
                out.push({
                    entry,
                    current,
                    kind: "new-role",
                    explanation: `Gained ${added.length} role${added.length === 1 ? "" : "s"} since capture.`,
                });
                continue;
            }
            if (removed.length > 0) {
                out.push({
                    entry,
                    current,
                    kind: "role-removed",
                    explanation: `Lost ${removed.length} role${removed.length === 1 ? "" : "s"} since capture.`,
                });
                continue;
            }
        }
        out.push({
            entry,
            current,
            kind: "unchanged",
            explanation: "No tier or role change since capture.",
        });
    }
    // Order: alerts first (anything other than unchanged), then by name.
    const driftOrder = {
        missing: 0,
        "tier-up": 1,
        "role-removed": 2,
        "new-role": 3,
        "tier-down": 4,
        unchanged: 5,
    };
    out.sort((a, b) => {
        if (driftOrder[a.kind] !== driftOrder[b.kind]) {
            return driftOrder[a.kind] - driftOrder[b.kind];
        }
        return a.entry.capturedDisplayName.localeCompare(b.entry.capturedDisplayName, undefined, { sensitivity: "base" });
    });
    return out;
}
/**
 * Audit-log action prefix the watchlist + critical-findings UI use so other
 * pages can correlate. Stable string so any "audit log" page can `startsWith`
 * to filter privileged-audit events.
 */
export const PRIVILEGED_AUDIT_ACTION_PREFIX = "privileged_audit_";
//# sourceMappingURL=privileged-audit-helpers.js.map