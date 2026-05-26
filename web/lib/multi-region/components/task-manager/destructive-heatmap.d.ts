/**
 * Destructive-op heatmap — corpus-grounded operator self-check.
 *
 * What it does:
 *   Subscribes to the session audit log, groups recent destructive actions
 *   (delete_pool, delete_subscription, hard_delete_user, etc.) by action
 *   class, and surfaces them as colored "heatmap" pills with a count and a
 *   rolling-window timestamp. Two alert tiers:
 *
 *     - "elevated"   : ≥ELEVATED_THRESHOLD destructive ops in WINDOW_MS
 *     - "anomalous"  : ≥ANOMALOUS_THRESHOLD OR a bulk-cancel burst that
 *                      looks like trail-hiding (many cancels on recently-
 *                      completed tasks within BURST_WINDOW_MS).
 *
 * Why this lives in the Task Manager:
 *   The Task Manager is the operations queue — every destructive task that
 *   gets dispatched lands here first. Showing the rate of destructive ops
 *   alongside the tasks themselves gives the operator immediate "am I
 *   about to break something" feedback. The audit log is the source of
 *   truth (already populated by every action site); we just present it.
 *
 * Corpus rationale (read-only reference):
 *   `_AZURE_BYPASS_PLAYBOOK.md` lines 139-152 lists the Critical Defender
 *   Audit Surface — destructive events to wire alerts on. Items 8-10 of
 *   that list (Delete diagnostic setting, Hard delete user, Cancel
 *   subscription) are the ones an attacker would use to clean up trails;
 *   our destructive classifier flags those at the top of the threat scale.
 *
 *   `_bypass_modify_delete.md` is the wider catalog of destructive ops.
 *
 * Why a separate file:
 *   Keeps the page component readable, makes the heatmap unit-testable
 *   without mounting the whole page, and provides a clean module boundary
 *   for future per-class threshold tuning.
 *
 * Source-only constraint: no new deps, no shared-component edits, no
 * service/store changes. We read the audit log via its existing public
 * `getEntries` / `subscribe` API.
 */
import * as React from "react";
import { AuditEntry } from "../../services/audit-log";
/**
 * Destructive-action class. Ordered by escalation severity — `tier3`
 * are the trail-clean / sovereignty-shift ops from the corpus's
 * "Critical Defender Audit Surface" items 8-10.
 */
export type DestructiveClass = "delete_pool" | "delete_account" | "delete_node" | "resize_pool" | "delete_subscription" | "hard_delete_user" | "delete_diagnostic_setting" | "task_cancel" | "task_remove" | "other_delete";
/**
 * Tier rubric:
 *   tier1 — workload-scope (pool/node restart, single-task cancel)
 *   tier2 — account/resource removal (delete_pool, delete_account)
 *   tier3 — tenant/billing/identity (cancel subscription, hard-delete user,
 *           delete diagnostic setting) — exactly the corpus's items 8-10.
 */
export type DestructiveTier = "tier1" | "tier2" | "tier3";
/**
 * Classify a raw audit `action` string. Action strings are free-form (see
 * `audit-log.ts` examples: "resize_pool", "delete_nodes", "login"), so
 * the classifier uses substring matching with corpus-aware precedence.
 * Returns `null` for non-destructive actions.
 */
export declare function classifyDestructive(action: string): DestructiveClass | null;
/**
 * "Bulk-cancel of recently-completed tasks" = the operator (or an attacker
 * who briefly held the session) is canceling a wave of tasks that were
 * already completed/cancelled — the typical motive is trail-hiding to
 * blur the audit log's view of what just happened. We detect this by
 * counting `task_cancel` / `task_remove` / `task_clear_finished` events
 * within BURST_WINDOW_MS whose target task's priorStatus was a terminal
 * state (completed / failed / cancelled / partial).
 *
 * Returns the burst count when above threshold, else 0.
 */
declare function detectBulkCancelBurst(entries: {
    entry: AuditEntry;
    klass: DestructiveClass;
    ageMs: number;
}[]): number;
export interface DestructiveHeatmapProps {
    /** If true, renders nothing when zero destructive ops in the window. */
    hideWhenEmpty?: boolean;
}
/**
 * Public component. Subscribes to the audit log, evaluates the rolling
 * destructive-op tally, and renders a heatmap row + (when triggered) an
 * elevated/anomalous banner.
 */
export declare const DestructiveHeatmap: React.FC<DestructiveHeatmapProps>;
export declare const _internals: {
    classifyDestructive: typeof classifyDestructive;
    detectBulkCancelBurst: typeof detectBulkCancelBurst;
    TIER_OF: Record<DestructiveClass, DestructiveTier>;
    WINDOW_MS: number;
    BURST_WINDOW_MS: number;
    ELEVATED_THRESHOLD: number;
    ANOMALOUS_THRESHOLD: number;
    BULK_CANCEL_BURST: number;
    RECENTLY_COMPLETED_MS: number;
};
export {};
//# sourceMappingURL=destructive-heatmap.d.ts.map