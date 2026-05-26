/**
 * PreFlightPanel — surfaces corpus-grounded signatures and a pre-create
 * simulation BEFORE the operator clicks submit. Read-only, never mutates
 * the form; it exists so the audit trail / SIEM picture the operator
 * expects matches what will actually fire.
 *
 * Grounded in `_ea_subscription_cross_tenant.md` (cross-tenant attack
 * shape) and `_bypass_role_grant.md` (billing-role chain effects).
 *
 * Renders nothing when there are no recipients yet — keeps the page
 * quiet during the early scope-pick phase.
 */
import * as React from "react";
import {
  AlertTriangle,
  Eye,
  ListTree,
  ShieldAlert,
  ShieldCheck,
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

import {
  type SignatureFinding,
  type SignatureSeverity,
  type SimulatedEvent,
  computeSignatures,
  simulatePreCreate,
} from "./corpus-signatures";

interface PreFlightPanelProps {
  callerTenantId: string;
  callerTenantLabel: string;
  callerUpn: string | undefined;
  recipients: ReadonlyArray<{
    source: "web-account" | "tenant-user" | "manual";
    tenantId: string;
    ownerObjectId: string;
    displayLabel: string;
    upn?: string;
  }>;
}

const severityClass = (sev: SignatureSeverity): string => {
  switch (sev) {
    case "critical":
      return "border-destructive/40 bg-destructive/5";
    case "warning":
      return "border-warning/40 bg-warning/5";
    case "notice":
      return "border-info/40 bg-info/5";
    case "info":
    default:
      return "border-border bg-surface-sunken";
  }
};

const severityIcon = (sev: SignatureSeverity) => {
  switch (sev) {
    case "critical":
      return (
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
      );
    case "warning":
      return (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
      );
    case "notice":
      return <Eye className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden />;
    case "info":
    default:
      return (
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
      );
  }
};

const tenantBadgeTone = (
  scope: SimulatedEvent["tenant"],
): "default" | "secondary" | "outline" => {
  if (scope === "destination") return "outline";
  if (scope === "azure-activity") return "outline";
  return "secondary";
};

export const PreFlightPanel: React.FC<PreFlightPanelProps> = ({
  callerTenantId,
  callerTenantLabel,
  callerUpn,
  recipients,
}) => {
  const findings = React.useMemo<SignatureFinding[]>(
    () =>
      computeSignatures({
        callerTenantId,
        callerUpn,
        recipients,
      }),
    [callerTenantId, callerUpn, recipients],
  );

  const crossTenantCount = React.useMemo(() => {
    const home = callerTenantId.toLowerCase();
    return recipients.reduce(
      (acc, r) => acc + (r.tenantId.toLowerCase() !== home ? 1 : 0),
      0,
    );
  }, [recipients, callerTenantId]);

  const simulated = React.useMemo<SimulatedEvent[]>(
    () =>
      simulatePreCreate({
        recipientCount: recipients.length,
        crossTenantCount,
        callerTenantLabel,
      }),
    [recipients.length, crossTenantCount, callerTenantLabel],
  );

  if (recipients.length === 0) return null;

  const headlineSeverity: SignatureSeverity =
    findings.find((f) => f.severity === "critical")
      ? "critical"
      : findings.find((f) => f.severity === "warning")
        ? "warning"
        : findings.find((f) => f.severity === "notice")
          ? "notice"
          : "info";

  return (
    <Card
      className={cn(
        "transition-colors duration-200 ease-out",
        severityClass(headlineSeverity),
      )}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden />
          Pre-flight Cross-Tenant Signature
          {findings.length > 0 && (
            <Badge
              variant="secondary"
              className={cn(
                "text-2xs font-normal",
                headlineSeverity === "critical" &&
                  "bg-destructive/10 text-destructive",
                headlineSeverity === "warning" &&
                  "bg-warning/15 text-warning",
                headlineSeverity === "notice" && "bg-info/10 text-info",
              )}
            >
              {findings.length} finding{findings.length === 1 ? "" : "s"}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Corpus-grounded shape checks (read-only). These never block the
          submit — they highlight batches that look like documented EA
          abuse patterns so you can confirm intent before committing
          irreversible billing operations.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {findings.length === 0 ? (
          <div
            className="flex items-start gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-2xs"
            role="status"
          >
            <ShieldCheck
              className="h-3.5 w-3.5 shrink-0 text-success"
              aria-hidden
            />
            <p>
              No suspicious signatures detected in the proposed batch. The
              shape matches typical operator workflow (low cross-tenant
              count, owners well-resolved, sources consistent).
            </p>
          </div>
        ) : (
          <ul
            className="flex flex-col gap-2"
            role="list"
            aria-label="Pre-flight signature findings"
          >
            {findings.map((f) => (
              <li
                key={f.id}
                className={cn(
                  "flex items-start gap-2 rounded-md border px-3 py-2 text-2xs",
                  severityClass(f.severity),
                )}
              >
                {severityIcon(f.severity)}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="text-xs font-medium text-foreground">
                    {f.title}
                  </p>
                  <p className="text-muted-foreground">{f.detail}</p>
                  <p className="font-mono text-2xs text-muted-foreground/80">
                    cite: {f.citation}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

        <details className="rounded-md border border-border bg-card px-3 py-2 text-2xs">
          <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-foreground">
            <ListTree className="h-3.5 w-3.5" aria-hidden />
            Simulate audit events ({simulated.length} expected)
          </summary>
          <ol className="mt-2 flex flex-col gap-1.5 pl-1">
            {simulated.map((s) => (
              <li
                key={s.order}
                className="flex items-start gap-2 rounded border border-border/50 bg-background/60 px-2 py-1.5"
              >
                <span className="tabular-nums font-mono text-muted-foreground">
                  {s.order}.
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <code className="font-mono text-foreground">
                      {s.event}
                    </code>
                    <Badge
                      variant={tenantBadgeTone(s.tenant)}
                      className="text-2xs font-normal"
                    >
                      {s.tenant === "caller"
                        ? "caller tenant"
                        : s.tenant === "destination"
                          ? "destination tenant"
                          : "Azure Activity"}
                    </Badge>
                  </span>
                  <span className="text-muted-foreground">{s.detail}</span>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-muted-foreground">
            Tip: the per-recipient and batch-level event names above match
            the actual <code>auditLog.record</code> calls in this page, so
            an SIEM filter built against these names will match real
            events.
          </p>
        </details>
      </CardContent>
    </Card>
  );
};
