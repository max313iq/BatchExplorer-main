/**
 * ReconciliationTile — post-batch steady-state check.
 *
 * After a batch completes, this panel reconciles the per-recipient status
 * map against expected steady-state and surfaces rows that need operator
 * attention. Grounded in `_bypass_modify_delete.md` (state-changing
 * operations need explicit follow-up — Azure does not guarantee the
 * caller's view of the new resource matches the destination tenant's
 * view immediately).
 *
 * Definitions of "steady state":
 *   - Same-tenant subscription, state="success" + subscriptionId    → STEADY
 *   - Same-tenant subscription, state="success", no subscriptionId  → ALIAS-ONLY (poll)
 *   - Cross-tenant subscription, state="success" + subscriptionId   → PENDING ACCEPTANCE
 *   - state="failure"                                               → FAILED
 *   - state="pending" / "running" past the end of the submit window → STALE
 */
import * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  Hourglass,
  Loader2,
  RotateCcw,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

type StatusState =
  | { state: "pending" }
  | { state: "running"; startedAt: number }
  | {
      state: "success";
      subscriptionId?: string;
      aliasName: string;
      startedAt: number;
      completedAt: number;
    }
  | {
      state: "failure";
      error: string;
      startedAt: number;
      completedAt: number;
    };

interface ReconciliationTileProps {
  callerTenantId: string;
  recipients: ReadonlyArray<{
    key: string;
    displayLabel: string;
    tenantId: string;
  }>;
  statusMap: Record<string, StatusState>;
  submitting: boolean;
}

type Bucket = "steady" | "aliasOnly" | "pendingAcceptance" | "failed" | "stale";

interface BucketRow {
  key: string;
  displayLabel: string;
  bucket: Bucket;
  note?: string;
}

function classify(
  callerTenantId: string,
  r: { key: string; displayLabel: string; tenantId: string },
  s: StatusState | undefined,
  submitting: boolean,
): BucketRow | null {
  if (!s) return null;
  if (s.state === "pending" || s.state === "running") {
    if (submitting) return null;
    return {
      key: r.key,
      displayLabel: r.displayLabel,
      bucket: "stale",
      note: "Submit window closed but the row is still pending/running. UI was likely refreshed mid-flight; the Subscription Alias call may still complete server-side.",
    };
  }
  if (s.state === "failure") {
    return {
      key: r.key,
      displayLabel: r.displayLabel,
      bucket: "failed",
      note: s.error,
    };
  }
  // success
  const home = callerTenantId.toLowerCase();
  const target = r.tenantId.toLowerCase();
  if (target !== home) {
    return {
      key: r.key,
      displayLabel: r.displayLabel,
      bucket: "pendingAcceptance",
      note: "Cross-tenant: the destination owner has 7 days to accept ownership in their tenant. Until then, the subscription is provisioned but not yet owned.",
    };
  }
  if (!s.subscriptionId) {
    return {
      key: r.key,
      displayLabel: r.displayLabel,
      bucket: "aliasOnly",
      note: "The alias PUT succeeded but the async polling did not return a subscriptionId before the UI moved on. Refresh or check the alias-status endpoint to retrieve the id.",
    };
  }
  return {
    key: r.key,
    displayLabel: r.displayLabel,
    bucket: "steady",
  };
}

const BUCKET_META: Record<
  Bucket,
  {
    label: string;
    icon: React.ReactNode;
    tone: string;
  }
> = {
  steady: {
    label: "Steady",
    icon: <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden />,
    tone: "border-success/30 bg-success/5 text-success-foreground",
  },
  aliasOnly: {
    label: "Alias-only (poll)",
    icon: (
      <Loader2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
    ),
    tone: "border-border bg-surface-sunken",
  },
  pendingAcceptance: {
    label: "Awaiting acceptance",
    icon: <Hourglass className="h-3.5 w-3.5 text-warning" aria-hidden />,
    tone: "border-warning/30 bg-warning/5",
  },
  failed: {
    label: "Failed",
    icon: (
      <AlertCircle className="h-3.5 w-3.5 text-destructive" aria-hidden />
    ),
    tone: "border-destructive/30 bg-destructive/5",
  },
  stale: {
    label: "Stale",
    icon: (
      <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
    ),
    tone: "border-border bg-surface-sunken",
  },
};

export const ReconciliationTile: React.FC<ReconciliationTileProps> = ({
  callerTenantId,
  recipients,
  statusMap,
  submitting,
}) => {
  const classified = React.useMemo<BucketRow[]>(() => {
    const out: BucketRow[] = [];
    for (const r of recipients) {
      const row = classify(callerTenantId, r, statusMap[r.key], submitting);
      if (row) out.push(row);
    }
    return out;
  }, [recipients, statusMap, submitting, callerTenantId]);

  const counts = React.useMemo<Record<Bucket, BucketRow[]>>(() => {
    const acc: Record<Bucket, BucketRow[]> = {
      steady: [],
      aliasOnly: [],
      pendingAcceptance: [],
      failed: [],
      stale: [],
    };
    for (const row of classified) acc[row.bucket].push(row);
    return acc;
  }, [classified]);

  if (classified.length === 0) return null;

  const allSteady =
    counts.steady.length === classified.length && classified.length > 0;

  return (
    <Card
      className={cn(
        "transition-colors duration-200 ease-out",
        allSteady
          ? "border-success/40 bg-success/5"
          : counts.failed.length > 0
            ? "border-destructive/30"
            : "border-border",
      )}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          {allSteady ? (
            <Sparkles
              className="h-4 w-4 text-success"
              aria-hidden
            />
          ) : (
            <CheckCircle2
              className="h-4 w-4 text-primary"
              aria-hidden
            />
          )}
          Steady-state reconciliation
          <Badge variant="secondary" className="text-2xs font-normal">
            {counts.steady.length}/{classified.length} steady
          </Badge>
        </CardTitle>
        <CardDescription>
          {allSteady
            ? "All rows reached steady state — subscription IDs are visible in your caller tenant and ready to use."
            : "Outcome breakdown by post-submit state. Use the buckets to triage what still needs the operator's attention."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1.5 text-2xs">
          {(Object.keys(BUCKET_META) as Bucket[]).map((b) => {
            const meta = BUCKET_META[b];
            const count = counts[b].length;
            if (count === 0) return null;
            return (
              <span
                key={b}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium",
                  meta.tone,
                )}
              >
                {meta.icon}
                {count} {meta.label}
              </span>
            );
          })}
        </div>
        {(counts.aliasOnly.length > 0 ||
          counts.pendingAcceptance.length > 0 ||
          counts.failed.length > 0 ||
          counts.stale.length > 0) && (
          <ul className="mt-1 flex flex-col gap-1 text-2xs">
            {(
              [
                "failed",
                "stale",
                "aliasOnly",
                "pendingAcceptance",
              ] as Bucket[]
            ).flatMap((b) =>
              counts[b].slice(0, 3).map((row) => (
                <li
                  key={row.key}
                  className={cn(
                    "flex items-start gap-2 rounded border px-2 py-1.5",
                    BUCKET_META[b].tone,
                  )}
                >
                  {BUCKET_META[b].icon}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium text-foreground">
                      {row.displayLabel}
                    </span>
                    {row.note && (
                      <span className="text-muted-foreground">
                        {row.note}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 uppercase tracking-wider opacity-70">
                    {BUCKET_META[b].label}
                  </span>
                </li>
              )),
            )}
            {(counts.aliasOnly.length > 3 ||
              counts.pendingAcceptance.length > 3 ||
              counts.failed.length > 3 ||
              counts.stale.length > 3) && (
              <li className="text-muted-foreground">
                …more rows in details above (scroll to per-recipient strip).
              </li>
            )}
          </ul>
        )}
        <p className="mt-1 text-2xs text-muted-foreground">
          Cite: <code className="font-mono">_bypass_modify_delete.md</code>{" "}
          (state-changing ops need explicit follow-up); cross-tenant
          steady-state per <code className="font-mono">_ea_subscription_cross_tenant.md</code> §7.
        </p>
      </CardContent>
    </Card>
  );
};
