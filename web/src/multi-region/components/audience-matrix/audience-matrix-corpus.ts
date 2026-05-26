/**
 * Audience Matrix — corpus-derived reference data.
 *
 * Defensive context, NOT offensive primitives. The matrix page only DISPLAYS
 * these constants — annotation, not actuation. Source-only refs are below;
 * see CLAUDE.md `Primary research resource` for the corpus rules.
 *
 * What's in this file
 * -------------------
 * 1. FOCI client-id set + a `clientIdIsFoci()` predicate (Signal A).
 *    Source of truth: secureworks/family-of-client-ids-research/known-foci-clients.csv
 *    cloned at
 *    `C:\Users\baimgprodsesa1\Desktop\New folder\dirkjanm\family-of-client-ids-research\known-foci-clients.csv`
 *    The CSV is regenerated as Microsoft adds / removes family members; this
 *    file is a frozen snapshot — re-sync from the corpus when the upstream
 *    CSV moves.
 *
 * 2. Audience risk score (Signal B). A small enum + map keyed by the
 *    matrix's audience-column `key`. Risk is the DEFENSIVE blast-radius
 *    classifier — "if this audience is reachable from a stolen FRT, how
 *    bad is it". Calibrated from:
 *      - dafthack/azure-ad-first-party-apps-permissions/README.md
 *        (defender catalog of first-party pre-consented scopes)
 *      - _analysis_dirkjanm.md §FOCI (ROADtools' canonical audience set)
 *      - _AZURE_LOGIN_METHODS.md §FOCI (master playbook)
 *
 * 3. Defender-awareness banner text (Signal C). One short paragraph the
 *    operator can dismiss; the dismissed state is persisted by the page
 *    via `usePersistedState`. Cites the corpus paths so the operator can
 *    follow up.
 *
 * Authoritative corpus paths cited from this module
 * ---
 * - `_AZURE_LOGIN_METHODS.md`               (master playbook, §FOCI)
 * - `_analysis_dirkjanm.md`                 (FOCI deep-dive)
 * - `_analysis_defender_view.md`            (defender perspective)
 * - `dirkjanm/family-of-client-ids-research/known-foci-clients.csv`
 * - `dirkjanm/family-of-client-ids-research/README.md`
 * - `dafthack/azure-ad-first-party-apps-permissions/README.md`
 *
 * Hardening
 * ---------
 * - The lookups here are pure, read-only constants. No network, no I/O.
 * - Client ids and resource ids are non-secret. Treat this file as
 *   reference material, not as code that touches tokens.
 */

// ---------------------------------------------------------------------------
//  Signal A — FOCI client_id set
// ---------------------------------------------------------------------------
//
// Source: `dirkjanm/family-of-client-ids-research/known-foci-clients.csv`
// (corpus path —
//  `C:\Users\baimgprodsesa1\Desktop\New folder\dirkjanm\family-of-client-ids-research\known-foci-clients.csv`).
// Keep entries lowercase; lookups are normalized with `.toLowerCase()` so the
// upstream CSV's case style doesn't matter.
//
// Snapshot timestamp: 2026-05-26 (sync from corpus when upstream changes).
//
// The presence of `foci: "1"` in an AAD token response is the wire-level
// confirmation that the source client belongs to the family — see
// `_AZURE_LOGIN_METHODS.md` §FOCI for the protocol detail. This list
// covers the publicly enumerated members; Microsoft has never published
// the full FOCI list (see corpus README "Microsoft dismissed the idea of
// publishing the current list of FOCI clients").

interface FociClient {
  /** AAD client_id (GUID). Lowercase. */
  readonly id: string;
  /** Friendly application name from the upstream CSV. */
  readonly name: string;
}

export const KNOWN_FOCI_CLIENTS: ReadonlyArray<FociClient> = Object.freeze([
  { id: "00b41c95-dab0-4487-9791-b9d2c32c80f2", name: "Office 365 Management" },
  { id: "04b07795-8ddb-461a-bbee-02f9e1bf7b46", name: "Microsoft Azure CLI" },
  { id: "1950a258-227b-4e31-a9cf-717495945fc2", name: "Microsoft Azure PowerShell" },
  { id: "1fec8e78-bce4-4aaf-ab1b-5451cc387264", name: "Microsoft Teams" },
  { id: "26a7ee05-5602-4d76-a7ba-eae8b7b67941", name: "Windows Search" },
  { id: "27922004-5251-4030-b22d-91ecd9a37ea4", name: "Outlook Mobile" },
  { id: "4813382a-8fa7-425e-ab75-3b753aab3abb", name: "Microsoft Authenticator App" },
  { id: "ab9b8c07-8f02-4f72-87fa-80105867a763", name: "OneDrive SyncEngine" },
  { id: "d3590ed6-52b3-4102-aeff-aad2292ab01c", name: "Microsoft Office" },
  { id: "872cd9fa-d31f-45e0-9eab-6e460a02d1f1", name: "Visual Studio" },
  { id: "af124e86-4e96-495a-b70a-90f90ab96707", name: "OneDrive iOS App" },
  { id: "2d7f3606-b07d-41d1-b9d2-0d0c9296a6e8", name: "Microsoft Bing Search for Microsoft Edge" },
  { id: "844cca35-0656-46ce-b636-13f48b0eecbd", name: "Microsoft Stream Mobile Native" },
  { id: "87749df4-7ccf-48f8-aa87-704bad0e0e16", name: "Microsoft Teams - Device Admin Agent" },
  { id: "cf36b471-5b44-428c-9ce7-313bf84528de", name: "Microsoft Bing Search" },
  { id: "0ec893e0-5785-4de6-99da-4ed124e5296c", name: "Office UWP PWA" },
  { id: "22098786-6e16-43cc-a27d-191a01a1e3b5", name: "Microsoft To-Do client" },
  { id: "4e291c71-d680-4d0e-9640-0a3358e31177", name: "PowerApps" },
  { id: "57336123-6e14-4acc-8dcf-287b6088aa28", name: "Microsoft Whiteboard Client" },
  { id: "57fcbcfa-7cee-4eb1-8b25-12d2030b4ee0", name: "Microsoft Flow" },
  { id: "66375f6b-983f-4c2c-9701-d680650f588f", name: "Microsoft Planner" },
  { id: "9ba1a5c7-f17a-4de9-a1f1-6178c8d51223", name: "Microsoft Intune Company Portal" },
  { id: "a40d7d7d-59aa-447e-a655-679a4107e548", name: "Accounts Control UI" },
  { id: "a569458c-7f2b-45cb-bab9-b7dee514d112", name: "Yammer iPhone" },
  { id: "b26aadf8-566f-4478-926f-589f601d9c74", name: "OneDrive" },
  { id: "c0d2a505-13b8-4ae0-aa9e-cddd5eab0b12", name: "Microsoft Power BI" },
  { id: "d326c1ce-6cc6-4de2-bebc-4591e5e13ef0", name: "SharePoint" },
  { id: "e9c51622-460d-4d3d-952d-966a5b1da34c", name: "Microsoft Edge" },
  { id: "eb539595-3fe1-474e-9c1d-feb3625d1be5", name: "Microsoft Tunnel" },
  { id: "ecd6b820-32c2-49b6-98a6-444530e5a77a", name: "Microsoft Edge" },
  { id: "f05ff7c9-f75a-4acd-a3b5-f4b6a870245d", name: "SharePoint Android" },
  { id: "f44b1140-bc5e-48c6-8dc0-5cf5a53c0e34", name: "Microsoft Edge" },
  { id: "be1918be-3fe3-4be9-b32b-b542fc27f02e", name: "M365 Compliance Drive Client" },
  { id: "cab96880-db5b-4e15-90a7-f3f1d62ffe39", name: "Microsoft Defender Platform" },
  { id: "d7b530a4-7680-4c23-a8bf-c52c121d2e87", name: "Microsoft Edge Enterprise New Tab Page" },
  { id: "dd47d17a-3194-4d86-bfd5-c6ae6f5651e3", name: "Microsoft Defender for Mobile" },
  { id: "e9b154d0-7658-433b-bb25-6b8e0a8a7c59", name: "Outlook Lite" },
]);

/** Pre-computed lowercase Set for O(1) FOCI membership lookups. */
const FOCI_SET: ReadonlySet<string> = new Set(
  KNOWN_FOCI_CLIENTS.map((c) => c.id.toLowerCase()),
);

/**
 * True when `clientId` is a member of the published FOCI family. Returns
 * false for empty / undefined / unknown ids — never throws.
 *
 * Per `dirkjanm/family-of-client-ids-research/README.md`, the family-member
 * set is published-but-incomplete; a FALSE here does NOT prove "not FOCI",
 * only "not on the published list as of the snapshot above".
 */
export function clientIdIsFoci(clientId: string | undefined | null): boolean {
  if (!clientId) return false;
  return FOCI_SET.has(clientId.toLowerCase());
}

/**
 * Friendly name for a known FOCI client id, or `undefined` when unknown.
 * The matrix uses this only for tooltips — never for routing decisions.
 */
export function fociClientName(
  clientId: string | undefined | null,
): string | undefined {
  if (!clientId) return undefined;
  const id = clientId.toLowerCase();
  for (const c of KNOWN_FOCI_CLIENTS) {
    if (c.id.toLowerCase() === id) return c.name;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
//  Signal B — Audience risk score
// ---------------------------------------------------------------------------
//
// Defensive blast-radius classifier. The matrix already enumerates well-known
// Azure audiences; this map ranks each by "how bad is it if a stolen FOCI
// refresh-token can mint here". Calibration sources:
//   - `dafthack/azure-ad-first-party-apps-permissions/README.md` — the
//     canonical defender-side catalog of pre-consented Microsoft first-party
//     scopes; Graph and ARM dominate the high-risk slice because every
//     pre-consented Microsoft app has at least one Graph scope.
//   - `_analysis_dirkjanm.md` §FOCI — Dirk-jan's own audience picker order
//     in ROADtools/roadtx ranks ARM and Graph first for the same reason.
//   - `_AZURE_LOGIN_METHODS.md` §FOCI — master-playbook treatment of
//     "what does the family token reach?".
//
// Rationale per tier
// ------------------
// "critical": directly grants directory-graph read/write or arbitrary
// resource-plane control over an entire tenant.
//   - Graph   — directory roles, user CRUD, group membership, sign-in logs,
//               consent grants. The "everything" audience.
//   - ARM     — every subscription the principal can see; RBAC mutation,
//               role assignment escalation, RunAs cert minting.
//
// "high": substantial data-plane reach in a single resource service.
//   - Vault   — secrets/keys/certs; pre-stage persistence material.
//   - Storage — blob/file/queue/table data.
//   - Intune  — device control surface; pivot to managed endpoints.
//   - Batch   — pool/job/task execution; arbitrary compute.
//
// "medium": single-product reach inside the M365 graph or a specific
//          analytics surface.
//   - Substrate, Power BI, Monitor, DevOps.
//
// "low": narrower / less-impactful surface or community-focused.
//   - Yammer, Custom (depends on operator scope — caller's choice).

export type AudienceRiskTier = "critical" | "high" | "medium" | "low";

interface AudienceRiskRecord {
  readonly tier: AudienceRiskTier;
  /** One-line corpus-grounded justification shown in the tooltip. */
  readonly rationale: string;
}

/**
 * Risk score keyed by the matrix's `AudienceColumn.key`. Adding a new
 * audience column without an entry here results in the fallback "low" —
 * intentional so unknown columns can't accidentally claim a high score.
 */
export const AUDIENCE_RISK_SCORE: Readonly<Record<string, AudienceRiskRecord>> =
  Object.freeze({
    ARM: {
      tier: "critical",
      rationale:
        "Azure Resource Manager controls every subscription the principal can see — RBAC, billing, deployment. ROADtools/roadtx defaults to ARM first when probing FOCI reach (see _analysis_dirkjanm.md §FOCI).",
    },
    Graph: {
      tier: "critical",
      rationale:
        "Microsoft Graph is the directory plane — users, groups, sign-ins, consent grants, directory roles. Most FOCI-pre-consented Microsoft apps carry some Graph scope (see dafthack/azure-ad-first-party-apps-permissions).",
    },
    Vault: {
      tier: "high",
      rationale:
        "Key Vault data-plane = secrets, keys, certificates. Common persistence stash for operators (see _bypass_role_grant.md and _AZURE_LOGIN_METHODS.md).",
    },
    Storage: {
      tier: "high",
      rationale:
        "Storage data-plane OAuth covers blobs/files/queues/tables across the principal's accessible accounts.",
    },
    Intune: {
      tier: "high",
      rationale:
        "Intune device-management surface — pivot to enrolled endpoints (see _analysis_dafthack.md).",
    },
    Batch: {
      tier: "high",
      rationale:
        "Azure Batch lets a token submit/execute arbitrary compute against the principal's Batch accounts.",
    },
    Substrate: {
      tier: "medium",
      rationale:
        "Microsoft Substrate is the internal M365 graph store — Outlook/Teams/OneDrive metadata. High value but narrower than Graph (see _analysis_dafthack.md GraphRunner).",
    },
    "Power BI": {
      tier: "medium",
      rationale: "Power BI REST API — dataset / report access scoped to workspaces the principal can see.",
    },
    Monitor: {
      tier: "medium",
      rationale:
        "Azure Monitor metrics/logs ingestion; defenders use the SAME plane for sign-in-log triage (see _analysis_defender_view.md).",
    },
    DevOps: {
      tier: "medium",
      rationale:
        "Azure DevOps Services — pipelines, secrets in variable groups, service connections. App id 499b84ac-1321-427f-aa17-267ca6975798.",
    },
    Yammer: {
      tier: "low",
      rationale: "Yammer / Viva Engage REST API — community-focused, comparatively narrow blast radius.",
    },
    Custom: {
      tier: "low",
      rationale:
        "Risk depends entirely on the operator-supplied scope. The matrix can't classify what it doesn't know — treat as the most sensitive of the API behind the scope.",
    },
  });

/** Tier ordering used for sort comparisons (critical = 0, low = 3). */
const TIER_RANK: Readonly<Record<AudienceRiskTier, number>> = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
});

/** Compare two tiers — earlier (more critical) tier sorts first. */
export function compareAudienceRisk(
  a: AudienceRiskTier,
  b: AudienceRiskTier,
): number {
  return TIER_RANK[a] - TIER_RANK[b];
}

/**
 * Lookup the risk record for an audience column key. Falls back to the
 * "low" tier with an explicit "uncalibrated" rationale so the column
 * still renders cleanly when a new audience is added without updating
 * this map.
 */
export function getAudienceRisk(audienceKey: string): AudienceRiskRecord {
  const r = AUDIENCE_RISK_SCORE[audienceKey];
  if (r) return r;
  return {
    tier: "low",
    rationale:
      "Risk tier not calibrated. Treat as low until classified — see audience-matrix-corpus.ts for the calibration sources.",
  };
}

/**
 * Map a tier onto a Tailwind text-color class. Centralised so the page
 * and any future call-site stays visually consistent.
 */
export function tierTextClass(tier: AudienceRiskTier): string {
  switch (tier) {
    case "critical":
      return "text-destructive";
    case "high":
      return "text-warning";
    case "medium":
      return "text-info";
    case "low":
    default:
      return "text-muted-foreground";
  }
}

/** Compact one-letter label for the column-header risk pill. */
export function tierShort(tier: AudienceRiskTier): string {
  switch (tier) {
    case "critical":
      return "CRIT";
    case "high":
      return "HIGH";
    case "medium":
      return "MED";
    case "low":
      return "LOW";
  }
}

// ---------------------------------------------------------------------------
//  Signal C — Defender awareness banner copy
// ---------------------------------------------------------------------------
//
// Source: `_AZURE_LOGIN_METHODS.md` §FOCI ("Why it matters" paragraph) and
// `_analysis_defender_view.md` (defender perspective on FRT swap detection).
//
// Surfaced ONCE per browser by the page (dismiss persisted via
// `usePersistedState` with the `localStorage` key below). The copy here is
// intentionally short — operators dismiss verbose banners; we want the FOCI
// concept to land in two sentences.

/** localStorage key for the dismissed-banner flag. */
export const FOCI_BANNER_DISMISS_KEY = "audience-matrix.foci-banner.dismissed";

// ---------------------------------------------------------------------------
//  Signal D — FOCI client → typical pre-consented scopes (defender catalog)
// ---------------------------------------------------------------------------
//
// "WHAT does this FOCI client typically hold?" — annotation only. The matrix
// uses this to tell a defender "Azure CLI typically holds AuditLog.Read.All —
// be careful" when they see an Azure CLI RT row.
//
// Sources (annotation, not actuation):
//   - `dirkjanm/family-of-client-ids-research/scope-map.txt`
//     (scope → resource → client tabular dump from a known consenting tenant)
//   - `dafthack/azure-ad-first-party-apps-permissions/README.md`
//     (defender catalog of pre-consented Microsoft first-party scopes)
//
// Curation rules
// --------------
// - This is a CURATED subset — the canonical `scope-map.txt` is 2k+ lines and
//   most rows are duplicative across the family. We surface the high-signal
//   high-risk scopes per client so a defender can answer "if this RT leaks,
//   what's the worst the holder can do without re-consenting?".
// - "audiences" lists which AUDIENCE_COLUMNS keys the client is known to
//   tokenize for (used by the reachability table).
// - "highValueScopes" lists the scopes that should make a defender pause —
//   selected for blast-radius, NOT exhaustive.
// - "notes" is a one-line summary suitable for a tooltip.

export interface FociClientProfile {
  /** Lowercase client_id. */
  readonly id: string;
  /** Friendly application name. */
  readonly name: string;
  /** AudienceColumn keys the client is known to tokenize. */
  readonly audiences: ReadonlyArray<string>;
  /** Curated high-value scopes a defender should care about. */
  readonly highValueScopes: ReadonlyArray<string>;
  /** One-line operator/defender summary. */
  readonly notes: string;
}

/**
 * Per-FOCI-client annotated profile. Keyed by lowercase client_id. The
 * matrix uses this for:
 *   - the row-identifier popover ("Azure CLI typically holds…")
 *   - the audience reachability table
 *   - the audience→FOCI reverse map below
 *
 * Coverage: the highest-leverage clients first. Clients NOT in this map
 * still appear in the FOCI badge — `clientIdIsFoci()` is a superset check;
 * this map is the annotated subset. Adding a profile here NEVER changes
 * the badge behaviour.
 */
export const FOCI_CLIENT_PROFILES: Readonly<Record<string, FociClientProfile>> =
  Object.freeze({
    "04b07795-8ddb-461a-bbee-02f9e1bf7b46": {
      id: "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
      name: "Microsoft Azure CLI",
      audiences: ["ARM", "Graph", "Batch", "Vault", "Storage", "Monitor"],
      highValueScopes: [
        "user_impersonation (ARM, ALL subscriptions)",
        "AuditLog.Read.All (Graph)",
        "Directory.AccessAsUser.All (Graph)",
        "Application.ReadWrite.All (Graph)",
      ],
      notes:
        "Azure CLI holds the broadest 'admin' set in the family — ARM user_impersonation + privileged Graph scopes. A leaked Azure CLI RT effectively grants tenant-wide read/write across both planes.",
    },
    "1950a258-227b-4e31-a9cf-717495945fc2": {
      id: "1950a258-227b-4e31-a9cf-717495945fc2",
      name: "Microsoft Azure PowerShell",
      audiences: ["ARM", "Graph", "Batch", "Vault", "Storage"],
      highValueScopes: [
        "user_impersonation (ARM)",
        "Directory.AccessAsUser.All (Graph)",
        "AuditLog.Read.All (Graph)",
      ],
      notes:
        "Azure PowerShell shares Azure CLI's ARM reach; Graph coverage is similar. Operator muscle-memory pivots through both interchangeably.",
    },
    "1fec8e78-bce4-4aaf-ab1b-5451cc387264": {
      id: "1fec8e78-bce4-4aaf-ab1b-5451cc387264",
      name: "Microsoft Teams",
      audiences: ["Graph", "Substrate", "Power BI"],
      highValueScopes: [
        "Chat.ReadWrite (Graph)",
        "User.Read.All (Graph)",
        "Channel.ReadBasic.All (Graph)",
        "Files.ReadWrite.All (Graph)",
      ],
      notes:
        "Teams holds rich messaging + presence scopes — chat exfil, channel enumeration, and SharePoint/OneDrive file access via Substrate.",
    },
    "d3590ed6-52b3-4102-aeff-aad2292ab01c": {
      id: "d3590ed6-52b3-4102-aeff-aad2292ab01c",
      name: "Microsoft Office",
      audiences: ["Graph", "Substrate", "Power BI"],
      highValueScopes: [
        "Mail.ReadWrite (Graph)",
        "Calendars.ReadWrite (Graph)",
        "Files.ReadWrite.All (Graph)",
        "AuditLog.Read.All (Graph)",
        "Contacts.ReadWrite (Graph)",
      ],
      notes:
        "Microsoft Office shares the 'productivity' superset — mail, calendars, files. AuditLog.Read.All is unusual for this client; treat as elevated risk.",
    },
    "27922004-5251-4030-b22d-91ecd9a37ea4": {
      id: "27922004-5251-4030-b22d-91ecd9a37ea4",
      name: "Outlook Mobile",
      audiences: ["Graph", "Substrate"],
      highValueScopes: [
        "Mail.ReadWrite (Outlook + Substrate)",
        "Calendars.ReadWrite.All",
        "Contacts.ReadWrite (Substrate)",
      ],
      notes:
        "Outlook Mobile is the Substrate-heavy member — mail/calendar/contacts read+write. Common phishing-pivot target.",
    },
    "00b41c95-dab0-4487-9791-b9d2c32c80f2": {
      id: "00b41c95-dab0-4487-9791-b9d2c32c80f2",
      name: "Office 365 Management",
      audiences: ["ARM", "Graph", "Substrate"],
      highValueScopes: [
        "AdminApi.AccessAsUser.All (Outlook admin)",
        "Contacts.Read (Graph)",
        "manage.office.com /.default",
      ],
      notes:
        "O365 Management acts as a thin admin shim — admin APIs over Exchange Online plus broad Graph reach.",
    },
    "872cd9fa-d31f-45e0-9eab-6e460a02d1f1": {
      id: "872cd9fa-d31f-45e0-9eab-6e460a02d1f1",
      name: "Visual Studio",
      audiences: ["ARM", "Graph", "DevOps", "Vault", "Storage"],
      highValueScopes: [
        "user_impersonation (ARM)",
        "Code.ReadWrite (DevOps)",
        "vso.* scopes (DevOps PATs)",
      ],
      notes:
        "Visual Studio crosses ARM + Azure DevOps in one family member — supply-chain pivots through pipelines/service connections.",
    },
    "4813382a-8fa7-425e-ab75-3b753aab3abb": {
      id: "4813382a-8fa7-425e-ab75-3b753aab3abb",
      name: "Microsoft Authenticator App",
      audiences: ["Graph", "Substrate"],
      highValueScopes: [
        "DeviceManagementManagedDevices.Read.All (Graph)",
        "User.Read (Graph)",
      ],
      notes:
        "Authenticator App RTs are valuable because they ride device-bound PRT cookies and can be redeemed without prompting; see _AZURE_LOGIN_METHODS.md §PRT.",
    },
    "ab9b8c07-8f02-4f72-87fa-80105867a763": {
      id: "ab9b8c07-8f02-4f72-87fa-80105867a763",
      name: "OneDrive SyncEngine",
      audiences: ["Graph", "Substrate"],
      highValueScopes: ["Files.ReadWrite.All (Graph)", "Sites.Read.All (Graph)"],
      notes:
        "OneDrive SyncEngine sees full file plane across the user's drive + delegated sites. Exfil-friendly.",
    },
    "c0d2a505-13b8-4ae0-aa9e-cddd5eab0b12": {
      id: "c0d2a505-13b8-4ae0-aa9e-cddd5eab0b12",
      name: "Microsoft Power BI",
      audiences: ["Graph", "Power BI"],
      highValueScopes: [
        "Dataset.ReadWrite.All (Power BI)",
        "Report.ReadWrite.All (Power BI)",
      ],
      notes:
        "Power BI RTs unlock dataset + report APIs scoped to workspaces the principal can see. Useful for tenant-data exfil at the analytics tier.",
    },
    "9ba1a5c7-f17a-4de9-a1f1-6178c8d51223": {
      id: "9ba1a5c7-f17a-4de9-a1f1-6178c8d51223",
      name: "Microsoft Intune Company Portal",
      audiences: ["Graph", "Intune"],
      highValueScopes: [
        "DeviceManagementManagedDevices.PrivilegedOperations.All (Graph)",
        "DeviceManagementApps.ReadWrite.All (Graph)",
      ],
      notes:
        "Intune Company Portal can pivot to managed-device commands and app-deployment plane — pivot to endpoints.",
    },
  });

/**
 * Look up a FOCI client's annotated profile. Returns `undefined` for unknown
 * or un-annotated clients. NEVER throws.
 *
 * `id === ""` is treated as "not a real profile" — defensive guard in case a
 * future maintainer adds a stub entry without a matching client_id.
 */
export function getFociClientProfile(
  clientId: string | undefined | null,
): FociClientProfile | undefined {
  if (!clientId) return undefined;
  const id = clientId.toLowerCase();
  const p = FOCI_CLIENT_PROFILES[id];
  if (!p || !p.id) return undefined;
  return p;
}

// ---------------------------------------------------------------------------
//  Signal E — Audience → reachable FOCI clients (reverse map)
// ---------------------------------------------------------------------------
//
// "Per known FOCI client_id, which audiences are tokenable from it" is the
// matrix's headline reachability claim. Surfacing the REVERSE — for each
// audience, which FOCI client_ids are known to mint to it — is the
// defender-side framing: "if my SOC sees a token mint to audience X from
// client Y, is that on the published reachability?".
//
// Derived from FOCI_CLIENT_PROFILES above by inverting the audiences arrays.
// Computed once at module load; the result is frozen.

export interface AudienceReachability {
  readonly audienceKey: string;
  readonly clients: ReadonlyArray<{ id: string; name: string }>;
}

const AUDIENCE_TO_CLIENTS_BUILDER: Record<
  string,
  Array<{ id: string; name: string }>
> = {};
for (const id of Object.keys(FOCI_CLIENT_PROFILES)) {
  const p = FOCI_CLIENT_PROFILES[id];
  if (!p || !p.id) continue;
  for (const aud of p.audiences) {
    if (!AUDIENCE_TO_CLIENTS_BUILDER[aud]) AUDIENCE_TO_CLIENTS_BUILDER[aud] = [];
    AUDIENCE_TO_CLIENTS_BUILDER[aud].push({ id: p.id, name: p.name });
  }
}
// Sort each list by name for stable display.
for (const aud of Object.keys(AUDIENCE_TO_CLIENTS_BUILDER)) {
  AUDIENCE_TO_CLIENTS_BUILDER[aud]!.sort((a, b) => a.name.localeCompare(b.name));
  Object.freeze(AUDIENCE_TO_CLIENTS_BUILDER[aud]);
}

/**
 * For each audience column key, the list of annotated FOCI clients known to
 * tokenize for that audience. An empty list means "no annotated client in
 * `FOCI_CLIENT_PROFILES` reaches this audience" — which is NOT proof of
 * unreachability (the audience may still be reachable via clients we haven't
 * annotated). Treat absence as "uncalibrated".
 */
export const AUDIENCE_TO_FOCI_CLIENTS: Readonly<
  Record<string, ReadonlyArray<{ id: string; name: string }>>
> = Object.freeze(AUDIENCE_TO_CLIENTS_BUILDER);

/**
 * Count annotated FOCI clients reaching an audience. Used by the reachability
 * table for the summary badge.
 */
export function fociClientsReachingAudience(audienceKey: string): number {
  return AUDIENCE_TO_FOCI_CLIENTS[audienceKey]?.length ?? 0;
}

export interface DefenderBannerCopy {
  readonly title: string;
  readonly body: string;
  readonly citationLines: ReadonlyArray<string>;
}

export const DEFENDER_BANNER_COPY: DefenderBannerCopy = Object.freeze({
  title: "FOCI swap is a normal Microsoft auth behavior — visible here for defenders.",
  body:
    "An imported refresh token issued to ANY family-of-client-ids member can be redeemed for an access token as any other family member, with the new client's pre-consented scopes — without re-authentication. This matrix surfaces that fan-out so operators can detect anomalous audience-mint chains from a single compromised RT. For audit, filter Azure AD Sign-in Logs (Non-interactive sign-ins) on the Application ID column against the FOCI list below.",
  citationLines: Object.freeze([
    "_AZURE_LOGIN_METHODS.md §FOCI (master playbook)",
    "_analysis_defender_view.md (defender perspective)",
    "dirkjanm/family-of-client-ids-research/README.md (canonical research)",
  ]),
});
