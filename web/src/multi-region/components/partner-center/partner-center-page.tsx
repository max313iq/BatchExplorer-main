/**
 * Partner Center page — checks whether a signed-in Azure account can
 * operate against Microsoft Partner Center as a Cloud Solution
 * Provider (CSP) partner and/or carries a Microsoft Partner Network
 * (MPN) profile, and manages the Partner Admin Link (PAL) used by
 * Microsoft to attribute Azure consumption back to a partner of
 * record.
 *
 * The page is read-mostly: four lightweight probes that the operator
 * fires on demand. The only mutating actions are linking / unlinking
 * a Partner ID via ARM's `Microsoft.ManagementPartner` resource type,
 * both gated behind an audited confirmation flow.
 *
 * UX choices worth calling out:
 *   - Probe runs are audited even on success — the operator's history
 *     should be reproducible (what did we check, when, against whom).
 *   - All errors are surfaced to the UI; no silent `.catch(() => {})`.
 *     A failed probe shows a banner with the AAD error code +
 *     remediation hint (sign in with a different identity, or pivot
 *     to Token Importer).
 *   - Keyboard shortcuts: `Mod+Enter` runs all probes, `Mod+L` focuses
 *     the Partner-ID input, `Mod+Shift+R` re-runs only the probes that
 *     previously failed (cheap retry after fixing tenant / consent).
 *   - Stale-write guard: switching accounts mid-flight cancels the
 *     write-back of in-flight results to the new account's slot.
 */
import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Handshake,
  Link2,
  Link2Off,
  Loader2,
  Network,
  Radar,
  RotateCcw,
  RotateCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  StopCircle,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import {
  getActiveTenant,
  getArmTokenForAccount,
  getGraphTokenForAccount,
  getPartnerCenterTokenForAccount,
} from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { modKeyLabel, useShortcut } from "../../hooks/use-shortcut";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { auditLog } from "../../services/audit-log";
import {
  getPartnerAdminLink,
  linkPartnerAdmin,
  probeCspAccess,
  probeLegalBusinessProfile,
  probeMpnProfile,
  unlinkPartnerAdmin,
  type CspCustomerSummary,
  type LegalBusinessProfileSummary,
  type MpnProfileSummary,
  type PartnerAdminLinkSummary,
  type ProbeOutcome,
  type ProbeResult,
} from "../../services/partner-center-service";
import { useMultiRegionState, useMultiRegionStore } from "../../store/store-context";

import {
  bulkProbeCustomers,
  probeGdapDelegations,
  probePalDrift,
  type CustomerMatrixRow,
  type GdapDelegation,
  type GdapDelegationSummary,
  type PalDriftSummary,
  type SubscriptionPalRow,
} from "./partner-relationships-probe";

import { useDashboardOutletContext } from "../page-router";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyableText, CopyButton } from "../shared/copy-button";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SignInRequired } from "../shared/sign-in-required";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { type PageKey } from "../shared/sidebar-nav";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

// COORDINATOR: `EmptyState` was imported but unused in the historical page;
// dropped to keep this file self-contained and lint-clean. Re-add if a
// future enhancement needs the shared empty layout.

const ACTIVE_ACCOUNT_KEY = "partner-center:active-account";
const PARTNER_ID_KEY = "partner-center:last-partner-id";
const PREFERRED_MPN_KEY = "partner-center:preferred-mpn";
const PARTNER_ID_RE = /^\d{6,10}$/;
/**
 * Probes whose `lastRunAt` is older than this are flagged as "stale". The
 * threshold (24h) mirrors CSP partner-of-record reconciliation cadence —
 * a probe answer older than a day is no longer trustworthy for billing
 * attribution decisions.
 */
const STALE_PROBE_MS = 24 * 60 * 60 * 1000;

/**
 * Longer "haven't even bothered to probe" threshold (60d). When the
 * operator's CSP customer matrix carries customers we haven't poked at
 * in two months, those rows are the most likely to harbour a dormant
 * MSP relationship that has drifted (cf. corpus playbook
 * `_bypass_tenant_switch.md` §6.3 — MSP supply-chain abuse is most
 * effective against dormant relationships because they generate no
 * alerts).
 */
const STALE_CUSTOMER_MS = 60 * 24 * 60 * 60 * 1000;

/** Session-storage key for the bulk-customer-probe last-run timestamps. */
const CUSTOMER_PROBE_KEY = "partner-center:customer-last-probe";

/**
 * Loose container for "when did we last touch this CSP customer?". Kept
 * in sessionStorage so a reload doesn't lose the timeline — but
 * deliberately NOT persistent (a per-account view that survives the
 * session is enough; persisting across sessions would invite confusion
 * if the operator pivots tenants).
 */
type CustomerProbeLedger = Record<string, number>;

function loadCustomerLedger(key: string): CustomerProbeLedger {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const out: CustomerProbeLedger = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
  } catch {
    /* corrupt — ignore */
  }
  return {};
}

function saveCustomerLedger(key: string, ledger: CustomerProbeLedger): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(ledger));
  } catch {
    /* ignore quota errors */
  }
}

/**
 * Truncate the middle of a long opaque id (tenantId, GUID, etc.) so it
 * stays scannable in a single line. Mirrors the local helper on
 * azure-accounts / user-creator / ea-subscription pages — duplicated
 * intentionally to keep this page self-contained (`@/lib/utils`
 * doesn't currently export this helper).
 */
function truncateMiddle(value: string, head = 8, tail = 4): string {
  if (!value) return "";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export interface PartnerCenterPageProps {
  /**
   * Legacy navigation callback retained for backward compat with the
   * `<PartnerCenterPage onNavigate={...}/>` adapter in page-router. New
   * call sites should rely on `useDashboardOutletContext().navigateToPage`
   * directly. When both are present, `navigateToPage` wins.
   */
  onNavigate?: (k: PageKey) => void;
}

interface CandidateAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
}

type ProbeKey = "csp" | "mpn" | "legalBusiness" | "pal";

const ALL_PROBES: ProbeKey[] = ["csp", "mpn", "legalBusiness", "pal"];

/**
 * Row shape exported via `ExportMenu`. Hoisted to module scope so the
 * `ExportColumn<ExportRow>` generic resolves to a stable identity across
 * renders (declaring an interface inside the component body works at the
 * TS level but creates a fresh type identity per render — fine for
 * erasable types but unnecessarily noisy in editor inlay hints).
 */
interface ExportRow {
  probe: ProbeKey;
  label: string;
  outcome: string;
  summary: string;
  httpStatus: number | null;
  errorCode: string | null;
  detail: string | null;
  data: unknown;
  ranAt: string | null;
  stale: boolean;
}

interface ProbeState {
  csp: ProbeResult<CspCustomerSummary> | null;
  mpn: ProbeResult<MpnProfileSummary> | null;
  legalBusiness: ProbeResult<LegalBusinessProfileSummary> | null;
  pal: ProbeResult<PartnerAdminLinkSummary> | null;
}

const EMPTY_PROBES: ProbeState = {
  csp: null,
  mpn: null,
  legalBusiness: null,
  pal: null,
};

const PROBE_LABEL: Record<ProbeKey, string> = {
  csp: "CSP customer access",
  mpn: "MPN / Partner Network profile",
  legalBusiness: "Legal-business profile",
  pal: "Partner Admin Link (PAL)",
};

/** Pretty label + accent class for a probe outcome badge. */
function outcomeBadge(outcome: ProbeOutcome | undefined) {
  switch (outcome) {
    case "pass":
      return { label: "Pass", variant: "success" as const };
    case "unauthorized":
      return { label: "Not authorized", variant: "warning" as const };
    case "fail":
      return { label: "Fail", variant: "destructive" as const };
    case "unknown":
      return { label: "Unknown", variant: "outline" as const };
    default:
      return { label: "Not run", variant: "outline" as const };
  }
}

/**
 * Format a probe outcome for ARIA / textual export. Mirrors
 * `outcomeBadge` labels so the CSV export and the on-screen badge agree.
 */
function outcomeAsText(outcome: ProbeOutcome | undefined): string {
  return outcomeBadge(outcome).label;
}

export const PartnerCenterPage: React.FC<PartnerCenterPageProps> = ({
  onNavigate,
}) => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const azureAccounts = state.azureAccounts ?? [];

  /* ───────────────────────────────────────────────────────────────────
   * Navigation. Prefer the path-based `navigateToPage` from the
   * dashboard outlet context (the canonical wiring); fall back to the
   * legacy `onNavigate(pageKey)` prop for storybook / standalone
   * mounts and for the back-compat adapter in page-router. The cast
   * tolerates rendering outside an Outlet (returns `undefined`).
   * ─────────────────────────────────────────────────────────────────── */
  const outletCtx = useDashboardOutletContext() as unknown as
    | { navigateToPage?: (path: string) => void }
    | undefined;
  const navigateTo = React.useCallback(
    (key: PageKey) => {
      if (outletCtx?.navigateToPage) {
        outletCtx.navigateToPage(key.startsWith("/") ? key : `/${key}`);
        return;
      }
      onNavigate?.(key);
    },
    [outletCtx, onNavigate],
  );

  /* ───────────────────────────────────────────────────────────────────
   * Candidate accounts. Every signed-in Azure account is a candidate
   * — Partner Center membership lives at the *tenant* level so the
   * operator picks "as which signed-in identity should I run this
   * probe?" rather than us pre-filtering on a role we'd just have to
   * call PC to verify anyway.
   * ─────────────────────────────────────────────────────────────────── */
  const candidates: CandidateAccount[] = React.useMemo(() => {
    return azureAccounts
      .map((a) => ({
        homeAccountId: a.homeAccountId,
        tenantId: getActiveTenant(a.homeAccountId) ?? a.tenantId,
        username: a.username,
        name: a.name || a.username,
      }))
      .filter((a) => a.homeAccountId && a.tenantId);
  }, [azureAccounts]);

  const [accountId, setAccountId] = React.useState<string>(() => {
    try {
      return sessionStorage.getItem(ACTIVE_ACCOUNT_KEY) ?? "";
    } catch {
      return "";
    }
  });

  React.useEffect(() => {
    if (candidates.length === 0) return;
    if (!candidates.some((c) => c.homeAccountId === accountId)) {
      const next = candidates[0]!.homeAccountId;
      setAccountId(next);
      // Mirror the auto-selection to sessionStorage so a reload picks up
      // the same default rather than re-running this effect.
      try {
        sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, next);
      } catch {
        /* ignore */
      }
    }
  }, [candidates, accountId]);

  /* ───────────────────────────────────────────────────────────────────
   * Stale-write guard. Every probe captures the account id it started
   * against; the setProbes call later compares that against the
   * "current" account id and bails if the operator switched mid-run.
   * Without this guard, a slow probe fired against tenant A could land
   * its result in tenant B's slot after the picker change. The
   * generation counter makes the comparison cheap and re-entrant.
   * ─────────────────────────────────────────────────────────────────── */
  const accountGenRef = React.useRef(0);
  const partnerIdInputRef = React.useRef<HTMLInputElement | null>(null);

  const handleSelectAccount = React.useCallback((id: string) => {
    setAccountId(id);
    accountGenRef.current += 1;
    try {
      sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, id);
    } catch {
      /* ignore */
    }
    // Clear stale probe results when the operator switches accounts
    // — they belong to a different identity.
    setProbes(EMPTY_PROBES);
  }, []);

  const account: CandidateAccount | null = React.useMemo(
    () => candidates.find((c) => c.homeAccountId === accountId) ?? null,
    [candidates, accountId],
  );

  /**
   * Resolve the *currently active* tenant id for the selected account.
   * `CandidateAccount.tenantId` is snapshotted at memo-build time —
   * fine for the picker chips, but the runtime call sites below
   * (token acquisition, audit writes, exports) must read the live
   * `activeTenantId` off the underlying `AzureLoginAccount` so a
   * mid-flight tenant switch lands in the right slot.
   */
  const getActiveTenantIdForSelected = React.useCallback((): string | undefined => {
    if (!account) return undefined;
    const full = azureAccounts.find(
      (a) => a.homeAccountId === account.homeAccountId,
    );
    return full ? resolveActiveTenantId(full) : account.tenantId;
  }, [account, azureAccounts]);

  /* ───────────────────────────────────────────────────────────────────
   * Page-level ARM token tracker. Drives the TokenExpiryBadge rendered
   * alongside the account picker. The page makes ARM calls for the
   * PAL probe + link/unlink mutations via getArmTokenForAccount(...)
   * inline in each handler — we don't bridge this tracker into those
   * call sites (they still acquire fresh per-call), the badge is here
   * purely so the operator sees when the ARM half of the session is
   * about to need a refresh. Partner Center tokens are deliberately
   * NOT tracked here — those are minted lazily by acquirePcToken and
   * follow a different consent / failure path (CSP enrollment).
   * ─────────────────────────────────────────────────────────────────── */
  const armTokenTracker = useArmToken(
    account?.homeAccountId,
    getActiveTenantIdForSelected() ?? account?.tenantId,
  );

  /* ───────────────────────────────────────────────────────────────────
   * Probe state + per-probe loading flags + per-probe last-run
   * timestamp (rendered as a small "1 min ago" hint).
   * ─────────────────────────────────────────────────────────────────── */
  const [probes, setProbes] = React.useState<ProbeState>(EMPTY_PROBES);
  const [busy, setBusy] = React.useState<Record<ProbeKey, boolean>>({
    csp: false,
    mpn: false,
    legalBusiness: false,
    pal: false,
  });
  const [lastRunAt, setLastRunAt] = React.useState<
    Record<ProbeKey, number | null>
  >({
    csp: null,
    mpn: null,
    legalBusiness: null,
    pal: null,
  });

  /** Cached Partner Center token for the current account (best effort). */
  const acquirePcToken = React.useCallback(async (): Promise<{
    token: string | null;
    error?: ProbeResult<never>;
  }> => {
    if (!account) return { token: null };
    try {
      const tok = await getPartnerCenterTokenForAccount(
        account.homeAccountId,
        getActiveTenantIdForSelected() ?? account.tenantId,
      );
      return { token: tok };
    } catch (err) {
      // Token acquisition failure usually means "this tenant isn't a
      // CSP partner" (consent_required / unauthorized_client). Bake
      // the same failure into all three PC probes so the operator
      // sees a coherent answer without spamming the AAD endpoint.
      const msg = err instanceof Error ? err.message : String(err);
      const isAccessDenied =
        /consent_required|interaction_required|unauthorized_client|AADSTS65001|AADSTS70011|AADSTS50020|invalid_resource/i.test(
          msg,
        );
      const fail: ProbeResult<never> = {
        outcome: isAccessDenied ? "unauthorized" : "unknown",
        summary: isAccessDenied
          ? "Tenant cannot mint Partner Center tokens (not a CSP partner)"
          : "Partner Center token acquisition failed",
        detail: msg,
        data: null,
      };
      return { token: null, error: fail };
    }
  }, [account, getActiveTenantIdForSelected]);

  /**
   * Record a probe outcome in the audit log. Always writes — both pass
   * and fail are useful history. Distinct from the link/unlink
   * mutations which use their own `action` strings.
   */
  const recordProbeAudit = React.useCallback(
    (which: ProbeKey, result: ProbeResult, actorAccount: CandidateAccount) => {
      const status =
        result.outcome === "pass"
          ? ("success" as const)
          : ("failure" as const);
      const full = azureAccounts.find(
        (a) => a.homeAccountId === actorAccount.homeAccountId,
      );
      const activeTenantId = full
        ? resolveActiveTenantId(full)
        : actorAccount.tenantId;
      auditLog.record({
        actor: actorAccount.username,
        action: `probe_partner_center:${which}`,
        target: which === "pal" ? partnerIdRef.current.trim() || "(no id)" : "tenant",
        status,
        error: status === "failure" ? result.summary : undefined,
        details: {
          tenantId: activeTenantId,
          outcome: result.outcome,
          httpStatus: result.status,
          code: result.code,
        },
      });
    },
    [azureAccounts],
  );

  const runProbe = React.useCallback(
    async (which: ProbeKey, all = false) => {
      if (!account) return;
      const gen = accountGenRef.current;
      const actorAccount = account;
      // Safe-write — if the operator switched accounts while this probe
      // was in flight, drop the result silently.
      const safeSetProbes = (mut: (p: ProbeState) => ProbeState) => {
        if (accountGenRef.current !== gen) return;
        setProbes(mut);
        setLastRunAt((m) => ({ ...m, [which]: Date.now() }));
      };
      setBusy((b) => ({ ...b, [which]: true }));
      try {
        if (which === "pal") {
          const pid = partnerIdRef.current.trim();
          // PAL needs a known Partner ID. If we don't have one in
          // state, skip silently when called from "Run all"; surface
          // a non-fatal hint otherwise.
          if (!pid || !PARTNER_ID_RE.test(pid)) {
            if (!all) {
              safeSetProbes((p) => ({
                ...p,
                pal: {
                  outcome: "unknown",
                  summary:
                    "Enter a Partner ID (6–10 digits) and try again.",
                  data: null,
                },
              }));
            }
            return;
          }
          try {
            // Tenant arg omitted so we pick up the operator's current active
            // tenant (was pinning to actorAccount.tenantId / the account's
            // HOME tenant — pre-switch).
            const armToken = await getArmTokenForAccount(
              actorAccount.homeAccountId,
            );
            const r = await getPartnerAdminLink(pid, armToken);
            safeSetProbes((p) => ({ ...p, pal: r }));
            recordProbeAudit("pal", r, actorAccount);
          } catch (err) {
            // ARM token acquisition itself blew up (network /
            // interaction_required) — surface this rather than
            // silently swallowing.
            const msg = err instanceof Error ? err.message : String(err);
            const synthetic: ProbeResult<PartnerAdminLinkSummary> = {
              outcome: /interaction_required|consent_required|AADSTS/i.test(
                msg,
              )
                ? "unauthorized"
                : "unknown",
              summary: "ARM token acquisition failed",
              detail: msg,
              data: null,
            };
            safeSetProbes((p) => ({ ...p, pal: synthetic }));
            recordProbeAudit("pal", synthetic, actorAccount);
          }
          return;
        }

        const { token, error } = await acquirePcToken();
        if (!token) {
          // Mirror the same failure into the requested probe slot so
          // the UI surfaces a real answer rather than the spinner
          // hanging forever.
          const synthetic: ProbeResult = error ?? {
            outcome: "unknown",
            summary: "Partner Center token unavailable",
            data: null,
          };
          safeSetProbes((p) => ({ ...p, [which]: synthetic }));
          recordProbeAudit(which, synthetic, actorAccount);
          return;
        }
        try {
          // Await BEFORE entering the setState callback — `(p) => ...`
          // is a synchronous arrow function and `await` inside it is a
          // parse error.
          if (which === "csp") {
            const r = await probeCspAccess(token);
            safeSetProbes((p) => ({ ...p, csp: r }));
            recordProbeAudit("csp", r, actorAccount);
          } else if (which === "mpn") {
            const r = await probeMpnProfile(token);
            safeSetProbes((p) => ({ ...p, mpn: r }));
            recordProbeAudit("mpn", r, actorAccount);
          } else if (which === "legalBusiness") {
            const r = await probeLegalBusinessProfile(token);
            safeSetProbes((p) => ({ ...p, legalBusiness: r }));
            recordProbeAudit("legalBusiness", r, actorAccount);
          }
        } catch (err) {
          // The service-layer probes already trap errors into
          // ProbeResult, so a throw here is exceptional (likely a
          // programming error). Still — don't let it leak as an
          // un-handled rejection.
          const msg = err instanceof Error ? err.message : String(err);
          const synthetic: ProbeResult = {
            outcome: "unknown",
            summary: `${PROBE_LABEL[which]} threw unexpectedly`,
            detail: msg,
            data: null,
          };
          safeSetProbes((p) => ({ ...p, [which]: synthetic }));
          recordProbeAudit(which, synthetic, actorAccount);
        }
      } finally {
        // Always clear busy — even on stale-write — so a flipped
        // account doesn't leave a phantom spinner spinning.
        setBusy((b) => ({ ...b, [which]: false }));
      }
    },
    [account, acquirePcToken, recordProbeAudit],
  );

  /* ───────────────────────────────────────────────────────────────────
   * Partner Admin Link form + actions.
   *
   * partnerIdRef is read by callbacks (runProbe / runAllProbes) so they
   * always see the latest value without having to take partnerId as a
   * dep — important because otherwise the `useShortcut` registrations
   * below would re-bind every keystroke.
   * ─────────────────────────────────────────────────────────────────── */
  const [partnerId, setPartnerId] = usePersistedState<string>(
    PARTNER_ID_KEY,
    "",
    {
      // Keep the raw-string legacy shape (no envelope wrapping) so older
      // installs hydrate their last-typed Partner ID without a migration
      // pass — `localStorage.getItem` previously returned the raw value.
      deserialize: (raw) => raw,
      serialize: (v) => v,
    },
  );
  const partnerIdRef = React.useRef(partnerId);
  React.useEffect(() => {
    partnerIdRef.current = partnerId;
  }, [partnerId]);

  const handlePartnerIdChange = React.useCallback(
    (v: string) => setPartnerId(v),
    [setPartnerId],
  );
  const partnerIdValid = PARTNER_ID_RE.test(partnerId.trim());

  /* ───────────────────────────────────────────────────────────────────
   * Enhancement #1 — persisted "preferred MPN" filter.
   *
   * Operators in multi-tenant CSP estates spend most of their day staring
   * at the SAME partner's customers. Persisting the MPN id (independent
   * of the in-flight Partner ID field above) lets us:
   *   - highlight the matching tenant in the CSP customer sample
   *   - pre-populate the Partner ID input on first paint when empty
   *   - flag a "this isn't my partner" mismatch when the MPN probe
   *     comes back with a different mpnId
   *
   * Stored under its own key so toggling it doesn't churn the working
   * Partner ID typed into the link/unlink form.
   * ─────────────────────────────────────────────────────────────────── */
  const [preferredMpn, setPreferredMpn] = usePersistedState<string>(
    PREFERRED_MPN_KEY,
    "",
    {
      deserialize: (raw) => raw,
      serialize: (v) => v,
    },
  );
  const [mpnFilterOn, setMpnFilterOn] = usePersistedState<boolean>(
    `${PREFERRED_MPN_KEY}:on`,
    false,
  );

  const [linking, setLinking] = React.useState(false);
  const [pendingLink, setPendingLink] = React.useState(false);
  const [pendingUnlink, setPendingUnlink] = React.useState(false);
  const [unlinking, setUnlinking] = React.useState(false);

  const runAllProbes = React.useCallback(async () => {
    if (!account) return;
    const gen = accountGenRef.current;
    const actorAccount = account;
    setProbes(EMPTY_PROBES);
    // Acquire PC token once and reuse across the three PC probes —
    // avoids three sequential consent prompts on first run.
    setBusy({ csp: true, mpn: true, legalBusiness: true, pal: false });
    const { token, error } = await acquirePcToken();
    if (!token) {
      const synthetic = error ?? {
        outcome: "unknown" as const,
        summary: "Partner Center token unavailable",
        data: null,
      };
      // Stale-write guard.
      if (accountGenRef.current === gen) {
        setProbes({
          csp: synthetic,
          mpn: synthetic,
          legalBusiness: synthetic,
          pal: null,
        });
        const now = Date.now();
        setLastRunAt((m) => ({ ...m, csp: now, mpn: now, legalBusiness: now }));
        recordProbeAudit("csp", synthetic, actorAccount);
        recordProbeAudit("mpn", synthetic, actorAccount);
        recordProbeAudit("legalBusiness", synthetic, actorAccount);
      }
      setBusy({ csp: false, mpn: false, legalBusiness: false, pal: false });
      // Still run PAL if the operator entered a Partner ID — that path
      // uses an ARM token, not a PC token.
      const pid = partnerIdRef.current.trim();
      if (pid && PARTNER_ID_RE.test(pid)) {
        await runProbe("pal", true);
      }
      return;
    }
    const [csp, mpn, legalBusiness] = await Promise.all([
      probeCspAccess(token).catch((e) => ({
        outcome: "unknown" as const,
        summary: "CSP probe threw",
        detail: e instanceof Error ? e.message : String(e),
        data: null,
      })),
      probeMpnProfile(token).catch((e) => ({
        outcome: "unknown" as const,
        summary: "MPN probe threw",
        detail: e instanceof Error ? e.message : String(e),
        data: null,
      })),
      probeLegalBusinessProfile(token).catch((e) => ({
        outcome: "unknown" as const,
        summary: "Legal-business probe threw",
        detail: e instanceof Error ? e.message : String(e),
        data: null,
      })),
    ]);
    if (accountGenRef.current === gen) {
      setProbes((p) => ({ ...p, csp, mpn, legalBusiness }));
      const now = Date.now();
      setLastRunAt((m) => ({ ...m, csp: now, mpn: now, legalBusiness: now }));
      recordProbeAudit("csp", csp, actorAccount);
      recordProbeAudit("mpn", mpn, actorAccount);
      recordProbeAudit("legalBusiness", legalBusiness, actorAccount);
    }
    setBusy({ csp: false, mpn: false, legalBusiness: false, pal: false });
    // Run PAL after the others; it uses a separate ARM token and a
    // distinct user-supplied Partner ID.
    const pid = partnerIdRef.current.trim();
    if (pid && PARTNER_ID_RE.test(pid)) {
      await runProbe("pal", true);
    }
  }, [account, acquirePcToken, runProbe, recordProbeAudit]);

  /**
   * Re-run only probes whose previous outcome wasn't `pass`. Skips PAL
   * if there's no valid Partner ID. Cheap retry after fixing tenant /
   * consent.
   */
  const retryFailedProbes = React.useCallback(async () => {
    if (!account) return;
    const failedKeys = ALL_PROBES.filter((k) => {
      const r = probes[k];
      if (!r) return false;
      return r.outcome !== "pass";
    });
    if (failedKeys.length === 0) return;
    for (const k of failedKeys) {
      // Sequentially so we don't double-prompt for the PC token; the
      // service layer keeps no shared cache.
      await runProbe(k, true);
    }
  }, [account, probes, runProbe]);

  /* ───────────────────────────────────────────────────────────────────
   * Corpus-grounded extra probes — GDAP delegation creep + subscription-
   * level PAL drift. Both are off-by-default; the operator clicks "Run"
   * to fire them. See `partner-relationships-probe.ts` for the
   * implementation and `_bypass_tenant_switch.md` §6 for the rationale.
   * ─────────────────────────────────────────────────────────────────── */
  const [gdapProbe, setGdapProbe] =
    React.useState<ProbeResult<GdapDelegationSummary> | null>(null);
  const [gdapBusy, setGdapBusy] = React.useState(false);
  const [palDriftProbe, setPalDriftProbe] =
    React.useState<ProbeResult<PalDriftSummary> | null>(null);
  const [palDriftBusy, setPalDriftBusy] = React.useState(false);

  const runGdapProbe = React.useCallback(async () => {
    if (!account) return;
    const gen = accountGenRef.current;
    const actorAccount = account;
    setGdapBusy(true);
    try {
      const graphToken = await getGraphTokenForAccount(
        actorAccount.homeAccountId,
        getActiveTenantIdForSelected() ?? actorAccount.tenantId,
      );
      const r = await probeGdapDelegations(graphToken);
      if (accountGenRef.current !== gen) return;
      setGdapProbe(r);
      const status = r.outcome === "pass" ? "success" : "failure";
      auditLog.record({
        actor: actorAccount.username,
        action: "probe_partner_center:gdap",
        target: "tenantRelationships/delegatedAdminRelationships",
        status,
        error: status === "failure" ? r.summary : undefined,
        details: {
          tenantId:
            getActiveTenantIdForSelected() ?? actorAccount.tenantId,
          outcome: r.outcome,
          activeCount: r.data?.activeCount,
          highPrivActiveCount: r.data?.highPrivActiveCount,
          creep: r.data?.creep,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const synthetic: ProbeResult<GdapDelegationSummary> = {
        outcome: /interaction_required|consent_required|AADSTS/i.test(msg)
          ? "unauthorized"
          : "unknown",
        summary: "Graph token acquisition failed",
        detail: msg,
        data: null,
      };
      if (accountGenRef.current === gen) setGdapProbe(synthetic);
    } finally {
      setGdapBusy(false);
    }
  }, [account, getActiveTenantIdForSelected]);

  const runPalDriftProbe = React.useCallback(async () => {
    if (!account) return;
    const gen = accountGenRef.current;
    const actorAccount = account;
    setPalDriftBusy(true);
    try {
      const armToken = await getArmTokenForAccount(actorAccount.homeAccountId);
      const r = await probePalDrift(
        armToken,
        preferredMpn.trim() || null,
      );
      if (accountGenRef.current !== gen) return;
      setPalDriftProbe(r);
      const status = r.outcome === "pass" ? "success" : "failure";
      auditLog.record({
        actor: actorAccount.username,
        action: "probe_partner_center:pal_drift",
        target:
          preferredMpn.trim() ||
          "(no preferred mpn — no-PAL gaps only)",
        status,
        error: status === "failure" ? r.summary : undefined,
        details: {
          tenantId:
            getActiveTenantIdForSelected() ?? actorAccount.tenantId,
          outcome: r.outcome,
          mismatchCount: r.data?.mismatchCount,
          noPalCount: r.data?.noPalCount,
          totalSubscriptions: r.data?.totalSubscriptions,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const synthetic: ProbeResult<PalDriftSummary> = {
        outcome: /interaction_required|consent_required|AADSTS/i.test(msg)
          ? "unauthorized"
          : "unknown",
        summary: "ARM token acquisition failed",
        detail: msg,
        data: null,
      };
      if (accountGenRef.current === gen) setPalDriftProbe(synthetic);
    } finally {
      setPalDriftBusy(false);
    }
  }, [account, getActiveTenantIdForSelected, preferredMpn]);

  /* ───────────────────────────────────────────────────────────────────
   * Bulk customer probe. Walks the CSP customer sample (or all visible
   * customer IDs in `probes.csp.data.sample`) and probes each one in
   * sequence so we don't trip Partner Center's per-principal throttle.
   * Renders a progress bar; cancellable mid-sweep.
   * ─────────────────────────────────────────────────────────────────── */
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkDone, setBulkDone] = React.useState(0);
  const [bulkTotal, setBulkTotal] = React.useState(0);
  const [bulkRows, setBulkRows] = React.useState<CustomerMatrixRow[]>([]);
  const bulkAbortRef = React.useRef<AbortController | null>(null);

  /** Per-customer last-probe timestamps (per account, sessionStorage). */
  const customerLedgerKey = account
    ? `${CUSTOMER_PROBE_KEY}:${account.homeAccountId}`
    : CUSTOMER_PROBE_KEY;
  const [customerLedger, setCustomerLedger] = React.useState<CustomerProbeLedger>(
    () => loadCustomerLedger(customerLedgerKey),
  );
  // Rehydrate the ledger when the active account changes.
  React.useEffect(() => {
    setCustomerLedger(loadCustomerLedger(customerLedgerKey));
  }, [customerLedgerKey]);

  const runBulkCustomerProbe = React.useCallback(async () => {
    if (!account) return;
    const cspData =
      probes.csp?.outcome === "pass"
        ? (probes.csp.data as CspCustomerSummary | null | undefined) ?? null
        : null;
    const ids = cspData?.sample ?? [];
    if (ids.length === 0) return;
    const gen = accountGenRef.current;
    const actorAccount = account;
    const { token, error } = await acquirePcToken();
    if (!token) {
      store.addNotification({
        type: "error",
        message: error?.summary ?? "Partner Center token unavailable.",
      });
      return;
    }
    setBulkBusy(true);
    setBulkDone(0);
    setBulkTotal(ids.length);
    setBulkRows([]);
    const ctrl = new AbortController();
    bulkAbortRef.current = ctrl;
    try {
      const ledgerUpdate: CustomerProbeLedger = { ...customerLedger };
      const rows = await bulkProbeCustomers(ids, token, {
        signal: ctrl.signal,
        onProgress: (done, total, row) => {
          if (accountGenRef.current !== gen) return;
          setBulkDone(done);
          setBulkRows((prev) => [...prev, row]);
          ledgerUpdate[row.customerId] = Date.now();
        },
      });
      if (accountGenRef.current === gen) {
        saveCustomerLedger(customerLedgerKey, ledgerUpdate);
        setCustomerLedger(ledgerUpdate);
        const passCount = rows.filter((r) => r.outcome === "pass").length;
        auditLog.record({
          actor: actorAccount.username,
          action: "probe_partner_center:bulk_customers",
          target: `${rows.length} customers`,
          status: ctrl.signal.aborted
            ? "failure"
            : passCount > 0
              ? "success"
              : "failure",
          error: ctrl.signal.aborted ? "operator cancelled" : undefined,
          details: {
            tenantId:
              getActiveTenantIdForSelected() ?? actorAccount.tenantId,
            scanned: rows.length,
            passed: passCount,
          },
        });
      }
    } finally {
      bulkAbortRef.current = null;
      setBulkBusy(false);
    }
  }, [
    account,
    acquirePcToken,
    customerLedger,
    customerLedgerKey,
    getActiveTenantIdForSelected,
    probes.csp,
    store,
  ]);

  const cancelBulkProbe = React.useCallback(() => {
    bulkAbortRef.current?.abort();
  }, []);

  /* ───────────────────────────────────────────────────────────────────
   * Stale-customer (60d) view. Cross-references the most recent
   * customer ledger against the current CSP probe's sample — any
   * customer that's been seen in the sample but hasn't been probed in
   * 60 days bubbles up. The threshold is corpus-grounded: dormant MSP
   * relationships are the classic supply-chain pivot
   * (`_bypass_tenant_switch.md` §6.3).
   * ─────────────────────────────────────────────────────────────────── */
  const staleCustomers = React.useMemo(() => {
    const cspData =
      probes.csp?.outcome === "pass"
        ? (probes.csp.data as CspCustomerSummary | null | undefined) ?? null
        : null;
    const ids = cspData?.sample ?? [];
    if (ids.length === 0) return [];
    const now = Date.now();
    return ids
      .map((id) => ({
        id,
        lastProbedMs: customerLedger[id] ?? null,
      }))
      .filter(
        (e) =>
          e.lastProbedMs === null ||
          now - (e.lastProbedMs ?? 0) > STALE_CUSTOMER_MS,
      );
  }, [customerLedger, probes.csp]);

  /* ───────────────────────────────────────────────────────────────────
   * MPN-mismatch filter (chip). Extends wave-1 warning into an
   * "explicit, only-show-mismatched" filter. When on AND the MPN probe
   * has a `data.mpnId`, the page emphasises the mismatch warning.
   * ─────────────────────────────────────────────────────────────────── */
  const [showMismatchedOnly, setShowMismatchedOnly] = usePersistedState<boolean>(
    `${PREFERRED_MPN_KEY}:mismatched-only`,
    false,
  );

  const handleConfirmLink = React.useCallback(async () => {
    if (!account || !partnerIdValid) return;
    setPendingLink(false);
    setLinking(true);
    const gen = accountGenRef.current;
    const actorAccount = account;
    const fullActor = azureAccounts.find(
      (a) => a.homeAccountId === actorAccount.homeAccountId,
    );
    const activeTenantId = fullActor
      ? resolveActiveTenantId(fullActor)
      : actorAccount.tenantId;
    try {
      // Tenant arg omitted so we pick up the operator's current active
      // tenant (was pinning to actorAccount.tenantId / the account's HOME
      // tenant — pre-switch).
      const armToken = await getArmTokenForAccount(actorAccount.homeAccountId);
      await linkPartnerAdmin(partnerId.trim(), armToken);
      auditLog.record({
        actor: actorAccount.username,
        action: "link_partner_admin",
        target: partnerId.trim(),
        status: "success",
        details: { tenantId: activeTenantId },
      });
      store.addNotification({
        type: "success",
        message: `Partner ID ${partnerId.trim()} linked.`,
      });
      // Refresh the PAL probe so the operator sees confirmation —
      // but only if we're still on the same account.
      if (accountGenRef.current === gen) {
        await runProbe("pal");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditLog.record({
        actor: actorAccount.username,
        action: "link_partner_admin",
        target: partnerId.trim(),
        status: "failure",
        error: msg,
        details: { tenantId: activeTenantId },
      });
      store.addNotification({
        type: "error",
        message: `Link failed: ${msg}`,
      });
    } finally {
      setLinking(false);
    }
  }, [account, azureAccounts, partnerId, partnerIdValid, runProbe, store]);

  const handleConfirmUnlink = React.useCallback(async () => {
    if (!account || !partnerIdValid) return;
    setPendingUnlink(false);
    setUnlinking(true);
    const gen = accountGenRef.current;
    const actorAccount = account;
    const fullActor = azureAccounts.find(
      (a) => a.homeAccountId === actorAccount.homeAccountId,
    );
    const activeTenantId = fullActor
      ? resolveActiveTenantId(fullActor)
      : actorAccount.tenantId;
    try {
      // Tenant arg omitted so we pick up the operator's current active
      // tenant (was pinning to actorAccount.tenantId / the account's HOME
      // tenant — pre-switch).
      const armToken = await getArmTokenForAccount(actorAccount.homeAccountId);
      await unlinkPartnerAdmin(partnerId.trim(), armToken);
      auditLog.record({
        actor: actorAccount.username,
        action: "unlink_partner_admin",
        target: partnerId.trim(),
        status: "success",
        details: { tenantId: activeTenantId },
      });
      store.addNotification({
        type: "success",
        message: `Partner ID ${partnerId.trim()} unlinked.`,
      });
      if (accountGenRef.current === gen) {
        setProbes((p) => ({
          ...p,
          pal: {
            outcome: "fail",
            summary: `Partner ID ${partnerId.trim()} is not linked to this account`,
            status: 404,
            data: null,
          },
        }));
        setLastRunAt((m) => ({ ...m, pal: Date.now() }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditLog.record({
        actor: actorAccount.username,
        action: "unlink_partner_admin",
        target: partnerId.trim(),
        status: "failure",
        error: msg,
        details: { tenantId: activeTenantId },
      });
      store.addNotification({
        type: "error",
        message: `Unlink failed: ${msg}`,
      });
    } finally {
      setUnlinking(false);
    }
  }, [account, azureAccounts, partnerId, partnerIdValid, store]);

  /* ───────────────────────────────────────────────────────────────────
   * Probe-results export. Captures the four probe slots + their parsed
   * data, exporting one row per probe so the JSON / CSV files match
   * what the operator just saw on screen.
   *
   * Enhancement #3 — unified ExportMenu (CSV + JSON in one dropdown)
   * replaces the previous pair of inline buttons. The accessor callbacks
   * mirror what the on-screen badges show so a CSV opened in Excel and
   * the UI never disagree.
   * ─────────────────────────────────────────────────────────────────── */

  const exportRows: ExportRow[] = React.useMemo(() => {
    const now = Date.now();
    return ALL_PROBES.map((k) => {
      const r = probes[k];
      const ranAtMs = lastRunAt[k];
      return {
        probe: k,
        label: PROBE_LABEL[k],
        outcome: r ? outcomeAsText(r.outcome) : "Not run",
        summary: r?.summary ?? "",
        httpStatus: r?.status ?? null,
        errorCode: r?.code ?? null,
        detail: r?.detail ?? null,
        data: r?.data ?? null,
        ranAt: ranAtMs ? new Date(ranAtMs).toISOString() : null,
        stale: ranAtMs != null && now - ranAtMs > STALE_PROBE_MS,
      };
    });
  }, [probes, lastRunAt]);

  const exportColumns: ExportColumn<ExportRow>[] = React.useMemo(
    () => [
      { header: "Probe", accessor: (r) => r.probe },
      { header: "Label", accessor: (r) => r.label },
      { header: "Outcome", accessor: (r) => r.outcome },
      { header: "Summary", accessor: (r) => r.summary },
      { header: "HTTP status", accessor: (r) => r.httpStatus ?? "" },
      { header: "Error code", accessor: (r) => r.errorCode ?? "" },
      { header: "Ran at", accessor: (r) => r.ranAt ?? "" },
      { header: "Stale (>24h)", accessor: (r) => (r.stale ? "yes" : "") },
      { header: "Detail", accessor: (r) => r.detail ?? "" },
    ],
    [],
  );

  const exportMetadata: Record<string, unknown> = React.useMemo(
    () => ({
      tenantId: getActiveTenantIdForSelected() ?? account?.tenantId ?? null,
      account: account?.username ?? null,
      partnerId: partnerId.trim() || null,
      preferredMpn: preferredMpn.trim() || null,
    }),
    [account, getActiveTenantIdForSelected, partnerId, preferredMpn],
  );

  /* ───────────────────────────────────────────────────────────────────
   * Enhancement #5 — stale-probe detector.
   *
   * A probe that hasn't been re-run in >24h is no longer trustworthy for
   * partner-of-record / billing-attribution decisions. We surface a
   * small "Stale" pill on the row + a banner-level count, and the CSV
   * export carries a dedicated column so the operator can filter on it
   * downstream.
   * ─────────────────────────────────────────────────────────────────── */
  const staleCount = React.useMemo(
    () => exportRows.filter((r) => r.stale).length,
    [exportRows],
  );

  /* ───────────────────────────────────────────────────────────────────
   * Keyboard shortcuts (page-scoped, suppressed while typing in an
   * input). The shortcuts are intentionally light — operators tend to
   * be deep in a probe-then-fix loop, so anything that saves a click
   * pays off.
   * ─────────────────────────────────────────────────────────────────── */
  useShortcut("Mod+Enter", () => {
    if (!account) return;
    void runAllProbes();
  });
  useShortcut("Mod+l", () => {
    partnerIdInputRef.current?.focus();
    partnerIdInputRef.current?.select();
  });
  useShortcut("Mod+Shift+r", () => {
    if (!account) return;
    void retryFailedProbes();
  });
  // Bare-key shortcuts. These intentionally do NOT use Mod+ so they
  // mirror the bare-key conventions on similar list / probe pages.
  // Suppressed automatically while focus is inside an input (the
  // useShortcut hook handles that).
  //
  // NOTE: do NOT reference values declared after the early-return for
  // "no candidates" below — the handler closure would TDZ on those
  // when the keypress fires from a render that took the early return.
  // Compute "any failed/unauthorised/unknown" inline from `probes`.
  useShortcut("r", () => {
    if (!account) return;
    // `r` re-runs the failed probes if any, otherwise runs all four.
    // The "selected" intent (per spec) collapses to "the probes that
    // need running" — no row-selection UI exists.
    const hasFailures = ALL_PROBES.some((k) => {
      const r = probes[k];
      return r != null && r.outcome !== "pass";
    });
    if (hasFailures) {
      void retryFailedProbes();
    } else {
      void runAllProbes();
    }
  });
  useShortcut("/", () => {
    // `/` focuses the Partner ID input as the page's primary "search /
    // narrow" affordance — the input doubles as the PAL probe target
    // and the preferred-MPN seed.
    partnerIdInputRef.current?.focus();
    partnerIdInputRef.current?.select();
  });

  useTenantChange(undefined, (detail) => {
    const candidate = detail.homeAccountId;
    if (!candidates.some((c) => c.homeAccountId === candidate)) return;
    if (accountId === candidate) return;
    // Route through handleSelectAccount so the generation counter bumps
    // AND the probe state resets — otherwise an in-flight probe fired
    // against the previous account can land its result in the new
    // account's slot (the bare setAccountId path skipped both
    // accountGenRef++ and setProbes(EMPTY_PROBES)).
    handleSelectAccount(candidate);
  });

  /* ───────────────────────────────────────────────────────────────────
   * Render
   * ─────────────────────────────────────────────────────────────────── */
  if (candidates.length === 0) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <PageHeader
          title="Partner Center"
          description="Probe a signed-in account for CSP / MPN / Partner Admin Link capability."
        />
        <SignInRequired
          whatYouCantDo="Probe Partner Center capability"
          why="an Azure account whose tenant has CSP, MPN, or Partner Admin Link associations"
          onNavigate={(k) => navigateTo(k)}
        />
      </div>
    );
  }

  // Per-outcome counts for the summary strip — granular breakdown the
  // single "fail" column couldn't carry.
  const counts = ALL_PROBES.reduce(
    (acc, k) => {
      const r = probes[k];
      if (!r) acc.notRun += 1;
      else if (r.outcome === "pass") acc.pass += 1;
      else if (r.outcome === "unauthorized") acc.unauthorized += 1;
      else if (r.outcome === "fail") acc.fail += 1;
      else acc.unknown += 1;
      return acc;
    },
    { pass: 0, unauthorized: 0, fail: 0, unknown: 0, notRun: 0 },
  );
  const failOrUnauth = counts.fail + counts.unauthorized + counts.unknown;
  const ranCount = 4 - counts.notRun;
  const hasAnyResult = ranCount > 0;

  const anyBusy = busy.csp || busy.mpn || busy.legalBusiness || busy.pal;

  // True when at least one probe ran AND none of them passed — almost
  // always means "wrong tenant" or "needs Token Importer".
  const allFailed = hasAnyResult && counts.pass === 0;

  // Derived MPN match state — used by the preferred-MPN filter chip and
  // by the MPN probe row to flag "this isn't the partner you usually
  // operate as". Trimmed because operators paste with stray whitespace.
  const trimmedPreferredMpn = preferredMpn.trim();
  const observedMpnId =
    probes.mpn?.outcome === "pass"
      ? (probes.mpn.data as MpnProfileSummary | null | undefined)?.mpnId ?? ""
      : "";
  const mpnMismatch =
    mpnFilterOn &&
    !!trimmedPreferredMpn &&
    !!observedMpnId &&
    observedMpnId !== trimmedPreferredMpn;

  return (
    <div className="flex flex-col gap-4 py-4">
      <PageHeader
        title="Partner Center"
        description="Probe a signed-in account for CSP (Cloud Solution Provider) and MPN (Partner Network) capability, and manage Partner Admin Link."
      >
        <div className="flex items-center gap-2">
          <TokenExpiryBadge
            secondsUntilExpiry={armTokenTracker.secondsUntilExpiry}
            loading={armTokenTracker.loading}
            onRefresh={() => void armTokenTracker.refresh()}
            needsReauth={armTokenTracker.needsReauth}
            onReauth={() =>
              void armTokenTracker.reauth({
                loginHint: account?.username,
              })
            }
          />
          <KeyboardHintBadge />
          <Select value={accountId} onValueChange={handleSelectAccount}>
            <SelectTrigger
              className="h-8 w-72 text-xs"
              aria-label="Select account to probe"
            >
              <SelectValue placeholder="Select account" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((a) => (
                <SelectItem key={a.homeAccountId} value={a.homeAccountId}>
                  <span className="truncate">
                    {a.name || a.username}
                    <span className="ml-1 text-muted-foreground">
                      (
                      <code className="font-mono">
                        {truncateMiddle(a.tenantId)}
                      </code>
                      )
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
        <SummaryStatItem label="Probes run" value={`${ranCount}/4`} compact />
        <SummaryStatItem
          label="Pass"
          value={counts.pass}
          tone="success"
          compact
        />
        <SummaryStatItem
          label="Unauthorized"
          value={counts.unauthorized}
          tone={counts.unauthorized > 0 ? "warning" : "muted"}
          compact
        />
        <SummaryStatItem
          label="Fail"
          value={counts.fail}
          tone={counts.fail > 0 ? "destructive" : "muted"}
          compact
        />
        <SummaryStatItem
          label="Not run"
          value={counts.notRun}
          tone="muted"
          compact
        />
        <SummaryStatItem
          label="Stale (>24h)"
          value={staleCount}
          tone={staleCount > 0 ? "warning" : "muted"}
          hint={staleCount > 0 ? "re-run for fresh data" : undefined}
          compact
        />
        <div
          className="group/copy flex flex-col justify-center gap-0.5 rounded-md border border-border/60 bg-card/40 px-3 py-2"
          aria-label="Active tenant id"
        >
          <span className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
            Tenant
          </span>
          <div className="flex items-center gap-1">
            <code className="truncate font-mono text-xs text-foreground">
              {truncateMiddle(account?.tenantId ?? "", 8, 4) || "—"}
            </code>
            {account?.tenantId ? (
              <CopyButton
                value={account.tenantId}
                ariaLabel={`Copy tenant id ${account.tenantId}`}
              />
            ) : null}
          </div>
        </div>
      </div>

      {allFailed && (
        <Alert variant="warning" className="text-xs">
          <AlertTriangle className="h-3.5 w-3.5" />
          <AlertDescription>
            None of the probes passed for this account. The likely
            cause: <strong>{account?.username ?? "this account"}</strong>{" "}
            is signed in but the tenant{" "}
            <code className="font-mono">
              {truncateMiddle(account?.tenantId ?? "")}
            </code>{" "}
            isn't enrolled in CSP or MPN. Sign in with a partner-tenant
            identity, or use{" "}
            <strong>Token Importer</strong> to paste a Partner Center
            token from a working browser session.
          </AlertDescription>
        </Alert>
      )}

      {/* Enhancement #1 — persisted "preferred MPN" filter. The chip
          row toggles a soft filter that, when on, highlights the
          configured MPN id in the MPN probe row and warns when the
          observed MPN differs (likely wrong tenant). */}
      <div
        className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-2 text-2xs"
        role="region"
        aria-label="Preferred MPN filter"
      >
        <span className="font-semibold uppercase tracking-wider text-muted-foreground">
          Preferred MPN
        </span>
        <Input
          value={preferredMpn}
          onChange={(e) => setPreferredMpn(e.target.value)}
          placeholder="e.g. 1234567"
          inputMode="numeric"
          autoComplete="off"
          aria-label="Preferred MPN id (sticky filter)"
          className="h-7 w-32 font-mono text-xs"
        />
        <Button
          type="button"
          variant={mpnFilterOn ? "default" : "outline"}
          size="sm"
          className="h-7 px-2"
          aria-pressed={mpnFilterOn}
          onClick={() => setMpnFilterOn((on) => !on)}
          disabled={!trimmedPreferredMpn}
          title={
            !trimmedPreferredMpn
              ? "Enter an MPN id first"
              : mpnFilterOn
                ? "Disable preferred-MPN check"
                : "Highlight the configured MPN in probe results"
          }
        >
          {mpnFilterOn ? "Filter on" : "Filter off"}
        </Button>
        {trimmedPreferredMpn && partnerId.trim() !== trimmedPreferredMpn && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-3xs"
            onClick={() => handlePartnerIdChange(trimmedPreferredMpn)}
            aria-label="Use the preferred MPN as the working Partner ID"
          >
            Use as Partner ID
          </Button>
        )}
        <Button
          type="button"
          variant={showMismatchedOnly ? "default" : "outline"}
          size="sm"
          className="h-7 px-2 text-3xs"
          aria-pressed={showMismatchedOnly}
          onClick={() => setShowMismatchedOnly((v) => !v)}
          disabled={!mpnFilterOn || !trimmedPreferredMpn}
          title={
            !mpnFilterOn
              ? "Turn the preferred-MPN filter on first"
              : showMismatchedOnly
                ? "Stop emphasising mismatched MPNs"
                : "Emphasise customers / subs whose MPN ≠ preferred"
          }
        >
          Mismatched only
        </Button>
        {mpnMismatch && (
          <span className="ml-auto inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-medium text-warning">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            MPN mismatch: observed{" "}
            <code className="font-mono">{observedMpnId}</code>
            <CopyButton
              value={observedMpnId}
              alwaysVisible
              ariaLabel={`Copy observed MPN ${observedMpnId}`}
            />
          </span>
        )}
      </div>

      <Card className="border-border bg-card shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="h-4 w-4 text-primary" aria-hidden />
                Capability probes
              </CardTitle>
              <CardDescription className="mt-1">
                Fires non-mutating GETs against{" "}
                <code className="font-mono">
                  api.partnercenter.microsoft.com
                </code>{" "}
                and ARM{" "}
                <code className="font-mono">
                  Microsoft.ManagementPartner
                </code>
                . Outcomes are recorded to the audit log.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <ExportMenu<ExportRow>
                rows={exportRows}
                columns={exportColumns}
                filename="partner-center-probes"
                jsonMetadata={exportMetadata}
                disabled={!hasAnyResult}
                rowCount={ranCount}
                label="Export"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => void runAllProbes()}
              loading={anyBusy}
              disabled={!account}
              aria-label="Run all Partner Center probes"
              title={`Run all probes (${modKeyLabel()}+Enter)`}
            >
              {!anyBusy && <RotateCw className="h-3.5 w-3.5" />}
              Run all probes
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void retryFailedProbes()}
              disabled={!account || anyBusy || failOrUnauth === 0}
              aria-label="Re-run only the probes that did not pass"
              title={`Retry failed probes (${modKeyLabel()}+Shift+R)`}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry failed
              {failOrUnauth > 0 && (
                <Badge variant="outline" className="ml-1 text-3xs">
                  {failOrUnauth}
                </Badge>
              )}
            </Button>
            <span className="text-2xs text-muted-foreground">
              {account ? (
                <>
                  As{" "}
                  <span className="font-semibold">{account.username}</span> ·{" "}
                  tenant{" "}
                  <code className="font-mono">
                    {truncateMiddle(account.tenantId)}
                  </code>
                </>
              ) : (
                "Pick an account first."
              )}
            </span>
          </div>

          <ProbeRow
            label={PROBE_LABEL.csp}
            help="GET /v1/customers — confirms the signed-in account belongs to a Cloud Solution Provider partner tenant and has at least read access to the partner's customer list. A 401/403 here usually means the account is signed in but lacks CSP role assignment."
            icon={ShieldCheck}
            result={probes.csp}
            loading={busy.csp}
            onRun={() => void runProbe("csp")}
            disabled={!account}
            lastRunAt={lastRunAt.csp}
            stale={
              lastRunAt.csp != null &&
              Date.now() - lastRunAt.csp > STALE_PROBE_MS
            }
            renderExtra={(r) => {
              if (r.outcome !== "pass" || !r.data) return null;
              const data = r.data as CspCustomerSummary;
              if (data.totalCount === 0) return null;
              return (
                <div className="text-2xs text-muted-foreground">
                  Customers visible: <strong>{data.totalCount}</strong>
                  {data.sample.length > 0 && (
                    <span className="ml-1.5 opacity-80">
                      (sample:{" "}
                      {data.sample
                        .slice(0, 3)
                        .map((s) => truncateMiddle(s, 6, 4))
                        .join(", ")}
                      {data.sample.length > 3 ? "…" : ""})
                    </span>
                  )}
                </div>
              );
            }}
          />
          <ProbeRow
            label={PROBE_LABEL.mpn}
            help="GET /v1/profiles/mpn — returns the partner's MPN ID (also called Partner ID) and program membership. Required to create offers and earn incentives. The MPN ID returned here is what you'd paste into the Partner ID field below."
            icon={Handshake}
            result={probes.mpn}
            loading={busy.mpn}
            onRun={() => void runProbe("mpn")}
            disabled={!account}
            lastRunAt={lastRunAt.mpn}
            stale={
              lastRunAt.mpn != null &&
              Date.now() - lastRunAt.mpn > STALE_PROBE_MS
            }
            renderExtra={(r) => {
              if (r.outcome !== "pass" || !r.data) return null;
              const data = r.data as MpnProfileSummary;
              if (!data.mpnId) return null;
              const isPreferred =
                mpnFilterOn &&
                !!trimmedPreferredMpn &&
                data.mpnId === trimmedPreferredMpn;
              const isPreferredMismatch =
                mpnFilterOn &&
                !!trimmedPreferredMpn &&
                data.mpnId !== trimmedPreferredMpn;
              return (
                <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
                  <span>
                    Partner ID:{" "}
                    <CopyableText value={data.mpnId} mono alwaysVisibleButton />
                  </span>
                  {data.profileType && (
                    <Badge variant="outline" className="text-3xs">
                      {data.profileType}
                    </Badge>
                  )}
                  {isPreferred && (
                    <Badge variant="success" className="text-3xs">
                      preferred MPN ✓
                    </Badge>
                  )}
                  {isPreferredMismatch && (
                    <Badge variant="warning" className="text-3xs">
                      ≠ preferred {trimmedPreferredMpn}
                    </Badge>
                  )}
                  {data.mpnId !== partnerId.trim() && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-5 px-1.5 text-3xs"
                      onClick={() => handlePartnerIdChange(data.mpnId!)}
                      aria-label={`Use ${data.mpnId} as the Partner ID below`}
                    >
                      Use below
                    </Button>
                  )}
                </div>
              );
            }}
          />
          <ProbeRow
            label={PROBE_LABEL.legalBusiness}
            help="GET /v1/profiles/legalbusiness — proves the partner has cleared the business-verification gate. Often the first call that fails for partners mid-onboarding or in suspended state. Required for transacting in Partner Center."
            icon={ShieldAlert}
            result={probes.legalBusiness}
            loading={busy.legalBusiness}
            onRun={() => void runProbe("legalBusiness")}
            disabled={!account}
            lastRunAt={lastRunAt.legalBusiness}
            stale={
              lastRunAt.legalBusiness != null &&
              Date.now() - lastRunAt.legalBusiness > STALE_PROBE_MS
            }
            renderExtra={(r) => {
              if (r.outcome !== "pass" || !r.data) return null;
              const data = r.data as LegalBusinessProfileSummary;
              if (!data.companyName) return null;
              return (
                <div className="text-2xs text-muted-foreground">
                  Company: <strong>{data.companyName}</strong>
                </div>
              );
            }}
          />
          <ProbeRow
            label={PROBE_LABEL.pal}
            help="GET Microsoft.ManagementPartner/partners/{partnerId} — checks whether the Partner ID below is linked to this account, so Azure usage gets attributed back to the partner of record. Requires a valid 6–10 digit Partner ID in the form below."
            icon={Link2}
            result={probes.pal}
            loading={busy.pal}
            onRun={() => void runProbe("pal")}
            disabled={!account || !partnerIdValid}
            lastRunAt={lastRunAt.pal}
            stale={
              lastRunAt.pal != null &&
              Date.now() - lastRunAt.pal > STALE_PROBE_MS
            }
            requiredHint={
              !partnerIdValid
                ? "Enter a 6–10 digit Partner ID below to enable this probe."
                : undefined
            }
            renderExtra={(r) => {
              if (r.outcome !== "pass" || !r.data) return null;
              const data = r.data as PartnerAdminLinkSummary;
              return (
                <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
                  <span>
                    Linked:{" "}
                    <CopyableText
                      value={data.partnerId}
                      mono
                      alwaysVisibleButton
                    />
                  </span>
                  {data.createdTime && (
                    <span className="opacity-80">
                      since {new Date(data.createdTime).toLocaleString()}
                    </span>
                  )}
                </div>
              );
            }}
          />
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────────────────────────
          Corpus-grounded "partner-relationships" probes.

          - GDAP delegation creep — `/v1.0/tenantRelationships/
            delegatedAdminRelationships`. The corpus playbook
            (_bypass_tenant_switch.md §6.2) flags this as the canonical
            MSP-pivot vector: a high or skewed delegation set means the
            operator's tenant carries significant downstream blast
            radius if compromised. Surfaces active count, high-priv
            count, expiring-soon count, and a creep heuristic.

          - Subscription PAL drift — pulls accessible subscriptions and
            reads the subscription-scoped
            `Microsoft.ManagementPartner/partners` collection per sub.
            Cross-references against the preferred MPN to surface
            mismatches (third-party partner of record) and gaps
            (no-PAL). The corpus (§6.3) calls out PAL stale-relationship
            checks as a "looks routine but isn't" defender finding.
          ───────────────────────────────────────────────────────────── */}
      <Card className="border-border bg-card shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Radar className="h-4 w-4 text-primary" aria-hidden />
            Partner-relationships probes
            <InfoTooltip content="Defensive probes derived from the MSP-pivot corpus. They reveal how much downstream surface the operator's tenant carries via GDAP delegations, and whether subscriptions in this tenant are stamped with an unexpected (or no) partner-of-record." />
          </CardTitle>
          <CardDescription>
            Catches the two MSP / GDAP / PAL drift signals that don't
            show up in the per-capability probes above. Cite:{" "}
            <code className="font-mono">_bypass_tenant_switch.md</code>{" "}
            §6 (Lighthouse-GDAP, MSP supply-chain).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {/* GDAP delegation creep row */}
          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-base p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Network
                className="h-3.5 w-3.5 text-muted-foreground"
                aria-hidden
              />
              <span className="text-xs font-semibold text-foreground">
                GDAP delegations (partner side)
              </span>
              <InfoTooltip content="Lists every customer tenant this tenant has a delegated-admin relationship with (active or terminated), and the directory roles delegated. Corpus: defenders rarely audit GDAP delegations because they're invisible in the customer's role list." />
              <Badge
                variant={
                  gdapProbe?.outcome === "pass"
                    ? gdapProbe.data?.creep
                      ? "warning"
                      : "success"
                    : gdapProbe?.outcome === "unauthorized"
                      ? "warning"
                      : gdapProbe?.outcome === "fail" ||
                          gdapProbe?.outcome === "unknown"
                        ? "destructive"
                        : "outline"
                }
                className="ml-auto text-2xs"
              >
                {gdapBusy ? (
                  <span className="flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                    Running
                  </span>
                ) : gdapProbe ? (
                  gdapProbe.outcome === "pass"
                    ? gdapProbe.data?.creep
                      ? "Creep"
                      : "Pass"
                    : outcomeBadge(gdapProbe.outcome).label
                ) : (
                  "Not run"
                )}
              </Badge>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-2xs"
                onClick={() => void runGdapProbe()}
                loading={gdapBusy}
                disabled={!account}
                aria-label={
                  gdapProbe ? "Re-run GDAP probe" : "Run GDAP probe"
                }
              >
                {gdapProbe ? "Re-run" : "Run"}
              </Button>
            </div>
            {gdapProbe?.outcome === "pass" && gdapProbe.data && (
              <div className="flex flex-col gap-1.5">
                <div className="grid grid-cols-2 gap-2 text-2xs sm:grid-cols-4">
                  <span className="rounded border border-border/60 bg-card/40 px-2 py-1">
                    <span className="block text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Active
                    </span>
                    <span className="font-mono">
                      {gdapProbe.data.activeCount}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "rounded border border-border/60 bg-card/40 px-2 py-1",
                      gdapProbe.data.highPrivActiveCount > 0 &&
                        "border-destructive/40 bg-destructive/10",
                    )}
                  >
                    <span className="block text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                      High-priv active
                    </span>
                    <span className="font-mono">
                      {gdapProbe.data.highPrivActiveCount}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "rounded border border-border/60 bg-card/40 px-2 py-1",
                      gdapProbe.data.expiringSoonCount > 0 &&
                        "border-warning/40 bg-warning/10",
                    )}
                  >
                    <span className="block text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Expiring &lt;30d
                    </span>
                    <span className="font-mono">
                      {gdapProbe.data.expiringSoonCount}
                    </span>
                  </span>
                  <span className="rounded border border-border/60 bg-card/40 px-2 py-1">
                    <span className="block text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Total
                    </span>
                    <span className="font-mono">
                      {gdapProbe.data.totalCount}
                    </span>
                  </span>
                </div>
                {gdapProbe.data.creep && (
                  <Alert variant="warning" className="text-2xs">
                    <AlertTriangle className="h-3 w-3" />
                    <AlertDescription>
                      Delegation creep detected. This tenant holds
                      delegated-admin authority over a large or
                      privilege-heavy customer set — supply-chain risk
                      if any operator account is compromised.
                    </AlertDescription>
                  </Alert>
                )}
                {gdapProbe.data.sample.length > 0 && (
                  <details className="text-2xs">
                    <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                      Show first {gdapProbe.data.sample.length} delegation
                      {gdapProbe.data.sample.length === 1 ? "" : "s"}
                    </summary>
                    <div className="mt-1 flex flex-col gap-1">
                      {gdapProbe.data.sample.map((d: GdapDelegation) => (
                        <div
                          key={d.id}
                          className={cn(
                            "group/copy flex flex-wrap items-center gap-1.5 rounded border border-border/60 bg-card/40 px-2 py-1",
                            d.highPriv && "border-destructive/40",
                          )}
                        >
                          <span className="font-semibold">
                            {d.customerDisplayName || d.displayName}
                          </span>
                          {d.customerTenantId && (
                            <CopyableText
                              value={d.customerTenantId}
                              mono
                              display={
                                <code className="font-mono">
                                  {truncateMiddle(d.customerTenantId, 6, 4)}
                                </code>
                              }
                              ariaLabel={`Copy customer tenant id ${d.customerTenantId}`}
                              alwaysVisibleButton
                            />
                          )}
                          <Badge
                            variant={
                              d.status === "active" ? "outline" : "secondary"
                            }
                            className="text-3xs"
                          >
                            {d.status}
                          </Badge>
                          {d.roleNames.length > 0 && (
                            <span className="ml-auto text-3xs text-muted-foreground">
                              {d.roleNames.slice(0, 3).join(", ")}
                              {d.roleNames.length > 3 ? "…" : ""}
                            </span>
                          )}
                          {d.highPriv && (
                            <Badge
                              variant="destructive"
                              className="text-3xs"
                            >
                              Tier-0
                            </Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
            {gdapProbe &&
              gdapProbe.outcome !== "pass" &&
              gdapProbe.summary && (
                <div className="text-2xs text-muted-foreground">
                  {gdapProbe.summary}
                  {gdapProbe.detail && (
                    <span className="ml-1 opacity-70">
                      · {gdapProbe.detail.slice(0, 160)}
                    </span>
                  )}
                </div>
              )}
          </div>

          {/* Subscription PAL drift row */}
          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-base p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Link2
                className="h-3.5 w-3.5 text-muted-foreground"
                aria-hidden
              />
              <span className="text-xs font-semibold text-foreground">
                Subscription PAL drift
              </span>
              <InfoTooltip content="Walks accessible subscriptions and checks the per-subscription Partner Admin Link stamp. Subscriptions whose PAL partnerId ≠ the configured preferred MPN are surfaced as drift; no-PAL subs are surfaced as revenue-attribution gaps." />
              <Badge
                variant={
                  palDriftProbe?.outcome === "pass"
                    ? palDriftProbe.data?.mismatchCount &&
                      palDriftProbe.data.mismatchCount > 0
                      ? "warning"
                      : "success"
                    : palDriftProbe?.outcome === "unauthorized"
                      ? "warning"
                      : palDriftProbe?.outcome === "fail" ||
                          palDriftProbe?.outcome === "unknown"
                        ? "destructive"
                        : "outline"
                }
                className="ml-auto text-2xs"
              >
                {palDriftBusy ? (
                  <span className="flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                    Running
                  </span>
                ) : palDriftProbe ? (
                  outcomeBadge(palDriftProbe.outcome).label
                ) : (
                  "Not run"
                )}
              </Badge>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-2xs"
                onClick={() => void runPalDriftProbe()}
                loading={palDriftBusy}
                disabled={!account}
                aria-label={
                  palDriftProbe
                    ? "Re-run PAL drift probe"
                    : "Run PAL drift probe"
                }
              >
                {palDriftProbe ? "Re-run" : "Run"}
              </Button>
            </div>
            {palDriftProbe?.outcome === "pass" && palDriftProbe.data && (
              <div className="flex flex-col gap-1.5">
                <div className="grid grid-cols-3 gap-2 text-2xs">
                  <span className="rounded border border-border/60 bg-card/40 px-2 py-1">
                    <span className="block text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Scanned
                    </span>
                    <span className="font-mono">
                      {palDriftProbe.data.totalSubscriptions}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "rounded border border-border/60 bg-card/40 px-2 py-1",
                      palDriftProbe.data.mismatchCount > 0 &&
                        "border-warning/40 bg-warning/10",
                    )}
                  >
                    <span className="block text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Mismatched
                    </span>
                    <span className="font-mono">
                      {palDriftProbe.data.mismatchCount}
                    </span>
                  </span>
                  <span className="rounded border border-border/60 bg-card/40 px-2 py-1">
                    <span className="block text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                      No-PAL
                    </span>
                    <span className="font-mono">
                      {palDriftProbe.data.noPalCount}
                    </span>
                  </span>
                </div>
                {!trimmedPreferredMpn && (
                  <div className="text-3xs text-muted-foreground">
                    Set a preferred MPN above to enable the mismatch
                    check; without one only no-PAL subs are flagged.
                  </div>
                )}
                {palDriftProbe.data.rows.length > 0 && (
                  <details className="text-2xs">
                    <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                      Show {palDriftProbe.data.rows.length} subscription
                      {palDriftProbe.data.rows.length === 1 ? "" : "s"}
                    </summary>
                    <div className="mt-1 flex flex-col gap-1">
                      {palDriftProbe.data.rows
                        .filter((r: SubscriptionPalRow) =>
                          showMismatchedOnly
                            ? r.mismatch
                            : true,
                        )
                        .map((r: SubscriptionPalRow) => (
                          <div
                            key={r.subscriptionId}
                            className={cn(
                              "group/copy flex flex-wrap items-center gap-1.5 rounded border border-border/60 bg-card/40 px-2 py-1",
                              r.mismatch && "border-warning/40",
                              r.noPal && "border-destructive/30",
                            )}
                          >
                            <span className="font-semibold">
                              {r.displayName}
                            </span>
                            <CopyableText
                              value={r.subscriptionId}
                              mono
                              display={
                                <code className="font-mono">
                                  {truncateMiddle(r.subscriptionId, 6, 4)}
                                </code>
                              }
                              ariaLabel={`Copy subscription id ${r.subscriptionId}`}
                              alwaysVisibleButton
                            />
                            <Badge variant="outline" className="text-3xs">
                              {r.state}
                            </Badge>
                            {r.palPartnerId ? (
                              <span className="ml-auto inline-flex items-center gap-1 text-3xs text-muted-foreground">
                                PAL:{" "}
                                <CopyableText
                                  value={r.palPartnerId}
                                  mono
                                  alwaysVisibleButton
                                />
                              </span>
                            ) : (
                              <span className="ml-auto text-3xs text-destructive">
                                no PAL
                              </span>
                            )}
                            {r.mismatch && (
                              <Badge variant="warning" className="text-3xs">
                                ≠ preferred
                              </Badge>
                            )}
                          </div>
                        ))}
                    </div>
                  </details>
                )}
              </div>
            )}
            {palDriftProbe &&
              palDriftProbe.outcome !== "pass" &&
              palDriftProbe.summary && (
                <div className="text-2xs text-muted-foreground">
                  {palDriftProbe.summary}
                  {palDriftProbe.detail && (
                    <span className="ml-1 opacity-70">
                      · {palDriftProbe.detail.slice(0, 160)}
                    </span>
                  )}
                </div>
              )}
          </div>
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────────────────────────
          Bulk CSP-customer probe + 60d stale-customer panel.

          The CSP probe above samples up to 5 customer ids. This panel
          drives a per-customer sweep over the whole sample (rate-limited
          one-at-a-time so we don't tip Partner Center's throttle) and
          stamps each customer's last-probe timestamp into the session
          ledger. The 60d threshold mirrors the corpus' "dormant MSP
          relationship" guidance — anything we haven't touched in two
          months is the first place to look during an audit.
          ───────────────────────────────────────────────────────────── */}
      {probes.csp?.outcome === "pass" &&
        (probes.csp.data as CspCustomerSummary | null | undefined)
          ?.sample &&
        ((probes.csp.data as CspCustomerSummary).sample.length > 0) && (
          <Card className="border-border bg-card shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Users className="h-4 w-4 text-primary" aria-hidden />
                CSP customer sweep
                <InfoTooltip content="Iterates the CSP customer sample one-by-one (rate-limited) and stamps each customer's last-probe time. The 60-day staleness panel flags customers in a dormant MSP relationship — the classic supply-chain pivot per _bypass_tenant_switch.md §6.3." />
              </CardTitle>
              <CardDescription>
                Walks the CSP customer sample so the operator can
                audit relationship health without leaving the page.
                Stale (&gt;60d unprobed) customers are flagged
                separately.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={() => void runBulkCustomerProbe()}
                  loading={bulkBusy}
                  disabled={!account || bulkBusy}
                  aria-label="Probe each CSP customer in sequence"
                >
                  <Search className="h-3.5 w-3.5" />
                  Probe all customers
                </Button>
                {bulkBusy && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={cancelBulkProbe}
                    aria-label="Stop bulk customer probe"
                  >
                    <StopCircle className="h-3.5 w-3.5" />
                    Stop
                  </Button>
                )}
                {bulkTotal > 0 && (
                  <span className="text-2xs text-muted-foreground">
                    {bulkDone} / {bulkTotal}
                    {bulkRows.length > 0 &&
                      ` · ${bulkRows.filter((r) => r.outcome === "pass").length} ok`}
                  </span>
                )}
              </div>
              {bulkBusy && bulkTotal > 0 && (
                <Progress
                  value={Math.round((bulkDone / bulkTotal) * 100)}
                  aria-label="Bulk customer probe progress"
                />
              )}
              {bulkRows.length > 0 && (
                <ExportMenu<CustomerMatrixRow>
                  rows={bulkRows}
                  columns={[
                    { header: "Customer ID", accessor: (r) => r.customerId },
                    {
                      header: "Company",
                      accessor: (r) => r.companyName ?? "",
                    },
                    { header: "Domain", accessor: (r) => r.domain ?? "" },
                    { header: "Outcome", accessor: (r) => r.outcome },
                    { header: "Error", accessor: (r) => r.error ?? "" },
                  ]}
                  filename="partner-center-customer-matrix"
                  jsonMetadata={{
                    tenantId:
                      getActiveTenantIdForSelected() ??
                      account?.tenantId ??
                      null,
                    preferredMpn: trimmedPreferredMpn || null,
                    scannedAt: new Date().toISOString(),
                  }}
                  rowCount={bulkRows.length}
                  label="Export matrix"
                />
              )}
              {bulkRows.length > 0 && (
                <details className="text-2xs">
                  <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                    Show {bulkRows.length} customer
                    {bulkRows.length === 1 ? "" : "s"}
                  </summary>
                  <div className="mt-1 flex flex-col gap-1">
                    {bulkRows.map((r) => (
                      <div
                        key={r.customerId}
                        className={cn(
                          "group/copy flex flex-wrap items-center gap-1.5 rounded border border-border/60 bg-card/40 px-2 py-1",
                          r.outcome === "fail" && "border-destructive/30",
                          r.outcome === "unauthorized" && "border-warning/40",
                        )}
                      >
                        <span className="font-semibold">
                          {r.companyName || "(unknown)"}
                        </span>
                        <CopyableText
                          value={r.customerId}
                          mono
                          display={
                            <code className="font-mono">
                              {truncateMiddle(r.customerId, 6, 4)}
                            </code>
                          }
                          ariaLabel={`Copy customer id ${r.customerId}`}
                          alwaysVisibleButton
                        />
                        {r.domain && (
                          <span className="text-3xs text-muted-foreground">
                            {r.domain}
                          </span>
                        )}
                        <Badge
                          variant={
                            r.outcome === "pass"
                              ? "success"
                              : r.outcome === "unauthorized"
                                ? "warning"
                                : r.outcome === "fail"
                                  ? "destructive"
                                  : "outline"
                          }
                          className="ml-auto text-3xs"
                        >
                          {r.outcome}
                        </Badge>
                        {r.error && (
                          <span className="text-3xs text-destructive">
                            {r.error}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {staleCustomers.length > 0 && (
                <div className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-2xs">
                  <div className="flex items-center gap-1.5 font-semibold text-warning">
                    <Clock className="h-3 w-3" aria-hidden />
                    {staleCustomers.length} customer
                    {staleCustomers.length === 1 ? " has" : "s have"} not
                    been probed in &gt;60d
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {staleCustomers.slice(0, 10).map((e) => (
                      <span
                        key={e.id}
                        className="group/copy inline-flex items-center gap-1 rounded border border-warning/40 bg-card/40 px-1.5 py-0.5"
                      >
                        <code className="font-mono">
                          {truncateMiddle(e.id, 6, 4)}
                        </code>
                        <CopyButton
                          value={e.id}
                          ariaLabel={`Copy customer id ${e.id}`}
                        />
                        <span className="text-3xs text-muted-foreground">
                          {e.lastProbedMs
                            ? new Date(e.lastProbedMs).toLocaleDateString()
                            : "never"}
                        </span>
                      </span>
                    ))}
                    {staleCustomers.length > 10 && (
                      <span className="text-3xs text-muted-foreground">
                        +{staleCustomers.length - 10} more
                      </span>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

      <Card className="border-border bg-card shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Link2 className="h-4 w-4 text-primary" aria-hidden />
            Partner Admin Link
            <InfoTooltip content="PAL associates an Azure account with a Microsoft partner (by Partner ID / MPN ID) so the partner gets credit for the customer's Azure consumption. Linking is per-account and idempotent." />
          </CardTitle>
          <CardDescription>
            Link / unlink the Partner ID for the selected account. PUT
            is idempotent — re-linking the same Partner ID has no
            effect. Both actions are confirmed and audited.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor="partner-id"
              className="flex items-center gap-1 text-xs"
            >
              Partner ID (MPN ID, 6–10 digits)
              <InfoTooltip content="The numeric MPN / Partner ID issued to your partner organisation by Microsoft. You can read it from the MPN profile probe above, or look it up in Partner Center under Account settings → Identifiers." />
            </Label>
            <div className="group/copy flex items-center gap-1.5">
              <Input
                id="partner-id"
                ref={partnerIdInputRef}
                value={partnerId}
                onChange={(e) => handlePartnerIdChange(e.target.value)}
                placeholder="e.g. 1234567"
                inputMode="numeric"
                autoComplete="off"
                aria-label="Partner ID"
                aria-invalid={
                  partnerId.trim().length > 0 && !partnerIdValid
                    ? true
                    : undefined
                }
                className={cn(
                  "max-w-xs font-mono text-sm",
                  partnerId.trim().length > 0 &&
                    !partnerIdValid &&
                    "border-destructive/60 focus-visible:ring-destructive",
                )}
              />
              {partnerId.trim().length > 0 && (
                <CopyButton
                  value={partnerId.trim()}
                  alwaysVisible
                  ariaLabel={`Copy Partner ID ${partnerId.trim()}`}
                />
              )}
              <span className="text-3xs text-muted-foreground">
                ({modKeyLabel()}+L)
              </span>
            </div>
            {!partnerIdValid && partnerId.trim().length > 0 && (
              <span className="text-2xs text-destructive">
                Partner ID must be 6–10 digits.
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => setPendingLink(true)}
              loading={linking}
              disabled={!account || !partnerIdValid || unlinking}
              aria-label="Link Partner ID to this account"
            >
              {!linking && <Link2 className="h-3.5 w-3.5" />}
              Link Partner ID
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPendingUnlink(true)}
              loading={unlinking}
              disabled={!account || !partnerIdValid || linking}
              aria-label="Unlink Partner ID from this account"
            >
              {!unlinking && <Link2Off className="h-3.5 w-3.5" />}
              Unlink
            </Button>
            <Button type="button" variant="outline" size="sm" asChild>
              <a
                href="https://partner.microsoft.com/dashboard"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open Microsoft Partner Center dashboard in a new tab"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open Partner Center
              </a>
            </Button>
          </div>
          {probes.pal?.outcome === "pass" && probes.pal.data && (
            <Alert variant="success" className="text-xs">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <AlertDescription>
                Linked:{" "}
                <CopyableText
                  value={probes.pal.data.partnerId}
                  mono
                  alwaysVisibleButton
                />
                {probes.pal.data.createdTime && (
                  <span className="ml-2 text-2xs text-muted-foreground">
                    since{" "}
                    {new Date(probes.pal.data.createdTime).toLocaleString()}
                  </span>
                )}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <ConfirmationDialog
        hidden={!pendingLink}
        title="Link Partner Admin?"
        message={
          <span>
            Link Partner ID{" "}
            <strong className="font-mono">{partnerId.trim()}</strong> to{" "}
            <strong>{account?.username ?? "this account"}</strong>. Azure
            consumption against this signed-in identity will be
            attributed to the partner of record. This action is
            idempotent and audited.
          </span>
        }
        confirmText="Link"
        loading={linking}
        onConfirm={() => void handleConfirmLink()}
        onCancel={() => setPendingLink(false)}
      />

      <ConfirmationDialog
        hidden={!pendingUnlink}
        title="Unlink Partner Admin?"
        message={
          <span>
            Remove the PAL linking Partner ID{" "}
            <strong className="font-mono">{partnerId.trim()}</strong> from{" "}
            <strong>{account?.username ?? "this account"}</strong>. Azure
            consumption will no longer be attributed to this partner.
          </span>
        }
        confirmText="Unlink"
        danger
        loading={unlinking}
        onConfirm={() => void handleConfirmUnlink()}
        onCancel={() => setPendingUnlink(false)}
      />
    </div>
  );
};

/* ─────────────────────────────────────────────────────────────────────
 * Per-probe row
 * ───────────────────────────────────────────────────────────────────── */

interface ProbeRowProps {
  label: string;
  help: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  result: ProbeResult | null;
  loading: boolean;
  onRun: () => void;
  disabled: boolean;
  lastRunAt: number | null;
  /** Optional secondary hint shown when `disabled` is true (e.g. PAL needs an id). */
  requiredHint?: string;
  /**
   * When true, the row renders a "Stale" pill — the probe answer is older
   * than `STALE_PROBE_MS` and likely needs re-running before the operator
   * makes an attribution decision.
   */
  stale?: boolean;
  /** Optional render extension: per-probe extra info on pass (counts, etc.). */
  renderExtra?: (result: ProbeResult) => React.ReactNode;
}

const ProbeRow: React.FC<ProbeRowProps> = ({
  label,
  help,
  icon: Icon,
  result,
  loading,
  onRun,
  disabled,
  lastRunAt,
  requiredHint,
  stale = false,
  renderExtra,
}) => {
  const badge = outcomeBadge(result?.outcome);
  const [showDetail, setShowDetail] = React.useState(false);
  const hasDetail = !!(result?.detail || result?.data || result?.code);

  // Tick once a minute so "Xs/Xm ago" stays fresh without a render
  // storm.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!lastRunAt) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, [lastRunAt]);

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border border-border bg-surface-base p-2.5",
        result?.outcome === "pass" && "border-success/40",
        result?.outcome === "unauthorized" && "border-warning/40",
        (result?.outcome === "fail" || result?.outcome === "unknown") &&
          "border-destructive/30",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <span className="text-xs font-semibold text-foreground">{label}</span>
        <InfoTooltip content={help} />
        {lastRunAt && (
          <span
            className="text-3xs text-muted-foreground/80"
            title={new Date(lastRunAt).toLocaleString()}
          >
            ran {formatRelative(lastRunAt)}
          </span>
        )}
        {stale && (
          <span
            className="inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1 py-0.5 text-3xs font-medium text-warning"
            title="Probe result is older than 24h — re-run for fresh data"
          >
            <Clock className="h-2.5 w-2.5" aria-hidden />
            Stale
          </span>
        )}
        <Badge variant={badge.variant} className="ml-auto text-2xs">
          {loading ? (
            <span className="flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
              Running
            </span>
          ) : (
            badge.label
          )}
        </Badge>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-2xs"
          onClick={onRun}
          loading={loading}
          disabled={disabled}
          aria-label={
            result ? `Re-run ${label} probe` : `Run ${label} probe`
          }
          title={result ? "Re-run probe" : "Run probe"}
        >
          {result ? "Re-run" : "Run"}
        </Button>
      </div>
      {!result && disabled && requiredHint && (
        <div className="text-2xs text-muted-foreground/80">{requiredHint}</div>
      )}
      {result && (
        <div className="flex items-start gap-1.5 text-2xs text-muted-foreground">
          {result.outcome === "pass" ? (
            <CheckCircle2
              className="mt-0.5 h-3 w-3 shrink-0 text-success"
              aria-hidden
            />
          ) : result.outcome === "unauthorized" ? (
            <ShieldAlert
              className="mt-0.5 h-3 w-3 shrink-0 text-warning"
              aria-hidden
            />
          ) : (
            <XCircle
              className="mt-0.5 h-3 w-3 shrink-0 text-destructive"
              aria-hidden
            />
          )}
          <span className="min-w-0 break-words">
            {result.summary}
            {result.status != null && (
              <span className="ml-1 opacity-70">(HTTP {result.status})</span>
            )}
            {result.code && (
              <span className="ml-1 opacity-70">
                · <code className="font-mono">{result.code}</code>
              </span>
            )}
          </span>
        </div>
      )}
      {result && renderExtra && renderExtra(result)}
      {result && hasDetail && (
        <details
          open={showDetail}
          onToggle={(e) =>
            setShowDetail((e.target as HTMLDetailsElement).open)
          }
          className="text-2xs"
        >
          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
            {showDetail ? "Hide raw response" : "Show raw response"}
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded border border-border/60 bg-muted/30 p-1.5 font-mono text-[10px] text-foreground">
            {safeStringify(
              result.data ?? { detail: result.detail, code: result.code },
            )}
          </pre>
        </details>
      )}
      {result?.outcome === "unauthorized" && (
        <Alert variant="warning" className="text-2xs">
          <AlertTriangle className="h-3 w-3" />
          <AlertDescription>
            The signed-in account can't reach this endpoint. For Partner
            Center probes, the tenant typically isn't enrolled in CSP or
            MPN — sign in with a partner-tenant account, or pivot to
            <strong> Token Importer</strong> to paste a Partner Center
            token from another browser session.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
};

/**
 * Compact keyboard-shortcut hint pill rendered in the page header.
 * Hover for the full key list.
 */
const KeyboardHintBadge: React.FC = () => {
  const mod = modKeyLabel();
  return (
    <InfoTooltip
      ariaLabel="Keyboard shortcuts"
      variant="help"
      side="bottom"
      align="end"
      content={
        <div className="flex flex-col gap-1 text-xs">
          <p className="m-0 font-semibold">Keyboard shortcuts</p>
          <ul className="m-0 list-none space-y-0.5 p-0">
            <li>
              <kbd className="rounded border px-1 py-0.5 text-3xs">
                {mod}+Enter
              </kbd>{" "}
              Run all probes
            </li>
            <li>
              <kbd className="rounded border px-1 py-0.5 text-3xs">
                {mod}+Shift+R
              </kbd>{" "}
              Retry failed probes
            </li>
            <li>
              <kbd className="rounded border px-1 py-0.5 text-3xs">
                {mod}+L
              </kbd>{" "}
              Focus Partner ID input
            </li>
            <li>
              <kbd className="rounded border px-1 py-0.5 text-3xs">r</kbd>{" "}
              Run / re-run probes (retry-failed first)
            </li>
            <li>
              <kbd className="rounded border px-1 py-0.5 text-3xs">/</kbd>{" "}
              Focus Partner ID (search)
            </li>
          </ul>
        </div>
      }
      className="h-7 w-7 rounded-md border border-border/60 bg-card/60 hover:bg-accent/30"
    />
  );
};

/* ─────────────────────────────────────────────────────────────────────
 * Local helpers
 * ───────────────────────────────────────────────────────────────────── */

/** Best-effort JSON.stringify that survives BigInt / circular refs. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      value,
      (_k, v: unknown) => {
        if (typeof v === "bigint") return v.toString();
        if (typeof v === "object" && v !== null) {
          if (seen.has(v as object)) return "[Circular]";
          seen.add(v as object);
        }
        return v;
      },
      2,
    );
  }
}

/** "5s ago" / "3m ago" / "2h ago" — gives the probe row a freshness cue. */
function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 0) return "just now";
  const s = Math.floor(delta / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

