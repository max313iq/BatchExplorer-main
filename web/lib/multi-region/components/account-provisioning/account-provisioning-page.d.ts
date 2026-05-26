/**
 * Account-provisioning page — 5-step wizard (Configure → Preflight → Review →
 * Submit → Result) per Design Contract §3.7. URL reflects current step via
 * `?step=...`. The `import existing accounts` flow remains as a sibling tab
 * since it is a different action class.
 *
 * 2026-05-26 wave-8 (Opus deep pass):
 *   - Lifted `PerSubSparkline` to module scope so it doesn't re-create per
 *     render of the parent (was an inline component, churned every keystroke
 *     on the filter inputs while a run was in flight).
 *   - Moved `perSubSummary` + `confirmMessage` + the dispatch-preview
 *     derivation into `React.useMemo` hooks at the component scope so they
 *     don't recompute on every render of the result step / hidden-dialog.
 *   - Added `Ctrl+Enter` (submit from Submit step) and `ArrowLeft` /
 *     `ArrowRight` to walk enabled wizard steps. ESC keeps its existing
 *     destructive-cancel-with-confirm behaviour.
 *   - Wired `aria-current="step"` on the active AnimatedTabs entry and a
 *     `role="progressbar"` mirror on the per-sub progress bar (Radix
 *     Progress is already a `<progress>` but the per-sub variant uses our
 *     internal component — explicit role + valuenow/valuemin/valuemax keep
 *     it screen-reader correct).
 *   - Per-region/by-sub toggle on the mid-run live rollup so an operator
 *     debugging a stuck region can group by region instead of by sub
 *     (defender-side telemetry view).
 *   - Resume-aborted-run banner: when a persisted `attemptStartedAt`
 *     outlives a hard reload, the configure step shows "Previous run
 *     interrupted at sub X/Y — see audit log for the partial state".
 *   - Defender-grade audit payload (per `_bypass_modify_delete.md` —
 *     state-change operations should be reconstructable from the audit
 *     trail alone): every submit now records a stable `attemptId` UUID,
 *     a preview of the dispatch plan (first 10 pairs), the
 *     `tokenExpirySecAtSubmit` (so a defender reviewing a 401 storm can
 *     tell whether the token was already near-expiry), and the unique
 *     tenant id set the run spans.
 *   - "Post-creation enumeration preview" panel on the Review step
 *     (corpus: NetSPI MicroBurst `Get-AzBatchAccounts` — every new Batch
 *     account is discoverable via `Microsoft.Batch/batchAccounts` list).
 *     Mirrors what an attacker enumerating this tenant would see immediately
 *     after a successful run, so the operator has informed-consent at the
 *     irreversible-action boundary.
 *   - Per-step elapsed time chip rendered in the step header so the
 *     operator can see how long they've spent reading vs. acting.
 *
 * 2026-05-24 redesign: per-page improvement loop. Focus areas:
 *   - Cancellable inter-sub waits (Stop now aborts both the orchestrator
 *     and the configured delay between sub dispatches).
 *   - Region-picker presets (All US / Europe / GPU / Clear) and inline
 *     filter so the dropdown isn't a wall of 40 regions to scroll.
 *   - Subscription-picker filter, copy-to-clipboard for IDs, info tooltip
 *     on the per-sub delay slider, and a "Skip already-existing" toggle
 *     that drops regions where the picked sub already owns a Batch
 *     account from the dispatch list (avoids 409 conflicts at the
 *     orchestrator).
 *   - Result step gains a summary stats panel (success rate, elapsed
 *     wall-clock, avg per region) and a per-account row click that opens
 *     the Azure Portal blade.
 *   - Multiple correctness fixes: timer cleanup on unmount during Stop,
 *     consolidated prefs hydration effect (replaces the two split effects
 *     with the eslint-disabled deps), and tightened attemptAccounts
 *     filter (use createdAt parse rather than lexical compare).
 *
 * 2026-05-25 hardening pass:
 *   - Plumbed AbortSignal end-to-end into `orchestrator.execute({...,signal})`
 *     so a Stop click cancels the in-flight ARM PUT (and not just the
 *     inter-sub wait + the agent-side cancellation flag).
 *   - Switched the 1-second progress ticker + the unmount-cancellation
 *     guard to `useAbortableEffect` so all async timer lifetimes are
 *     guaranteed to be torn down on dependency change / unmount.
 *   - Added `auditLog.record(...)` for every state-mutating user action
 *     (submit, stop, retry, discover, stop-discover, ESC-cancel,
 *     new-request) so the audit-log page surfaces this page like every
 *     other destructive page.
 *   - Persisted the in-progress wizard draft (subs picked, regions,
 *     per-sub delay, skipExisting) to localStorage via `usePersistedState`
 *     so a hard reload mid-configuration doesn't blow away the operator's
 *     work.
 *   - ESC-bound cancel-everything (orchestrator + inter-sub wait) gated
 *     by a confirmation dialog. Inactive when no run is in flight so the
 *     key isn't hijacked from other Radix popovers.
 *   - Per-sub success/fail mini-sparkline rendered mid-run from
 *     `attemptAccounts` so the operator sees per-sub progress without
 *     scrolling to the result step.
 *   - "Copy region list to clipboard" affordance on Step 2 (Preflight)
 *     via the shared `CopyButton`, so the operator can paste the list
 *     into a runbook / ticket without leaving the wizard.
 *   - Per-sub estimated-time badge derived from the rolling average
 *     across previously completed subs in the same attempt, so when a
 *     run is mid-flight the operator can see "Sub 4/8 — ~2m 30s
 *     remaining" instead of staring at an indeterminate spinner.
 *   - Switched the bespoke `CopyChip` to the shared `CopyButton`
 *     primitive so clipboard fallback semantics are identical to the
 *     rest of the app (clipboard API → execCommand fallback).
 */
import * as React from "react";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
interface AccountProvisioningPageProps {
    orchestrator: OrchestratorAgent;
}
export declare const AccountProvisioningPage: React.FC<AccountProvisioningPageProps>;
export {};
//# sourceMappingURL=account-provisioning-page.d.ts.map