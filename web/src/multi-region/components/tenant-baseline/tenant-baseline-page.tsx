/**
 * Tenant Security Baseline + Service Principal Credentials — defensive
 * tenant auditor inspired by AADInternals' read-only cmdlets.
 *
 * What this page is for:
 *
 *   - Tenant admins audit common Entra ID misconfigs in THEIR OWN tenant
 *     (Tab 1 = Baseline configuration)
 *   - Operations teams track SP password / certificate expiries before
 *     they cause an outage (Tab 2 = Service Principal credentials)
 *
 * What this page is NOT:
 *
 *   - This page never POSTs / PATCHes / DELETEs. It cannot change tenant
 *     configuration or rotate any credential. Every action is a Graph GET.
 *   - It does not access the undocumented MS-DRS / provisioning APIs that
 *     AADInternals reaches for in its offensive code paths. Anything we
 *     surface comes from the public Graph v1.0 surface area.
 *
 * Authentication / scope:
 *
 *   - The page auto-uses the primary signed-in account's *active* tenant
 *     (the same one the operator picked in the global tenant switcher).
 *     Switching account is handled at the global level — no per-page
 *     selector to keep the surface simple.
 *
 * Permissions:
 *
 *   - Required: `Directory.Read.All` (default for any admin role)
 *   - Recommended: `Policy.Read.All` so we can read the security defaults
 *     + authorization policies. Without it, those checks degrade to
 *     "Unknown" with an inline banner.
 *   - Recommended: `RoleManagement.Read.Directory` so the SP admin-role
 *     cross-check works. Without it, all SPs render with hasAdminRole=false.
 *
 * Audit log:
 *
 *   - `action: "tenant_baseline_audit"` once Tab 1 finishes loading.
 *   - `action: "sp_credentials_audit"` once Tab 2 finishes loading.
 *   - `action: "tenant_baseline_snapshot_save"` when the operator saves a
 *     compliance baseline snapshot (Enhancement #1).
 *   - `action: "tenant_baseline_snapshot_clear"` when the snapshot is cleared.
 *   - `action: "tenant_baseline_filter_change"` on Tab 2 filter mutations
 *     (severity / type). Filter changes are inexpensive but recorded so a
 *     reviewer can reconstruct the operator's viewport at the time of audit.
 *
 * Enhancements added (per page-improvement spec):
 *
 *   - Persisted "compliance baseline" snapshot per tenant via usePersistedState
 *     (save + diff current vs saved + clear).
 *   - Drift badges (regressed / improved / changed) per finding card +
 *     aggregated counters in the tab summary row.
 *   - CSV / JSON export via shared ExportMenu (replaces ad-hoc CSV button).
 *   - URL-persisted filter (search / severity / type) on the SP tab via
 *     useUrlState — deep links preserve the operator's view.
 *   - Click-to-copy on tenant id, finding check id, SP appId + display name
 *     via shared CopyButton (replaces inline clipboard helpers).
 *   - "Open in Entra portal" deep link per finding + per SP row.
 *
 * Wiring tightening:
 *
 *   - Initial baseline probe uses useAbortableEffect (abort-on-unmount).
 *   - All ad-hoc clipboard / download utilities replaced with shared
 *     components.
 *   - No edits outside this folder (helpers extension is in
 *     tenant-baseline-helpers.ts).
 */
import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BellRing,
  Bookmark,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cloud,
  ExternalLink,
  FileCheck,
  GitCompare,
  Globe,
  History,
  Info,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, formatRelativeTime } from "@/lib/utils";

import { getActiveTenant, getGraphTokenForAccount } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog } from "../../services/audit-log";
import { useMultiRegionState } from "../../store/store-context";
import { CopyButton } from "../shared/copy-button";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";

import {
  type BaselineCheckId,
  type BaselineFinding,
  type BaselineHistoryEntry,
  type BaselineSeverity,
  type BaselineSnapshot,
  type CloudEnvironmentInfo,
  type ComplianceEvidence,
  type ConditionalAccessPolicyRaw,
  type DomainRaw,
  type DriftSummary,
  type FederatedDomainEntry,
  type FederationConfigRaw,
  type FindingDrift,
  type GraphServicePrincipalRaw,
  type OrganizationRaw,
  type AuthorizationPolicyRaw,
  type SecurityDefaultsPolicyRaw,
  type SpScoredRow,
  type SpType,
  TIER_ZERO_ROLE_TEMPLATE_IDS,
  buildComplianceEvidence,
  buildHistoryEntry,
  buildSnapshot,
  compareHistoryEntries,
  compareIsoDates,
  compareSeverityDesc,
  detectCloudEnvironmentFromToken,
  diffAgainstSnapshot,
  portalLinkForFinding,
  portalLinkForServicePrincipal,
  pushHistoryEntry,
  scoreCaPolicyDrift,
  scoreDefaultUserPermissions,
  scoreDomainsFederation,
  scoreFederationBackdoorDrift,
  scoreGuestInvitePolicy,
  scoreOnPremSync,
  scorePasswordProtection,
  scoreSecurityDefaults,
  scoreServicePrincipal,
  severityLabel,
  severityToBadgeVariant,
  summarizeDrift,
  tallySeverities,
} from "./tenant-baseline-helpers";

// ===========================================================================
// Constants
// ===========================================================================

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SP_PAGE_SIZE = 999; // Graph max for $top on /servicePrincipals
const SEARCH_DEBOUNCE_MS = 150;

/** localStorage key prefix for the saved baseline snapshot (per-tenant). */
const SNAPSHOT_STORAGE_PREFIX = "tenant-baseline:snapshot:";
/** Schema version — bump if BaselineSnapshot shape changes. */
const SNAPSHOT_SCHEMA_VERSION = 1;
/** localStorage key prefix for the drift-history ring buffer (per-tenant). */
const HISTORY_STORAGE_PREFIX = "tenant-baseline:history:";
/** Schema version for the history ring — bump if BaselineHistoryEntry shape changes. */
const HISTORY_SCHEMA_VERSION = 1;
/** localStorage key for the global "alert me on drift" preference. Cross-tenant. */
const ALERT_ON_DRIFT_PREF_KEY = "tenant-baseline:alert-on-drift";

// Severity filter chips for Tab 2 — kept module-scoped so the chip strip
// component can render them without re-creating the array each render.
const SEVERITY_FILTER_OPTIONS: BaselineSeverity[] = [
  "critical",
  "high",
  "medium",
  "ok",
  "info",
];

const SP_TYPE_OPTIONS: SpType[] = [
  "ManagedIdentity",
  "Application",
  "Legacy",
  "Unknown",
];

// ===========================================================================
// Small primitives
// ===========================================================================

/**
 * Visual icon for a severity tier. Used inside the finding cards on Tab 1
 * and as a leading element on each SP row in Tab 2.
 */
const SeverityIcon: React.FC<{
  severity: BaselineSeverity;
  className?: string;
}> = ({ severity, className }) => {
  const cls = cn("h-4 w-4", className);
  switch (severity) {
    case "ok":
      return <CheckCircle2 className={cn(cls, "text-success")} aria-hidden />;
    case "critical":
    case "high":
      return <XCircle className={cn(cls, "text-destructive")} aria-hidden />;
    case "medium":
      return (
        <AlertTriangle className={cn(cls, "text-warning")} aria-hidden />
      );
    case "low":
    case "info":
      return <Info className={cn(cls, "text-info")} aria-hidden />;
    case "unknown":
    default:
      return (
        <AlertCircle
          className={cn(cls, "text-muted-foreground")}
          aria-hidden
        />
      );
  }
};

/** Severity badge — small, colour-coded. */
const SeverityBadge: React.FC<{ severity: BaselineSeverity }> = ({
  severity,
}) => {
  return (
    <Badge variant={severityToBadgeVariant(severity)} className="gap-1">
      <SeverityIcon severity={severity} className="h-3 w-3" />
      {severityLabel(severity)}
    </Badge>
  );
};

/**
 * Tiny details/summary disclosure used inside a finding card. We use a
 * native <details> rather than a Radix accordion because (a) the page has
 * up to 18 of these on screen at once, and (b) we want them independently
 * collapsible without any focus-trap behaviour.
 */
const Expander: React.FC<{
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}> = ({ label, children, defaultOpen }) => {
  return (
    <details
      className="group rounded-md border border-border bg-muted/30"
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-2xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
        {label}
      </summary>
      <div className="border-t border-border px-2.5 py-2 text-xs leading-relaxed text-foreground">
        {children}
      </div>
    </details>
  );
};

/** Pre-formatted JSON viewer used inside Expander. */
const JsonViewer: React.FC<{ value: unknown }> = ({ value }) => {
  const text = React.useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  return (
    <div className="relative">
      <div className="absolute right-1 top-1">
        <CopyButton
          value={text}
          alwaysVisible
          ariaLabel="Copy raw Graph response to clipboard"
        />
      </div>
      <pre className="max-h-72 overflow-auto rounded bg-card p-2 font-mono text-2xs leading-snug text-foreground">
        {text}
      </pre>
    </div>
  );
};

// ===========================================================================
// Drift indicator (Enhancement: drift vs saved baseline)
// ===========================================================================

/**
 * Compact pill rendered on each finding card when a saved baseline exists.
 * - regressed: this run is WORSE than the saved baseline
 * - improved:  this run is BETTER than the saved baseline
 * - summary-changed: same severity but the human summary changed
 *   (e.g. extra detail in the finding text — worth a glance)
 * - new-check-introduced: this check id was added AFTER the saved baseline
 *   was captured. Rendered as an info pill so the operator knows the
 *   diff against an old baseline includes auditor schema additions.
 * - match: identical — no pill (we skip render)
 * - no-baseline: skipped (handled by caller)
 */
const DriftPill: React.FC<{ drift: FindingDrift }> = ({ drift }) => {
  if (drift.status === "match" || drift.status === "no-baseline") return null;
  if (drift.status === "new-check-introduced") {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="info" className="gap-1">
              <Sparkles className="h-3 w-3" aria-hidden />
              New check
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-md text-2xs">
            This check id wasn&rsquo;t present when the approved baseline
            snapshot was captured. Review it, then re-save the baseline so
            future drift comparisons include this signal.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  if (drift.status === "regressed") {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="destructive" className="gap-1">
              <ArrowUpRight className="h-3 w-3" aria-hidden />
              Regressed
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-md text-2xs">
            Was {drift.baselineSeverity} in saved baseline — now worse.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  if (drift.status === "improved") {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="success" className="gap-1">
              <ArrowDownRight className="h-3 w-3" aria-hidden />
              Improved
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-md text-2xs">
            Was {drift.baselineSeverity} in saved baseline — now better.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  // summary-changed
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="warning" className="gap-1">
            <GitCompare className="h-3 w-3" aria-hidden />
            Changed
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-md text-2xs">
          Severity unchanged ({drift.baselineSeverity}) but the underlying
          status text changed. Previous summary: &ldquo;{drift.baselineSummary}&rdquo;.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

/**
 * Sovereign-cloud sentinel banner (Signal C).
 *
 * Pure presentational. Reads the cloud env we already inferred from the
 * Graph token's `iss` claim and renders a one-line read-only banner. We
 * never probe other clouds.
 *
 * Detection inspired by:
 *   New folder/_AZURE_BYPASS_PLAYBOOK.md Phase 4 ("Cross-cloud: probe
 *     login.microsoftonline.us and login.partner.microsoftonline.cn").
 *   New folder/_bypass_tenant_switch.md §8.2 — defenders rarely correlate
 *     sign-in logs across clouds; cross-cloud guests are a documented
 *     pivot path.
 */
const SovereignCloudBanner: React.FC<{ cloudInfo: CloudEnvironmentInfo }> = ({
  cloudInfo,
}) => {
  // Sovereign clouds use a warning-tinted banner; commercial uses a
  // neutral / muted shade. Unknown also gets the warning shade because
  // an unidentifiable issuer is itself a signal.
  const isSovereign: boolean =
    cloudInfo.environment === "AzureUSGovernment" ||
    cloudInfo.environment === "AzureChina" ||
    cloudInfo.environment === "AzureGermany";
  const isUnknown: boolean = cloudInfo.environment === "Unknown";
  return (
    <div
      role="status"
      aria-label={`Active Microsoft cloud environment: ${cloudInfo.label}`}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
        isSovereign
          ? "border-warning/50 bg-warning/10 text-foreground"
          : isUnknown
            ? "border-warning/40 bg-muted/40 text-foreground"
            : "border-border bg-muted/30 text-muted-foreground",
      )}
    >
      <Cloud className="h-3.5 w-3.5" aria-hidden />
      <span className="font-semibold">{cloudInfo.label}</span>
      <span className="text-2xs text-muted-foreground">
        — posture in this view reflects ONLY this cloud. Identities also
        present in other Microsoft clouds (Commercial / US Gov / China)
        must be audited separately.
      </span>
      {cloudInfo.issuer && (
        <span className="ml-auto font-mono text-3xs text-muted-foreground">
          iss: {cloudInfo.issuer}
        </span>
      )}
    </div>
  );
};

/**
 * Single baseline-check card — the visual unit on Tab 1. Renders the
 * severity icon + name + status, with three lazy expanders for the
 * three deeper sections (why it matters, remediation, raw response).
 *
 * Optional `drift` props in a drift pill ("Regressed" / "Improved" / "Changed")
 * vs the saved baseline, and `portalHref` adds an "Open in Entra portal"
 * deep-link button to the card header.
 */
const FindingCard: React.FC<{
  finding: BaselineFinding;
  drift: FindingDrift;
  portalLink: { href: string; label: string };
}> = ({ finding, drift, portalLink }) => {
  const isDrift =
    drift.status === "regressed" ||
    drift.status === "improved" ||
    drift.status === "summary-changed" ||
    drift.status === "new-check-introduced";
  return (
    <Card
      className={cn(
        "overflow-hidden",
        drift.status === "regressed" && "border-destructive/60",
        drift.status === "improved" && "border-success/60",
        drift.status === "new-check-introduced" && "border-info/60",
      )}
    >
      <CardHeader className="space-y-1 pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <SeverityIcon severity={finding.severity} />
          <span>{finding.name}</span>
          <SeverityBadge severity={finding.severity} />
          {isDrift && <DriftPill drift={drift} />}
          <span className="group/copy ml-auto inline-flex items-center gap-1">
            <CopyButton
              value={finding.id}
              ariaLabel={`Copy check id ${finding.id}`}
            />
            <a
              href={portalLink.href}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={portalLink.label}
              title={portalLink.label}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </span>
        </CardTitle>
        <CardDescription className="text-xs leading-relaxed">
          {finding.summary}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 pt-0">
        <Expander label="Why it matters">
          <p>{finding.whyItMatters}</p>
        </Expander>
        <Expander label="Remediation">
          <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">
            {finding.remediation}
          </pre>
        </Expander>
        <Expander label="Raw Graph response">
          {finding.raw === undefined ? (
            <p className="text-muted-foreground">
              No response captured. The probe likely failed before it could
              send a request — see the error banner above the tab.
            </p>
          ) : (
            <JsonViewer value={finding.raw} />
          )}
        </Expander>
        {finding.error && (
          <Alert variant="warning" className="py-2">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-2xs">
              {finding.error}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};

// ===========================================================================
// Graph fetch helpers (page-local — we don't want to bloat the service layer
// for endpoints used only by this auditor)
// ===========================================================================

interface GraphFetchOpts {
  signal?: AbortSignal;
}

async function graphGet<T>(
  path: string,
  token: string,
  opts?: GraphFetchOpts,
): Promise<T> {
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Graph GET ${path} failed: ${resp.status} ${body.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

/**
 * Walk @odata.nextLink until exhausted. Returns the concatenated `value`
 * arrays. We don't go through the service-layer guardedFetch helper here
 * because this auditor page is one-shot per tab; using vanilla fetch
 * keeps the dependency surface small and avoids touching the shared
 * RequestGuard's rate-limit counters.
 */
async function graphList<T>(
  initialPath: string,
  token: string,
  opts?: GraphFetchOpts,
): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = initialPath;
  let safety = 0;
  while (url) {
    if (safety++ > 100) {
      throw new Error("Graph list pagination exceeded safety cap (100 pages)");
    }
    const page: { value?: T[]; "@odata.nextLink"?: string } = await graphGet<{
      value?: T[];
      "@odata.nextLink"?: string;
    }>(url, token, opts);
    if (Array.isArray(page.value)) {
      out.push(...page.value);
    }
    url = page["@odata.nextLink"] ?? null;
  }
  return out;
}

/**
 * Token expiry derived from the JWT exp claim. We never decode the
 * signature — this is only used for the in-app "token expires in Xm"
 * pill. If the token can't be parsed (e.g. opaque token from an
 * imported source), returns null.
 */
function tokenSecondsUntilExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const pad = payload.length % 4;
    const padded = pad ? payload + "=".repeat(4 - pad) : payload;
    const decoded =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("utf8");
    const json = JSON.parse(decoded) as { exp?: number };
    if (typeof json.exp !== "number") return null;
    return Math.max(0, json.exp - Math.floor(Date.now() / 1000));
  } catch {
    return null;
  }
}

// ===========================================================================
// Tab 1 — Baseline configuration
// ===========================================================================

interface BaselineState {
  loading: boolean;
  findings: BaselineFinding[];
  globalError: string | null;
  permissionWarnings: string[];
  lastRefreshedAt: number | null;
}

interface BaselineTabProps {
  state: BaselineState;
  onRefresh: () => void;
  tenantId: string;
  tenantDisplayName: string;
  snapshot: BaselineSnapshot | null;
  onSaveSnapshot: () => void;
  onClearSnapshot: () => void;
  /** Persisted drift-history ring buffer (oldest → newest). */
  history: ReadonlyArray<BaselineHistoryEntry>;
  /** Operator's "alert me when posture regresses" preference. */
  alertOnDrift: boolean;
  /** Toggle handler for the alert preference (cross-tenant). */
  onToggleAlertOnDrift: (next: boolean) => void;
  /** Trigger a compliance-evidence export (computes SHA-256 hash). */
  onExportEvidence: () => void;
  /** True while the evidence-export is computing the hash. */
  isExportingEvidence: boolean;
  /** Refs the hot-key dispatcher can use to focus controls. */
  refreshButtonRef: React.RefObject<HTMLButtonElement>;
  /** Span wrapping the ExportMenu so the hot-key handler can locate the
   *  dropdown trigger button via querySelector. */
  exportMenuButtonRef: React.RefObject<HTMLSpanElement>;
}

/**
 * Hidden ARIA-live region that announces drift outcomes to assistive
 * tech. We render whenever the operator has the "Alert on drift"
 * preference enabled AND a baseline snapshot exists. The region is
 * visually hidden (no on-screen overlap) but kept in the DOM so
 * `aria-live` semantics fire on text mutation.
 *
 * The visible drift counters in the toolbar above are sufficient for
 * sighted operators; this region is a secondary channel that announces
 * the SAME information politely (no focus theft, no role="alert" panic
 * tone) to anyone running NVDA / JAWS / VoiceOver.
 */
const DriftLiveRegion: React.FC<{
  enabled: boolean;
  summary: DriftSummary;
  hasBaseline: boolean;
}> = ({ enabled, summary, hasBaseline }) => {
  // Compose the human announcement.
  const announcement = React.useMemo(() => {
    if (!enabled || !hasBaseline) return "";
    const parts: string[] = [];
    if (summary.regressed > 0) {
      parts.push(
        `${summary.regressed} check${summary.regressed === 1 ? "" : "s"} regressed`,
      );
    }
    if (summary.improved > 0) {
      parts.push(
        `${summary.improved} check${summary.improved === 1 ? "" : "s"} improved`,
      );
    }
    if (summary.changed > 0) {
      parts.push(
        `${summary.changed} check${summary.changed === 1 ? "" : "s"} changed summary`,
      );
    }
    if (summary.newlyIntroduced > 0) {
      parts.push(
        `${summary.newlyIntroduced} new check${summary.newlyIntroduced === 1 ? "" : "s"} since baseline`,
      );
    }
    if (parts.length === 0) {
      return "Tenant baseline matches saved snapshot — no drift detected.";
    }
    return `Tenant baseline drift: ${parts.join(", ")}.`;
  }, [enabled, hasBaseline, summary]);

  return (
    <>
      {/* Visible inline alert: only when there's regression to surface. */}
      {enabled && hasBaseline && summary.hasRegressions && (
        <Alert variant="warning" role="status">
          <BellRing className="h-4 w-4" />
          <AlertDescription className="text-2xs leading-relaxed">
            <strong>Drift detected:</strong> {summary.regressed} check
            {summary.regressed === 1 ? "" : "s"} regressed since the saved
            baseline. Review the cards marked &ldquo;Regressed&rdquo; below
            and re-save the baseline only after confirming the changes are
            intentional.
          </AlertDescription>
        </Alert>
      )}
      {/* Always-present ARIA-live region — invisible to sighted users. */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="tenant-baseline-drift-live-region"
      >
        {announcement}
      </div>
    </>
  );
};

/**
 * Drift-history timeline — small horizontal strip of severity heat-cells,
 * one per persisted history entry. The most recent entry is on the right;
 * the leftmost cell is the oldest. Cells colour-code by the worst
 * severity in that run's tally (critical → high → medium → ok), and a
 * bookmark icon marks the entry that was the approved baseline.
 *
 * Pure presentational — the parent owns the ring buffer.
 *
 * Why this exists (corpus framing):
 *   Drift on the federation backdoor / CA policy axes is often slow-moving
 *   (`_AZURE_BYPASS_PLAYBOOK.md` "Critical Defender Audit Surface" — an
 *   attacker who has Global Admin for 5 minutes can flip CA off, then
 *   wait days to use the bypass). Without a longitudinal record, a one-
 *   shot audit only catches the live state. The timeline gives the
 *   defender the "what did it look like 2 weeks ago" view without any
 *   backend.
 */
const HistoryTimeline: React.FC<{
  history: ReadonlyArray<BaselineHistoryEntry>;
  approvedAt: string | null;
}> = ({ history, approvedAt }) => {
  if (history.length === 0) return null;
  // Worst-severity helper — pure local function so the timeline can sort
  // colours consistently with the per-card SeverityBadge.
  const worstSeverity = (
    tally: Record<BaselineSeverity, number>,
  ): BaselineSeverity => {
    if (tally.critical > 0) return "critical";
    if (tally.high > 0) return "high";
    if (tally.medium > 0) return "medium";
    if (tally.low > 0) return "low";
    if (tally.unknown > 0) return "unknown";
    if (tally.ok > 0) return "ok";
    return "info";
  };

  // Compute the delta vs the immediately-previous entry — used for the
  // tooltip "got worse / got better".
  const deltas = React.useMemo(() => {
    const out: Array<{ delta: number; regressed: number; improved: number }> = [];
    for (let i = 0; i < history.length; i += 1) {
      if (i === 0) {
        out.push({ delta: 0, regressed: 0, improved: 0 });
        continue;
      }
      const prev = history[i - 1]!;
      const cur = history[i]!;
      const cmp = compareHistoryEntries(prev, cur);
      out.push({
        delta: cmp.delta,
        regressed: cmp.regressed.length,
        improved: cmp.improved.length,
      });
    }
    return out;
  }, [history]);

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-2xs"
      role="region"
      aria-label="Tenant baseline drift history timeline"
    >
      <History className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      <span className="font-semibold text-foreground">History</span>
      <span className="text-muted-foreground">
        ({history.length} run{history.length === 1 ? "" : "s"} on device)
      </span>
      <div className="ml-1 flex items-center gap-0.5">
        {history.map((h, i) => {
          const worst = worstSeverity(h.tally);
          const variant = severityToBadgeVariant(worst);
          const delta = deltas[i]!;
          const isApproved = approvedAt !== null && h.capturedAt === approvedAt;
          const label = `${new Date(h.capturedAt).toLocaleString()} — worst: ${severityLabel(worst)}${
            delta.delta !== 0
              ? `, delta vs prior run: ${delta.delta > 0 ? "+" : ""}${delta.delta} (${delta.regressed} regressed, ${delta.improved} improved)`
              : ""
          }${isApproved ? " — approved baseline" : ""}`;
          return (
            <TooltipProvider key={`${h.capturedAt}-${i}`} delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "inline-flex h-4 w-4 cursor-default items-center justify-center rounded-sm border",
                      // Variant-driven background so the cell colour matches
                      // the same severity vocabulary the cards use.
                      variant === "destructive" && "border-destructive/40 bg-destructive/30",
                      variant === "warning" && "border-warning/40 bg-warning/30",
                      variant === "info" && "border-info/40 bg-info/30",
                      variant === "success" && "border-success/40 bg-success/30",
                      variant === "secondary" && "border-border bg-muted/60",
                      variant === "outline" && "border-border bg-card",
                      isApproved && "ring-1 ring-primary",
                    )}
                    aria-label={label}
                  >
                    {isApproved && (
                      <Bookmark className="h-2.5 w-2.5 text-primary" aria-hidden />
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-md text-2xs">
                  {label}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        })}
      </div>
      <span className="ml-1 text-3xs text-muted-foreground">
        oldest → newest
      </span>
    </div>
  );
};

/** Export columns for the baseline matrix CSV (Enhancement: CSV via ExportMenu). */
const BASELINE_EXPORT_COLUMNS: ReadonlyArray<ExportColumn<BaselineFinding>> = [
  { header: "id", accessor: (f) => f.id },
  { header: "name", accessor: (f) => f.name },
  { header: "severity", accessor: (f) => f.severity },
  { header: "summary", accessor: (f) => f.summary },
  { header: "error", accessor: (f) => f.error ?? "" },
];

const BaselineTab: React.FC<BaselineTabProps> = ({
  state,
  onRefresh,
  tenantId,
  tenantDisplayName,
  snapshot,
  onSaveSnapshot,
  onClearSnapshot,
  history,
  alertOnDrift,
  onToggleAlertOnDrift,
  onExportEvidence,
  isExportingEvidence,
  refreshButtonRef,
  exportMenuButtonRef,
}) => {
  const tally = React.useMemo(() => tallySeverities(state.findings), [
    state.findings,
  ]);

  // Per-id drift map vs the saved baseline. useMemo so the per-card
  // re-render only happens when findings OR snapshot change.
  const driftMap = React.useMemo(
    () => diffAgainstSnapshot(state.findings, snapshot),
    [state.findings, snapshot],
  );

  // Single-pass drift summary (regressed / improved / changed / newly-
  // introduced). The helper is pure + module-scoped — same input always
  // yields the same counts which means the surrounding memo + the audit
  // log "this run drifted vs baseline" record line up byte-for-byte.
  const driftSummary: DriftSummary = React.useMemo(
    () => summarizeDrift(driftMap),
    [driftMap],
  );

  // Cached portal-link map per check id. Stable references mean FindingCard
  // memos (if introduced later) won't tear on parent re-renders.
  const portalLinks = React.useMemo(() => {
    const out: Record<BaselineCheckId, { href: string; label: string }> = {
      "security-defaults": portalLinkForFinding("security-defaults", tenantId),
      "guest-invite-policy": portalLinkForFinding("guest-invite-policy", tenantId),
      "default-user-permissions": portalLinkForFinding(
        "default-user-permissions",
        tenantId,
      ),
      "domains-federation": portalLinkForFinding("domains-federation", tenantId),
      // Detection inspired by: New folder/_AZURE_BYPASS_PLAYBOOK.md
      // "Critical Defender Audit Surface" item 1; corresponds to the
      // federation-backdoor-drift baseline finding.
      "federation-backdoor-drift": portalLinkForFinding(
        "federation-backdoor-drift",
        tenantId,
      ),
      // Detection inspired by: New folder/_AZURE_BYPASS_PLAYBOOK.md
      // "Critical Defender Audit Surface" item 2.
      "ca-policy-drift": portalLinkForFinding("ca-policy-drift", tenantId),
      "onprem-sync": portalLinkForFinding("onprem-sync", tenantId),
      "password-protection": portalLinkForFinding("password-protection", tenantId),
    };
    return out;
  }, [tenantId]);

  const jsonMetadata = React.useMemo(
    () => ({
      tenantId,
      tenantDisplayName,
      capturedAt: new Date().toISOString(),
      summary: tally,
      drift: driftSummary,
      hasSavedBaseline: snapshot !== null,
    }),
    [tenantId, tenantDisplayName, tally, driftSummary, snapshot],
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Summary row */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="gap-1">
          <Shield className="h-3 w-3" aria-hidden />
          {state.findings.length} check{state.findings.length === 1 ? "" : "s"}
        </Badge>
        {tally.critical > 0 && (
          <Badge variant="destructive" className="gap-1">
            <ShieldAlert className="h-3 w-3" aria-hidden />
            {tally.critical} critical
          </Badge>
        )}
        {tally.high > 0 && (
          <Badge variant="destructive" className="gap-1">
            <XCircle className="h-3 w-3" aria-hidden />
            {tally.high} high
          </Badge>
        )}
        {tally.medium > 0 && (
          <Badge variant="warning" className="gap-1">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {tally.medium} medium
          </Badge>
        )}
        {tally.low > 0 && (
          <Badge variant="info" className="gap-1">
            <Info className="h-3 w-3" aria-hidden />
            {tally.low} low
          </Badge>
        )}
        {tally.ok > 0 && (
          <Badge variant="success" className="gap-1">
            <CheckCircle2 className="h-3 w-3" aria-hidden />
            {tally.ok} ok
          </Badge>
        )}
        {tally.unknown > 0 && (
          <Badge variant="secondary" className="gap-1">
            <AlertCircle className="h-3 w-3" aria-hidden />
            {tally.unknown} unknown
          </Badge>
        )}
        {/* Drift counters — only render when a baseline is saved. */}
        {snapshot && driftSummary.regressed > 0 && (
          <Badge variant="destructive" className="gap-1">
            <ArrowUpRight className="h-3 w-3" aria-hidden />
            {driftSummary.regressed} regressed
          </Badge>
        )}
        {snapshot && driftSummary.improved > 0 && (
          <Badge variant="success" className="gap-1">
            <ArrowDownRight className="h-3 w-3" aria-hidden />
            {driftSummary.improved} improved
          </Badge>
        )}
        {snapshot && driftSummary.changed > 0 && (
          <Badge variant="warning" className="gap-1">
            <GitCompare className="h-3 w-3" aria-hidden />
            {driftSummary.changed} changed
          </Badge>
        )}
        {snapshot && driftSummary.newlyIntroduced > 0 && (
          <Badge variant="info" className="gap-1">
            <Sparkles className="h-3 w-3" aria-hidden />
            {driftSummary.newlyIntroduced} new check
            {driftSummary.newlyIntroduced === 1 ? "" : "s"}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          {state.lastRefreshedAt && (
            <span className="text-2xs text-muted-foreground">
              Refreshed {formatRelativeTime(new Date(state.lastRefreshedAt))}
            </span>
          )}
          {/*
            ExportMenu does not accept a forwarded ref (it owns its own
            DropdownMenuTrigger). We wrap it in a span the hot-key
            handler can query — `exportMenuButtonRef.current
            ?.querySelector('button')?.click()` opens the dropdown from
            the keyboard without us having to fork the shared component.
          */}
          <span ref={exportMenuButtonRef} className="inline-flex">
            <ExportMenu
              rows={state.findings}
              columns={BASELINE_EXPORT_COLUMNS}
              filename={`tenant-baseline-${tenantId.slice(0, 8)}`}
              jsonMetadata={jsonMetadata}
              disabled={state.findings.length === 0}
              label="Export"
            />
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onExportEvidence}
            disabled={state.findings.length === 0 || state.loading || isExportingEvidence}
            aria-label="Export compliance evidence with SHA-256 hash"
            title="Export findings as a signed compliance-evidence envelope. Embeds a SHA-256 hash over the canonical findings JSON so an auditor can detect post-hoc tampering."
          >
            {isExportingEvidence ? (
              <Loader2 className="animate-spin" />
            ) : (
              <FileCheck />
            )}
            Evidence
          </Button>
          <Button
            type="button"
            variant={alertOnDrift ? "default" : "outline"}
            size="sm"
            onClick={() => onToggleAlertOnDrift(!alertOnDrift)}
            aria-pressed={alertOnDrift}
            aria-label={
              alertOnDrift
                ? "Disable drift alert banner"
                : "Enable drift alert banner"
            }
            title="Toggle screen-reader-announced drift banner. When ON, any regression in this run triggers a polite ARIA live announcement."
          >
            <BellRing />
            Alert on drift
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onSaveSnapshot}
            disabled={state.findings.length === 0 || state.loading}
            aria-label="Save current findings as compliance baseline snapshot (hotkey s)"
            title="Save current findings as the approved compliance baseline. Future refreshes show drift against this snapshot. Hotkey: s"
          >
            <Save />
            Save baseline
          </Button>
          {snapshot && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClearSnapshot}
              aria-label="Clear the saved baseline snapshot (hotkey c)"
              title={`Clear saved baseline (captured ${formatRelativeTime(new Date(snapshot.capturedAt))}). Hotkey: c`}
            >
              <Trash2 />
              Clear baseline
            </Button>
          )}
          <Button
            ref={refreshButtonRef}
            type="button"
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={state.loading}
            aria-label="Re-run baseline probes"
          >
            {state.loading ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {/*
        ARIA-live drift banner. Renders whenever `alertOnDrift` is on AND
        the current run regressed against the saved baseline. The
        polite aria-live region announces the regression count to
        screen-reader users without stealing focus.
      */}
      <DriftLiveRegion
        enabled={alertOnDrift}
        summary={driftSummary}
        hasBaseline={snapshot !== null}
      />

      {/* History timeline strip — visualises the last N runs at a glance. */}
      {history.length > 0 && (
        <HistoryTimeline history={history} approvedAt={snapshot?.capturedAt ?? null} />
      )}

      {/* Saved-baseline pill (informational). */}
      {snapshot && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-2xs text-muted-foreground">
          <Bookmark className="h-3 w-3" aria-hidden />
          <span>
            Comparing against baseline saved{" "}
            <span className="font-medium text-foreground">
              {formatRelativeTime(new Date(snapshot.capturedAt))}
            </span>{" "}
            (for tenant {snapshot.tenantDisplayName})
          </span>
        </div>
      )}

      {state.globalError && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription>{state.globalError}</AlertDescription>
        </Alert>
      )}

      {state.permissionWarnings.length > 0 && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Some checks could not run because the signed-in account is
            missing Graph permissions. The corresponding cards below will
            render with severity = Unknown.
            <ul className="ml-4 mt-1 list-disc text-2xs">
              {state.permissionWarnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {state.loading && state.findings.length === 0 ? (
          <Card className="md:col-span-2">
            <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Probing tenant baseline configuration…
            </CardContent>
          </Card>
        ) : (
          state.findings.map((f) => (
            <FindingCard
              key={f.id}
              finding={f}
              drift={driftMap.get(f.id) ?? {
                status: "no-baseline",
                baselineSeverity: null,
                baselineSummary: null,
              }}
              portalLink={portalLinks[f.id]}
            />
          ))
        )}
      </div>
    </div>
  );
};

// ===========================================================================
// Tab 2 — Service Principal credentials
// ===========================================================================

interface SpTabState {
  loading: boolean;
  rows: SpScoredRow[];
  error: string | null;
  lastRefreshedAt: number | null;
  /** True when admin-role enumeration failed; we still render rows but
   *  with hasAdminRole=false everywhere. */
  roleEnumerationFailed: boolean;
}

interface SpTabProps {
  state: SpTabState;
  onRefresh: () => void;
  tenantId: string;
  tenantDisplayName: string;
  /** Audit actor — passed down so filter mutations can be recorded. */
  actor: string;
}

/** CSV columns for SP credentials export (Enhancement: ExportMenu). */
const SP_EXPORT_COLUMNS: ReadonlyArray<ExportColumn<SpScoredRow>> = [
  { header: "displayName", accessor: (r) => r.displayName },
  { header: "appId", accessor: (r) => r.appId },
  { header: "id", accessor: (r) => r.id },
  { header: "type", accessor: (r) => r.type },
  { header: "accountEnabled", accessor: (r) => r.accountEnabled },
  { header: "totalCredentials", accessor: (r) => r.totalCredentials },
  { header: "earliestExpiry", accessor: (r) => r.earliestExpiry ?? "" },
  {
    header: "daysUntilEarliest",
    accessor: (r) => r.daysUntilEarliestExpiry ?? "",
  },
  { header: "hasExpired", accessor: (r) => r.hasExpired },
  { header: "hasAdminRole", accessor: (r) => r.hasAdminRole },
  { header: "severity", accessor: (r) => r.severity },
  { header: "summary", accessor: (r) => r.severitySummary },
];

const SpTab: React.FC<SpTabProps> = ({
  state,
  onRefresh,
  tenantId,
  tenantDisplayName,
  actor,
}) => {
  // Filter state — URL-persisted via useUrlState so deep links preserve
  // the operator's view (Enhancement: URL-persisted filter).
  // `keysKey` parameters are render-stable: the literal arrays here pass
  // through useUrlState's fingerprint-by-content guard.
  const URL_STATE_INITIAL = React.useMemo(
    () => ({ q: "", sev: [] as string[], type: [] as string[] }),
    [],
  );
  const [urlState, setUrlState] = useUrlState(URL_STATE_INITIAL, {
    replace: true,
  });

  // Local "typing" copy of the search input for debouncing — only the
  // debounced value is pushed to the URL.
  const [searchInput, setSearchInput] = React.useState<string>(
    () => (urlState.q as string) ?? "",
  );
  // Keep the input in sync if URL changes (e.g. browser back/forward).
  React.useEffect(() => {
    const next = (urlState.q as string) ?? "";
    setSearchInput((cur) => (cur === next ? cur : next));
  }, [urlState.q]);

  // Debounce typing → URL.
  React.useEffect(() => {
    const id = setTimeout(() => {
      const current = (urlState.q as string) ?? "";
      if (current !== searchInput) {
        setUrlState({ q: searchInput });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
    // urlState.q intentionally NOT in deps — we mirror local→url only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput, setUrlState]);

  // Derive Sets from the URL string arrays.
  const severityFilter = React.useMemo<Set<BaselineSeverity>>(() => {
    const raw = (urlState.sev as string[]) ?? [];
    return new Set(raw.filter((v): v is BaselineSeverity =>
      SEVERITY_FILTER_OPTIONS.includes(v as BaselineSeverity),
    ));
  }, [urlState.sev]);

  const typeFilter = React.useMemo<Set<SpType>>(() => {
    const raw = (urlState.type as string[]) ?? [];
    return new Set(raw.filter((v): v is SpType =>
      SP_TYPE_OPTIONS.includes(v as SpType),
    ));
  }, [urlState.type]);

  const searchQuery = (urlState.q as string) ?? "";

  // Stable setters that also audit-log the filter mutation. The audit
  // entry is intentionally lightweight — we don't enumerate SPs, only
  // record that the operator narrowed/widened the view.
  const setSeverityFilter = React.useCallback(
    (updater: (prev: Set<BaselineSeverity>) => Set<BaselineSeverity>) => {
      const next = updater(severityFilter);
      const arr = Array.from(next);
      setUrlState({ sev: arr });
      auditLog.record({
        actor,
        action: "tenant_baseline_filter_change",
        target: tenantId,
        status: "success",
        details: {
          tab: "sp",
          filter: "severity",
          value: arr,
        },
      });
    },
    [severityFilter, setUrlState, actor, tenantId],
  );

  const setTypeFilter = React.useCallback(
    (updater: (prev: Set<SpType>) => Set<SpType>) => {
      const next = updater(typeFilter);
      const arr = Array.from(next);
      setUrlState({ type: arr });
      auditLog.record({
        actor,
        action: "tenant_baseline_filter_change",
        target: tenantId,
        status: "success",
        details: {
          tab: "sp",
          filter: "type",
          value: arr,
        },
      });
    },
    [typeFilter, setUrlState, actor, tenantId],
  );

  // Sort + filter + summary.
  const filteredRows = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let rows = state.rows;
    if (severityFilter.size > 0) {
      rows = rows.filter((r) => severityFilter.has(r.severity));
    }
    if (typeFilter.size > 0) {
      rows = rows.filter((r) => typeFilter.has(r.type));
    }
    if (q) {
      rows = rows.filter((r) => {
        return (
          r.displayName.toLowerCase().includes(q) ||
          r.appId.toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q)
        );
      });
    }
    // Sort: severity desc, then earliest expiry asc (null last).
    return rows.slice().sort((a, b) => {
      const sev = compareSeverityDesc(a.severity, b.severity);
      if (sev !== 0) return sev;
      return compareIsoDates(a.earliestExpiry, b.earliestExpiry);
    });
  }, [state.rows, severityFilter, typeFilter, searchQuery]);

  const stats = React.useMemo(() => {
    let total = 0;
    let expiring30 = 0;
    let expired = 0;
    let withAdmin = 0;
    let noCreds = 0;
    for (const r of state.rows) {
      total += 1;
      if (r.hasExpired) expired += 1;
      else if (
        r.daysUntilEarliestExpiry !== null &&
        r.daysUntilEarliestExpiry < 30
      )
        expiring30 += 1;
      if (r.hasAdminRole) withAdmin += 1;
      if (r.totalCredentials === 0) noCreds += 1;
    }
    return { total, expiring30, expired, withAdmin, noCreds };
  }, [state.rows]);

  const exportMetadata = React.useMemo(
    () => ({
      tenantId,
      tenantDisplayName,
      capturedAt: new Date().toISOString(),
      summary: stats,
      filtersApplied: {
        search: searchQuery,
        severity: Array.from(severityFilter),
        type: Array.from(typeFilter),
      },
    }),
    [tenantId, tenantDisplayName, stats, searchQuery, severityFilter, typeFilter],
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Summary chips */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="gap-1">
          <Users className="h-3 w-3" aria-hidden />
          {stats.total} total
        </Badge>
        {stats.expired > 0 && (
          <Badge variant="destructive" className="gap-1">
            <XCircle className="h-3 w-3" aria-hidden />
            {stats.expired} already expired
          </Badge>
        )}
        {stats.expiring30 > 0 && (
          <Badge variant="warning" className="gap-1">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {stats.expiring30} expiring &lt; 30d
          </Badge>
        )}
        {stats.withAdmin > 0 && (
          <Badge variant="destructive" className="gap-1">
            <ShieldAlert className="h-3 w-3" aria-hidden />
            {stats.withAdmin} with admin role
          </Badge>
        )}
        {stats.noCreds > 0 && (
          <Badge variant="secondary" className="gap-1">
            <Info className="h-3 w-3" aria-hidden />
            {stats.noCreds} with no creds
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          {state.lastRefreshedAt && (
            <span className="text-2xs text-muted-foreground">
              Refreshed {formatRelativeTime(new Date(state.lastRefreshedAt))}
            </span>
          )}
          <ExportMenu
            rows={filteredRows}
            columns={SP_EXPORT_COLUMNS}
            filename={`sp-credentials-${tenantId.slice(0, 8)}`}
            jsonMetadata={exportMetadata}
            disabled={filteredRows.length === 0}
            label="Export"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={state.loading}
            aria-label="Re-run service principal probe"
          >
            {state.loading ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by name, app id, or object id…"
            className="pl-7 text-xs"
            aria-label="Search service principals"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              Severity
              {severityFilter.size > 0 && (
                <Badge variant="secondary" className="ml-1.5">
                  {severityFilter.size}
                </Badge>
              )}
              <ChevronDown className="ml-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Filter by severity</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {SEVERITY_FILTER_OPTIONS.map((s) => (
              <DropdownMenuCheckboxItem
                key={s}
                checked={severityFilter.has(s)}
                onCheckedChange={(checked) => {
                  setSeverityFilter((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(s);
                    else next.delete(s);
                    return next;
                  });
                }}
              >
                <span className="flex items-center gap-1.5">
                  <SeverityIcon severity={s} className="h-3 w-3" />
                  {severityLabel(s)}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={false}
              onCheckedChange={() => setSeverityFilter(() => new Set())}
            >
              Clear all
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* SP type chips (compact, click to toggle inclusion). */}
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label="Filter by service principal type"
        >
          {SP_TYPE_OPTIONS.map((t) => {
            const active = typeFilter.has(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTypeFilter((prev) => {
                    const next = new Set(prev);
                    if (next.has(t)) next.delete(t);
                    else next.add(t);
                    return next;
                  });
                }}
                aria-pressed={active}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors",
                  active
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
              >
                {t}
              </button>
            );
          })}
        </div>
      </div>

      {state.error && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {state.roleEnumerationFailed && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Could not enumerate directory-role memberships (needs{" "}
            <code className="font-mono">RoleManagement.Read.Directory</code>).
            The &ldquo;admin role&rdquo; column will show false for every row.
          </AlertDescription>
        </Alert>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[900px] border-collapse text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-2xs uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 text-left">Service Principal</th>
              <th className="px-3 py-2 text-left">App ID</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-right"># creds</th>
              <th className="px-3 py-2 text-left">Earliest expiry</th>
              <th className="px-3 py-2 text-center">Admin role</th>
              <th className="px-3 py-2 text-left">Severity</th>
            </tr>
          </thead>
          <tbody>
            {state.loading && state.rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center">
                  <span className="inline-flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading service principals…
                  </span>
                </td>
              </tr>
            ) : filteredRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                  No service principals match the current filters.
                </td>
              </tr>
            ) : (
              filteredRows.map((r) => (
                <SpRow key={r.id} row={r} tenantId={tenantId} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/**
 * One row in the SP credentials table. Splitting it out lets the
 * details/summary toggle hold its own state without re-rendering the
 * whole table when a single row is expanded.
 *
 * Memoised (deep-pass) so toggling one row's `expanded` state doesn't
 * cause every other row to re-render. Large tenants commonly have 800+
 * service principals; the previous unmemoised implementation produced a
 * visible scroll-jank on every chevron click. The custom `arePropsEqual`
 * comparator is intentionally shallow on `row` because the parent always
 * creates a fresh array from a `slice().sort()` — so a new array
 * reference is expected, but row IDENTITIES (and their internal severity
 * + credentials) are stable across filter-only changes.
 */
const SpRowInner: React.FC<{ row: SpScoredRow; tenantId: string }> = ({
  row,
  tenantId,
}) => {
  const [expanded, setExpanded] = React.useState(false);
  const portal = React.useMemo(
    () => portalLinkForServicePrincipal(row.appId, tenantId),
    [row.appId, tenantId],
  );
  const handleToggle = React.useCallback(() => setExpanded((v) => !v), []);

  return (
    <>
      <tr
        className={cn(
          "border-b border-border hover:bg-muted/40",
          row.severity === "critical" && "bg-destructive/5",
        )}
      >
        <td className="px-3 py-2">
          <button
            type="button"
            onClick={handleToggle}
            className="inline-flex items-center gap-1.5 text-left text-foreground hover:underline"
            aria-expanded={expanded}
            title={expanded ? "Hide credential details" : "Show credential details"}
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 transition-transform",
                expanded && "rotate-90",
              )}
            />
            <span className="truncate">{row.displayName || "(unnamed)"}</span>
            {!row.accountEnabled && (
              <Badge variant="secondary" className="ml-1 text-2xs">
                disabled
              </Badge>
            )}
            {row.displayName && (
              <CopyButton
                value={row.displayName}
                ariaLabel={`Copy display name ${row.displayName}`}
              />
            )}
          </button>
        </td>
        <td className="px-3 py-2">
          <div className="group/copy flex items-center gap-1">
            <code className="truncate font-mono text-2xs text-muted-foreground">
              {row.appId}
            </code>
            <CopyButton
              value={row.appId}
              ariaLabel={`Copy app id for ${row.displayName}`}
            />
            <a
              href={portal.href}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={portal.label}
              title={portal.label}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent/30 hover:text-foreground group-hover/copy:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </div>
        </td>
        <td className="px-3 py-2">
          <Badge
            variant={row.type === "ManagedIdentity" ? "info" : "outline"}
            className="text-2xs"
          >
            {row.type}
          </Badge>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {row.totalCredentials}
        </td>
        <td className="px-3 py-2">
          {row.earliestExpiry ? (
            <span className="flex flex-col">
              <span
                className={cn(
                  "text-xs",
                  row.hasExpired && "text-destructive",
                )}
              >
                {formatRelativeTime(row.earliestExpiry)}
              </span>
              <span className="text-2xs text-muted-foreground">
                {new Date(row.earliestExpiry).toLocaleDateString()}
              </span>
            </span>
          ) : (
            <span className="text-2xs text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-3 py-2 text-center">
          {row.hasAdminRole ? (
            <Badge variant="destructive" className="gap-1">
              <ShieldAlert className="h-3 w-3" aria-hidden />
              Tier 0
            </Badge>
          ) : (
            <span className="text-2xs text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-3 py-2">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <SeverityBadge severity={row.severity} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-md">
                {row.severitySummary}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-muted/20">
          <td colSpan={7} className="px-6 py-3">
            {row.credentials.length === 0 ? (
              <p className="text-2xs text-muted-foreground">
                No client secrets or certificates configured.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Credentials ({row.credentials.length})
                </p>
                <table className="w-full text-2xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="px-2 py-1 text-left">Kind</th>
                      <th className="px-2 py-1 text-left">Name</th>
                      <th className="px-2 py-1 text-left">Key ID</th>
                      <th className="px-2 py-1 text-left">Type / usage</th>
                      <th className="px-2 py-1 text-left">Starts</th>
                      <th className="px-2 py-1 text-left">Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.credentials.map((c, idx) => {
                      const isExpired = c.endDateTime
                        ? Date.parse(c.endDateTime) < Date.now()
                        : false;
                      return (
                        <tr
                          key={`${c.keyId}-${idx}`}
                          className="border-t border-border"
                        >
                          <td className="px-2 py-1">
                            <Badge
                              variant={
                                c.kind === "password" ? "outline" : "info"
                              }
                              className="text-2xs"
                            >
                              {c.kind === "password" ? "Secret" : "Cert"}
                            </Badge>
                          </td>
                          <td className="px-2 py-1">{c.displayName}</td>
                          <td className="px-2 py-1 font-mono text-3xs text-muted-foreground">
                            {c.keyId.slice(0, 8) || "—"}
                          </td>
                          <td className="px-2 py-1 text-muted-foreground">
                            {[c.type, c.usage].filter((s) => s).join(" / ") || "—"}
                          </td>
                          <td className="px-2 py-1 text-muted-foreground">
                            {c.startDateTime
                              ? new Date(c.startDateTime).toLocaleDateString()
                              : "—"}
                          </td>
                          <td
                            className={cn(
                              "px-2 py-1",
                              isExpired
                                ? "text-destructive"
                                : "text-foreground",
                            )}
                          >
                            {c.endDateTime
                              ? `${new Date(c.endDateTime).toLocaleDateString()} (${formatRelativeTime(c.endDateTime)})`
                              : "never"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
};

/**
 * Memoised SpRow — re-renders only when `row` identity or `tenantId`
 * changes. Filter-only mutations in `SpTab` reuse the underlying scored
 * row objects (the filter chain calls `.slice().sort()` which preserves
 * row references), so this memo prevents an N-row re-render storm when
 * one row's local `expanded` state toggles.
 */
const SpRow = React.memo(
  SpRowInner,
  (prev, next) => prev.row === next.row && prev.tenantId === next.tenantId,
);
SpRow.displayName = "SpRow";

// ===========================================================================
// Probe orchestrators
// ===========================================================================

/**
 * Run all six baseline probes in parallel. Each probe captures its own
 * errors so a 403 on one probe never blocks the others.
 *
 * Returns the array of findings (in the canonical display order) plus a
 * list of human-readable "permission warning" strings for probes that
 * 403'd on a permission we'd recommend the operator request.
 */
async function probeBaseline(
  token: string,
  signal: AbortSignal,
): Promise<{
  findings: BaselineFinding[];
  permissionWarnings: string[];
}> {
  const permissionWarnings: string[] = [];

  // Run six probes in parallel; each captures its own failure.
  //
  // The CA probe is the per-policy "drift" enumeration used by Signal B
  // (`scoreCaPolicyDrift`). We request the fields the scorer cares about
  // up front so the snapshot envelope stays small.
  // Detection inspired by: New folder/_AZURE_BYPASS_PLAYBOOK.md
  // "Critical Defender Audit Surface" item 2 (`Update conditional access
  // policy` audit event).
  const CA_POLICY_SELECT =
    "id,displayName,state,createdDateTime,modifiedDateTime,conditions";
  const [
    secDefaultsRes,
    caPoliciesRes,
    authPolicyRes,
    orgRes,
    domainsRes,
    pwdPolicyRes,
  ] = await Promise.allSettled([
    graphGet<SecurityDefaultsPolicyRaw>(
      "/policies/identitySecurityDefaultsEnforcementPolicy",
      token,
      { signal },
    ),
    // Full CA enumeration — both for the "any CA exists?" boolean the
    // security-defaults scorer needs AND for the per-policy drift scorer.
    graphList<ConditionalAccessPolicyRaw>(
      `/identity/conditionalAccess/policies?$select=${CA_POLICY_SELECT}&$top=100`,
      token,
      { signal },
    ),
    graphGet<AuthorizationPolicyRaw>("/policies/authorizationPolicy", token, {
      signal,
    }),
    graphGet<{ value?: OrganizationRaw[] }>("/organization", token, { signal }),
    graphList<DomainRaw>("/domains?$select=id,authenticationType,isDefault,isVerified,supportedServices", token, {
      signal,
    }),
    // Best-effort password policy on the initial domain. Most tenants 403
    // without Policy.Read.All — we surface that to the operator.
    (async () => {
      // Find the verified default domain first so the URL is correct.
      const orgResp = await graphGet<{ value?: OrganizationRaw[] }>(
        "/organization",
        token,
        { signal },
      );
      const verified = orgResp.value?.[0] ?? null;
      // Initial domain is the .onmicrosoft.com one; we'll prefer the
      // default verified domain if exposed.
      // The path `/domains/{id}/policies/passwordValidationPolicies` is
      // documented but commonly returns 403 outside Policy.Read.All.
      const domain = verified?.displayName ?? null;
      void domain; // unused; kept for clarity that this is best-effort
      return graphGet("/domains/policies/passwordValidationPolicies", token, {
        signal,
      });
    })(),
  ]);

  // --- Security defaults -------------------------------------------------
  let secDefaultsFinding: BaselineFinding;
  let hasAnyCA: boolean | null;
  let caPolicies: ConditionalAccessPolicyRaw[] | null = null;
  let caPoliciesError: string | null = null;
  if (caPoliciesRes.status === "fulfilled") {
    caPolicies = caPoliciesRes.value;
    hasAnyCA = caPolicies.length > 0;
  } else {
    hasAnyCA = null;
    const msg = String(
      caPoliciesRes.reason instanceof Error
        ? caPoliciesRes.reason.message
        : caPoliciesRes.reason,
    );
    caPoliciesError = msg;
    if (msg.includes("403")) {
      permissionWarnings.push(
        "Could not enumerate Conditional Access policies — needs Policy.Read.All",
      );
    }
  }
  if (secDefaultsRes.status === "fulfilled") {
    secDefaultsFinding = scoreSecurityDefaults({
      policy: secDefaultsRes.value,
      hasAnyConditionalAccess: hasAnyCA,
    });
  } else {
    const msg = String(
      secDefaultsRes.reason instanceof Error
        ? secDefaultsRes.reason.message
        : secDefaultsRes.reason,
    );
    if (msg.includes("403")) {
      permissionWarnings.push(
        "Could not read security defaults policy — needs Policy.Read.All",
      );
    }
    secDefaultsFinding = {
      ...scoreSecurityDefaults({
        policy: null,
        hasAnyConditionalAccess: hasAnyCA,
      }),
      error: msg,
    };
  }

  // --- Authorization policy (covers two findings) ------------------------
  const authPolicy =
    authPolicyRes.status === "fulfilled" ? authPolicyRes.value : null;
  if (authPolicyRes.status === "rejected") {
    const msg = String(
      authPolicyRes.reason instanceof Error
        ? authPolicyRes.reason.message
        : authPolicyRes.reason,
    );
    if (msg.includes("403")) {
      permissionWarnings.push(
        "Could not read /policies/authorizationPolicy — needs Policy.Read.All",
      );
    }
  }
  const guestFinding = scoreGuestInvitePolicy(authPolicy);
  const defaultPermsFinding = scoreDefaultUserPermissions(authPolicy);
  if (authPolicyRes.status === "rejected") {
    const errMsg = String(
      authPolicyRes.reason instanceof Error
        ? authPolicyRes.reason.message
        : authPolicyRes.reason,
    );
    guestFinding.error = errMsg;
    defaultPermsFinding.error = errMsg;
  }

  // --- Organization (on-prem sync) ---------------------------------------
  const org =
    orgRes.status === "fulfilled" ? (orgRes.value.value?.[0] ?? null) : null;
  const onPremFinding = scoreOnPremSync(org);
  if (orgRes.status === "rejected") {
    const errMsg = String(
      orgRes.reason instanceof Error ? orgRes.reason.message : orgRes.reason,
    );
    onPremFinding.error = errMsg;
  }

  // --- Domains -----------------------------------------------------------
  let domainsFinding: BaselineFinding;
  let federatedEntries: FederatedDomainEntry[] = [];
  if (domainsRes.status === "fulfilled") {
    domainsFinding = scoreDomainsFederation(domainsRes.value);
    // Per-domain federation enrichment for Signal A (federation-backdoor).
    // Detection inspired by: New folder/_analysis_aadinternals.md §2.4
    // "The Federation Backdoor (`ConvertTo-Backdoor`)" — every federated
    // domain has a corresponding `internalDomainFederation` config object
    // that records `issuerUri`, `signingCertificate`, and modification
    // metadata. A *fresh* config on a *new* domain is the textbook signal.
    const fedDomains = domainsRes.value.filter(
      (d) => (d.authenticationType ?? "").toLowerCase() === "federated",
    );
    federatedEntries = await Promise.all(
      fedDomains.map(async (d): Promise<FederatedDomainEntry> => {
        const domain = (d.id ?? "") as string;
        try {
          const cfg = await graphGet<{
            value?: FederationConfigRaw[];
          }>(
            `/domains/${encodeURIComponent(domain)}/federationConfiguration`,
            token,
            { signal },
          );
          // The endpoint returns a collection; defenders typically have a
          // single primary config per domain. Surface the first record but
          // keep the rest in raw if anyone needs them.
          const primary = cfg.value?.[0] ?? null;
          return {
            domain,
            isDefault: d.isDefault === true,
            config: primary,
            configError: null,
          };
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          if (m.includes("403")) {
            permissionWarnings.push(
              "Could not read /domains/{id}/federationConfiguration — needs Domain.Read.All",
            );
          }
          return {
            domain,
            isDefault: d.isDefault === true,
            config: null,
            configError: m,
          };
        }
      }),
    );
  } else {
    const errMsg = String(
      domainsRes.reason instanceof Error
        ? domainsRes.reason.message
        : domainsRes.reason,
    );
    if (errMsg.includes("403")) {
      permissionWarnings.push(
        "Could not enumerate domains — needs Domain.Read.All",
      );
    }
    domainsFinding = {
      ...scoreDomainsFederation(null),
      error: errMsg,
    };
    federatedEntries = [];
  }

  // --- Signal A — Federation backdoor drift ------------------------------
  // Detection inspired by: New folder/_AZURE_BYPASS_PLAYBOOK.md "Critical
  // Defender Audit Surface" item 1 (`Set domain authentication`); New
  // folder/_analysis_aadinternals.md §2.4 (`ConvertTo-Backdoor`).
  const federationBackdoorFinding = scoreFederationBackdoorDrift({
    entries: federatedEntries,
  });
  // Inherit any blanket domain-enumeration error so the operator sees it
  // attached to *both* federation cards.
  if (domainsRes.status === "rejected") {
    federationBackdoorFinding.error =
      federationBackdoorFinding.error ?? domainsFinding.error;
  }

  // --- Signal B — Conditional Access policy drift ------------------------
  // Detection inspired by: New folder/_AZURE_BYPASS_PLAYBOOK.md "Critical
  // Defender Audit Surface" item 2 (`Update conditional access policy`).
  const caDriftFinding = scoreCaPolicyDrift({
    policies: caPolicies,
    policiesError: caPoliciesError,
  });

  // --- Password protection ----------------------------------------------
  let pwdFinding: BaselineFinding;
  if (pwdPolicyRes.status === "fulfilled") {
    pwdFinding = scorePasswordProtection({
      policy: pwdPolicyRes.value,
      policyError: null,
    });
  } else {
    const errMsg = String(
      pwdPolicyRes.reason instanceof Error
        ? pwdPolicyRes.reason.message
        : pwdPolicyRes.reason,
    );
    // This is the noisiest 403 by far — don't add to warnings unless we
    // can clearly attribute it to a permission gap.
    if (errMsg.includes("403")) {
      permissionWarnings.push(
        "Could not read password protection policy — needs Policy.Read.All",
      );
    }
    pwdFinding = scorePasswordProtection({
      policy: null,
      policyError: errMsg,
    });
  }

  return {
    findings: [
      secDefaultsFinding,
      // Signal B sits next to security-defaults because they answer
      // adjacent questions ("is anything enforcing MFA at all?" → "is
      // anything weakening the enforcement we have?").
      caDriftFinding,
      guestFinding,
      defaultPermsFinding,
      domainsFinding,
      // Signal A sits immediately after the legacy domain-federation
      // card so an operator scrolling through the matrix reads them as a
      // pair (count of federated domains → per-domain backdoor posture).
      federationBackdoorFinding,
      onPremFinding,
      pwdFinding,
    ],
    permissionWarnings: Array.from(new Set(permissionWarnings)),
  };
}

/**
 * Enumerate every directory role + collect the set of principal ids
 * (users/groups/SPs) that are members. Returns a Set of SP-or-anything
 * object ids that hold ANY Tier 0 role. We don't differentiate further
 * — the SP scorer just needs a single "is this principal privileged" bit.
 */
async function fetchTier0PrincipalIds(
  token: string,
  signal: AbortSignal,
): Promise<Set<string>> {
  // /directoryRoles only returns ACTIVATED roles in the tenant. For the
  // ones we care about (Global Admin, Privileged Role Admin) this is fine
  // — if no one has ever activated the role, no SP holds it either.
  const roles = await graphList<{ id?: string; roleTemplateId?: string }>(
    "/directoryRoles?$select=id,roleTemplateId",
    token,
    { signal },
  );
  const tier0 = roles.filter((r) =>
    TIER_ZERO_ROLE_TEMPLATE_IDS.has((r.roleTemplateId ?? "") as string),
  );
  const principalIds = new Set<string>();
  for (const r of tier0) {
    if (!r.id) continue;
    try {
      const members = await graphList<{ id?: string }>(
        `/directoryRoles/${encodeURIComponent(r.id)}/members?$select=id`,
        token,
        { signal },
      );
      for (const m of members) {
        if (m.id) principalIds.add(m.id);
      }
    } catch (err) {
      // Don't kill the whole probe if a single role lookup fails.
      console.warn(
        `[tenant-baseline] tier-0 members lookup failed for role ${r.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return principalIds;
}

async function probeServicePrincipals(
  token: string,
  signal: AbortSignal,
): Promise<{
  rows: SpScoredRow[];
  roleEnumerationFailed: boolean;
}> {
  // Kick off both calls in parallel — SP enumeration is the long one.
  const tier0Promise = fetchTier0PrincipalIds(token, signal).catch(() => null);
  const select =
    "id,displayName,appId,servicePrincipalType,accountEnabled,keyCredentials,passwordCredentials,createdDateTime";
  const sps = await graphList<GraphServicePrincipalRaw>(
    `/servicePrincipals?$select=${select}&$top=${SP_PAGE_SIZE}`,
    token,
    { signal },
  );
  const tier0 = await tier0Promise;
  const roleEnumerationFailed = tier0 === null;
  const now = new Date();
  const rows: SpScoredRow[] = sps.map((sp) =>
    scoreServicePrincipal({
      sp,
      hasAdminRole: tier0 !== null && !!sp.id && tier0.has(sp.id),
      now,
    }),
  );
  return { rows, roleEnumerationFailed };
}

// ===========================================================================
// Main page
// ===========================================================================

interface ActiveAccountContext {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
}

/**
 * Top-level page export. Combines tenant-scope discovery, both tabs, and
 * a refresh control. Auto-loads both tabs when an active tenant is
 * available.
 */
export const TenantBaselinePage: React.FC = () => {
  const state = useMultiRegionState();
  const azureAccounts = state.azureAccounts ?? [];

  // Pick the first signed-in account's active tenant as the scope. The
  // global tenant switcher already covers cross-account flipping, so we
  // don't replicate it here.
  const primaryAccount: ActiveAccountContext | null = React.useMemo(() => {
    for (const a of azureAccounts) {
      if (!a.homeAccountId) continue;
      const tenant = getActiveTenant(a.homeAccountId) ?? resolveActiveTenantId(a);
      if (tenant) {
        return {
          homeAccountId: a.homeAccountId,
          tenantId: tenant,
          username: a.username,
          name: a.name || a.username,
        };
      }
    }
    return null;
  }, [azureAccounts]);

  // Sync token expiry for the header pill. We re-acquire on every refresh
  // so the badge tracks the latest token — not the very first one we got.
  const [tokenExpiresInSec, setTokenExpiresInSec] = React.useState<
    number | null
  >(null);

  // Signal C — Sovereign-cloud sentinel.
  //
  // We derive the active cloud environment from the `iss` claim of the
  // most-recent Graph token. Pure presentational — we never probe other
  // clouds.
  //
  // Detection inspired by:
  //   New folder/_AZURE_BYPASS_PLAYBOOK.md Phase 4 (Cross-cloud pivots).
  //   New folder/_bypass_tenant_switch.md §8 "Sovereign / Cross-Cloud
  //     Pivots" — defenders rarely correlate sign-in logs across clouds.
  const [cloudInfo, setCloudInfo] = React.useState<CloudEnvironmentInfo | null>(
    null,
  );

  // Tab state.
  const [baselineState, setBaselineState] = React.useState<BaselineState>({
    loading: false,
    findings: [],
    globalError: null,
    permissionWarnings: [],
    lastRefreshedAt: null,
  });
  const [spState, setSpState] = React.useState<SpTabState>({
    loading: false,
    rows: [],
    error: null,
    lastRefreshedAt: null,
    roleEnumerationFailed: false,
  });

  // Persisted compliance baseline snapshot (Enhancement #1).
  // The key embeds the tenant id so multi-tenant operators get a separate
  // snapshot per tenant. usePersistedState handles the key change correctly
  // — when the operator flips tenants in the global switcher, the hook
  // re-reads from localStorage with the new key.
  const snapshotKey = primaryAccount
    ? `${SNAPSHOT_STORAGE_PREFIX}${primaryAccount.tenantId}`
    : `${SNAPSHOT_STORAGE_PREFIX}__no_tenant__`;
  const [snapshot, setSnapshot, clearSnapshot] =
    usePersistedState<BaselineSnapshot | null>(snapshotKey, null, {
      version: SNAPSHOT_SCHEMA_VERSION,
      // Bump to schema v2+ — coerce unknown shapes to null so we don't crash.
      migrate: (raw) => {
        if (raw == null || typeof raw !== "object") return null;
        const obj = raw as Partial<BaselineSnapshot>;
        if (
          typeof obj.tenantId === "string" &&
          typeof obj.capturedAt === "string" &&
          obj.findings &&
          typeof obj.findings === "object"
        ) {
          return obj as BaselineSnapshot;
        }
        return null;
      },
    });

  // Per-tenant drift-history ring buffer (Deep-pass enhancement). Every
  // successful refresh appends a compact entry. The ring is capped in
  // helpers.ts so the localStorage envelope stays well under quota.
  const historyKey = primaryAccount
    ? `${HISTORY_STORAGE_PREFIX}${primaryAccount.tenantId}`
    : `${HISTORY_STORAGE_PREFIX}__no_tenant__`;
  const [history, setHistory] = usePersistedState<BaselineHistoryEntry[]>(
    historyKey,
    [],
    {
      version: HISTORY_SCHEMA_VERSION,
      migrate: (raw) => {
        if (!Array.isArray(raw)) return [];
        // Defensive shape coercion — drop entries that don't conform.
        return raw.filter((entry): entry is BaselineHistoryEntry => {
          if (!entry || typeof entry !== "object") return false;
          const e = entry as Partial<BaselineHistoryEntry>;
          return (
            typeof e.capturedAt === "string" &&
            typeof e.tally === "object" &&
            e.tally !== null &&
            typeof e.perCheck === "object" &&
            e.perCheck !== null
          );
        });
      },
    },
  );

  // Global cross-tenant "alert me when posture regresses" preference.
  // Persisted as a plain boolean. Defaulting to ON because the cost is
  // negligible (one off-screen aria-live message) and the value is high
  // when a defender flips tenants between audits.
  const [alertOnDrift, setAlertOnDrift] = usePersistedState<boolean>(
    ALERT_ON_DRIFT_PREF_KEY,
    true,
  );

  // Per-tab last-fetch-wins guards. Without these, switching tabs +
  // refreshing while a slow probe is in-flight can clobber the new
  // results with the old.
  const baselineSeqRef = React.useRef(0);
  const spSeqRef = React.useRef(0);

  const refreshBaseline = React.useCallback(async () => {
    if (!primaryAccount) return;
    const seq = ++baselineSeqRef.current;
    const controller = new AbortController();
    setBaselineState((prev) => ({ ...prev, loading: true, globalError: null }));
    try {
      const token = await getGraphTokenForAccount(
        primaryAccount.homeAccountId,
        primaryAccount.tenantId,
      );
      if (seq !== baselineSeqRef.current) return;
      setTokenExpiresInSec(tokenSecondsUntilExpiry(token));
      // Signal C — derive active cloud environment from the token's
      // `iss` claim. Read-only enumeration of OUR own token; we do not
      // probe sovereign endpoints.
      setCloudInfo(detectCloudEnvironmentFromToken(token));
      const { findings, permissionWarnings } = await probeBaseline(
        token,
        controller.signal,
      );
      if (seq !== baselineSeqRef.current) return;
      setBaselineState({
        loading: false,
        findings,
        globalError: null,
        permissionWarnings,
        lastRefreshedAt: Date.now(),
      });
      // Append a compact history entry on every successful refresh so the
      // timeline strip in the baseline tab tracks longitudinal drift
      // without a backend. `pushHistoryEntry` caps the ring at
      // BASELINE_HISTORY_LIMIT — older entries fall off the left.
      setHistory((prev) => pushHistoryEntry(prev, buildHistoryEntry(findings, false)));
      auditLog.record({
        actor: primaryAccount.username || primaryAccount.homeAccountId,
        action: "tenant_baseline_audit",
        target: primaryAccount.tenantId,
        status: "success",
        details: {
          tenantId: primaryAccount.tenantId,
          findingsCount: findings.length,
          countsBySeverity: tallySeverities(findings),
          permissionWarnings,
        },
      });
    } catch (err) {
      if (seq !== baselineSeqRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setBaselineState({
        loading: false,
        findings: [],
        globalError: msg,
        permissionWarnings: [],
        lastRefreshedAt: Date.now(),
      });
      auditLog.record({
        actor: primaryAccount.username || primaryAccount.homeAccountId,
        action: "tenant_baseline_audit",
        target: primaryAccount.tenantId,
        status: "failure",
        error: msg,
        details: { tenantId: primaryAccount.tenantId },
      });
    }
  }, [primaryAccount, setHistory]);

  const refreshSps = React.useCallback(async () => {
    if (!primaryAccount) return;
    const seq = ++spSeqRef.current;
    const controller = new AbortController();
    setSpState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const token = await getGraphTokenForAccount(
        primaryAccount.homeAccountId,
        primaryAccount.tenantId,
      );
      if (seq !== spSeqRef.current) return;
      setTokenExpiresInSec(tokenSecondsUntilExpiry(token));
      // Signal C — derive active cloud environment from the token's
      // `iss` claim. Read-only enumeration of OUR own token; we do not
      // probe sovereign endpoints.
      setCloudInfo(detectCloudEnvironmentFromToken(token));
      const { rows, roleEnumerationFailed } = await probeServicePrincipals(
        token,
        controller.signal,
      );
      if (seq !== spSeqRef.current) return;
      setSpState({
        loading: false,
        rows,
        error: null,
        lastRefreshedAt: Date.now(),
        roleEnumerationFailed,
      });
      auditLog.record({
        actor: primaryAccount.username || primaryAccount.homeAccountId,
        action: "sp_credentials_audit",
        target: primaryAccount.tenantId,
        status: "success",
        details: {
          tenantId: primaryAccount.tenantId,
          spCount: rows.length,
          countsBySeverity: tallySeverities(rows),
          roleEnumerationFailed,
        },
      });
    } catch (err) {
      if (seq !== spSeqRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setSpState({
        loading: false,
        rows: [],
        error: msg,
        lastRefreshedAt: Date.now(),
        roleEnumerationFailed: false,
      });
      auditLog.record({
        actor: primaryAccount.username || primaryAccount.homeAccountId,
        action: "sp_credentials_audit",
        target: primaryAccount.tenantId,
        status: "failure",
        error: msg,
        details: { tenantId: primaryAccount.tenantId },
      });
    }
  }, [primaryAccount]);

  // Auto-load baseline on first render once we have a tenant. SP tab is
  // lazy-loaded only when the user opens it the first time to avoid the
  // 999-row Graph hit if they only care about the baseline.
  //
  // useAbortableEffect gives us correct cleanup if the operator unmounts
  // the page mid-probe (or if `primaryAccount` flips before the probe
  // finishes), without relying on the per-tab seq-ref guard alone.
  const baselineLoadedForTenantRef = React.useRef<string | null>(null);
  useAbortableEffect(
    () => {
      if (!primaryAccount) return;
      if (baselineLoadedForTenantRef.current === primaryAccount.tenantId) return;
      baselineLoadedForTenantRef.current = primaryAccount.tenantId;
      // refreshBaseline owns its own AbortController via the sequence guard;
      // useAbortableEffect's signal is observed implicitly by re-rendering
      // (a new tenant produces a new effect run, abort fires on the prior).
      void refreshBaseline();
    },
    [primaryAccount, refreshBaseline],
  );

  // Snapshot save/clear handlers. Both are audit-logged so a sweep across
  // the audit log can answer "who saved a baseline against tenant X".
  const handleSaveSnapshot = React.useCallback(() => {
    if (!primaryAccount) return;
    if (baselineState.findings.length === 0) return;
    const base = buildSnapshot(
      primaryAccount.tenantId,
      primaryAccount.name || primaryAccount.username,
      baselineState.findings,
    );
    // Pin the snapshot's capturedAt to the latest history entry's
    // capturedAt so the timeline bookmark check (`h.capturedAt ===
    // snapshot.capturedAt`) lines up. Without this the two timestamps
    // would drift by a few milliseconds (refresh wrote one, save wrote
    // another) and no history entry would ever match.
    //
    // Read `history` from the closure (the rendered value at click-time)
    // rather than the functional setHistory updater — that keeps the
    // snapshot write deterministic and synchronous.
    const latestHistoryAt =
      history.length > 0 ? history[history.length - 1]!.capturedAt : null;
    const snap: BaselineSnapshot = latestHistoryAt
      ? { ...base, capturedAt: latestHistoryAt }
      : base;
    setSnapshot(snap);
    // Mark the latest history entry as the approved baseline so the
    // timeline shows a bookmark on it.
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      // Clear any prior approved-flag — only one bookmark at a time.
      for (let i = 0; i < next.length - 1; i += 1) {
        const entry = next[i];
        if (entry && entry.wasApproved) {
          next[i] = { ...entry, wasApproved: false };
        }
      }
      const last = next[next.length - 1];
      if (last) {
        next[next.length - 1] = { ...last, wasApproved: true };
      }
      return next;
    });
    auditLog.record({
      actor: primaryAccount.username || primaryAccount.homeAccountId,
      action: "tenant_baseline_snapshot_save",
      target: primaryAccount.tenantId,
      status: "success",
      details: {
        tenantId: primaryAccount.tenantId,
        findingsCount: baselineState.findings.length,
        countsBySeverity: tallySeverities(baselineState.findings),
      },
    });
  }, [primaryAccount, baselineState.findings, setSnapshot, setHistory, history]);

  const handleClearSnapshot = React.useCallback(() => {
    if (!primaryAccount) {
      clearSnapshot();
      return;
    }
    clearSnapshot();
    auditLog.record({
      actor: primaryAccount.username || primaryAccount.homeAccountId,
      action: "tenant_baseline_snapshot_clear",
      target: primaryAccount.tenantId,
      status: "success",
      details: { tenantId: primaryAccount.tenantId },
    });
  }, [primaryAccount, clearSnapshot]);

  // Compliance-evidence export — builds an envelope with a SHA-256 hash
  // over the canonical findings JSON (chain-of-custody anchor) and pushes
  // it to the user's downloads. The hash itself is computed inside the
  // helper via WebCrypto SubtleCrypto.
  const [isExportingEvidence, setIsExportingEvidence] = React.useState(false);
  const handleExportEvidence = React.useCallback(async () => {
    if (!primaryAccount) return;
    if (baselineState.findings.length === 0) return;
    setIsExportingEvidence(true);
    try {
      // Re-derive drift summary here — we don't share the BaselineTab's
      // memoised summary across the page (BaselineTab is the consumer).
      // Recomputing is O(n) and only runs on the operator's click.
      const driftMap = diffAgainstSnapshot(baselineState.findings, snapshot);
      const drift = summarizeDrift(driftMap);
      const envelope: ComplianceEvidence = await buildComplianceEvidence({
        tenantId: primaryAccount.tenantId,
        tenantDisplayName: primaryAccount.name || primaryAccount.username,
        actor: primaryAccount.username || primaryAccount.homeAccountId,
        cloudEnvironment: cloudInfo?.environment ?? "Unknown",
        findings: baselineState.findings,
        drift,
      });
      // Lazy import shape — we reuse the same `downloadJson` the
      // ExportMenu uses to keep dependency surface small.
      // Inline a tiny helper rather than pulling another import.
      const json = JSON.stringify(envelope, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `tenant-baseline-evidence-${primaryAccount.tenantId.slice(0, 8)}-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      auditLog.record({
        actor: primaryAccount.username || primaryAccount.homeAccountId,
        action: "tenant_baseline_evidence_export",
        target: primaryAccount.tenantId,
        status: "success",
        details: {
          tenantId: primaryAccount.tenantId,
          findingsCount: baselineState.findings.length,
          evidenceHash: envelope.evidenceHash,
          evidenceHashAlgorithm: envelope.evidenceHashAlgorithm,
          drift,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditLog.record({
        actor: primaryAccount.username || primaryAccount.homeAccountId,
        action: "tenant_baseline_evidence_export",
        target: primaryAccount.tenantId,
        status: "failure",
        error: msg,
        details: { tenantId: primaryAccount.tenantId },
      });
    } finally {
      setIsExportingEvidence(false);
    }
  }, [primaryAccount, baselineState.findings, snapshot, cloudInfo]);

  // Refs for hot-key focus + click — see useShortcut bindings below.
  const refreshButtonRef = React.useRef<HTMLButtonElement>(null);
  const exportMenuButtonRef = React.useRef<HTMLSpanElement>(null);

  // Hot-keys: only active when the operator is NOT typing in an input
  // (useShortcut already gates this by default). Bound to the window so
  // they work from any focus location on the page.
  //   s → save baseline
  //   c → clear baseline (if present)
  //   e → open the Export dropdown (focuses the trigger button)
  //   r → refresh
  //   v → export compliance evidence (v for "verify")
  useShortcut("s", () => {
    void handleSaveSnapshot();
  });
  useShortcut("c", () => {
    if (snapshot) void handleClearSnapshot();
  });
  useShortcut("e", () => {
    const trigger = exportMenuButtonRef.current?.querySelector("button");
    if (trigger instanceof HTMLButtonElement) {
      trigger.focus();
      trigger.click();
    }
  });
  useShortcut("r", () => {
    if (refreshButtonRef.current && !refreshButtonRef.current.disabled) {
      refreshButtonRef.current.click();
    }
  });
  useShortcut("v", () => {
    void handleExportEvidence();
  });

  const spLoadedRef = React.useRef(false);
  const handleTabChange = React.useCallback(
    (value: string) => {
      if (value === "sp" && !spLoadedRef.current && primaryAccount) {
        spLoadedRef.current = true;
        void refreshSps();
      }
    },
    [primaryAccount, refreshSps],
  );

  // Re-render once a minute so "Refreshed Xs ago" pills stay fresh.
  const [, forceTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // React to global tenant switches: when the operator flips the active
  // tenant for the primary account via the global tenant switcher, re-run
  // both probes against the new tenant scope. The page derives its tenant
  // from `getActiveTenant(homeAccountId)` inside the `primaryAccount` memo,
  // so we re-fetch directly rather than holding extra local state.
  useTenantChange(undefined, (detail) => {
    const candidate = detail.homeAccountId;
    if (!primaryAccount) return;
    if (candidate !== primaryAccount.homeAccountId) return;
    if (detail.tenantId === primaryAccount.tenantId) return;
    void refreshBaseline();
    if (spLoadedRef.current) void refreshSps();
  });

  // ----- Empty state — no signed-in account ---------------------------------
  if (!primaryAccount) {
    return (
      <Card className="mx-auto max-w-2xl border-dashed">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Shield className="h-6 w-6 text-muted-foreground" aria-hidden />
          </div>
          <CardTitle className="text-base">
            Sign in to audit the tenant baseline
          </CardTitle>
          <CardDescription>
            This page reads tenant configuration + service principal
            credentials via Microsoft Graph. It needs at least Directory.Read.All
            on the active tenant.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // ----- Normal render -----------------------------------------------------
  const tokenBadgeVariant: "outline" | "warning" | "destructive" | "success" =
    tokenExpiresInSec === null
      ? "outline"
      : tokenExpiresInSec < 60
        ? "destructive"
        : tokenExpiresInSec < 5 * 60
          ? "warning"
          : "success";

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="m-0 flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
            <ShieldCheck className="h-6 w-6 text-primary" aria-hidden />
            Tenant Security Baseline
          </h1>
          <p className="m-0 max-w-prose text-xs leading-relaxed text-muted-foreground">
            Defensive auditor — checks the signed-in tenant for the misconfigs
            AADInternals-class tooling routinely exploits, and tracks service
            principal credential expiries before they cause outages. All
            probes are read-only Microsoft Graph GETs.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="gap-1">
            <Globe className="h-3 w-3" aria-hidden />
            <span className="truncate">
              {primaryAccount.name || primaryAccount.username}
            </span>
          </Badge>
          <Badge variant="outline" className="gap-1 font-mono group/copy">
            <code className="text-2xs">
              {primaryAccount.tenantId.slice(0, 8)}…{primaryAccount.tenantId.slice(-4)}
            </code>
            <CopyButton
              value={primaryAccount.tenantId}
              ariaLabel={`Copy tenant id ${primaryAccount.tenantId}`}
              alwaysVisible
            />
          </Badge>
          {tokenExpiresInSec !== null && (
            <Badge variant={tokenBadgeVariant} className="gap-1">
              <KeyRound className="h-3 w-3" aria-hidden />
              Token {tokenExpiresInSec < 60
                ? `${tokenExpiresInSec}s`
                : tokenExpiresInSec < 3600
                  ? `${Math.floor(tokenExpiresInSec / 60)}m`
                  : `${Math.floor(tokenExpiresInSec / 3600)}h ${Math.floor((tokenExpiresInSec % 3600) / 60)}m`}
            </Badge>
          )}
        </div>
      </header>

      {/*
        Signal C — Sovereign-cloud sentinel banner.

        Read-only banner showing which Microsoft cloud the active Graph
        token was issued in. Defenders frequently *only* watch Commercial
        sign-in logs; a token issued by Gov or China endpoints means
        posture for THIS view does not cover the other clouds.

        Detection inspired by:
          New folder/_AZURE_BYPASS_PLAYBOOK.md Phase 4 (Cross-cloud pivots).
          New folder/_bypass_tenant_switch.md §8 (Sovereign / Cross-Cloud
            Pivots — endpoint catalog + §8.2 Commercial→Gov pivot).
      */}
      {cloudInfo && (
        <SovereignCloudBanner cloudInfo={cloudInfo} />
      )}

      <Tabs defaultValue="baseline" onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="baseline">
            <ShieldCheck className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Baseline configuration
          </TabsTrigger>
          <TabsTrigger value="sp">
            <KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Service principal credentials
          </TabsTrigger>
        </TabsList>
        <TabsContent value="baseline">
          <BaselineTab
            state={baselineState}
            onRefresh={refreshBaseline}
            tenantId={primaryAccount.tenantId}
            tenantDisplayName={primaryAccount.name || primaryAccount.username}
            snapshot={snapshot}
            onSaveSnapshot={handleSaveSnapshot}
            onClearSnapshot={handleClearSnapshot}
            history={history}
            alertOnDrift={alertOnDrift}
            onToggleAlertOnDrift={setAlertOnDrift}
            onExportEvidence={handleExportEvidence}
            isExportingEvidence={isExportingEvidence}
            refreshButtonRef={refreshButtonRef}
            exportMenuButtonRef={exportMenuButtonRef}
          />
        </TabsContent>
        <TabsContent value="sp">
          <SpTab
            state={spState}
            onRefresh={refreshSps}
            tenantId={primaryAccount.tenantId}
            tenantDisplayName={primaryAccount.name || primaryAccount.username}
            actor={primaryAccount.username || primaryAccount.homeAccountId}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};
