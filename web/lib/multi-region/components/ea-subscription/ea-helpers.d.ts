/**
 * Pure helpers extracted from ea-subscription-page.tsx so the main
 * component file is smaller, hot reloads faster, and unit tests (when
 * added) can target the helpers without mounting React.
 *
 * No JSX, no React imports. Importing from this file MUST stay free of
 * side-effects so the page-level bundle stays lean.
 */
export declare const UUID_REGEX: RegExp;
export declare const ALIAS_REGEX: RegExp;
/**
 * Map common Azure failure messages from the Subscription Alias API
 * to one-line remediation tips. The raw Azure message is still shown
 * inline; the tip appears below it as muted help text.
 */
export declare function suggestRemediation(rawError: string): string | null;
export declare function isValidUuid(value: string): boolean;
export declare function truncateMiddle(value: string, head?: number, tail?: number): string;
export declare function randomSuffix(n: number): string;
/**
 * Parse a freeform paste into one or more `(tenantId, ownerObjectId)`
 * pairs. Tolerates:
 *   - tab / comma / whitespace separators between the two GUIDs
 *   - one row per line OR a single comma-stream
 *   - extra whitespace, surrounding quotes, BOM
 *   - blank lines and `#` / `//` comment lines
 *   - reversed order is NOT auto-corrected — the contract is
 *     `tenant, owner` and reversing would silently provision in the
 *     wrong directory
 *
 * Returns up to `cap` valid pairs. Invalid lines are returned as
 * `errors` with the original line text for the operator to fix.
 */
export declare function parseBulkRecipients(raw: string, cap?: number): {
    pairs: Array<{
        tenantId: string;
        ownerObjectId: string;
        line: number;
    }>;
    errors: Array<{
        line: number;
        text: string;
        reason: string;
    }>;
    truncated: boolean;
};
export declare function isValidAlias(alias: string): boolean;
/**
 * Stable per-recipient idempotency key for a batch submit. The Subscription
 * Alias API treats the alias name itself as the idempotency key (a second
 * PUT with the same alias is a no-op when the first succeeded). We
 * additionally bake a batch-level uuid into the alias suffix so two
 * concurrent batches against the same recipient list never collide. The
 * key is also surfaced as a tag on the new subscription so it shows up in
 * audit logs and Azure Activity Log.
 */
export declare function generateBatchId(): string;
/**
 * Format a number of seconds as `mm:ss` (or `Xs` for under a minute).
 * Used in the per-recipient progress strip and the batch summary so
 * elapsed times are scannable without the operator counting digits.
 */
export declare function formatElapsedSec(secs: number): string;
/**
 * Coarse classification of an Azure error message into a category. Used by
 * the failure panel to badge errors so the operator can scan a long batch
 * and spot which failures are e.g. all the same auth issue vs. random
 * mixed problems. Returned label is short enough for an inline pill.
 */
export declare function categorizeError(error: string): {
    label: string;
    tone: "auth" | "data" | "quota" | "transient" | "input" | "unknown";
};
/**
 * Build the Azure Portal deep-link for a freshly-provisioned subscription.
 * The Subscription Alias API returns an ARM resource id like
 * `/subscriptions/{guid}` once the alias finishes async polling. The portal
 * accepts the bare GUID as a query parameter on the Subscriptions blade.
 */
export declare function azurePortalLinkForSubscription(subscriptionId: string): string;
//# sourceMappingURL=ea-helpers.d.ts.map