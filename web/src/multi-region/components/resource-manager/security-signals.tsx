/**
 * Resource-Manager security signals — heuristic warnings surfaced before
 * the operator commits a destructive ARM `moveResources` pipeline.
 *
 * These detections are grounded in the offensive-tooling corpus:
 *   - `_bypass_modify_delete.md` §4.10 "Bulk delete via batch" — bulk
 *     ops touching >20 resources from multiple RGs are an attacker
 *     anti-pattern. Same rubric applies to bulk moves: an attacker
 *     scooping up many resources across RGs is suspicious vs. an
 *     operator doing focused per-team migration.
 *   - `_bypass_modify_delete.md` §3 + §4 "Modify operations" — rename
 *     immediately followed by move is a known exfiltration pattern
 *     (attacker renames a resource to an obscure name to delay
 *     detection, then moves it to an attacker-controlled subscription
 *     where their telemetry can't be observed by the source tenant).
 *   - `_ea_subscription_cross_tenant.md` — cross-subscription transfers
 *     even within the same tenant change billing/RBAC inheritance and
 *     are worth flagging to the operator.
 *
 * NOTE: this is OPERATOR-VISIBLE defensive UX. It does NOT block the
 * action — the operator can still proceed. It exists so a defender
 * using this WebUI to drive a legitimate bulk move sees the same
 * red-flag heuristics that the SOC would see in Activity Log.
 */
import * as React from "react";
import {
  AlertTriangle,
  Shield,
  ArrowRight,
  Info,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

/** Computed input bundle for the security-signals card. */
export interface SecuritySignalsInput {
  /** How many planned rows in the current plan. */
  planRowCount: number;
  /** Distinct source resource-groups touched by the plan. */
  distinctSourceRgs: number;
  /** Distinct destination locations the plan would create. */
  distinctDestLocations: number;
  /** Source subscription id (full). */
  sourceSubscriptionId: string | null;
  /** Destination subscription id (full). */
  destinationSubscriptionId: string | null;
  /** Source tenant id (full). */
  sourceTenantId: string | null;
  /** Destination tenant id (full). */
  destinationTenantId: string | null;
  /**
   * How many rows have an operator-supplied destination RG name override
   * (the rename signal — combined with a move it triggers the
   * exfiltration heuristic).
   */
  rowsWithRenameOverride: number;
}

/**
 * Bulk-anomaly threshold — chosen to match the corpus rubric where
 * "bulk batch DELETE >20 ops" is the documented attacker pattern. We
 * apply the same threshold to bulk moves crossing RG boundaries.
 */
const BULK_ANOMALY_THRESHOLD = 20;

/**
 * Cross-RG-fan-out threshold — distinct source RGs in a single plan.
 * A legitimate "team migration" usually touches 1-3 RGs; >5 across
 * RGs in one bulk submit is the "scooping up everything" pattern.
 */
const FAN_OUT_RG_THRESHOLD = 5;

/**
 * Rename-then-move threshold — how many rows have to carry an operator
 * rename for the chain to qualify as "obvious bulk rename + move"
 * rather than a few targeted renames in an otherwise vanilla move.
 */
const RENAME_AND_MOVE_THRESHOLD = 3;

/**
 * Compute the active warning set for the current plan. Pure function
 * so it's trivially memoisable on the consumer side.
 */
export function computeSecuritySignals(
  input: SecuritySignalsInput,
): {
  bulkCrossRg: boolean;
  crossSubscription: boolean;
  crossTenant: boolean;
  renameAndMove: boolean;
  fanOutRgs: boolean;
  multiRegionLanding: boolean;
  anyActive: boolean;
} {
  const bulkCrossRg =
    input.planRowCount >= BULK_ANOMALY_THRESHOLD &&
    input.distinctSourceRgs > 1;
  const crossSubscription =
    !!input.sourceSubscriptionId &&
    !!input.destinationSubscriptionId &&
    input.sourceSubscriptionId !== input.destinationSubscriptionId;
  const crossTenant =
    !!input.sourceTenantId &&
    !!input.destinationTenantId &&
    input.sourceTenantId.toLowerCase() !==
      input.destinationTenantId.toLowerCase();
  const renameAndMove =
    input.rowsWithRenameOverride >= RENAME_AND_MOVE_THRESHOLD;
  const fanOutRgs = input.distinctSourceRgs >= FAN_OUT_RG_THRESHOLD;
  // Splaying a move across many destination locations is unusual — a
  // legitimate migration usually lands everything in one DR region. The
  // operator may have picked it on purpose, but worth surfacing.
  const multiRegionLanding = input.distinctDestLocations >= 4;
  return {
    bulkCrossRg,
    crossSubscription,
    crossTenant,
    renameAndMove,
    fanOutRgs,
    multiRegionLanding,
    anyActive:
      bulkCrossRg ||
      crossSubscription ||
      crossTenant ||
      renameAndMove ||
      fanOutRgs ||
      multiRegionLanding,
  };
}

interface SecuritySignalsBannerProps extends SecuritySignalsInput {
  /** Optional className passthrough. */
  className?: string;
}

/**
 * Compact banner that lists each active security signal as a line with
 * a corpus reference. Rendered above the action buttons so the operator
 * sees the warnings before clicking "Validate" / "Move".
 *
 * Renders nothing when no signal is active.
 */
export const SecuritySignalsBanner: React.FC<SecuritySignalsBannerProps> = (
  props,
) => {
  const signals = React.useMemo(() => computeSecuritySignals(props), [props]);
  if (!signals.anyActive) return null;

  const items: { key: string; severity: "warn" | "info"; text: React.ReactNode }[] = [];

  if (signals.crossTenant) {
    items.push({
      key: "cross-tenant",
      severity: "warn",
      text: (
        <>
          Cross-tenant move detected. ARM rejects this configuration
          ({" "}
          <code className="font-mono">{props.sourceTenantId?.slice(0, 8)}…</code>{" "}
          →{" "}
          <code className="font-mono">{props.destinationTenantId?.slice(0, 8)}…</code>
          ). Source &amp; destination subscriptions must live in the same
          tenant.{" "}
          <span className="text-muted-foreground">
            Ref: _ea_subscription_cross_tenant.md
          </span>
        </>
      ),
    });
  }

  if (signals.crossSubscription) {
    items.push({
      key: "cross-subscription",
      severity: "info",
      text: (
        <>
          Cross-subscription move ({" "}
          <code className="font-mono">
            {props.sourceSubscriptionId?.slice(0, 8)}…
          </code>{" "}
          →{" "}
          <code className="font-mono">
            {props.destinationSubscriptionId?.slice(0, 8)}…
          </code>
          ). RBAC role assignments scoped to the source subscription /
          RG do <strong>not</strong> follow the resource; policy
          assignments inherited from the source MG/sub do not follow
          either. Verify the destination&apos;s baseline before relying on
          inherited grants.{" "}
          <span className="text-muted-foreground">
            Ref: _bypass_role_grant.md
          </span>
        </>
      ),
    });
  }

  if (signals.bulkCrossRg) {
    items.push({
      key: "bulk-cross-rg",
      severity: "warn",
      text: (
        <>
          Bulk-move anomaly: <strong>{props.planRowCount}</strong> resources
          across <strong>{props.distinctSourceRgs}</strong> source RGs in a
          single submit. Activity-Log defenders flag {">"}{BULK_ANOMALY_THRESHOLD}
          {" "}cross-RG ops in a window — confirm this is a planned
          migration and not over-broad selection.{" "}
          <span className="text-muted-foreground">
            Ref: _bypass_modify_delete.md §4.10 (bulk batch ops rubric)
          </span>
        </>
      ),
    });
  } else if (signals.fanOutRgs) {
    items.push({
      key: "fan-out-rgs",
      severity: "info",
      text: (
        <>
          Plan touches <strong>{props.distinctSourceRgs}</strong> distinct
          source RGs. A legitimate team migration usually targets 1–3 RGs;
          if you didn&apos;t intend to span this many, narrow your
          selection.
        </>
      ),
    });
  }

  if (signals.renameAndMove) {
    items.push({
      key: "rename-and-move",
      severity: "warn",
      text: (
        <>
          Rename-and-move sequence: {" "}
          <strong>{props.rowsWithRenameOverride}</strong> of {" "}
          {props.planRowCount} rows have an operator-supplied destination
          RG name that overrides the template. Rename-then-move is a known
          exfiltration pattern (obscure name + relocation hides the
          resource from source-tenant telemetry). Double-check that the
          new names match an approved naming convention.{" "}
          <span className="text-muted-foreground">
            Ref: _bypass_modify_delete.md §4 (modify ops + relocation)
          </span>
        </>
      ),
    });
  }

  if (signals.multiRegionLanding) {
    items.push({
      key: "multi-region-landing",
      severity: "info",
      text: (
        <>
          Plan lands into <strong>{props.distinctDestLocations}</strong>{" "}
          distinct regions. A single bulk move usually consolidates into
          one DR region — verify this fan-out is intentional.
        </>
      ),
    });
  }

  return (
    <div
      role="region"
      aria-label="Security signals for the planned move"
      className={
        "rounded-md border border-warning/40 bg-warning/5 p-2 text-2xs " +
        (props.className ?? "")
      }
    >
      <div className="mb-1 flex items-center gap-1 font-medium text-warning">
        <Shield className="h-3 w-3" aria-hidden />
        <span>Move-pipeline security signals ({items.length})</span>
        <Badge variant="outline" className="ml-auto text-2xs">
          advisory
        </Badge>
      </div>
      <ul className="m-0 space-y-1 pl-0 list-none">
        {items.map((it) => (
          <li key={it.key} className="flex items-start gap-1">
            {it.severity === "warn" ? (
              <AlertTriangle
                className="h-3 w-3 shrink-0 translate-y-[1px] text-warning"
                aria-hidden
              />
            ) : (
              <Info
                className="h-3 w-3 shrink-0 translate-y-[1px] text-primary"
                aria-hidden
              />
            )}
            <span className="leading-snug">{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/* ------------------------------------------------------------------- */

/**
 * Pre-move attack-surface preview — a static reference card that
 * surfaces "what transfers, what doesn't" so an operator running their
 * first move doesn't get caught out by RBAC/policy/lock gaps at the
 * destination. Independent from the per-row plan; values are the
 * documented behaviour of ARM `moveResources`.
 *
 * Source-of-truth: Microsoft docs on resource-move limitations +
 * `_bypass_role_grant.md` for the role-assignment scoping rubric. We
 * surface this in the UI so the operator never has to context-switch
 * to the docs mid-pipeline.
 */
export const PreMoveAttackSurfacePreview: React.FC<{
  className?: string;
}> = ({ className }) => {
  return (
    <Alert
      variant="default"
      role="region"
      aria-label="What transfers with a moveResources call"
      className={
        "border-primary/30 bg-primary/5 " + (className ?? "")
      }
    >
      <ArrowRight className="h-3.5 w-3.5" />
      <AlertDescription>
        <div className="text-xs">
          <p className="m-0 mb-1 font-medium">
            What transfers with the move, what doesn&apos;t:
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <p className="m-0 text-2xs font-medium text-success">
                Transfers (lands at destination):
              </p>
              <ul className="m-0 list-disc pl-4 text-2xs text-muted-foreground">
                <li>Batch-account resource id (changes to new RG)</li>
                <li>Tags applied at the resource level</li>
                <li>Provisioning state &amp; data-plane endpoint</li>
                <li>Account-scoped pools (move with the parent)</li>
              </ul>
            </div>
            <div>
              <p className="m-0 text-2xs font-medium text-warning">
                Does NOT transfer (re-apply at destination):
              </p>
              <ul className="m-0 list-disc pl-4 text-2xs text-muted-foreground">
                <li>
                  RBAC role assignments scoped to the source RG/sub
                </li>
                <li>Resource locks (ReadOnly / CanNotDelete)</li>
                <li>Diagnostic-setting forwards (Log Analytics, Storage)</li>
                <li>Azure-Policy assignments inherited from source MG/sub</li>
                <li>Private-endpoint approvals (must re-approve)</li>
              </ul>
            </div>
          </div>
          <p className="m-0 mt-1 text-2xs text-muted-foreground">
            Re-audit role assignments &amp; diagnostic settings post-move so
            the moved Batch account doesn&apos;t silently lose telemetry
            forwarding or end up with stale source-RG grants leaking access.
          </p>
        </div>
      </AlertDescription>
    </Alert>
  );
};
