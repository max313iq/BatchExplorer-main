/**
 * Tenant Baseline helpers — pure functions for the defensive auditor.
 *
 * The page calls Microsoft Graph (read-only) and feeds the raw JSON
 * responses into the classifiers here. Keeping the logic pure makes the
 * audit explainable (the same JSON always produces the same finding) and
 * lets us unit-test severity scoring without spinning up an MSAL session.
 *
 * Inspired by AADInternals' read-only audit cmdlets — specifically the
 * pattern of probing tenant-wide config (Get-AADIntTenantDetails,
 * Get-AADIntTenantDomains, Get-AADIntTenantAuthPolicy) and flagging
 * known-bad defaults. Everything here uses public Microsoft Graph v1.0
 * endpoints; nothing touches the undocumented provisioning APIs the
 * offensive cmdlets reach for.
 */
/** Severity tiers for a baseline finding or an SP credential row. */
export type BaselineSeverity = "ok" | "info" | "low" | "medium" | "high" | "critical" | "unknown";
/** Stable identifier for each tenant-baseline check.
 *
 * Two corpus-derived defender signals extend the original six checks:
 *
 *   - "federation-backdoor-drift": per-federated-domain detector that
 *     surfaces issuer URI + signing certificate + recent-modification
 *     posture. Critical when a *new* federated domain appears since the
 *     saved baseline (the canonical AADInternals `ConvertTo-Backdoor`
 *     persistence technique). Detection inspired by:
 *       New folder/_AZURE_BYPASS_PLAYBOOK.md "Critical Defender Audit
 *         Surface" item 1 (`Set domain authentication` audit event) and
 *         "Top 30 Techniques" #30 (Federated domain backdoor).
 *       New folder/_analysis_aadinternals.md §2.4 "The Federation Backdoor
 *         (`ConvertTo-Backdoor`)".
 *       New folder/_bypass_tenant_switch.md "12 chains" #6 (External-IdP
 *         federation backdoor).
 *
 *   - "ca-policy-drift": per-policy CA enumeration that surfaces state,
 *     exclusion-set size, role-exclusion-for-Global-Admin, and the
 *     last-modified timestamp. Detection inspired by:
 *       New folder/_AZURE_BYPASS_PLAYBOOK.md "Critical Defender Audit
 *         Surface" item 2 (`Update conditional access policy` audit event).
 *       New folder/_analysis_dirkjanm.md (ROADrecon CA enumeration —
 *         `/identity/conditionalAccess/policies`).
 */
export type BaselineCheckId = "security-defaults" | "guest-invite-policy" | "default-user-permissions" | "domains-federation" | "federation-backdoor-drift" | "ca-policy-drift" | "onprem-sync" | "password-protection";
/** Result of evaluating a single baseline check. */
export interface BaselineFinding {
    /** Stable id for keying React lists + audit details. */
    id: BaselineCheckId;
    /** Human-readable check name. */
    name: string;
    /** Severity tier. `unknown` when the probe failed for a reason
     *  we attribute to "permissions" rather than "broken tenant". */
    severity: BaselineSeverity;
    /** One-line status summary shown next to the check name. */
    summary: string;
    /** Plain-language explanation of why the finding matters. */
    whyItMatters: string;
    /**
     * Concrete remediation steps the operator can follow — az CLI snippets
     * and/or Azure Portal paths. Newline-separated paragraphs.
     */
    remediation: string;
    /** The raw Graph response we used to derive the finding. May be undefined
     *  when the probe couldn't even start (e.g. token failure). */
    raw?: unknown;
    /** Set when the probe failed in a way we want to surface to the user. */
    error?: string;
}
/** Severity for a single SP row in the credentials tab. */
export type SpSeverity = BaselineSeverity;
/** Service-principal classification for the type chip. */
export type SpType = "ManagedIdentity" | "Application" | "Legacy" | "Unknown";
/** Subset of a Graph servicePrincipal we care about. */
export interface GraphServicePrincipalRaw {
    id?: string;
    displayName?: string | null;
    appId?: string | null;
    servicePrincipalType?: string | null;
    accountEnabled?: boolean | null;
    createdDateTime?: string | null;
    keyCredentials?: GraphCredentialRaw[] | null;
    passwordCredentials?: GraphCredentialRaw[] | null;
}
export interface GraphCredentialRaw {
    keyId?: string | null;
    displayName?: string | null;
    customKeyIdentifier?: string | null;
    endDateTime?: string | null;
    startDateTime?: string | null;
    usage?: string | null;
    type?: string | null;
}
/**
 * Normalized form of a credential — endDate is always present (we
 * default to null if Graph omitted it, which keeps downstream code from
 * crashing on a misshapen response).
 */
export interface NormalizedCredential {
    keyId: string;
    displayName: string;
    /** "password" for passwordCredentials, "key" for keyCredentials. */
    kind: "password" | "key";
    /** Null when the credential has no expiry — extremely rare. */
    endDateTime: string | null;
    startDateTime: string | null;
    /** "Sign" / "Verify" for keys; "" for passwords. */
    usage: string;
    /** "AsymmetricX509Cert" / "Symmetric" for keys; "" for passwords. */
    type: string;
}
/** Result of scoring a single SP. */
export interface SpScoredRow {
    id: string;
    displayName: string;
    appId: string;
    type: SpType;
    accountEnabled: boolean;
    createdDateTime: string | null;
    credentials: NormalizedCredential[];
    totalCredentials: number;
    earliestExpiry: string | null;
    daysUntilEarliestExpiry: number | null;
    hasExpired: boolean;
    hasAdminRole: boolean;
    /** Severity computed from the credential set + admin role. */
    severity: SpSeverity;
    /** Plain-language one-liner shown next to the severity badge. */
    severitySummary: string;
}
/** Constants — kept module-scoped so callers + tests can reuse them. */
export declare const EXPIRY_WINDOW_HIGH_DAYS = 7;
export declare const EXPIRY_WINDOW_MEDIUM_DAYS = 30;
/**
 * Set of directory-role template GUIDs we treat as "Tier 0" — credentials
 * for an SP holding any of these warrant a Critical bump.
 *
 * Source: https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference
 *
 * The two roles below are the de-facto top of the tenant trust pyramid.
 * Anything else (e.g. Application Administrator, Cloud Application
 * Administrator) is dangerous but treated as "high" not "critical" — the
 * spec only asks for these two by name.
 */
export declare const TIER_ZERO_ROLE_TEMPLATE_IDS: ReadonlySet<string>;
/**
 * Compute (target - now) in days, rounded DOWN. Returns null when the
 * input is missing/unparseable so callers can decide how to render a
 * "credential never expires" row.
 */
export declare function daysUntil(endDateTime: string | null | undefined, now?: Date): number | null;
/**
 * Compare ISO timestamps; null sorts AFTER any valid date so SPs with a
 * "never expires" credential drop to the bottom of an asc-by-expiry sort.
 */
export declare function compareIsoDates(a: string | null, b: string | null): number;
export declare function compareSeverityDesc(a: BaselineSeverity, b: BaselineSeverity): number;
export declare function normalizeCredentials(sp: GraphServicePrincipalRaw): NormalizedCredential[];
/** Classify the SP type for the chip column. */
export declare function classifySpType(sp: GraphServicePrincipalRaw): SpType;
export interface ScoreSpInput {
    sp: GraphServicePrincipalRaw;
    /** Whether the SP is in a Tier 0 directory role. */
    hasAdminRole: boolean;
    now?: Date;
}
/**
 * Score a single service-principal row.
 *
 * Decision tree (in priority order):
 *
 *   1. Tier 0 admin role AND any expired/expiring (<7d) credential → critical
 *   2. Any expired credential AND accountEnabled              → critical
 *   3. Earliest expiry < 7 days                                → high
 *   4. Earliest expiry < 30 days                               → medium
 *   5. No credentials at all                                   → info
 *   6. Everything else                                          → ok
 */
export declare function scoreServicePrincipal(input: ScoreSpInput): SpScoredRow;
/**
 * The `identitySecurityDefaultsEnforcementPolicy` shape we care about.
 */
export interface SecurityDefaultsPolicyRaw {
    id?: string;
    isEnabled?: boolean | null;
}
export interface ScoreSecurityDefaultsInput {
    policy: SecurityDefaultsPolicyRaw | null;
    /**
     * Whether the caller could detect at least one Conditional Access
     * policy. We treat "security defaults off + at least one CA" as
     * acceptable (the standard "we run our own CA stack" posture); without
     * either, the tenant has no MFA / legacy-auth protection at all.
     */
    hasAnyConditionalAccess: boolean | null;
}
export declare function scoreSecurityDefaults(input: ScoreSecurityDefaultsInput): BaselineFinding;
/** Subset of `/policies/authorizationPolicy` we consume. */
export interface AuthorizationPolicyRaw {
    id?: string;
    allowInvitesFrom?: string | null;
    allowedToSignUpEmailBasedSubscriptions?: boolean | null;
    defaultUserRolePermissions?: {
        allowedToCreateApps?: boolean | null;
        allowedToCreateSecurityGroups?: boolean | null;
        allowedToCreateTenants?: boolean | null;
        allowedToReadOtherUsers?: boolean | null;
    } | null;
}
/**
 * Guest invite + member sign-up sub-policy. We split this off from the
 * "default user permissions" finding because the remediation paths are
 * different (one is in External Identities, the other in User settings).
 */
export declare function scoreGuestInvitePolicy(policy: AuthorizationPolicyRaw | null): BaselineFinding;
/**
 * Default user role permissions — what a plain "member" can do without
 * any directory role.
 */
export declare function scoreDefaultUserPermissions(policy: AuthorizationPolicyRaw | null): BaselineFinding;
/** Verified-domain entry shape we consume. */
export interface DomainRaw {
    id?: string;
    authenticationType?: string | null;
    isDefault?: boolean | null;
    isVerified?: boolean | null;
    supportedServices?: string[] | null;
}
/**
 * `internalDomainFederation` resource shape returned by
 * `GET /domains/{id}/federationConfiguration`.
 *
 * Field names mirror Microsoft Graph's published schema; not every tenant
 * returns every field, hence everything is optional.
 *
 * Detection inspired by:
 *   New folder/_analysis_aadinternals.md §2.4 — `ConvertTo-Backdoor` sets
 *     `issuerUri` + signing key on a freshly-added federated domain.
 */
export interface FederationConfigRaw {
    id?: string;
    displayName?: string | null;
    issuerUri?: string | null;
    metadataExchangeUri?: string | null;
    passiveSignInUri?: string | null;
    preferredAuthenticationProtocol?: string | null;
    signingCertificate?: string | null;
    /** "Primary" | "Secondary" */
    signingCertificateUpdateStatus?: {
        certificateUpdateResult?: string | null;
        lastRunDateTime?: string | null;
    } | null;
    /** When the federation config was last modified. ISO timestamp. */
    modifiedDateTime?: string | null;
}
/** Result of per-domain federation enrichment used by Signal A. */
export interface FederatedDomainEntry {
    /** The domain name itself (`/domains/{id}` is the verified DNS suffix). */
    domain: string;
    /** Whether this is the tenant's `isDefault` domain. */
    isDefault: boolean;
    /** Per-domain federationConfiguration payload, when retrievable. */
    config: FederationConfigRaw | null;
    /** Set when the federationConfiguration probe failed. */
    configError: string | null;
}
/**
 * Domain federation — any federated non-Managed domain is flagged. Some
 * tenants legitimately federate (e.g. ADFS-backed customers), so this is
 * "High, please review" not "Critical".
 */
export declare function scoreDomainsFederation(domains: DomainRaw[] | null): BaselineFinding;
/**
 * Signal A — Federation backdoor detector.
 *
 * Defenders need a per-domain view that surfaces:
 *   - which domains are Federated (vs Managed)
 *   - their declared issuer URI (a fresh `https://attacker.tld/sts` is the
 *     loudest possible signal of `ConvertTo-Backdoor`)
 *   - whether the federation config was modified recently (last 30 days)
 *   - presence of a signing certificate (any federated domain MUST have
 *     one — its absence is itself suspicious)
 *
 * Severity framing (per corpus risk model):
 *   - critical: federation config was modified in the last 30 days. The
 *     `Set domain authentication` audit event is the #1 defender alert in
 *     `_AZURE_BYPASS_PLAYBOOK.md` "Critical Defender Audit Surface".
 *   - high:    federated domain present but config modification is older
 *     (still warrants verification — the IdP could have been backdoored
 *     long before).
 *   - medium:  configuration not retrievable (permissions gap); fall-through
 *     to the legacy domain-federation finding.
 *   - ok:      no federated domains in the tenant.
 *
 * Detection inspired by:
 *   New folder/_AZURE_BYPASS_PLAYBOOK.md "Critical Defender Audit Surface"
 *     item 1 ("`Set domain authentication` audit event").
 *   New folder/_analysis_aadinternals.md §2.4 "The Federation Backdoor
 *     (`ConvertTo-Backdoor`)".
 */
export interface ScoreFederationBackdoorInput {
    /** Per-federated-domain enrichment entries (config + errors). */
    entries: FederatedDomainEntry[];
    /** Wall clock — injectable for unit-tests. */
    now?: Date;
    /** Threshold for treating a federation change as "recent". */
    recentChangeWindowDays?: number;
}
export declare const FEDERATION_RECENT_CHANGE_WINDOW_DAYS = 30;
export declare function scoreFederationBackdoorDrift(input: ScoreFederationBackdoorInput): BaselineFinding;
/**
 * Signal B — Conditional Access policy drift detector.
 *
 * Per-policy enumeration of `/identity/conditionalAccess/policies`. We pull
 * out the small set of fields a defender actually cares about:
 *
 *   - `state` (enabled / disabled / reportOnly): a recently flipped-to-
 *     disabled policy is one of the loudest attack signals (the canonical
 *     `Update conditional access policy` audit event in the playbook).
 *   - `conditions.users.excludeUsers/excludeGroups/excludeRoles`: an
 *     attacker who can edit CA policies typically adds themselves (or a
 *     planted group) to an exclusion list. A policy that excludes
 *     `Global Administrator` is the classic attacker bypass — the
 *     legitimate "break-glass account" exclusion is normally pinned to
 *     specific user IDs, not the role.
 *   - `modifiedDateTime`: any policy modified inside the change window
 *     warrants attention.
 *
 * Severity framing (per corpus risk model):
 *   - critical: a policy excludes the Global Administrator role
 *     (`62e90394-69f5-4237-9190-012177145e10`) — the most common attacker
 *     bypass shape, per `_AZURE_BYPASS_PLAYBOOK.md` and `_bypass_login.md`.
 *   - high:    a policy in `enabledForReportingButNotEnforced` whose name
 *     looks like a primary MFA policy (likely silently disabled), or any
 *     policy modified in the change window.
 *   - medium:  many disabled policies — broad weakening of posture.
 *   - ok:      everything enabled, no recent edits, no role exclusions.
 *   - unknown: enumeration failed (permissions gap).
 *
 * Detection inspired by:
 *   New folder/_AZURE_BYPASS_PLAYBOOK.md "Critical Defender Audit Surface"
 *     item 2 (`Update conditional access policy` audit event).
 *   New folder/_analysis_dirkjanm.md (ROADrecon enumerates the same
 *     endpoint via `/identity/conditionalAccess/policies`).
 */
/**
 * Subset of `/identity/conditionalAccess/policies` we consume.
 *
 * Graph returns more nested structure; we only project what the scorer
 * needs to surface signal. The page also persists this projection — keeping
 * it narrow keeps the snapshot envelope small.
 */
export interface ConditionalAccessPolicyRaw {
    id?: string;
    displayName?: string | null;
    /** "enabled" | "disabled" | "enabledForReportingButNotEnforced" */
    state?: string | null;
    createdDateTime?: string | null;
    modifiedDateTime?: string | null;
    conditions?: {
        users?: {
            excludeUsers?: string[] | null;
            excludeGroups?: string[] | null;
            excludeRoles?: string[] | null;
        } | null;
    } | null;
}
export interface ScoreCaPolicyDriftInput {
    policies: ConditionalAccessPolicyRaw[] | null;
    policiesError: string | null;
    /** Wall clock — injectable for unit-tests. */
    now?: Date;
    /** Treat policy modifications inside this window as "recent". */
    recentChangeWindowDays?: number;
}
export declare const CA_POLICY_RECENT_CHANGE_WINDOW_DAYS = 14;
export declare function scoreCaPolicyDrift(input: ScoreCaPolicyDriftInput): BaselineFinding;
/** Subset of `/organization[0]` we consume. */
export interface OrganizationRaw {
    id?: string;
    displayName?: string | null;
    onPremisesSyncEnabled?: boolean | null;
    onPremisesLastSyncDateTime?: string | null;
}
/**
 * On-prem sync — informational only. Surfaces whether AAD Connect is
 * configured and the last successful sync time.
 */
export declare function scoreOnPremSync(org: OrganizationRaw | null): BaselineFinding;
/**
 * Password protection / banned-password lists — Graph exposes this via
 * `/domains/{tenant}/policies/passwordValidationPolicies`. Most tenants
 * 403 on this without `Policy.Read.All`, so the helper accepts either a
 * partial response or a `policyError` string and returns an informative
 * finding either way.
 */
export interface PasswordProtectionInput {
    policy: unknown;
    policyError: string | null;
}
export declare function scorePasswordProtection(input: PasswordProtectionInput): BaselineFinding;
/** Map a severity tier to a Badge variant + Alert variant. */
export declare function severityToBadgeVariant(s: BaselineSeverity): "default" | "secondary" | "destructive" | "success" | "warning" | "info" | "outline";
export declare function severityLabel(s: BaselineSeverity): string;
/** Tally severities across an array of findings. */
export declare function tallySeverities(items: ReadonlyArray<{
    severity: BaselineSeverity;
}>): Record<BaselineSeverity, number>;
/**
 * Persisted snapshot envelope — what we stash in localStorage so the operator
 * can compare "what does my tenant look like NOW" vs "what was approved last
 * audit". One snapshot per tenant id (we key the persisted-state hook with
 * the tenant id), kept deliberately small (no raw Graph payloads).
 */
export interface BaselineSnapshot {
    tenantId: string;
    tenantDisplayName: string;
    capturedAt: string;
    findings: Record<BaselineCheckId, {
        severity: BaselineSeverity;
        summary: string;
    }>;
}
/** "Compared to last saved snapshot" status for a single check.
 *
 * The deep-pass added `"new-check-introduced"`: an explicit signal that
 * the snapshot pre-dates this check id. Without it, schema additions
 * (e.g. when we added `federation-backdoor-drift`) silently looked like
 * "no-baseline" — indistinguishable from "you never saved a baseline" —
 * leading operators to ignore real new signal. Distinguishing the two
 * cases lets the page render a clearer pill on the affected card.
 */
export type FindingDriftStatus = "no-baseline" | "match" | "improved" | "regressed" | "summary-changed" | "new-check-introduced";
/** Per-check drift result. */
export interface FindingDrift {
    status: FindingDriftStatus;
    /** Snapshot's recorded severity, if any. */
    baselineSeverity: BaselineSeverity | null;
    /** Snapshot's recorded summary, if any. */
    baselineSummary: string | null;
}
/**
 * Compare a freshly-collected set of findings against a saved snapshot.
 * Returns a per-id drift map. The page renders a drift chip / row tint
 * based on the result.
 */
export declare function diffAgainstSnapshot(findings: BaselineFinding[], snapshot: BaselineSnapshot | null): Map<BaselineCheckId, FindingDrift>;
/**
 * Build a snapshot envelope from the current finding set. Strips the
 * heavy `raw` Graph payloads so localStorage stays under the ~5MB quota.
 */
export declare function buildSnapshot(tenantId: string, tenantDisplayName: string, findings: BaselineFinding[]): BaselineSnapshot;
/**
 * Per-finding deep link into the Microsoft Entra admin portal. We hand-pick
 * the most useful blade per check rather than punting to a search. These
 * URLs are stable / documented and survive portal redesigns (the Entra
 * portal redirects old `aad.portal.azure.com` paths to `entra.microsoft.com`).
 */
export declare function portalLinkForFinding(id: BaselineCheckId, tenantId: string): {
    href: string;
    label: string;
};
/**
 * Per-SP deep link to the Enterprise application or App registration blade.
 * We default to the Enterprise apps view because the spec is "operator
 * checks an SP" — and that view shows credentials + role assignments
 * without requiring app-owner permissions.
 */
export declare function portalLinkForServicePrincipal(appId: string, tenantId: string): {
    href: string;
    label: string;
};
/**
 * The Microsoft cloud environment a token / endpoint belongs to.
 *
 * Detection inspired by:
 *   New folder/_AZURE_BYPASS_PLAYBOOK.md Phase 4 ("Cross-cloud: probe
 *     `login.microsoftonline.us` (Gov) and `login.partner.microsoftonline.cn`
 *     (China) for the same identity").
 *   New folder/_bypass_tenant_switch.md §8 "Sovereign / Cross-Cloud Pivots"
 *     (endpoint catalog + §8.2 "Commercial → Gov pivot" — defenders rarely
 *     correlate sign-in logs across clouds).
 */
export type AzureCloudEnvironment = "AzureCommercial" | "AzureUSGovernment" | "AzureChina" | "AzureGermany" | "Unknown";
export interface CloudEnvironmentInfo {
    environment: AzureCloudEnvironment;
    /** Human-readable label for the banner. */
    label: string;
    /** Issuer URI from the token, when parseable. */
    issuer: string | null;
    /** Best-effort raw `aud` / `appid` if we want to surface them. */
    audience: string | null;
}
/**
 * Decode the JWT body (no signature verification — purely presentational)
 * and infer which Microsoft cloud the token was issued in based on the
 * `iss` claim. Returns `Unknown` if the token cannot be parsed.
 *
 * Mapping comes from `_bypass_tenant_switch.md` §8.1 endpoint catalog —
 * the same hostnames Microsoft documents for cross-cloud routing.
 */
export declare function detectCloudEnvironmentFromToken(token: string): CloudEnvironmentInfo;
/**
 * Map an issuer URI / hostname to a Microsoft cloud environment.
 *
 * Exported so unit tests + the page banner can share the same mapping.
 */
export declare function classifyIssuer(issuer: string | null | undefined): {
    environment: AzureCloudEnvironment;
    label: string;
};
/**
 * Aggregate per-finding drift result into a small summary the page banners
 * + audit-log entries consume. Pure for testability.
 *
 * The "newly-introduced" count is the schema-evolution signal explained
 * on FindingDriftStatus — it is distinct from "regressed" so an operator
 * comparing against an old approved baseline can see at a glance whether
 * the deltas are *real* drift or just the auditor growing new checks.
 */
export interface DriftSummary {
    regressed: number;
    improved: number;
    changed: number;
    /** New check id absent from the saved baseline envelope. */
    newlyIntroduced: number;
    /** True when there is at least one regressed item. Convenience flag. */
    hasRegressions: boolean;
}
export declare function summarizeDrift(driftMap: ReadonlyMap<BaselineCheckId, FindingDrift>): DriftSummary;
/**
 * Lightweight history-timeline entry. We keep a small ring of these per
 * tenant so a defender can answer "did our posture get worse between
 * Tuesday and Friday?" without the auditor needing a backend.
 *
 * Detection inspired by:
 *   New folder/_AZURE_BYPASS_PLAYBOOK.md "Critical Defender Audit Surface"
 *   — drift on `Set domain authentication` + `Update conditional access
 *   policy` is the dominant attacker signal; a longitudinal local record
 *   makes catching slow-moving drift practical.
 */
export interface BaselineHistoryEntry {
    /** ISO timestamp when this baseline run completed. */
    capturedAt: string;
    /** Severity tally at run time (a compact heat-map). */
    tally: Record<BaselineSeverity, number>;
    /** Per-check severity at run time (omits raw / summary to keep small). */
    perCheck: Record<BaselineCheckId, BaselineSeverity>;
    /** Whether this entry was the approved baseline at the time of capture. */
    wasApproved: boolean;
}
/** Cap on the in-localStorage history ring buffer. ~10 KB max per tenant. */
export declare const BASELINE_HISTORY_LIMIT = 25;
/**
 * Append a new entry to the history ring buffer, dropping the oldest entry
 * once the cap is reached. Returns a *new* array — never mutates input.
 */
export declare function pushHistoryEntry(history: ReadonlyArray<BaselineHistoryEntry>, entry: BaselineHistoryEntry, limit?: number): BaselineHistoryEntry[];
/**
 * Build a compact per-tenant history entry from the current findings.
 * Strips raw payloads so the ring buffer stays tiny.
 */
export declare function buildHistoryEntry(findings: BaselineFinding[], wasApproved?: boolean): BaselineHistoryEntry;
/**
 * Compute the difference in severity-rank weight between two history
 * entries. Positive = posture worsened; negative = posture improved.
 * Used by the timeline component to render arrows / colour the segments.
 */
export declare function compareHistoryEntries(prev: BaselineHistoryEntry, next: BaselineHistoryEntry): {
    regressed: BaselineCheckId[];
    improved: BaselineCheckId[];
    delta: number;
};
/**
 * Compliance-evidence export envelope. The page's standard ExportMenu
 * dumps the findings table; this envelope adds the metadata an auditor's
 * "chain of custody" requires — tenant id, actor, capture timestamp,
 * tool version, and a cryptographic hash over the canonical payload.
 *
 * `evidenceHash` is computed over `canonicalizeFindingsForHash(findings)`
 * so the same findings always produce the same hash regardless of object
 * key ordering. The hash is intentionally NOT signed — local-only WebUI
 * has no signing key — but a hash committed alongside the export still
 * lets an auditor detect post-hoc tampering: any change to the JSON file
 * shifts the hash, and the operator can re-run the audit + recompute.
 */
export interface ComplianceEvidence {
    /** Stable envelope schema version — bump when shape changes. */
    schemaVersion: 1;
    /** Tenant scope captured at run time. */
    tenantId: string;
    tenantDisplayName: string;
    /** Person / account who triggered the export. */
    actor: string;
    /** ISO timestamp when the export was created. */
    capturedAt: string;
    /** Cloud env (commercial / gov / china / germany / unknown). */
    cloudEnvironment: AzureCloudEnvironment;
    /** Severity tally at export time. */
    summary: Record<BaselineSeverity, number>;
    /** Drift counters vs the approved baseline (zeros if none saved). */
    drift: DriftSummary;
    /**
     * Hex-encoded SHA-256 of `canonicalizeFindingsForHash(findings)` —
     * audit chain-of-custody anchor.
     */
    evidenceHash: string;
    /** Algorithm identifier kept verbatim in the envelope. */
    evidenceHashAlgorithm: "SHA-256";
    /** Findings (id, name, severity, summary — stripped raw payload). */
    findings: ReadonlyArray<{
        id: BaselineCheckId;
        name: string;
        severity: BaselineSeverity;
        summary: string;
        error?: string;
    }>;
}
/**
 * Produce a stable canonical JSON string suitable for hashing. We sort
 * findings by `id` and emit only the four scoring fields so the hash is
 * insensitive to React-internal ordering and to the heavy `raw` payload
 * (which is non-deterministic across tenants).
 *
 * The function is deliberately deterministic across browsers: it does
 * NOT rely on `JSON.stringify` key ordering for nested objects (we build
 * the canonical record explicitly). This means two runs against the
 * same posture produce byte-identical strings.
 */
export declare function canonicalizeFindingsForHash(findings: ReadonlyArray<BaselineFinding>): string;
/**
 * Compute SHA-256 hex digest of an arbitrary string using the WebCrypto
 * SubtleCrypto API. Returns `null` when SubtleCrypto is unavailable
 * (very old browsers / non-secure contexts) so callers can fall back to
 * an export-without-hash. We never throw from this helper.
 *
 * Browser-built-in API — no install required. Listed in MDN since 2014.
 */
export declare function computeSha256Hex(input: string): Promise<string | null>;
/**
 * Build the compliance-evidence envelope. Caller supplies the surrounding
 * context (tenant scope, actor, cloud env, drift counters); we compute
 * the canonical findings JSON + SHA-256 hash and stitch the envelope
 * together. Marked async because the hash is async.
 */
export declare function buildComplianceEvidence(input: {
    tenantId: string;
    tenantDisplayName: string;
    actor: string;
    cloudEnvironment: AzureCloudEnvironment;
    findings: ReadonlyArray<BaselineFinding>;
    drift: DriftSummary;
}): Promise<ComplianceEvidence>;
//# sourceMappingURL=tenant-baseline-helpers.d.ts.map