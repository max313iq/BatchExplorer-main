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
import {
  Activity,
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { auditLog, AuditEntry } from "../../services/audit-log";

/** Rolling window the heatmap evaluates against. 1h matches operator memory. */
const WINDOW_MS = 60 * 60 * 1000;
/** Tighter window used for bulk-cancel anomaly detection. */
const BURST_WINDOW_MS = 5 * 60 * 1000;
/** Crosses into "elevated" tier. */
const ELEVATED_THRESHOLD = 5;
/** Crosses into "anomalous" tier — visible warning banner. */
const ANOMALOUS_THRESHOLD = 12;
/** Bulk-cancel burst: this many cancels of recently-completed tasks in burst window. */
const BULK_CANCEL_BURST = 4;
/** "Recently completed" = completed within this much of the cancel timestamp. */
const RECENTLY_COMPLETED_MS = 10 * 60 * 1000;

/* --------------------------------------------------------------------- */
/* Classification                                                         */
/* --------------------------------------------------------------------- */

/**
 * Destructive-action class. Ordered by escalation severity — `tier3`
 * are the trail-clean / sovereignty-shift ops from the corpus's
 * "Critical Defender Audit Surface" items 8-10.
 */
export type DestructiveClass =
  | "delete_pool"
  | "delete_account"
  | "delete_node"
  | "resize_pool"
  | "delete_subscription"
  | "hard_delete_user"
  | "delete_diagnostic_setting"
  | "task_cancel"
  | "task_remove"
  | "other_delete";

/**
 * Tier rubric:
 *   tier1 — workload-scope (pool/node restart, single-task cancel)
 *   tier2 — account/resource removal (delete_pool, delete_account)
 *   tier3 — tenant/billing/identity (cancel subscription, hard-delete user,
 *           delete diagnostic setting) — exactly the corpus's items 8-10.
 */
export type DestructiveTier = "tier1" | "tier2" | "tier3";

const TIER_OF: Record<DestructiveClass, DestructiveTier> = {
  task_cancel: "tier1",
  task_remove: "tier1",
  delete_node: "tier1",
  resize_pool: "tier1",
  delete_pool: "tier2",
  delete_account: "tier2",
  other_delete: "tier2",
  delete_subscription: "tier3",
  hard_delete_user: "tier3",
  delete_diagnostic_setting: "tier3",
};

const LABEL_OF: Record<DestructiveClass, string> = {
  task_cancel: "Task cancels",
  task_remove: "Task removes",
  delete_node: "Node deletes",
  resize_pool: "Pool resizes",
  delete_pool: "Pool deletes",
  delete_account: "Account deletes",
  other_delete: "Other deletes",
  delete_subscription: "Subscription cancels",
  hard_delete_user: "Hard-delete users",
  delete_diagnostic_setting: "Diagnostic-setting deletes",
};

/**
 * Classify a raw audit `action` string. Action strings are free-form (see
 * `audit-log.ts` examples: "resize_pool", "delete_nodes", "login"), so
 * the classifier uses substring matching with corpus-aware precedence.
 * Returns `null` for non-destructive actions.
 */
export function classifyDestructive(action: string): DestructiveClass | null {
  const a = action.toLowerCase();
  // Order matters — most specific first.
  if (a.includes("hard_delete_user") || a.includes("hard delete user")) {
    return "hard_delete_user";
  }
  if (
    a.includes("delete_diagnostic") ||
    a.includes("delete diagnostic") ||
    a.includes("diagnostic_setting_delete")
  ) {
    return "delete_diagnostic_setting";
  }
  if (
    a.includes("cancel_subscription") ||
    a.includes("delete_subscription") ||
    a.includes("subscription_cancel")
  ) {
    return "delete_subscription";
  }
  if (a.includes("delete_pool") || a.includes("pool_delete")) {
    return "delete_pool";
  }
  if (a.includes("delete_account") || a.includes("account_delete")) {
    return "delete_account";
  }
  if (a.includes("delete_node") || a.includes("node_delete") || a === "delete") {
    return "delete_node";
  }
  if (a.includes("resize_pool") || a.includes("pool_resize")) {
    return "resize_pool";
  }
  // task_cancel + task_remove are the Task Manager's own destructive ops.
  if (a === "task_cancel" || a === "task_discard_interrupted") {
    return "task_cancel";
  }
  if (a === "task_remove" || a === "task_remove_history" || a === "task_clear_finished") {
    return "task_remove";
  }
  // Generic delete fallback — anything else that says "delete" anywhere.
  if (a.includes("delete")) return "other_delete";
  return null;
}

/* --------------------------------------------------------------------- */
/* Subscription                                                           */
/* --------------------------------------------------------------------- */

/**
 * Subscribe to the audit log and return entries that fall within the
 * rolling window AND classify as destructive. Refreshes on a 1-Hz tick
 * even without audit-log changes so old entries roll off the window.
 *
 * Cleanup: unsubscribes both the audit-log listener AND the interval
 * timer on unmount — no leaks even under HMR or fast remounts.
 */
function useRecentDestructiveEntries(
  windowMs: number,
): { entry: AuditEntry; klass: DestructiveClass; ageMs: number }[] {
  const [version, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    // Refresh on every audit-log change (single notify per record).
    const unsub = auditLog.onChange(bump);
    // ALSO re-evaluate once per second so entries roll off the window
    // even when no new audit events fire. Cheap — `getEntries()` is just
    // a slice over an in-memory array.
    const timer = window.setInterval(bump, 1000);
    return () => {
      unsub();
      window.clearInterval(timer);
    };
  }, []);
  void version;
  return React.useMemo(() => {
    const now = Date.now();
    const cutoff = now - windowMs;
    const out: { entry: AuditEntry; klass: DestructiveClass; ageMs: number }[] = [];
    for (const e of auditLog.getEntries()) {
      const t = new Date(e.timestamp).getTime();
      if (!isFinite(t) || t < cutoff) continue;
      const klass = classifyDestructive(e.action);
      if (!klass) continue;
      out.push({ entry: e, klass, ageMs: now - t });
    }
    return out;
  }, [windowMs, version]);
}

/* --------------------------------------------------------------------- */
/* Anomaly detection — bulk-cancel of recently-completed tasks            */
/* --------------------------------------------------------------------- */

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
function detectBulkCancelBurst(
  entries: { entry: AuditEntry; klass: DestructiveClass; ageMs: number }[],
): number {
  const now = Date.now();
  const burstCutoff = now - BURST_WINDOW_MS;
  let burst = 0;
  for (const { entry, klass } of entries) {
    if (klass !== "task_cancel" && klass !== "task_remove") continue;
    const t = new Date(entry.timestamp).getTime();
    if (t < burstCutoff) continue;
    const prior = (entry.details?.priorStatus as string | undefined) ?? "";
    const isTerminalPrior =
      prior === "completed" ||
      prior === "cancelled" ||
      prior === "failed" ||
      prior === "partial";
    // task_remove_history fires once with details.count for many tasks
    // at once — count it as a burst-of-1 weighted by count.
    if (entry.action === "task_remove_history") {
      const c = Number(entry.details?.count) || 1;
      // Heuristic: many history-removes in burst window is the smoking gun
      // for trail-hiding regardless of priorStatus (since by definition the
      // tasks being removed had terminal status).
      burst += Math.min(c, 25);
      continue;
    }
    if (entry.action === "task_clear_finished") {
      const c = Number(entry.details?.count) || 1;
      burst += Math.min(c, 25);
      continue;
    }
    // Was the target task in a terminal state when cancelled? If yes,
    // that's an anomaly (you can't "cancel" something that's done unless
    // you mean to bulk-clean the trail).
    if (isTerminalPrior) {
      // task_remove on a recently terminal task is suspicious; count both.
      burst++;
    }
  }
  return burst;
}

/* --------------------------------------------------------------------- */
/* Component                                                              */
/* --------------------------------------------------------------------- */

const TIER_TONE: Record<
  DestructiveTier,
  { ring: string; bg: string; fg: string; dot: string }
> = {
  tier1: {
    ring: "ring-muted/40",
    bg: "bg-muted/30",
    fg: "text-foreground",
    dot: "bg-muted-foreground",
  },
  tier2: {
    ring: "ring-warning/40",
    bg: "bg-warning/10",
    fg: "text-warning",
    dot: "bg-warning",
  },
  tier3: {
    ring: "ring-destructive/40",
    bg: "bg-destructive/10",
    fg: "text-destructive",
    dot: "bg-destructive",
  },
};

export interface DestructiveHeatmapProps {
  /** If true, renders nothing when zero destructive ops in the window. */
  hideWhenEmpty?: boolean;
}

/**
 * Public component. Subscribes to the audit log, evaluates the rolling
 * destructive-op tally, and renders a heatmap row + (when triggered) an
 * elevated/anomalous banner.
 */
export const DestructiveHeatmap: React.FC<DestructiveHeatmapProps> = ({
  hideWhenEmpty = false,
}) => {
  const entries = useRecentDestructiveEntries(WINDOW_MS);

  // Group counts by class. Object literal is cheaper than a Map at this size.
  const counts = React.useMemo(() => {
    const c: Partial<Record<DestructiveClass, number>> = {};
    for (const { klass } of entries) {
      c[klass] = (c[klass] ?? 0) + 1;
    }
    return c;
  }, [entries]);

  const total = entries.length;
  const burst = React.useMemo(() => detectBulkCancelBurst(entries), [entries]);
  // Tier3 carries more weight than count alone — surface those at the top
  // of the heatmap and use them as a tier3-fired flag for the banner copy.
  const tier3Count = React.useMemo(
    () =>
      entries.reduce(
        (n, e) => (TIER_OF[e.klass] === "tier3" ? n + 1 : n),
        0,
      ),
    [entries],
  );

  const tier: "ok" | "elevated" | "anomalous" =
    burst >= BULK_CANCEL_BURST || total >= ANOMALOUS_THRESHOLD || tier3Count >= 3
      ? "anomalous"
      : total >= ELEVATED_THRESHOLD || tier3Count >= 1
        ? "elevated"
        : "ok";

  if (hideWhenEmpty && total === 0 && burst === 0) return null;

  // Sort the visible chips by tier desc, then count desc — tier3 always
  // surfaces first so the operator's eye lands on the worst-case classes.
  const visibleChips = React.useMemo(() => {
    const all = Object.entries(counts) as Array<[DestructiveClass, number]>;
    return all
      .filter(([, n]) => n > 0)
      .sort((a, b) => {
        const tDiff =
          ["tier3", "tier2", "tier1"].indexOf(TIER_OF[a[0]]) -
          ["tier3", "tier2", "tier1"].indexOf(TIER_OF[b[0]]);
        if (tDiff !== 0) return tDiff;
        return b[1] - a[1];
      });
  }, [counts]);

  return (
    <div
      role="region"
      aria-label="Destructive operations heatmap"
      className={cn(
        "rounded-xl border bg-card/40 p-3 transition-colors duration-base",
        tier === "anomalous" && "border-destructive/40 bg-destructive/5",
        tier === "elevated" && "border-warning/40 bg-warning/5",
        tier === "ok" && "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          {tier === "anomalous" ? (
            <ShieldAlert className="h-4 w-4 text-destructive" aria-hidden="true" />
          ) : tier === "elevated" ? (
            <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
          ) : (
            <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Destructive ops · last hour
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="ml-0.5 inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full text-muted-foreground/70 hover:text-muted-foreground"
                aria-label="Destructive heatmap help"
              >
                <Activity className="h-3 w-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">
              Rolling-window tally of destructive actions issued in this
              session, grouped by class. Tier-3 (subscription cancels, hard-delete users,
              diagnostic-setting deletes) maps to the corpus's "Critical Defender
              Audit Surface" items 8-10 — review before issuing more.
            </TooltipContent>
          </Tooltip>
        </div>

        <span className="text-2xs tabular-nums text-muted-foreground">
          {total} op{total === 1 ? "" : "s"}
          {tier3Count > 0 && (
            <> · <span className="text-destructive">{tier3Count} tier-3</span></>
          )}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {visibleChips.length === 0 ? (
            <span className="text-2xs italic text-muted-foreground">
              No destructive ops recorded.
            </span>
          ) : (
            visibleChips.map(([klass, n]) => {
              const t = TIER_OF[klass];
              const tone = TIER_TONE[t];
              return (
                <Tooltip key={klass}>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold tabular-nums ring-1 transition-colors duration-fast",
                        tone.bg,
                        tone.fg,
                        tone.ring,
                      )}
                    >
                      <span
                        className={cn("h-1.5 w-1.5 rounded-full", tone.dot)}
                        aria-hidden="true"
                      />
                      {LABEL_OF[klass]}
                      <span className="rounded-full bg-background/40 px-1">
                        {n}
                      </span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {t === "tier3"
                      ? "Tier-3: corpus item 8-10 — defenders alert on this."
                      : t === "tier2"
                        ? "Tier-2: account / pool-scope deletion."
                        : "Tier-1: workload-scope action."}{" "}
                    {n} in the past hour.
                  </TooltipContent>
                </Tooltip>
              );
            })
          )}
        </div>
      </div>

      {/* Banner — only when elevated or anomalous. Lives inside the same
          card to keep the heatmap visually unified. */}
      {tier !== "ok" && (
        <div
          role="status"
          className={cn(
            "mt-2 flex animate-fade-in items-start gap-2 rounded-md px-2 py-1.5 text-2xs leading-snug",
            tier === "anomalous"
              ? "bg-destructive/10 text-destructive"
              : "bg-warning/10 text-warning",
          )}
        >
          <Trash2 className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            {tier === "anomalous" ? (
              <>
                <strong>Anomalous destructive activity</strong> — {total} ops
                in the past hour
                {burst >= BULK_CANCEL_BURST && (
                  <>
                    {" "}including a bulk-cancel burst of <strong>{burst}</strong>{" "}
                    in the past {Math.round(BURST_WINDOW_MS / 60_000)} min
                  </>
                )}
                {tier3Count >= 1 && (
                  <>
                    {" "}with <strong>{tier3Count} tier-3</strong> (subscription /
                    user / diagnostic-setting)
                  </>
                )}
                . Pause and review the audit log before issuing more.
              </>
            ) : (
              <>
                <strong>Elevated destructive activity</strong> — {total} ops in
                the past hour. Spot-check the audit log before continuing.
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
};

/* Test-only re-exports — the test file imports these to verify the
 * classifier and burst logic without rendering React. */
export const _internals = {
  classifyDestructive,
  detectBulkCancelBurst,
  TIER_OF,
  WINDOW_MS,
  BURST_WINDOW_MS,
  ELEVATED_THRESHOLD,
  ANOMALOUS_THRESHOLD,
  BULK_CANCEL_BURST,
  RECENTLY_COMPLETED_MS,
};
