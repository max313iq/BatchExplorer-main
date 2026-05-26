/**
 * Azure Accounts — intelligence helpers.
 *
 * Pure (no React, no DOM) data-shaping functions extracted from
 * `azure-accounts-page.tsx` so the page renders a per-row "cross-tenant
 * guest", "sovereign cloud", and "stale tenant association" signal
 * without bloating the already-large parent file.
 *
 * Every detection has a corpus citation in the comment above it —
 * defenders reading this code should be able to jump straight to the
 * offensive playbook that motivates the check.
 *
 *   Corpus root: C:\Users\baimgprodsesa1\Desktop\New folder\
 *
 *   - _bypass_tenant_switch.md §1 "Tenant Enumeration from a Single Token"
 *   - _bypass_tenant_switch.md §2 "Guest Invitation Abuse" (incl. §2.4
 *     "Privileged stale guests")
 *   - _bypass_tenant_switch.md §8 "Sovereign / Cross-Cloud Pivots"
 *     (endpoint catalog + §8.2 Commercial → Gov pivot)
 *   - _AZURE_LOGIN_METHODS.md §0 (every token transits the per-cloud
 *     `login.microsoftonline.*` OAuth endpoint — the `iss` claim is the
 *     ONLY claim that distinguishes Commercial / Gov / China / Germany
 *     reliably, since `tid` looks identical across clouds for the same
 *     tenant GUID).
 *
 * This file imports ZERO new dependencies and edits nothing outside the
 * `components/azure-accounts/` directory.
 */
import type {
  AzureLoginAccount,
  TenantInfo,
} from "../../store/store-types";

/* ------------------------------------------------------------------ */
/*  Sovereign-cloud detector                                          */
/* ------------------------------------------------------------------ */

/**
 * Discriminated value for the sovereign-cloud badge. `commercial` is the
 * default for any account whose `environment` looks like the public
 * `login.microsoftonline.com` host; the other variants are the three
 * sovereign clouds + an `unknown` fallback for anything we can't classify
 * (e.g. early-build B2C tenants, on-prem ADFS facades).
 *
 * Mirrors the row-shape in `_bypass_tenant_switch.md §8.1 "Endpoint
 * catalog"`. Keeping the labels short so they fit in a Badge.
 */
export type CloudEnvironment =
  | "commercial"
  | "gov"
  | "dod"
  | "china"
  | "germany"
  | "unknown";

export interface CloudEnvironmentInfo {
  /** Discriminator used to drive Badge variant / colour. */
  kind: CloudEnvironment;
  /** Short label shown in the row badge ("Commercial", "Gov", …). */
  label: string;
  /** Long-form text rendered into the tooltip body. */
  description: string;
}

const CLOUD_DESCRIPTIONS: Record<CloudEnvironment, string> = {
  commercial:
    "Public Azure (login.microsoftonline.com → graph.microsoft.com → management.azure.com).",
  gov: "Azure US Government (login.microsoftonline.us → graph.microsoft.us → management.usgovcloudapi.net).",
  dod: "Azure US Government DoD (Defense cloud; same endpoints as Gov but DoD subset of CA policies).",
  china:
    "Azure China 21Vianet (login.partner.microsoftonline.cn → microsoftgraph.chinacloudapi.cn → management.chinacloudapi.cn).",
  germany:
    "Azure Germany (legacy: login.microsoftonline.de → graph.microsoft.de). Retired for new tenants.",
  unknown:
    "Could not classify the sign-in environment from the MSAL `environment` field.",
};

/**
 * Classify an account by the MSAL `environment` string AND, when
 * available, the `iss` claim from a token decoded by the page. The
 * `environment` field is set by MSAL when it caches the account, and
 * is the most reliable signal for which cloud minted the original token
 * — `tid` looks the same across clouds for the same tenant GUID, but
 * `environment` will always be the per-cloud login host.
 *
 * Defenders: a single user with the SAME `homeAccountId` showing up in
 * both `commercial` and `gov` is exactly the cross-cloud pivot pattern
 * in `_bypass_tenant_switch.md §8.2`.
 */
export function classifyCloudEnvironment(
  environment: string | undefined,
): CloudEnvironmentInfo {
  const env = (environment ?? "").toLowerCase();
  if (!env) {
    return {
      kind: "unknown",
      label: "Unknown",
      description: CLOUD_DESCRIPTIONS.unknown,
    };
  }
  // Gov / DoD share `login.microsoftonline.us`; the DoD subset is only
  // identifiable from CA policy / tenant config so we conservatively
  // classify as `gov` and let the operator drill in via the drawer.
  if (
    env.includes("login.microsoftonline.us") ||
    env.includes("graph.microsoft.us") ||
    env.includes("usgovcloudapi.net")
  ) {
    return {
      kind: "gov",
      label: "US Gov",
      description: CLOUD_DESCRIPTIONS.gov,
    };
  }
  if (
    env.includes("login.partner.microsoftonline.cn") ||
    env.includes("microsoftgraph.chinacloudapi.cn") ||
    env.includes("chinacloudapi.cn")
  ) {
    return {
      kind: "china",
      label: "China",
      description: CLOUD_DESCRIPTIONS.china,
    };
  }
  if (
    env.includes("login.microsoftonline.de") ||
    env.includes("microsoftazure.de")
  ) {
    return {
      kind: "germany",
      label: "Germany",
      description: CLOUD_DESCRIPTIONS.germany,
    };
  }
  if (
    env.includes("login.microsoftonline.com") ||
    env.includes("graph.microsoft.com") ||
    env.includes("management.azure.com") ||
    env.includes("sts.windows.net")
  ) {
    return {
      kind: "commercial",
      label: "Commercial",
      description: CLOUD_DESCRIPTIONS.commercial,
    };
  }
  return {
    kind: "unknown",
    label: env,
    description: CLOUD_DESCRIPTIONS.unknown,
  };
}

/* ------------------------------------------------------------------ */
/*  Cross-tenant guest-token detector                                 */
/* ------------------------------------------------------------------ */

/**
 * An account "holds a cross-tenant token" when its currently-active
 * tenant is NOT its home tenant. This is the legitimate-but-noteworthy
 * signal that the operator has pivoted away from the account's home
 * tenant via a B2B guest invitation, Lighthouse / GDAP delegation, or
 * Cross-Tenant Sync.
 *
 * Defenders should treat this as a "where am I right now?" indicator —
 * tokens minted for a non-home tenant ALWAYS carry the `iss` of the new
 * tenant, and a stale `activeTenantId` from a deleted B2B relationship
 * is exactly the "stuck tenant" footprint described in
 * `_bypass_tenant_switch.md §2.4 "Privileged stale guests"`.
 *
 * Returns `null` when the account is not in a cross-tenant state.
 */
export interface CrossTenantState {
  /** The home tenant id (what `homeAccountId` was minted against). */
  homeTenantId: string;
  /** The currently-active tenant id (= where new tokens will be minted). */
  activeTenantId: string;
  /** Human label for the active tenant from `account.tenants` if known. */
  activeTenantLabel: string;
  /** Human label for the home tenant from `account.tenants` if known. */
  homeTenantLabel: string;
  /**
   * True when the active tenant id is NOT in the discovered `tenants`
   * list — i.e. the account is "stuck" with a token for a tenant it
   * no longer accesses (relationship deleted / guest revoked).
   */
  staleAssociation: boolean;
}

export function detectCrossTenant(
  account: AzureLoginAccount,
): CrossTenantState | null {
  const active =
    account.activeTenantId && account.activeTenantId.length > 0
      ? account.activeTenantId
      : account.tenantId;
  if (!active) return null;
  if (active === account.tenantId) return null;

  const tenants = account.tenants ?? [];
  const activeRow = tenants.find((t) => t.tenantId === active);
  const homeRow = tenants.find((t) => t.tenantId === account.tenantId);

  return {
    homeTenantId: account.tenantId,
    activeTenantId: active,
    activeTenantLabel:
      activeRow?.displayName ?? activeRow?.defaultDomain ?? active,
    homeTenantLabel:
      homeRow?.displayName ?? homeRow?.defaultDomain ?? account.tenantId,
    // `tenants` is populated lazily — if it's empty we have nothing to
    // compare against and should NOT raise a stale flag. Only when the
    // list is non-empty AND the active id is missing from it do we know
    // the operator is on a tenant they no longer enumerate.
    staleAssociation:
      tenants.length > 0 && !tenants.some((t) => t.tenantId === active),
  };
}

/* ------------------------------------------------------------------ */
/*  Tenant graph builder                                              */
/* ------------------------------------------------------------------ */

/**
 * One node in the tenant graph — a tenant the operator has at least one
 * account in OR at least one subscription owned by. Edges live as
 * `subscriptionsByTenant` / `accountsByTenant`. The aggregator below
 * builds the whole graph in a single pass; we keep the wire shape flat
 * so the panel can render it as a list-of-cards rather than a real graph
 * library (we have no graph deps available — source-only repo).
 *
 * Inspired by:
 *   - SpecterOps/AzureHound (`_analysis_specterops.md`) which builds a
 *     directed graph of `User -> {GuestIn}-> Tenant -> {Owns}->
 *     Subscription` and visualises trust topology for an operator.
 *   - ROADtools/roadrecon (`_analysis_dirkjanm.md`) which collects every
 *     accessible tenant per account via `GET /tenants` and renders a
 *     per-account tenant footprint in its web UI.
 */
export interface TenantNode {
  tenantId: string;
  /** Best-effort human label discovered from `account.tenants`. */
  label: string;
  /** Domain hint (e.g. `contoso.onmicrosoft.com`) if known. */
  defaultDomain?: string;
  /**
   * Accounts that hold a token for this tenant — either because the
   * tenant is their HOME or because they've been invited as a B2B guest
   * AND the account has actively switched to this tenant.
   */
  accountHomeAccountIds: string[];
  /**
   * Subscription rows whose `tenantId` is this tenant. A subscription's
   * `tenantId` is set to the tenant that *owns* the subscription —
   * cross-tenant Lighthouse/GDAP delegations show up here too.
   */
  subscriptions: { subscriptionId: string; displayName: string; ownedBy: string }[];
  /** Number of accounts whose HOME tenant is this one. */
  homeAccountsCount: number;
  /** Number of accounts that reach this tenant only as a guest. */
  guestAccountsCount: number;
  /** True if this tenant id is referenced but no account claims it as home. */
  guestOnly: boolean;
}

export interface TenantGraph {
  nodes: TenantNode[];
  /** Total accounts surveyed. */
  accountCount: number;
  /** Total tenants discovered. */
  tenantCount: number;
  /** Total subscriptions surveyed across all accounts. */
  subscriptionCount: number;
  /** Accounts that hold tokens for >1 tenant (multi-tenant footprint). */
  multiTenantAccountCount: number;
}

/**
 * Build the tenant graph from the page's `accounts` array. Single pass,
 * O(accounts × tenants_per_account + subs); cheap to recompute on every
 * accounts change but the caller should still wrap in `useMemo` because
 * the resulting `TenantNode` objects are new identities.
 */
export function buildTenantGraph(accounts: AzureLoginAccount[]): TenantGraph {
  const nodes = new Map<string, TenantNode>();

  const ensureNode = (
    tenantId: string,
    label: string | undefined,
    defaultDomain: string | undefined,
  ): TenantNode => {
    let node = nodes.get(tenantId);
    if (!node) {
      node = {
        tenantId,
        label: label ?? tenantId,
        defaultDomain,
        accountHomeAccountIds: [],
        subscriptions: [],
        homeAccountsCount: 0,
        guestAccountsCount: 0,
        guestOnly: false,
      };
      nodes.set(tenantId, node);
    } else {
      // Upgrade the label if we've learned a friendlier name from a
      // later account's tenant list (`tenants` is best-effort and the
      // first account that discovered the tenant may have only a GUID).
      if (
        (node.label === node.tenantId || !node.label) &&
        label &&
        label !== tenantId
      ) {
        node.label = label;
      }
      if (!node.defaultDomain && defaultDomain) {
        node.defaultDomain = defaultDomain;
      }
    }
    return node;
  };

  let multiTenantAccountCount = 0;
  let subscriptionCount = 0;

  for (const acct of accounts) {
    // 1. Home tenant — always a node, possibly without a friendly label
    //    if `tenants` hasn't been fetched yet.
    const homeRow = acct.tenants?.find((t) => t.tenantId === acct.tenantId);
    const homeNode = ensureNode(
      acct.tenantId,
      homeRow?.displayName ?? homeRow?.defaultDomain,
      homeRow?.defaultDomain,
    );
    if (!homeNode.accountHomeAccountIds.includes(acct.homeAccountId)) {
      homeNode.accountHomeAccountIds.push(acct.homeAccountId);
      homeNode.homeAccountsCount += 1;
    }

    // 2. Every other tenant in the account's tenants list is a guest
    //    relationship from this account's perspective.
    const allTenants: TenantInfo[] = acct.tenants ?? [];
    let touched = 0;
    for (const t of allTenants) {
      const node = ensureNode(t.tenantId, t.displayName, t.defaultDomain);
      if (t.tenantId === acct.tenantId) {
        touched += 1;
        continue;
      }
      if (!node.accountHomeAccountIds.includes(acct.homeAccountId)) {
        node.accountHomeAccountIds.push(acct.homeAccountId);
        node.guestAccountsCount += 1;
      }
      touched += 1;
    }
    if (touched > 1) multiTenantAccountCount += 1;

    // 3. Subscriptions — bucket by the subscription's `tenantId` (which
    //    is the OWNING tenant). A subscription from a Lighthouse-
    //    delegated tenant will land in that delegated tenant's node
    //    even though the account itself is in a different home tenant.
    for (const sub of acct.subscriptions) {
      subscriptionCount += 1;
      const node = ensureNode(sub.tenantId, undefined, undefined);
      // Dedup by subscription id (some accounts can see the same sub
      // via two routes — Lighthouse + direct guest — and we don't want
      // to double-count it).
      if (
        !node.subscriptions.some((s) => s.subscriptionId === sub.subscriptionId)
      ) {
        node.subscriptions.push({
          subscriptionId: sub.subscriptionId,
          displayName: sub.displayName,
          ownedBy: acct.homeAccountId,
        });
      }
    }
  }

  // Flag tenants that NO surveyed account claims as home — those are
  // "guest-only" entries (you reach them via someone's guest invitation
  // or via a subscription's owning-tenant pointer, but no signed-in
  // account is native there).
  for (const node of nodes.values()) {
    node.guestOnly = node.homeAccountsCount === 0;
  }

  const sorted = Array.from(nodes.values()).sort((a, b) => {
    // Home-tenants of signed-in accounts first; then by friendly label.
    if (a.homeAccountsCount > 0 && b.homeAccountsCount === 0) return -1;
    if (b.homeAccountsCount > 0 && a.homeAccountsCount === 0) return 1;
    return a.label.localeCompare(b.label);
  });

  return {
    nodes: sorted,
    accountCount: accounts.length,
    tenantCount: sorted.length,
    subscriptionCount,
    multiTenantAccountCount,
  };
}

/* ------------------------------------------------------------------ */
/*  Cross-tenant token aggregate                                      */
/* ------------------------------------------------------------------ */

/**
 * Summary used by the page's "advanced posture" banner. Returns a count
 * of accounts that match each of the high-signal patterns so the page
 * can render a single status line ("3 cross-tenant · 1 stale · 2 sovereign")
 * without re-walking the account array per badge.
 */
export interface PostureSummary {
  /** Accounts whose active tenant differs from home tenant. */
  crossTenantCount: number;
  /** Accounts holding a token for a tenant id not in their tenants list. */
  staleTenantCount: number;
  /** Accounts whose `environment` indicates a sovereign cloud. */
  sovereignAccountCount: number;
  /** Per-account sovereign classification (keyed by homeAccountId). */
  cloudByAccount: Record<string, CloudEnvironmentInfo>;
  /** Per-account cross-tenant state (only present for cross-tenant accts). */
  crossTenantByAccount: Record<string, CrossTenantState>;
}

export function summarizePosture(accounts: AzureLoginAccount[]): PostureSummary {
  let crossTenantCount = 0;
  let staleTenantCount = 0;
  let sovereignAccountCount = 0;
  const cloudByAccount: Record<string, CloudEnvironmentInfo> = {};
  const crossTenantByAccount: Record<string, CrossTenantState> = {};

  for (const acct of accounts) {
    const cloud = classifyCloudEnvironment(acct.environment);
    cloudByAccount[acct.homeAccountId] = cloud;
    if (cloud.kind !== "commercial" && cloud.kind !== "unknown") {
      sovereignAccountCount += 1;
    }
    const xt = detectCrossTenant(acct);
    if (xt) {
      crossTenantByAccount[acct.homeAccountId] = xt;
      crossTenantCount += 1;
      if (xt.staleAssociation) staleTenantCount += 1;
    }
  }

  return {
    crossTenantCount,
    staleTenantCount,
    sovereignAccountCount,
    cloudByAccount,
    crossTenantByAccount,
  };
}

/* ------------------------------------------------------------------ */
/*  Token-age trend buckets                                           */
/* ------------------------------------------------------------------ */

/**
 * Bucket an account into a "token age trend" — coarse-grained colour
 * coding for an inline mini-trend cell. We don't have per-token issue
 * timestamps available without decoding every cached JWT (and that
 * would burn an MSAL silent acquire), so we use `addedAt` as the
 * conservative proxy: it's set on initial sign-in and updated on every
 * refresh, so it tracks "how long since this account's bundle was last
 * confirmed valid".
 *
 * The same buckets drive the inline sparkline in the row — see
 * `tenant-graph-panel.tsx`.
 */
export function bucketAccountAge(account: AzureLoginAccount, now: number): {
  bucket: "fresh" | "warm" | "cool" | "stale" | "ancient";
  ageMs: number;
  ageLabel: string;
} {
  const ts = account.addedAt ? Date.parse(account.addedAt) : NaN;
  if (!Number.isFinite(ts)) {
    return { bucket: "ancient", ageMs: Number.POSITIVE_INFINITY, ageLabel: "—" };
  }
  const age = now - ts;
  if (age < 60 * 60 * 1000) {
    return { bucket: "fresh", ageMs: age, ageLabel: "<1h" };
  }
  if (age < 6 * 60 * 60 * 1000) {
    return { bucket: "warm", ageMs: age, ageLabel: "<6h" };
  }
  if (age < 24 * 60 * 60 * 1000) {
    return { bucket: "cool", ageMs: age, ageLabel: "<24h" };
  }
  if (age < 7 * 24 * 60 * 60 * 1000) {
    return { bucket: "stale", ageMs: age, ageLabel: "<7d" };
  }
  return { bucket: "ancient", ageMs: age, ageLabel: "≥7d" };
}

