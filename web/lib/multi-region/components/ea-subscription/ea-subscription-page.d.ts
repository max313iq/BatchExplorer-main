/**
 * EA Subscription page — provisions Azure subscriptions under an
 * Enterprise Agreement (or MCA) billing scope, one per recipient.
 * Uses a Popover + Command picker for fuzzy multi-recipient selection,
 * zod-validated form, EmptyState for the unauthenticated path, and
 * ConfirmationDialog for the irreversible create step.
 *
 * Sibling files (extracted from this page to keep its surface scannable
 * and improve re-render isolation):
 *
 *   - `./accept-ownership-panel.tsx` — destination-tenant companion for
 *     the cross-tenant flow (operator pastes a subscriptionId and accepts
 *     ownership inline).
 *   - `./copyable-id.tsx`            — shared "copy to clipboard" pill.
 *   - `./ea-helpers.ts`              — pure utilities (parseBulkRecipients,
 *     suggestRemediation, categorizeError, azurePortalLinkForSubscription,
 *     formatElapsedSec, UUID/ALIAS regex, randomSuffix, generateBatchId).
 *   - `./pre-flight-panel.tsx`       — corpus-grounded signature panel
 *     (cross-tenant fan-out, mixed-recipient anomaly, self-replication,
 *     manual-paste-heavy) + pre-create audit-event simulation.
 *     Cite: `_ea_subscription_cross_tenant.md` §1, §9.
 *   - `./reconciliation-tile.tsx`    — post-batch steady-state bucket
 *     (steady / alias-only / pending-acceptance / failed / stale).
 *     Cite: `_bypass_modify_delete.md`.
 *   - `./recipient-templates.tsx`    — persisted recipient lists for
 *     repeated batches; localStorage via `usePersistedState`.
 *   - `./corpus-signatures.ts`       — pure detection helpers consumed by
 *     `pre-flight-panel.tsx`.
 *
 * Hotkeys: `Ctrl/Cmd + Enter` opens the create-subscription confirmation
 * when the form is ready; `Escape` cancels the confirm dialog (but never
 * aborts an in-flight batch).
 *
 * Screen readers get an off-screen `aria-live="polite"` announcer near the
 * top of the rendered tree that emits short batch-milestone strings
 * ("Provisioning subscriptions: 3 of 10 complete", "Batch complete.")
 * in addition to the visible Provisioning Summary card.
 */
import * as React from "react";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
export interface EaSubscriptionPageProps {
    orchestrator?: OrchestratorAgent;
    onNavigate?: (key: string) => void;
}
export declare const EaSubscriptionPage: React.FC<EaSubscriptionPageProps>;
//# sourceMappingURL=ea-subscription-page.d.ts.map