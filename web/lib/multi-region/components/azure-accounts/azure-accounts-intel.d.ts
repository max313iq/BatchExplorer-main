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
import type { AzureLoginAccount } from "../../store/store-types";
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
export type CloudEnvironment = "commercial" | "gov" | "dod" | "china" | "germany" | "unknown";
export interface CloudEnvironmentInfo {
    /** Discriminator used to drive Badge variant / colour. */
    kind: CloudEnvironment;
    /** Short label shown in the row badge ("Commercial", "Gov", …). */
    label: string;
    /** Long-form text rendered into the tooltip body. */
    description: string;
}
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
export declare function classifyCloudEnvironment(environment: string | undefined): CloudEnvironmentInfo;
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
export declare function detectCrossTenant(account: AzureLoginAccount): CrossTenantState | null;
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
    subscriptions: {
        subscriptionId: string;
        displayName: string;
        ownedBy: string;
    }[];
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
export declare function buildTenantGraph(accounts: AzureLoginAccount[]): TenantGraph;
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
export declare function summarizePosture(accounts: AzureLoginAccount[]): PostureSummary;
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
export declare function bucketAccountAge(account: AzureLoginAccount, now: number): {
    bucket: "fresh" | "warm" | "cool" | "stale" | "ancient";
    ageMs: number;
    ageLabel: string;
};
//# sourceMappingURL=azure-accounts-intel.d.ts.map