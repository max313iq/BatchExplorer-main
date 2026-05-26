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
/** Look up a runbook for a finding's `ruleId`. Returns null when none
 *  is registered (page should fall back to a generic portal link). */
export declare function runbookFor(ruleId: string): RunbookEntry | null;
/** Fallback runbook used when nothing matches — kept exported so the
 *  page can render a consistent label/URL pair instead of an empty UI. */
export declare const GENERIC_RUNBOOK: RunbookEntry;
//# sourceMappingURL=security-audit-runbooks.d.ts.map