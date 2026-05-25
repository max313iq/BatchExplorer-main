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
 */
import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Globe,
  Info,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
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
import {
  cn,
  downloadCsv,
  downloadJson,
  formatRelativeTime,
} from "@/lib/utils";

import { getActiveTenant, getGraphTokenForAccount } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { auditLog } from "../../services/audit-log";
import { useMultiRegionState } from "../../store/store-context";

import {
  type BaselineFinding,
  type BaselineSeverity,
  type DomainRaw,
  type GraphServicePrincipalRaw,
  type OrganizationRaw,
  type AuthorizationPolicyRaw,
  type SecurityDefaultsPolicyRaw,
  type SpScoredRow,
  type SpType,
  TIER_ZERO_ROLE_TEMPLATE_IDS,
  compareIsoDates,
  compareSeverityDesc,
  scoreDefaultUserPermissions,
  scoreDomainsFederation,
  scoreGuestInvitePolicy,
  scoreOnPremSync,
  scorePasswordProtection,
  scoreSecurityDefaults,
  scoreServicePrincipal,
  severityLabel,
  severityToBadgeVariant,
  tallySeverities,
} from "./tenant-baseline-helpers";

// ===========================================================================
// Constants
// ===========================================================================

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SP_PAGE_SIZE = 999; // Graph max for $top on /servicePrincipals
const SEARCH_DEBOUNCE_MS = 150;

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
  const handleCopy = React.useCallback(() => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(text).catch(() => {
        /* clipboard denied — ignore */
      });
    }
  }, [text]);
  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={handleCopy}
        className="absolute right-1 top-1"
        aria-label="Copy raw response to clipboard"
        title="Copy JSON"
      >
        <Copy />
      </Button>
      <pre className="max-h-72 overflow-auto rounded bg-card p-2 font-mono text-2xs leading-snug text-foreground">
        {text}
      </pre>
    </div>
  );
};

/**
 * Single baseline-check card — the visual unit on Tab 1. Renders the
 * severity icon + name + status, with three lazy expanders for the
 * three deeper sections (why it matters, remediation, raw response).
 */
const FindingCard: React.FC<{ finding: BaselineFinding }> = ({ finding }) => {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="space-y-1 pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <SeverityIcon severity={finding.severity} />
          <span>{finding.name}</span>
          <SeverityBadge severity={finding.severity} />
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
    const page = await graphGet<{ value?: T[]; "@odata.nextLink"?: string }>(
      url,
      token,
      opts,
    );
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
}

const BaselineTab: React.FC<BaselineTabProps> = ({
  state,
  onRefresh,
  tenantId,
  tenantDisplayName,
}) => {
  const tally = React.useMemo(() => tallySeverities(state.findings), [
    state.findings,
  ]);

  const handleExportJson = React.useCallback(() => {
    const payload = {
      tenantId,
      tenantDisplayName,
      capturedAt: new Date().toISOString(),
      findings: state.findings,
    };
    downloadJson(
      `tenant-baseline-${tenantId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`,
      payload,
    );
  }, [state.findings, tenantId, tenantDisplayName]);

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
        <div className="ml-auto flex items-center gap-2">
          {state.lastRefreshedAt && (
            <span className="text-2xs text-muted-foreground">
              Refreshed {formatRelativeTime(new Date(state.lastRefreshedAt))}
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleExportJson}
            disabled={state.findings.length === 0}
            aria-label="Export findings as JSON"
            title="Export the current baseline snapshot to a JSON file"
          >
            <Download />
            Export JSON
          </Button>
          <Button
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
          state.findings.map((f) => <FindingCard key={f.id} finding={f} />)
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
}

const SpTab: React.FC<SpTabProps> = ({
  state,
  onRefresh,
  tenantId,
  tenantDisplayName,
}) => {
  // Filter state — kept page-local; not synced to URL because the page is
  // already account-scoped and the filter set is small.
  const [searchInput, setSearchInput] = React.useState("");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [severityFilter, setSeverityFilter] = React.useState<
    Set<BaselineSeverity>
  >(new Set());
  const [typeFilter, setTypeFilter] = React.useState<Set<SpType>>(new Set());

  // Debounced search.
  const searchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  React.useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setSearchQuery(searchInput);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [searchInput]);

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

  const handleExportCsv = React.useCallback(() => {
    if (filteredRows.length === 0) return;
    const headers = [
      "displayName",
      "appId",
      "id",
      "type",
      "accountEnabled",
      "totalCredentials",
      "earliestExpiry",
      "daysUntilEarliest",
      "hasExpired",
      "hasAdminRole",
      "severity",
      "summary",
    ];
    const rows = filteredRows.map((r) => [
      r.displayName,
      r.appId,
      r.id,
      r.type,
      r.accountEnabled ? "true" : "false",
      r.totalCredentials,
      r.earliestExpiry ?? "",
      r.daysUntilEarliestExpiry ?? "",
      r.hasExpired ? "true" : "false",
      r.hasAdminRole ? "true" : "false",
      r.severity,
      r.severitySummary,
    ]);
    downloadCsv(
      `sp-credentials-${tenantId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv`,
      headers,
      rows,
    );
  }, [filteredRows, tenantId]);

  const handleExportJson = React.useCallback(() => {
    const payload = {
      tenantId,
      tenantDisplayName,
      capturedAt: new Date().toISOString(),
      summary: stats,
      rows: filteredRows,
    };
    downloadJson(
      `sp-credentials-${tenantId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`,
      payload,
    );
  }, [filteredRows, stats, tenantId, tenantDisplayName]);

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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={filteredRows.length === 0}
            aria-label="Export filtered SP rows as CSV"
            title="Export the current (filtered) view to CSV"
          >
            <Download />
            CSV
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleExportJson}
            disabled={filteredRows.length === 0}
            aria-label="Export filtered SP rows as JSON (includes credentials)"
            title="Export the current (filtered) view to JSON with full credential details"
          >
            <Download />
            JSON
          </Button>
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
              onCheckedChange={() => setSeverityFilter(new Set())}
            >
              Clear all
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* SP type chips (compact, click to toggle inclusion). */}
        <div className="flex flex-wrap items-center gap-1">
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
              filteredRows.map((r) => <SpRow key={r.id} row={r} />)
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
 */
const SpRow: React.FC<{ row: SpScoredRow }> = ({ row }) => {
  const [expanded, setExpanded] = React.useState(false);
  const handleCopyAppId = React.useCallback(() => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(row.appId).catch(() => {});
    }
  }, [row.appId]);

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
            onClick={() => setExpanded((v) => !v)}
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
          </button>
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-1">
            <code className="truncate font-mono text-2xs text-muted-foreground">
              {row.appId}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={handleCopyAppId}
              aria-label={`Copy app id for ${row.displayName}`}
              title="Copy App ID"
            >
              <Copy />
            </Button>
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
  const [
    secDefaultsRes,
    caCountRes,
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
    // CA policies: `/identity/conditionalAccess/policies?$top=1` — we only
    // need to know whether there's at least one. If this 403s, leave the
    // count as "null" so the security-defaults scorer treats it as
    // "unknown" rather than "definitely none".
    graphList<{ id?: string }>(
      "/identity/conditionalAccess/policies?$select=id&$top=10",
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
  if (caCountRes.status === "fulfilled") {
    hasAnyCA = caCountRes.value.length > 0;
  } else {
    hasAnyCA = null;
    const msg = String(
      caCountRes.reason instanceof Error
        ? caCountRes.reason.message
        : caCountRes.reason,
    );
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
  if (domainsRes.status === "fulfilled") {
    domainsFinding = scoreDomainsFederation(domainsRes.value);
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
  }

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
      guestFinding,
      defaultPermsFinding,
      domainsFinding,
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
  }, [primaryAccount]);

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
  const baselineLoadedRef = React.useRef(false);
  React.useEffect(() => {
    if (!primaryAccount) return;
    if (baselineLoadedRef.current) return;
    baselineLoadedRef.current = true;
    void refreshBaseline();
  }, [primaryAccount, refreshBaseline]);

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
          <Badge variant="outline" className="gap-1 font-mono">
            <code className="text-2xs">
              {primaryAccount.tenantId.slice(0, 8)}…{primaryAccount.tenantId.slice(-4)}
            </code>
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
          />
        </TabsContent>
        <TabsContent value="sp">
          <SpTab
            state={spState}
            onRefresh={refreshSps}
            tenantId={primaryAccount.tenantId}
            tenantDisplayName={primaryAccount.name || primaryAccount.username}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};
