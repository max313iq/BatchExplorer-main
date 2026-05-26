/**
 * security-audit-runbooks.ts
 *
 * Static map from finding `ruleId` to an authoritative remediation
 * runbook URL. Two-tier policy:
 *
 *   1. Microsoft Learn / Azure docs — the primary remediation source.
 *      Operators trust these and they survive product UI churn better
 *      than blog posts.
 *   2. Corpus playbook references (kept as a secondary hint string,
 *      not a clickable link) so the operator can see WHY the rule
 *      exists with one extra click into the local research corpus.
 *
 * The page surfaces the Microsoft Learn link as a small "Open runbook"
 * affordance per finding row. The corpus citation already lives in the
 * "Why it matters" tooltip text in the corpus-signals evaluators, so we
 * don't duplicate it here — this is purely about giving the operator a
 * concrete fix-doc link.
 *
 * Sources for URL choices:
 *   - Storage: Azure Storage hardening checklist
 *     https://learn.microsoft.com/azure/storage/common/storage-security-guide
 *   - Key Vault: Best-practices doc
 *     https://learn.microsoft.com/azure/key-vault/general/best-practices
 *   - Diagnostic settings: Monitor diagnostic-settings overview
 *     https://learn.microsoft.com/azure/azure-monitor/essentials/diagnostic-settings
 *   - Subscription state: Cost management + subscription lifecycle
 *     https://learn.microsoft.com/azure/cost-management-billing/manage/cancel-azure-subscription
 *   - RG idle / orphans: Azure governance well-architected
 *     https://learn.microsoft.com/azure/cloud-adoption-framework/govern/
 *
 * These URLs are stable Microsoft Learn entry points — they redirect
 * within the docs as Microsoft reorganizes content, so we don't need to
 * chase deep-link rot.
 */

export interface RunbookEntry {
  /** Display label for the link button / aria label. */
  label: string;
  /** Microsoft Learn (or other authoritative) URL. */
  url: string;
}

const STORAGE_HARDENING: RunbookEntry = {
  label: "Storage hardening checklist",
  url: "https://learn.microsoft.com/azure/storage/common/storage-security-guide",
};

const KEYVAULT_BEST_PRACTICES: RunbookEntry = {
  label: "Key Vault best practices",
  url: "https://learn.microsoft.com/azure/key-vault/general/best-practices",
};

const KEYVAULT_SOFT_DELETE: RunbookEntry = {
  label: "Key Vault soft-delete + purge protection",
  url: "https://learn.microsoft.com/azure/key-vault/general/soft-delete-overview",
};

const KEYVAULT_NETWORK: RunbookEntry = {
  label: "Key Vault network security",
  url: "https://learn.microsoft.com/azure/key-vault/general/network-security",
};

const KEYVAULT_RBAC: RunbookEntry = {
  label: "Key Vault RBAC migration",
  url: "https://learn.microsoft.com/azure/key-vault/general/rbac-guide",
};

const STORAGE_PUBLIC_ACCESS: RunbookEntry = {
  label: "Block public access",
  url: "https://learn.microsoft.com/azure/storage/blobs/anonymous-read-access-prevent",
};

const STORAGE_HTTPS: RunbookEntry = {
  label: "Require secure transfer",
  url: "https://learn.microsoft.com/azure/storage/common/storage-require-secure-transfer",
};

const STORAGE_TLS: RunbookEntry = {
  label: "Minimum TLS version",
  url: "https://learn.microsoft.com/azure/storage/common/transport-layer-security-configure-minimum-version",
};

const STORAGE_NETWORK: RunbookEntry = {
  label: "Storage account network rules",
  url: "https://learn.microsoft.com/azure/storage/common/storage-network-security",
};

const STORAGE_AAD: RunbookEntry = {
  label: "Prefer Azure AD authorization",
  url: "https://learn.microsoft.com/azure/storage/common/shared-key-authorization-prevent",
};

const DIAG_SETTINGS: RunbookEntry = {
  label: "Configure diagnostic settings",
  url: "https://learn.microsoft.com/azure/azure-monitor/essentials/diagnostic-settings",
};

const SUBSCRIPTION_LIFECYCLE: RunbookEntry = {
  label: "Reactivate / billing subscription",
  url: "https://learn.microsoft.com/azure/cost-management-billing/manage/cancel-azure-subscription",
};

const RG_GOVERNANCE: RunbookEntry = {
  label: "Resource organization & tagging",
  url: "https://learn.microsoft.com/azure/cloud-adoption-framework/ready/azure-best-practices/resource-tagging",
};

const CONTAINER_PUBLIC: RunbookEntry = {
  label: "Configure container public access",
  url: "https://learn.microsoft.com/azure/storage/blobs/anonymous-read-access-configure",
};

/**
 * Stable ruleId -> runbook map. Returning `null` is meaningful: it
 * means "no specific runbook" so the page can fall back to the generic
 * portal link only.
 */
const RUNBOOK_MAP: Readonly<Record<string, RunbookEntry>> = {
  // Storage
  "storage.publicly-accessible": STORAGE_PUBLIC_ACCESS,
  "storage.allow-public-access": STORAGE_PUBLIC_ACCESS,
  "storage.http-allowed": STORAGE_HTTPS,
  "storage.deprecated-tls": STORAGE_TLS,
  "storage.shared-key-default": STORAGE_AAD,
  "storage.no-network-restrictions": STORAGE_NETWORK,
  // Key Vault
  "keyvault.no-purge-protection": KEYVAULT_SOFT_DELETE,
  "keyvault.no-soft-delete": KEYVAULT_SOFT_DELETE,
  "keyvault.publicly-reachable": KEYVAULT_NETWORK,
  "keyvault.legacy-access-policies": KEYVAULT_RBAC,
  "keyvault.short-retention": KEYVAULT_SOFT_DELETE,
  "keyvault.many-access-policies": KEYVAULT_BEST_PRACTICES,
  "keyvault.wildcard-policy": KEYVAULT_BEST_PRACTICES,
  // Corpus signals
  "diag.absent": DIAG_SETTINGS,
  "diag.audit-disabled": DIAG_SETTINGS,
  "sub.state.warned": SUBSCRIPTION_LIFECYCLE,
  "sub.state.past-due": SUBSCRIPTION_LIFECYCLE,
  "sub.state.deleted": SUBSCRIPTION_LIFECYCLE,
  "sub.state.disabled": SUBSCRIPTION_LIFECYCLE,
  "sub.state.unknown": SUBSCRIPTION_LIFECYCLE,
  "container.public": CONTAINER_PUBLIC,
  "container.public.sensitive": CONTAINER_PUBLIC,
  "rg.empty": RG_GOVERNANCE,
  "rg.idle": RG_GOVERNANCE,
};

/** Look up a runbook for a finding's `ruleId`. Returns null when none
 *  is registered (page should fall back to a generic portal link). */
export function runbookFor(ruleId: string): RunbookEntry | null {
  return RUNBOOK_MAP[ruleId] ?? null;
}

/** Fallback runbook used when nothing matches — kept exported so the
 *  page can render a consistent label/URL pair instead of an empty UI. */
export const GENERIC_RUNBOOK: RunbookEntry = {
  label: "Azure security baseline",
  url: "https://learn.microsoft.com/security/benchmark/azure/",
};
