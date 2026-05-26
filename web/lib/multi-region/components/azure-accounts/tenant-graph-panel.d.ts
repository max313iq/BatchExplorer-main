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
import type { AzureLoginAccount } from "../../store/store-types";
import { type CloudEnvironmentInfo, type CrossTenantState } from "./azure-accounts-intel";
export interface TenantGraphPanelProps {
    accounts: AzureLoginAccount[];
    /** Map keyed by homeAccountId → sovereign-cloud classification. */
    cloudByAccount: Record<string, CloudEnvironmentInfo>;
    /** Map keyed by homeAccountId → cross-tenant state (if any). */
    crossTenantByAccount: Record<string, CrossTenantState>;
    /** Open the operator-account drawer for a given home account id. */
    onOpenAccount: (homeAccountId: string) => void;
    /** Optional className passthrough so the page can constrain width. */
    className?: string;
}
export declare const TenantGraphPanel: React.FC<TenantGraphPanelProps>;
/**
 * Inline mini "age trend" cell used per-row in the account list — five
 * vertical bars whose heights encode the bucketed age (`fresh`/`warm`/
 * `cool`/`stale`/`ancient`). NOT a real trend (we don't have per-token
 * issue timestamps without burning a silent acquire for every account)
 * — it's a visual encoding of `bucketAccountAge()` so an operator can
 * scan a long list and spot the accounts that should be refreshed.
 *
 * Pure presentational + accessible: the bar group renders a single
 * `role="img"` with a textual `aria-label` describing the age, and the
 * actual bars are `aria-hidden`.
 */
export interface TokenAgeBarsProps {
    bucket: "fresh" | "warm" | "cool" | "stale" | "ancient";
    ageLabel: string;
    className?: string;
}
export declare const TokenAgeBars: React.FC<TokenAgeBarsProps>;
//# sourceMappingURL=tenant-graph-panel.d.ts.map