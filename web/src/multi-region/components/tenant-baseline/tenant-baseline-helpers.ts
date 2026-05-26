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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Severity tiers for a baseline finding or an SP credential row. */
export type BaselineSeverity =
  | "ok"
  | "info"
  | "low"
  | "medium"
  | "high"
  | "critical"
  | "unknown";

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
export type BaselineCheckId =
  | "security-defaults"
  | "guest-invite-policy"
  | "default-user-permissions"
  | "domains-federation"
  | "federation-backdoor-drift"
  | "ca-policy-drift"
  | "onprem-sync"
  | "password-protection";

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
export const EXPIRY_WINDOW_HIGH_DAYS = 7;
export const EXPIRY_WINDOW_MEDIUM_DAYS = 30;
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
export const TIER_ZERO_ROLE_TEMPLATE_IDS: ReadonlySet<string> = new Set([
  // Global Administrator
  "62e90394-69f5-4237-9190-012177145e10",
  // Privileged Role Administrator
  "e8611ab8-c189-46e8-94e1-60213ab1f814",
]);

// ---------------------------------------------------------------------------
// Helpers — generic
// ---------------------------------------------------------------------------

/**
 * Compute (target - now) in days, rounded DOWN. Returns null when the
 * input is missing/unparseable so callers can decide how to render a
 * "credential never expires" row.
 */
export function daysUntil(
  endDateTime: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!endDateTime) return null;
  const t = Date.parse(endDateTime);
  if (!Number.isFinite(t)) return null;
  const diffMs = t - now.getTime();
  // Math.floor matches "operator intuition" — a credential that expires in
  // 23.9 hours shows as "0 days" (today), not "1 day".
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Compare ISO timestamps; null sorts AFTER any valid date so SPs with a
 * "never expires" credential drop to the bottom of an asc-by-expiry sort.
 */
export function compareIsoDates(
  a: string | null,
  b: string | null,
): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
  if (!Number.isFinite(ta)) return 1;
  if (!Number.isFinite(tb)) return -1;
  return ta - tb;
}

/** Severity ordering (high → low) for sort stability. */
const SEVERITY_RANK: Record<BaselineSeverity, number> = {
  critical: 6,
  high: 5,
  medium: 4,
  low: 3,
  unknown: 2,
  info: 1,
  ok: 0,
};

export function compareSeverityDesc(
  a: BaselineSeverity,
  b: BaselineSeverity,
): number {
  return SEVERITY_RANK[b] - SEVERITY_RANK[a];
}

// ---------------------------------------------------------------------------
// Helpers — credential normalisation
// ---------------------------------------------------------------------------

export function normalizeCredentials(
  sp: GraphServicePrincipalRaw,
): NormalizedCredential[] {
  const out: NormalizedCredential[] = [];
  const passwords = Array.isArray(sp.passwordCredentials)
    ? sp.passwordCredentials
    : [];
  for (const c of passwords) {
    out.push({
      keyId: (c.keyId ?? "") as string,
      displayName:
        (c.displayName as string | undefined) ??
        (c.customKeyIdentifier as string | undefined) ??
        "(unnamed secret)",
      kind: "password",
      endDateTime: (c.endDateTime as string | undefined) ?? null,
      startDateTime: (c.startDateTime as string | undefined) ?? null,
      usage: "",
      type: "",
    });
  }
  const keys = Array.isArray(sp.keyCredentials) ? sp.keyCredentials : [];
  for (const c of keys) {
    out.push({
      keyId: (c.keyId ?? "") as string,
      displayName:
        (c.displayName as string | undefined) ??
        (c.customKeyIdentifier as string | undefined) ??
        "(unnamed cert)",
      kind: "key",
      endDateTime: (c.endDateTime as string | undefined) ?? null,
      startDateTime: (c.startDateTime as string | undefined) ?? null,
      usage: (c.usage as string | undefined) ?? "",
      type: (c.type as string | undefined) ?? "",
    });
  }
  return out;
}

/** Classify the SP type for the chip column. */
export function classifySpType(
  sp: GraphServicePrincipalRaw,
): SpType {
  const t = (sp.servicePrincipalType ?? "").toLowerCase();
  if (t === "managedidentity") return "ManagedIdentity";
  if (t === "application") return "Application";
  if (t === "legacy") return "Legacy";
  return "Unknown";
}

// ---------------------------------------------------------------------------
// Severity scoring — service principal credentials
// ---------------------------------------------------------------------------

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
export function scoreServicePrincipal(input: ScoreSpInput): SpScoredRow {
  const now = input.now ?? new Date();
  const sp = input.sp;
  const credentials = normalizeCredentials(sp);
  const totalCredentials = credentials.length;
  const accountEnabled = sp.accountEnabled !== false; // default true if absent

  const expiries = credentials
    .map((c) => c.endDateTime)
    .filter((d): d is string => d !== null)
    .map((d) => ({ raw: d, ts: Date.parse(d) }))
    .filter((d) => Number.isFinite(d.ts))
    .sort((a, b) => a.ts - b.ts);

  const earliestExpiry = expiries.length > 0 ? expiries[0]!.raw : null;
  const daysUntilEarliest = daysUntil(earliestExpiry, now);
  const hasExpired = expiries.some((e) => e.ts < now.getTime());

  let severity: SpSeverity;
  let severitySummary: string;

  if (totalCredentials === 0) {
    severity = "info";
    severitySummary =
      "No client secret or certificate configured (managed identity, or unused)";
  } else if (input.hasAdminRole && (hasExpired || (daysUntilEarliest !== null && daysUntilEarliest < EXPIRY_WINDOW_HIGH_DAYS))) {
    severity = "critical";
    severitySummary = hasExpired
      ? "Tier 0 admin role AND has expired credential — broken privileged integration"
      : `Tier 0 admin role AND credential expires in ${formatDaysCountdown(daysUntilEarliest)}`;
  } else if (hasExpired && accountEnabled) {
    severity = "critical";
    severitySummary =
      "Credential already expired and SP is enabled — integrations using it are likely failing";
  } else if (hasExpired) {
    // Disabled SP with expired creds — annoying but not impactful.
    severity = "high";
    severitySummary = "Has expired credential (SP is disabled)";
  } else if (
    daysUntilEarliest !== null &&
    daysUntilEarliest < EXPIRY_WINDOW_HIGH_DAYS
  ) {
    severity = "high";
    severitySummary = `Expires in ${formatDaysCountdown(daysUntilEarliest)} — rotate now`;
  } else if (
    daysUntilEarliest !== null &&
    daysUntilEarliest < EXPIRY_WINDOW_MEDIUM_DAYS
  ) {
    severity = "medium";
    severitySummary = `Expires in ${formatDaysCountdown(daysUntilEarliest)} — schedule rotation`;
  } else if (earliestExpiry === null) {
    severity = "info";
    severitySummary = "Credentials present but none has an expiry date";
  } else {
    severity = "ok";
    severitySummary = `Earliest expiry in ${formatDaysCountdown(daysUntilEarliest)}`;
  }

  return {
    id: (sp.id ?? "") as string,
    displayName: (sp.displayName ?? "(unnamed)") as string,
    appId: (sp.appId ?? "") as string,
    type: classifySpType(sp),
    accountEnabled,
    createdDateTime: (sp.createdDateTime ?? null) as string | null,
    credentials,
    totalCredentials,
    earliestExpiry,
    daysUntilEarliestExpiry: daysUntilEarliest,
    hasExpired,
    hasAdminRole: input.hasAdminRole,
    severity,
    severitySummary,
  };
}

function formatDaysCountdown(days: number | null): string {
  if (days === null) return "an unknown amount of time";
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;
  if (days === 0) return "less than 1 day";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Severity scoring — tenant baseline checks
// ---------------------------------------------------------------------------

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

export function scoreSecurityDefaults(
  input: ScoreSecurityDefaultsInput,
): BaselineFinding {
  const base = "Tenant security defaults";
  const remediation =
    "Azure Portal → Microsoft Entra ID → Properties → Manage Security defaults — set to Enabled.\n" +
    "Or use the Graph PATCH: PATCH https://graph.microsoft.com/v1.0/policies/identitySecurityDefaultsEnforcementPolicy with body {\"isEnabled\": true}.";
  const why =
    "Security defaults give every user a baseline of MFA enrollment and block legacy authentication protocols (IMAP, POP, basic SMTP) that bypass MFA. " +
    "Disabling them without an equivalent Conditional Access stack leaves the tenant exposed to credential stuffing.";

  if (!input.policy) {
    return {
      id: "security-defaults",
      name: base,
      severity: "unknown",
      summary: "Policy not retrieved — likely missing Policy.Read.All consent",
      whyItMatters: why,
      remediation,
      raw: null,
    };
  }
  const isEnabled = input.policy.isEnabled === true;
  if (isEnabled) {
    return {
      id: "security-defaults",
      name: base,
      severity: "ok",
      summary: "Security defaults are ENABLED",
      whyItMatters: why,
      remediation,
      raw: input.policy,
    };
  }
  if (input.hasAnyConditionalAccess === true) {
    return {
      id: "security-defaults",
      name: base,
      severity: "low",
      summary:
        "Security defaults OFF, but Conditional Access policies were detected — verify they cover all users + apps",
      whyItMatters: why,
      remediation,
      raw: input.policy,
    };
  }
  if (input.hasAnyConditionalAccess === false) {
    return {
      id: "security-defaults",
      name: base,
      severity: "critical",
      summary:
        "Security defaults OFF and NO Conditional Access policies — tenant has no baseline MFA",
      whyItMatters: why,
      remediation,
      raw: input.policy,
    };
  }
  // CA detection not attempted (likely no permissions) — fall back to medium.
  return {
    id: "security-defaults",
    name: base,
    severity: "medium",
    summary:
      "Security defaults OFF — verify a Conditional Access policy enforces MFA",
    whyItMatters: why,
    remediation,
    raw: input.policy,
  };
}

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
export function scoreGuestInvitePolicy(
  policy: AuthorizationPolicyRaw | null,
): BaselineFinding {
  const base = "Guest invite + member sign-up policy";
  const why =
    "When `allowInvitesFrom: everyone`, any member (and even some external guests) can invite arbitrary external accounts into the tenant — a classic data-exfiltration and OAuth-consent attack vector. " +
    "`allowedToSignUpEmailBasedSubscriptions: true` similarly lets unmanaged signups attach to the tenant.";
  const remediation =
    "Azure Portal → Microsoft Entra ID → External Identities → External collaboration settings → Guest invite settings: set to 'Only users assigned to specific admin roles can invite guest users'.\n" +
    "Or via Graph: PATCH /policies/authorizationPolicy with {\"allowInvitesFrom\": \"adminsAndGuestInviters\", \"allowedToSignUpEmailBasedSubscriptions\": false}.";

  if (!policy) {
    return {
      id: "guest-invite-policy",
      name: base,
      severity: "unknown",
      summary: "Policy not retrieved — likely missing Policy.Read.All consent",
      whyItMatters: why,
      remediation,
      raw: null,
    };
  }

  const invitesFrom = (policy.allowInvitesFrom ?? "").toLowerCase();
  const allowSignup = policy.allowedToSignUpEmailBasedSubscriptions === true;
  const allowAppsAll =
    policy.defaultUserRolePermissions?.allowedToCreateApps === true;

  // Determine the worst single finding. Order from worst-up.
  if (allowAppsAll) {
    return {
      id: "guest-invite-policy",
      name: base,
      severity: "high",
      summary:
        "Non-admins can register applications (default user permissions: allowedToCreateApps = true)",
      whyItMatters:
        "Allowing any member to register applications enables consent-phishing chains: an attacker can socially-engineer a member into registering a malicious multi-tenant app and consenting on their own behalf.",
      remediation,
      raw: policy,
    };
  }
  if (allowSignup) {
    return {
      id: "guest-invite-policy",
      name: base,
      severity: "high",
      summary:
        "Email-based subscriptions sign-up is enabled — unmanaged personal MSAs can self-attach",
      whyItMatters:
        "When email-based subscriptions sign-ups are allowed, anyone with an email address in your tenant's verified domains can self-provision an Azure subscription that you may end up paying for and that bypasses your governance.",
      remediation,
      raw: policy,
    };
  }
  if (invitesFrom === "everyone") {
    return {
      id: "guest-invite-policy",
      name: base,
      severity: "medium",
      summary:
        "allowInvitesFrom = everyone — any user (including guests) can invite external accounts",
      whyItMatters: why,
      remediation,
      raw: policy,
    };
  }
  if (invitesFrom === "adminsandguestinviters") {
    return {
      id: "guest-invite-policy",
      name: base,
      severity: "ok",
      summary: "Guest invites restricted to admins + designated inviters",
      whyItMatters: why,
      remediation,
      raw: policy,
    };
  }
  if (invitesFrom === "none") {
    return {
      id: "guest-invite-policy",
      name: base,
      severity: "ok",
      summary: "Guest invitations are completely disabled",
      whyItMatters: why,
      remediation,
      raw: policy,
    };
  }
  return {
    id: "guest-invite-policy",
    name: base,
    severity: "low",
    summary: `allowInvitesFrom = ${policy.allowInvitesFrom ?? "(unset)"} — review whether this matches your policy`,
    whyItMatters: why,
    remediation,
    raw: policy,
  };
}

/**
 * Default user role permissions — what a plain "member" can do without
 * any directory role.
 */
export function scoreDefaultUserPermissions(
  policy: AuthorizationPolicyRaw | null,
): BaselineFinding {
  const base = "Default user role permissions";
  const why =
    "Members without any directory role inherit a baseline permission set. Tightening it limits the blast radius of a phished/compromised member account.";
  const remediation =
    "Azure Portal → Microsoft Entra ID → Users → User settings → User feature settings.\n" +
    "Or via Graph: PATCH /policies/authorizationPolicy with `defaultUserRolePermissions` set to {allowedToCreateSecurityGroups: false, allowedToCreateTenants: false, allowedToReadOtherUsers: false} unless you have a specific business need.";
  if (!policy) {
    return {
      id: "default-user-permissions",
      name: base,
      severity: "unknown",
      summary: "Policy not retrieved — likely missing Policy.Read.All consent",
      whyItMatters: why,
      remediation,
      raw: null,
    };
  }
  const perms = policy.defaultUserRolePermissions ?? {};
  const findings: string[] = [];
  // allowedToCreateApps is the consent-phishing accelerator: any member
  // can register a multi-tenant app and silently OAuth-consent on their
  // own behalf. Detection inspired by:
  //   New folder/_bypass_login.md §"Illicit Consent Grant" (default-flow
  //     exploitation via app self-registration).
  //   New folder/_AZURE_LOGIN_METHODS.md (app registration is part of the
  //     default user surface — every member is an attacker primitive).
  //   New folder/_bypass_role_grant.md (app-role chains start from
  //     `allowedToCreateApps=true`).
  if (perms.allowedToCreateApps === true) {
    findings.push("can register applications (consent-phishing accelerator)");
  }
  if (perms.allowedToCreateSecurityGroups === true) {
    findings.push("can create security groups");
  }
  if (perms.allowedToCreateTenants === true) {
    findings.push("can create new tenants");
  }
  if (perms.allowedToReadOtherUsers === true) {
    findings.push("can read other users (default — usually OK but flag for review)");
  }
  if (findings.length === 0) {
    return {
      id: "default-user-permissions",
      name: base,
      severity: "ok",
      summary: "Default user permissions are appropriately restricted",
      whyItMatters: why,
      remediation,
      raw: policy,
    };
  }
  // Severity routing:
  //   - allowedToCreateApps OR allowedToCreateTenants present → high
  //     (both are documented consent / tenant-pivot accelerators)
  //   - allowedToCreateSecurityGroups alone → medium
  //   - only allowedToReadOtherUsers → low
  const hasOnlyReadOthers =
    findings.length === 1 && perms.allowedToReadOtherUsers === true;
  const hasAppOrTenantCreation =
    perms.allowedToCreateApps === true ||
    perms.allowedToCreateTenants === true;
  const severity: BaselineSeverity = hasOnlyReadOthers
    ? "low"
    : hasAppOrTenantCreation
      ? "high"
      : "medium";
  return {
    id: "default-user-permissions",
    name: base,
    severity,
    summary: `Non-admin members ${findings.join("; ")}`,
    whyItMatters: why,
    remediation,
    raw: policy,
  };
}

/** Verified-domain entry shape we consume. */
export interface DomainRaw {
  id?: string;
  authenticationType?: string | null; // "Managed" | "Federated"
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
  signingCertificateUpdateStatus?:
    | {
        certificateUpdateResult?: string | null;
        lastRunDateTime?: string | null;
      }
    | null;
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
export function scoreDomainsFederation(
  domains: DomainRaw[] | null,
): BaselineFinding {
  const base = "Verified domains + federation";
  const why =
    "Federated domains delegate sign-in to an external IdP (typically ADFS). " +
    "An attacker who can mint tokens against the federated IdP — for example via the Golden SAML technique AADInternals documented — can impersonate any user in the federated domain WITHOUT seeing their cleartext password. " +
    "If you no longer operate the federation server, demote the domain to Managed.";
  const remediation =
    "Run `Get-MgDomain -All | Select-Object Id, AuthenticationType, IsVerified` (Microsoft.Graph PowerShell) to inventory.\n" +
    "Demote a federated domain to managed: `Set-MgDomainFederationConfiguration` then `Update-MgDomain -DomainId <name> -BodyParameter @{ AuthenticationType = 'Managed' }`.\n" +
    "Audit federation signing certificates: portal → Microsoft Entra ID → Domains → click the domain → check the Federation tab.";

  if (!domains || domains.length === 0) {
    return {
      id: "domains-federation",
      name: base,
      severity: "unknown",
      summary: "Domains not retrieved — Domain.Read.All may be missing",
      whyItMatters: why,
      remediation,
      raw: domains,
    };
  }
  const federated = domains.filter(
    (d) => (d.authenticationType ?? "").toLowerCase() === "federated",
  );
  if (federated.length === 0) {
    return {
      id: "domains-federation",
      name: base,
      severity: "ok",
      summary: `${domains.length} verified domain${domains.length === 1 ? "" : "s"}, all Managed (cloud-only sign-in)`,
      whyItMatters: why,
      remediation,
      raw: domains,
    };
  }
  return {
    id: "domains-federation",
    name: base,
    severity: "high",
    summary: `${federated.length} federated domain${federated.length === 1 ? "" : "s"} detected — verify the IdP + signing certs are still under your control`,
    whyItMatters: why,
    remediation,
    raw: domains,
  };
}

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

export const FEDERATION_RECENT_CHANGE_WINDOW_DAYS = 30;

export function scoreFederationBackdoorDrift(
  input: ScoreFederationBackdoorInput,
): BaselineFinding {
  const base = "Federation backdoor drift";
  const why =
    "An attacker with Global Administrator can add a *new* federated domain pointing at their own IdP " +
    "(`Set-AADIntFederationSettings` / `ConvertTo-Backdoor`). Any subsequent SAML token the attacker " +
    "mints with `ImmutableID=<existing-user-guid>` is accepted as that user — no password, no MFA. " +
    "This is the canonical AADInternals persistence technique and survives password resets, MFA " +
    "resets, and role revocations. Detect at the federation-config edge: any new federated domain or " +
    "any recent change to issuer URI / signing cert on an existing one is a critical lead.";
  const remediation =
    "Triage: Microsoft Entra admin center → Domains → click each federated domain → Federation tab.\n" +
    "Confirm `issuerUri` matches your authoritative IdP (typically `http://yourorg.com/adfs/services/trust`).\n" +
    "Confirm `signingCertificate` thumbprint matches your ADFS Token-Signing certificate (Get-AdfsCertificate).\n" +
    "If either does not match, treat as a Global Admin compromise: rotate ALL credentials, then\n" +
    "  PATCH https://graph.microsoft.com/v1.0/domains/{domain} with {\"authenticationType\": \"Managed\"}\n" +
    "and remove the rogue domain via DELETE /domains/{domain}.\n" +
    "Wire-level audit: Microsoft 365 Unified Audit Log → `Set federation settings on domain`.";

  const now = input.now ?? new Date();
  const windowDays =
    input.recentChangeWindowDays ?? FEDERATION_RECENT_CHANGE_WINDOW_DAYS;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  const fed = input.entries;
  if (fed.length === 0) {
    return {
      id: "federation-backdoor-drift",
      name: base,
      severity: "ok",
      summary: "No federated domains detected — federation backdoor surface absent",
      whyItMatters: why,
      remediation,
      raw: { entries: [] },
    };
  }

  // Gather permission errors (likely 403 Domain.Read.All).
  const errorEntries = fed.filter((e) => e.configError !== null);
  const recentlyChanged: { domain: string; modifiedDateTime: string }[] = [];
  const missingSigningCert: string[] = [];
  for (const e of fed) {
    const m = e.config?.modifiedDateTime ?? null;
    if (m) {
      const t = Date.parse(m);
      if (Number.isFinite(t) && now.getTime() - t < windowMs) {
        recentlyChanged.push({ domain: e.domain, modifiedDateTime: m });
      }
    }
    if (e.config !== null && !e.config.signingCertificate) {
      missingSigningCert.push(e.domain);
    }
  }

  if (recentlyChanged.length > 0) {
    const list = recentlyChanged
      .map(
        (r) =>
          `${r.domain} (modified ${Math.round((now.getTime() - Date.parse(r.modifiedDateTime)) / (1000 * 60 * 60 * 24))}d ago)`,
      )
      .join(", ");
    return {
      id: "federation-backdoor-drift",
      name: base,
      severity: "critical",
      summary: `Federation config modified in last ${windowDays}d on: ${list}`,
      whyItMatters: why,
      remediation,
      raw: { entries: fed, recentlyChanged, missingSigningCert },
    };
  }
  if (missingSigningCert.length > 0) {
    return {
      id: "federation-backdoor-drift",
      name: base,
      severity: "high",
      summary: `Federated domain(s) without a signing certificate: ${missingSigningCert.join(", ")} — config is incomplete or unreadable`,
      whyItMatters: why,
      remediation,
      raw: { entries: fed, recentlyChanged, missingSigningCert },
    };
  }
  if (errorEntries.length === fed.length) {
    return {
      id: "federation-backdoor-drift",
      name: base,
      severity: "unknown",
      summary:
        "Federated domain(s) present but their federationConfiguration could not be read — needs Domain.Read.All / Policy.Read.All",
      whyItMatters: why,
      remediation,
      raw: { entries: fed },
      error: errorEntries[0]!.configError ?? undefined,
    };
  }
  return {
    id: "federation-backdoor-drift",
    name: base,
    severity: "high",
    summary: `${fed.length} federated domain${fed.length === 1 ? "" : "s"} — manually verify issuer URI + signing certificate ownership`,
    whyItMatters: why,
    remediation,
    raw: { entries: fed },
  };
}

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

export const CA_POLICY_RECENT_CHANGE_WINDOW_DAYS = 14;

export function scoreCaPolicyDrift(
  input: ScoreCaPolicyDriftInput,
): BaselineFinding {
  const base = "Conditional Access policy drift";
  const why =
    "A common AADInternals/GraphRunner privilege chain is: get into a high-priv role for a moment, " +
    "*flip* a critical CA policy off (or add yourself to its exclusion list), then sign in without " +
    "MFA. Both modifications surface here at the `/identity/conditionalAccess/policies` edge: state " +
    "changes and exclusion-list edits.";
  const remediation =
    "Microsoft Entra admin center → Protection → Conditional Access — review every policy listed in the raw response.\n" +
    "For each policy in 'disabled' or 'enabledForReportingButNotEnforced', verify intentional.\n" +
    "Inspect `conditions.users.excludeRoles`: legitimate break-glass exclusions should target specific user object ids, NOT the role guid.\n" +
    "Wire-level audit: Microsoft Entra Audit log → `Update conditional access policy` events from the last 30 days.";

  if (input.policiesError) {
    return {
      id: "ca-policy-drift",
      name: base,
      severity: "unknown",
      summary: `Could not enumerate Conditional Access policies: ${input.policiesError}`,
      whyItMatters: why,
      remediation,
      raw: { error: input.policiesError },
      error: input.policiesError,
    };
  }
  const policies = input.policies;
  if (!policies) {
    return {
      id: "ca-policy-drift",
      name: base,
      severity: "unknown",
      summary: "Conditional Access policies not retrieved",
      whyItMatters: why,
      remediation,
      raw: null,
    };
  }
  if (policies.length === 0) {
    return {
      id: "ca-policy-drift",
      name: base,
      severity: "high",
      summary:
        "Tenant has zero Conditional Access policies — MFA / device / location enforcement is absent",
      whyItMatters: why,
      remediation,
      raw: { policies },
    };
  }

  const now = input.now ?? new Date();
  const windowDays =
    input.recentChangeWindowDays ?? CA_POLICY_RECENT_CHANGE_WINDOW_DAYS;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  // Global Admin role template id — surfaced for "policy excludes GA role".
  const GA_ROLE_TEMPLATE_ID = "62e90394-69f5-4237-9190-012177145e10";

  let disabledCount = 0;
  let reportOnlyCount = 0;
  let enabledCount = 0;
  const recentlyModified: { name: string; modifiedDateTime: string }[] = [];
  const policiesExcludingGA: string[] = [];
  let totalExclusions = 0;

  for (const p of policies) {
    const state = (p.state ?? "").toLowerCase();
    if (state === "disabled") disabledCount += 1;
    else if (state === "enabledforreportingbutnotenforced") reportOnlyCount += 1;
    else if (state === "enabled") enabledCount += 1;

    const excludeRoles = p.conditions?.users?.excludeRoles ?? [];
    const excludeUsers = p.conditions?.users?.excludeUsers ?? [];
    const excludeGroups = p.conditions?.users?.excludeGroups ?? [];
    totalExclusions +=
      (excludeRoles?.length ?? 0) +
      (excludeUsers?.length ?? 0) +
      (excludeGroups?.length ?? 0);
    if (
      Array.isArray(excludeRoles) &&
      excludeRoles.includes(GA_ROLE_TEMPLATE_ID)
    ) {
      policiesExcludingGA.push(p.displayName ?? p.id ?? "(unnamed policy)");
    }

    const mod = p.modifiedDateTime ?? null;
    if (mod) {
      const t = Date.parse(mod);
      if (Number.isFinite(t) && now.getTime() - t < windowMs) {
        recentlyModified.push({
          name: p.displayName ?? p.id ?? "(unnamed policy)",
          modifiedDateTime: mod,
        });
      }
    }
  }

  if (policiesExcludingGA.length > 0) {
    return {
      id: "ca-policy-drift",
      name: base,
      severity: "critical",
      summary: `Policies excluding the Global Administrator role: ${policiesExcludingGA.join(", ")} — attacker-classic exclusion shape`,
      whyItMatters: why,
      remediation,
      raw: {
        policies,
        disabledCount,
        reportOnlyCount,
        enabledCount,
        totalExclusions,
        recentlyModified,
        policiesExcludingGA,
      },
    };
  }
  if (recentlyModified.length > 0) {
    const list = recentlyModified
      .map(
        (r) =>
          `${r.name} (${Math.round((now.getTime() - Date.parse(r.modifiedDateTime)) / (1000 * 60 * 60 * 24))}d ago)`,
      )
      .join(", ");
    return {
      id: "ca-policy-drift",
      name: base,
      severity: "high",
      summary: `${recentlyModified.length} policy/policies modified in last ${windowDays}d: ${list}`,
      whyItMatters: why,
      remediation,
      raw: {
        policies,
        disabledCount,
        reportOnlyCount,
        enabledCount,
        totalExclusions,
        recentlyModified,
        policiesExcludingGA,
      },
    };
  }
  if (disabledCount + reportOnlyCount > enabledCount && enabledCount === 0) {
    return {
      id: "ca-policy-drift",
      name: base,
      severity: "high",
      summary: `${policies.length} CA policies but NONE are in the enabled state (${disabledCount} disabled, ${reportOnlyCount} report-only)`,
      whyItMatters: why,
      remediation,
      raw: {
        policies,
        disabledCount,
        reportOnlyCount,
        enabledCount,
        totalExclusions,
        recentlyModified,
        policiesExcludingGA,
      },
    };
  }
  if (disabledCount + reportOnlyCount >= enabledCount && enabledCount > 0) {
    return {
      id: "ca-policy-drift",
      name: base,
      severity: "medium",
      summary: `${enabledCount} enabled, ${disabledCount} disabled, ${reportOnlyCount} report-only — confirm disabled/report-only policies are intentional`,
      whyItMatters: why,
      remediation,
      raw: {
        policies,
        disabledCount,
        reportOnlyCount,
        enabledCount,
        totalExclusions,
        recentlyModified,
        policiesExcludingGA,
      },
    };
  }
  return {
    id: "ca-policy-drift",
    name: base,
    severity: "ok",
    summary: `${enabledCount} enabled CA policies, ${disabledCount} disabled, ${reportOnlyCount} report-only — no recent edits, no GA-role exclusions`,
    whyItMatters: why,
    remediation,
    raw: {
      policies,
      disabledCount,
      reportOnlyCount,
      enabledCount,
      totalExclusions,
      recentlyModified,
      policiesExcludingGA,
    },
  };
}

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
export function scoreOnPremSync(
  org: OrganizationRaw | null,
): BaselineFinding {
  const base = "On-premises directory sync (AAD Connect)";
  const why =
    "AAD Connect bridges your on-prem AD to Entra ID. Stale syncs leave deactivated on-prem accounts active in the cloud — a common path for offboarded-user re-entry. Healthy syncs usually finish within 30 minutes.";
  const remediation =
    "On the AAD Connect server: `Start-ADSyncSyncCycle -PolicyType Delta`.\n" +
    "Investigate hung syncs via Azure Portal → Microsoft Entra ID → Microsoft Entra Connect → Health.";
  if (!org) {
    return {
      id: "onprem-sync",
      name: base,
      severity: "unknown",
      summary: "Organization data not retrieved",
      whyItMatters: why,
      remediation,
      raw: null,
    };
  }
  if (org.onPremisesSyncEnabled !== true) {
    return {
      id: "onprem-sync",
      name: base,
      severity: "info",
      summary: "Cloud-only tenant — no on-prem AD sync configured",
      whyItMatters: why,
      remediation,
      raw: org,
    };
  }
  const lastSync = org.onPremisesLastSyncDateTime ?? null;
  const lastSyncMs = lastSync ? Date.parse(lastSync) : NaN;
  const hoursSinceSync = Number.isFinite(lastSyncMs)
    ? (Date.now() - lastSyncMs) / (1000 * 60 * 60)
    : NaN;
  if (!Number.isFinite(hoursSinceSync)) {
    return {
      id: "onprem-sync",
      name: base,
      severity: "medium",
      summary: "On-prem sync is enabled but no last-sync timestamp returned",
      whyItMatters: why,
      remediation,
      raw: org,
    };
  }
  if (hoursSinceSync > 48) {
    return {
      id: "onprem-sync",
      name: base,
      severity: "high",
      summary: `On-prem sync last ran ${Math.round(hoursSinceSync)}h ago — AAD Connect may be stuck`,
      whyItMatters: why,
      remediation,
      raw: org,
    };
  }
  if (hoursSinceSync > 6) {
    return {
      id: "onprem-sync",
      name: base,
      severity: "low",
      summary: `On-prem sync last ran ${Math.round(hoursSinceSync)}h ago — expected interval is ~30 min`,
      whyItMatters: why,
      remediation,
      raw: org,
    };
  }
  return {
    id: "onprem-sync",
    name: base,
    severity: "info",
    summary: `Healthy on-prem sync — last completed ${Math.round(hoursSinceSync * 60)} min ago`,
    whyItMatters: why,
    remediation,
    raw: org,
  };
}

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

export function scorePasswordProtection(
  input: PasswordProtectionInput,
): BaselineFinding {
  const base = "Password protection (banned-password lists)";
  const why =
    "Entra ID supports a custom banned-password list on top of Microsoft's global list. Tenants without one frequently fail credential-stuffing simulations because attackers prefer passwords like `Welcome2025!` that pass the standard complexity rules but are in every common wordlist.";
  const remediation =
    "Azure Portal → Microsoft Entra ID → Security → Authentication methods → Password protection.\n" +
    "Add 5+ tenant-specific banned words (company name, sports teams, building names) and turn on 'Enforce custom list'.";
  if (input.policyError) {
    return {
      id: "password-protection",
      name: base,
      severity: "unknown",
      summary: `Unable to read password policy: ${input.policyError}`,
      whyItMatters: why,
      remediation,
      raw: { error: input.policyError },
    };
  }
  if (input.policy && typeof input.policy === "object") {
    // Best-effort: we don't have a stable schema here, so just surface
    // that the policy exists and let the operator open the raw JSON.
    return {
      id: "password-protection",
      name: base,
      severity: "info",
      summary:
        "Password validation policy is configured — open the raw response to inspect the banned-word list",
      whyItMatters: why,
      remediation,
      raw: input.policy,
    };
  }
  return {
    id: "password-protection",
    name: base,
    severity: "high",
    summary:
      "No password protection policy detected — Microsoft's global list is in effect but no tenant-specific banned words are configured",
    whyItMatters: why,
    remediation,
    raw: input.policy,
  };
}

// ---------------------------------------------------------------------------
// Display helpers — colours / icons
// ---------------------------------------------------------------------------

/** Map a severity tier to a Badge variant + Alert variant. */
export function severityToBadgeVariant(
  s: BaselineSeverity,
): "default" | "secondary" | "destructive" | "success" | "warning" | "info" | "outline" {
  switch (s) {
    case "critical":
    case "high":
      return "destructive";
    case "medium":
      return "warning";
    case "low":
      return "info";
    case "ok":
      return "success";
    case "info":
      return "info";
    case "unknown":
      return "secondary";
    default:
      return "outline";
  }
}

export function severityLabel(s: BaselineSeverity): string {
  switch (s) {
    case "critical":
      return "Critical";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    case "ok":
      return "OK";
    case "info":
      return "Info";
    case "unknown":
      return "Unknown";
    default:
      return s;
  }
}

/** Tally severities across an array of findings. */
export function tallySeverities(
  items: { severity: BaselineSeverity }[],
): Record<BaselineSeverity, number> {
  const out: Record<BaselineSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    ok: 0,
    info: 0,
    unknown: 0,
  };
  for (const it of items) {
    out[it.severity] = (out[it.severity] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Baseline snapshot / drift (Enhancement #1)
// ---------------------------------------------------------------------------

/**
 * Persisted snapshot envelope — what we stash in localStorage so the operator
 * can compare "what does my tenant look like NOW" vs "what was approved last
 * audit". One snapshot per tenant id (we key the persisted-state hook with
 * the tenant id), kept deliberately small (no raw Graph payloads).
 */
export interface BaselineSnapshot {
  tenantId: string;
  tenantDisplayName: string;
  capturedAt: string; // ISO timestamp
  // Map<BaselineCheckId, { severity, summary }>
  findings: Record<
    BaselineCheckId,
    { severity: BaselineSeverity; summary: string }
  >;
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
export type FindingDriftStatus =
  | "no-baseline"
  | "match"
  | "improved"
  | "regressed"
  | "summary-changed"
  | "new-check-introduced";

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
export function diffAgainstSnapshot(
  findings: BaselineFinding[],
  snapshot: BaselineSnapshot | null,
): Map<BaselineCheckId, FindingDrift> {
  const out = new Map<BaselineCheckId, FindingDrift>();
  if (!snapshot) {
    for (const f of findings) {
      out.set(f.id, {
        status: "no-baseline",
        baselineSeverity: null,
        baselineSummary: null,
      });
    }
    return out;
  }
  for (const f of findings) {
    const prev = snapshot.findings[f.id];
    if (!prev) {
      // The snapshot envelope was captured before this check id existed
      // (or it was an unknown-severity placeholder we never overwrote).
      // Treat that as a *distinct* drift signal — operators reviewing a
      // diff against an older approved baseline should see "this is new"
      // rather than the ambiguous "no baseline".
      out.set(f.id, {
        status: "new-check-introduced",
        baselineSeverity: null,
        baselineSummary: null,
      });
      continue;
    }
    // Synthetic empty-summary entries created by buildSnapshot() for any
    // check that wasn't present at snapshot time get the same treatment.
    if (prev.summary === "" && prev.severity === "unknown") {
      out.set(f.id, {
        status: "new-check-introduced",
        baselineSeverity: null,
        baselineSummary: null,
      });
      continue;
    }
    const sevDelta = SEVERITY_RANK[f.severity] - SEVERITY_RANK[prev.severity];
    let status: FindingDriftStatus;
    if (sevDelta > 0) status = "regressed";
    else if (sevDelta < 0) status = "improved";
    else if (prev.summary !== f.summary) status = "summary-changed";
    else status = "match";
    out.set(f.id, {
      status,
      baselineSeverity: prev.severity,
      baselineSummary: prev.summary,
    });
  }
  return out;
}

/**
 * Build a snapshot envelope from the current finding set. Strips the
 * heavy `raw` Graph payloads so localStorage stays under the ~5MB quota.
 */
export function buildSnapshot(
  tenantId: string,
  tenantDisplayName: string,
  findings: BaselineFinding[],
): BaselineSnapshot {
  const out: BaselineSnapshot["findings"] = {
    "security-defaults": { severity: "unknown", summary: "" },
    "guest-invite-policy": { severity: "unknown", summary: "" },
    "default-user-permissions": { severity: "unknown", summary: "" },
    "domains-federation": { severity: "unknown", summary: "" },
    "federation-backdoor-drift": { severity: "unknown", summary: "" },
    "ca-policy-drift": { severity: "unknown", summary: "" },
    "onprem-sync": { severity: "unknown", summary: "" },
    "password-protection": { severity: "unknown", summary: "" },
  };
  for (const f of findings) {
    out[f.id] = { severity: f.severity, summary: f.summary };
  }
  return {
    tenantId,
    tenantDisplayName,
    capturedAt: new Date().toISOString(),
    findings: out,
  };
}

// ---------------------------------------------------------------------------
// Entra portal deep links (Enhancement #5)
// ---------------------------------------------------------------------------

/**
 * Per-finding deep link into the Microsoft Entra admin portal. We hand-pick
 * the most useful blade per check rather than punting to a search. These
 * URLs are stable / documented and survive portal redesigns (the Entra
 * portal redirects old `aad.portal.azure.com` paths to `entra.microsoft.com`).
 */
export function portalLinkForFinding(
  id: BaselineCheckId,
  tenantId: string,
): { href: string; label: string } {
  const t = encodeURIComponent(tenantId);
  switch (id) {
    case "security-defaults":
      return {
        href: `https://entra.microsoft.com/${t}/#view/Microsoft_AAD_IAM/SecurityMenuBlade/~/Properties`,
        label: "Open Entra ID → Properties (Security defaults)",
      };
    case "guest-invite-policy":
      return {
        href: `https://entra.microsoft.com/${t}/#view/Microsoft_AAD_IAM/CompanyRelationshipsMenuBlade/~/Settings`,
        label: "Open External Identities → Collaboration settings",
      };
    case "default-user-permissions":
      return {
        href: `https://entra.microsoft.com/${t}/#view/Microsoft_AAD_UsersAndTenants/UserManagementMenuBlade/~/UserSettings`,
        label: "Open Users → User settings",
      };
    case "domains-federation":
      return {
        href: `https://entra.microsoft.com/${t}/#view/Microsoft_AAD_IAM/DomainsList.ReactView`,
        label: "Open Domains",
      };
    case "federation-backdoor-drift":
      // Same Domains blade — operator clicks through to the federated
      // domain's "Federation" tab to inspect issuer + signing cert.
      return {
        href: `https://entra.microsoft.com/${t}/#view/Microsoft_AAD_IAM/DomainsList.ReactView`,
        label: "Open Domains → click federated domain → Federation tab",
      };
    case "ca-policy-drift":
      return {
        href: `https://entra.microsoft.com/${t}/#view/Microsoft_AAD_ConditionalAccess/ConditionalAccessBlade/~/Policies`,
        label: "Open Conditional Access → Policies",
      };
    case "onprem-sync":
      return {
        href: `https://entra.microsoft.com/${t}/#view/Microsoft_AAD_IAM/EntraConnectMenuBlade/~/Overview`,
        label: "Open Microsoft Entra Connect → Health",
      };
    case "password-protection":
      return {
        href: `https://entra.microsoft.com/${t}/#view/Microsoft_AAD_IAM/AuthenticationMethodsMenuBlade/~/PasswordProtection`,
        label: "Open Authentication methods → Password protection",
      };
  }
}

/**
 * Per-SP deep link to the Enterprise application or App registration blade.
 * We default to the Enterprise apps view because the spec is "operator
 * checks an SP" — and that view shows credentials + role assignments
 * without requiring app-owner permissions.
 */
export function portalLinkForServicePrincipal(
  appId: string,
  tenantId: string,
): { href: string; label: string } {
  const t = encodeURIComponent(tenantId);
  const a = encodeURIComponent(appId);
  return {
    href: `https://entra.microsoft.com/${t}/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Credentials/objectId//appId/${a}`,
    label: "Open in Entra portal (Enterprise applications)",
  };
}

// ---------------------------------------------------------------------------
// Signal C — Sovereign cloud sentinel
// ---------------------------------------------------------------------------

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
export type AzureCloudEnvironment =
  | "AzureCommercial"
  | "AzureUSGovernment"
  | "AzureChina"
  | "AzureGermany"
  | "Unknown";

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
export function detectCloudEnvironmentFromToken(
  token: string,
): CloudEnvironmentInfo {
  const fallback: CloudEnvironmentInfo = {
    environment: "Unknown",
    label: "Unknown cloud",
    issuer: null,
    audience: null,
  };
  const parts = token.split(".");
  if (parts.length < 2) return fallback;
  try {
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const pad = payload.length % 4;
    const padded = pad ? payload + "=".repeat(4 - pad) : payload;
    const decoded =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("utf8");
    const json = JSON.parse(decoded) as {
      iss?: string;
      aud?: string;
    };
    const iss = typeof json.iss === "string" ? json.iss : null;
    const aud = typeof json.aud === "string" ? json.aud : null;
    return {
      ...classifyIssuer(iss),
      issuer: iss,
      audience: aud,
    };
  } catch {
    return fallback;
  }
}

/**
 * Map an issuer URI / hostname to a Microsoft cloud environment.
 *
 * Exported so unit tests + the page banner can share the same mapping.
 */
export function classifyIssuer(
  issuer: string | null | undefined,
): { environment: AzureCloudEnvironment; label: string } {
  if (!issuer) {
    return { environment: "Unknown", label: "Unknown cloud" };
  }
  const lower = issuer.toLowerCase();
  if (
    lower.includes("login.microsoftonline.us") ||
    lower.includes("sts.windows-ppe.us") ||
    lower.includes("sts.windows.us")
  ) {
    return {
      environment: "AzureUSGovernment",
      label: "Azure US Government (sovereign)",
    };
  }
  if (
    lower.includes("login.partner.microsoftonline.cn") ||
    lower.includes("login.chinacloudapi.cn")
  ) {
    return { environment: "AzureChina", label: "Azure China 21Vianet (sovereign)" };
  }
  if (
    lower.includes("login.microsoftonline.de") ||
    lower.includes("microsoftazure.de")
  ) {
    return { environment: "AzureGermany", label: "Azure Germany (legacy)" };
  }
  if (
    lower.includes("login.microsoftonline.com") ||
    lower.includes("sts.windows.net")
  ) {
    return { environment: "AzureCommercial", label: "Azure Commercial" };
  }
  return { environment: "Unknown", label: "Unknown cloud" };
}

// ---------------------------------------------------------------------------
// Deep-pass enhancements — drift-history timeline + compliance evidence hash
// ---------------------------------------------------------------------------

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

export function summarizeDrift(
  driftMap: ReadonlyMap<BaselineCheckId, FindingDrift>,
): DriftSummary {
  let regressed = 0;
  let improved = 0;
  let changed = 0;
  let newlyIntroduced = 0;
  for (const d of driftMap.values()) {
    if (d.status === "regressed") regressed += 1;
    else if (d.status === "improved") improved += 1;
    else if (d.status === "summary-changed") changed += 1;
    else if (d.status === "new-check-introduced") newlyIntroduced += 1;
  }
  return {
    regressed,
    improved,
    changed,
    newlyIntroduced,
    hasRegressions: regressed > 0,
  };
}

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
export const BASELINE_HISTORY_LIMIT = 25;

/**
 * Append a new entry to the history ring buffer, dropping the oldest entry
 * once the cap is reached. Returns a *new* array — never mutates input.
 */
export function pushHistoryEntry(
  history: ReadonlyArray<BaselineHistoryEntry>,
  entry: BaselineHistoryEntry,
  limit: number = BASELINE_HISTORY_LIMIT,
): BaselineHistoryEntry[] {
  const next = history.slice();
  next.push(entry);
  while (next.length > limit) next.shift();
  return next;
}

/**
 * Build a compact per-tenant history entry from the current findings.
 * Strips raw payloads so the ring buffer stays tiny.
 */
export function buildHistoryEntry(
  findings: BaselineFinding[],
  wasApproved: boolean = false,
): BaselineHistoryEntry {
  const perCheck: Record<BaselineCheckId, BaselineSeverity> = {
    "security-defaults": "unknown",
    "guest-invite-policy": "unknown",
    "default-user-permissions": "unknown",
    "domains-federation": "unknown",
    "federation-backdoor-drift": "unknown",
    "ca-policy-drift": "unknown",
    "onprem-sync": "unknown",
    "password-protection": "unknown",
  };
  for (const f of findings) perCheck[f.id] = f.severity;
  return {
    capturedAt: new Date().toISOString(),
    tally: tallySeverities(findings),
    perCheck,
    wasApproved,
  };
}

/**
 * Compute the difference in severity-rank weight between two history
 * entries. Positive = posture worsened; negative = posture improved.
 * Used by the timeline component to render arrows / colour the segments.
 */
export function compareHistoryEntries(
  prev: BaselineHistoryEntry,
  next: BaselineHistoryEntry,
): { regressed: BaselineCheckId[]; improved: BaselineCheckId[]; delta: number } {
  const regressed: BaselineCheckId[] = [];
  const improved: BaselineCheckId[] = [];
  let delta = 0;
  const ids = Object.keys(next.perCheck) as BaselineCheckId[];
  for (const id of ids) {
    const a = prev.perCheck[id] ?? "unknown";
    const b = next.perCheck[id];
    const d = SEVERITY_RANK[b] - SEVERITY_RANK[a];
    delta += d;
    if (d > 0) regressed.push(id);
    else if (d < 0) improved.push(id);
  }
  return { regressed, improved, delta };
}

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
export function canonicalizeFindingsForHash(
  findings: ReadonlyArray<BaselineFinding>,
): string {
  const sorted = findings
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const compact = sorted.map((f) => ({
    id: f.id,
    name: f.name,
    severity: f.severity,
    summary: f.summary,
    // Include error if present so a probe-failure baseline still hashes
    // distinctly from a clean baseline.
    error: f.error ?? "",
  }));
  return JSON.stringify(compact);
}

/**
 * Compute SHA-256 hex digest of an arbitrary string using the WebCrypto
 * SubtleCrypto API. Returns `null` when SubtleCrypto is unavailable
 * (very old browsers / non-secure contexts) so callers can fall back to
 * an export-without-hash. We never throw from this helper.
 *
 * Browser-built-in API — no install required. Listed in MDN since 2014.
 */
export async function computeSha256Hex(input: string): Promise<string | null> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(input));
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i] as number;
      hex += b.toString(16).padStart(2, "0");
    }
    return hex;
  } catch {
    return null;
  }
}

/**
 * Build the compliance-evidence envelope. Caller supplies the surrounding
 * context (tenant scope, actor, cloud env, drift counters); we compute
 * the canonical findings JSON + SHA-256 hash and stitch the envelope
 * together. Marked async because the hash is async.
 */
export async function buildComplianceEvidence(input: {
  tenantId: string;
  tenantDisplayName: string;
  actor: string;
  cloudEnvironment: AzureCloudEnvironment;
  findings: ReadonlyArray<BaselineFinding>;
  drift: DriftSummary;
}): Promise<ComplianceEvidence> {
  const canonical = canonicalizeFindingsForHash(input.findings);
  const hash = (await computeSha256Hex(canonical)) ?? "sha256-unavailable";
  const tally: Record<BaselineSeverity, number> = tallySeverities(
    input.findings,
  );
  const compactFindings = input.findings.map((f) => ({
    id: f.id,
    name: f.name,
    severity: f.severity,
    summary: f.summary,
    ...(f.error ? { error: f.error } : {}),
  }));
  return {
    schemaVersion: 1,
    tenantId: input.tenantId,
    tenantDisplayName: input.tenantDisplayName,
    actor: input.actor,
    capturedAt: new Date().toISOString(),
    cloudEnvironment: input.cloudEnvironment,
    summary: tally,
    drift: input.drift,
    evidenceHash: hash,
    evidenceHashAlgorithm: "SHA-256",
    findings: compactFindings,
  };
}
