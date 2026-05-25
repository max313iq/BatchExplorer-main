/**
 * Legacy EA Sub Creator — uses the 2018-03-01-preview Subscription
 * creation API documented at
 *   https://learn.microsoft.com/azure/cost-management-billing/manage/
 *     programmatically-create-subscription
 *
 * Flow:
 *   1. List enrollment accounts the caller is an Owner on:
 *      GET /providers/Microsoft.Billing/enrollmentAccounts?api-version=2018-03-01-preview
 *   2. POST createSubscription with the enrollment-account object id +
 *      offerType (MS-AZR-0017P or MS-AZR-0148P) + optional owners.
 *   3. Poll the Location header until ARM returns the subscriptionLink.
 *
 * Different from the existing EA Subscription page (which uses the
 * modern Subscription Alias API): no alias name, no cross-tenant owner
 * required, fewer optional fields, but capped at 5000 subs per
 * enrollment account.
 *
 * IMPORTANT — this page wraps a **deprecated** API path. Newer EA
 * enrollments routinely return `Commerce Account Is Null` because the
 * legacy billing namespace was never populated for them. The UI keeps
 * this page available for the rare automation that specifically needs
 * the 2018-03-01-preview shape, but it shows persistent deprecation
 * banners and gates the submit behind an acknowledgement so nobody
 * accidentally builds a new workflow on top of the dying endpoint.
 */
import * as React from "react";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Building2,
  Check,
  CheckCircle2,
  Crown,
  Eraser,
  ExternalLink,
  History,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Terminal,
  Trash2,
  User,
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  getActiveTenant,
  getArmTokenForAccount,
} from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog } from "../../services/audit-log";
import {
  createLegacyEaSubscription,
  listLegacyEnrollmentAccounts,
} from "../../services";
import type {
  LegacyEaSubscriptionResult,
  LegacyEnrollmentAccount,
} from "../../services";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";

// COORDINATOR: page consumes the dashboard outlet context (orchestrator,
// store, navigateToPage) instead of calling `useNavigate` directly — the
// shared `navigateToPage` already resolves PageKey strings to canonical
// paths and is what page-router promises every page.
import { useDashboardOutletContext } from "../page-router";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton, CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { StatusBadge } from "../shared/status-badge";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

/* --------------------------------------------------------------------- */
/* Constants                                                             */
/* --------------------------------------------------------------------- */

const STORAGE_ACCOUNT = "legacy-ea-sub:account";
const STORAGE_EA = "legacy-ea-sub:enrollment-account";
const STORAGE_MANUAL_GUID = "legacy-ea-sub:manual-guid";
const STORAGE_HISTORY = "legacy-ea-sub:session-history";
const STORAGE_ACK = "legacy-ea-sub:deprecation-acknowledged";
// localStorage-backed (NOT sessionStorage) — survives full reload, so an
// operator who refreshes mid-fill keeps their draft.
const STORAGE_DRAFT = "legacy-ea-sub:draft";
const STORAGE_DRAFT_VERSION = 1;

// Per-EA subscription cap that ARM enforces on the 2018-03-01-preview
// path. Canceled / transferred / deleted subs still count toward it.
const EA_SUBSCRIPTION_CAP = 5000;
const DISPLAY_NAME_MAX = 64;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Match `/providers/Microsoft.Billing/enrollmentAccounts/<guid>` so the
// manual-mode input accepts a full ARM path that an operator might paste
// from a runbook or `az billing` command.
const ARM_EA_PATH_RE =
  /\/providers\/Microsoft\.Billing\/enrollmentAccounts\/([0-9a-f-]{36})/i;

/* --------------------------------------------------------------------- */
/* Types                                                                 */
/* --------------------------------------------------------------------- */

interface SourceAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
}

/** Recorded in-memory + sessionStorage row for a submitted (or attempted)
 *  subscription. Drives the ExportMenu, the timeline strip, and the
 *  "Created this session" header stat. */
interface SessionEntry {
  timestamp: string;
  displayName: string;
  offerType: string;
  enrollmentAccountId: string;
  enrollmentAccountOwner?: string;
  subscriptionId?: string;
  subscriptionLink?: string;
  httpStatus: number;
  ownerCount: number;
  outcome: "success" | "failure";
  error?: string;
}

/** Reload-survivable draft of the in-progress create form. Persisted to
 *  localStorage via `usePersistedState` — operator who hits F5 mid-fill
 *  gets the displayName / offer / owners back. EA selection lives in
 *  sessionStorage already because it's a per-tab pick. */
interface LegacyEaDraft {
  displayName: string;
  offerType: "MS-AZR-0017P" | "MS-AZR-0148P";
  owners: string[];
  /** ISO timestamp of when the draft was last touched — surfaces in the
   *  draft-restored banner so the operator can decide whether the saved
   *  values are still meaningful. */
  updatedAt: string;
}

const DRAFT_EMPTY: LegacyEaDraft = {
  displayName: "",
  offerType: "MS-AZR-0017P",
  owners: [],
  updatedAt: "",
};

function isDraftMeaningful(d: LegacyEaDraft): boolean {
  return d.displayName.trim().length > 0 || d.owners.length > 0;
}

/** Submit-time error classification — drives which targeted help panel
 *  renders below the form. */
interface ErrorClass {
  deprecated: boolean;
  invalidOffer: boolean;
  expired: boolean;
  forbidden: boolean;
  unauthorized: boolean;
  throttled: boolean;
}

const ERROR_CLASS_EMPTY: ErrorClass = {
  deprecated: false,
  invalidOffer: false,
  expired: false,
  forbidden: false,
  unauthorized: false,
  throttled: false,
};

/* --------------------------------------------------------------------- */
/* Helpers                                                               */
/* --------------------------------------------------------------------- */

/**
 * Best-effort load of the in-session history from sessionStorage. Keeps
 * the timeline / export intact across navigations to other pages within
 * the same tab — a full reload still wipes it (sessionStorage by design).
 */
function loadSessionHistory(): SessionEntry[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_HISTORY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Filter to entries that at least have the required scalar shape;
    // protects against schema drift if we ever change SessionEntry.
    return parsed.filter(
      (e): e is SessionEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as SessionEntry).timestamp === "string" &&
        typeof (e as SessionEntry).displayName === "string" &&
        typeof (e as SessionEntry).offerType === "string" &&
        typeof (e as SessionEntry).enrollmentAccountId === "string",
    );
  } catch {
    return [];
  }
}

function saveSessionHistory(entries: SessionEntry[]): void {
  try {
    sessionStorage.setItem(STORAGE_HISTORY, JSON.stringify(entries));
  } catch {
    /* sessionStorage full / unavailable — non-fatal */
  }
}

/**
 * Pull a GUID out of arbitrary input — handles bare GUIDs, full ARM
 * resource paths, and surrounding whitespace / quotation marks an
 * operator might paste from a doc or runbook.
 */
function extractEnrollmentGuid(raw: string): string {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (UUID_RE.test(trimmed)) return trimmed.toLowerCase();
  const m = ARM_EA_PATH_RE.exec(trimmed);
  return m ? m[1]!.toLowerCase() : trimmed;
}

/**
 * Classify a submit error string into one of the targeted help buckets
 * below. Order of detection matters: "commerce account is null" wins
 * over a generic "offer not enabled" because the dedicated deprecation
 * panel is more actionable.
 */
function classifyError(msg: string): ErrorClass {
  const out = { ...ERROR_CLASS_EMPTY };
  if (
    /commerce account is null/i.test(msg) ||
    /commerce.+account.+null/i.test(msg)
  ) {
    out.deprecated = true;
  }
  if (
    /offer .* is not enabled/i.test(msg) ||
    /offer type .* invalid/i.test(msg) ||
    /devtest .* not enabled/i.test(msg)
  ) {
    out.invalidOffer = true;
  }
  if (
    /enrollment .* (expired|inactive|not active|terminated)/i.test(msg) ||
    /enrollment account .* (expired|inactive)/i.test(msg)
  ) {
    out.expired = true;
  }
  if (
    /\b(401|unauthor[iz]ed|invalid.token|token.expired)\b/i.test(msg) ||
    /authentication failed/i.test(msg)
  ) {
    out.unauthorized = true;
  }
  if (
    /\b(403|forbidden)\b/i.test(msg) ||
    /authorization.failed/i.test(msg) ||
    /does not have authorization/i.test(msg)
  ) {
    out.forbidden = true;
  }
  if (
    /\b(429|throttl|too many requests|rate.?limit)\b/i.test(msg) ||
    /retry.?after/i.test(msg)
  ) {
    out.throttled = true;
  }
  return out;
}

/**
 * Build an `az rest` command that exactly mirrors the create call this
 * page would POST. Handy for the audit trail or for handing off to a
 * shell when the browser can't reach ARM directly.
 */
function buildAzRestCommand(
  enrollmentAccountId: string,
  body: { displayName?: string; offerType: string; owners?: string[] },
): string {
  const url =
    `https://management.azure.com/providers/Microsoft.Billing/enrollmentAccounts/` +
    `${enrollmentAccountId}/providers/Microsoft.Subscription/createSubscription` +
    `?api-version=2018-03-01-preview`;
  const payload: Record<string, unknown> = { offerType: body.offerType };
  if (body.displayName?.trim()) payload.displayName = body.displayName.trim();
  if (body.owners && body.owners.length > 0) {
    payload.owners = body.owners.map((o) => ({ objectId: o }));
  }
  // Single-line `--body` argument so the command pastes cleanly into
  // PowerShell / bash without escaping headaches.
  const json = JSON.stringify(payload);
  return `az rest --method POST --uri "${url}" --headers "Content-Type=application/json" --body '${json}'`;
}

/** Suggest a timestamp-suffixed display name when the field is empty. */
function suggestDisplayName(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `Legacy-EA-Sub-${yyyy}${mm}${dd}-${hh}${mi}`;
}

/** Human-friendly relative time for the session history strip. */
function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* --------------------------------------------------------------------- */
/* Page                                                                  */
/* --------------------------------------------------------------------- */

export const LegacyEaSubCreatorPage: React.FC = () => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  // COORDINATOR: use the path-based navigator from the dashboard outlet
  // context rather than calling `useNavigate()` directly. `navigateToPage`
  // accepts either a PageKey or a literal path and is what page-router
  // promises every page consumes.
  const { navigateToPage } = useDashboardOutletContext();
  const azureAccounts = state.azureAccounts ?? [];

  /* ----- Account picker ------------------------------------------ */
  const candidates: SourceAccount[] = React.useMemo(
    () =>
      azureAccounts
        .map((a) => ({
          homeAccountId: a.homeAccountId,
          tenantId: getActiveTenant(a.homeAccountId) ?? resolveActiveTenantId(a),
          username: a.username,
          name: a.name || a.username,
        }))
        .filter((a) => !!a.tenantId),
    [azureAccounts],
  );

  const [accountId, setAccountIdState] = React.useState<string>(() => {
    try {
      return sessionStorage.getItem(STORAGE_ACCOUNT) ?? "";
    } catch {
      return "";
    }
  });
  const setAccountId = React.useCallback((id: string) => {
    setAccountIdState(id);
    try {
      sessionStorage.setItem(STORAGE_ACCOUNT, id);
    } catch {
      /* ignore */
    }
  }, []);
  React.useEffect(() => {
    if (
      candidates.length > 0 &&
      !candidates.some((c) => c.homeAccountId === accountId)
    ) {
      setAccountId(candidates[0]!.homeAccountId);
    }
  }, [candidates, accountId, setAccountId]);
  const account = React.useMemo(
    () => candidates.find((c) => c.homeAccountId === accountId) ?? null,
    [candidates, accountId],
  );

  /* ----- ARM token + enrollment accounts ------------------------- */
  const [armToken, setArmToken] = React.useState<string | null>(null);
  // Central ARM-token tracker — handles tenant-switch re-mint,
  // pre-expiry refresh, and feeds the TokenExpiryBadge below. The
  // existing `armToken` state is kept for downstream call sites; the
  // sync bridge below mirrors fresh tokens from the tracker into it.
  const armTokenTracker = useArmToken(
    account?.homeAccountId,
    account?.tenantId,
  );
  React.useEffect(() => {
    if (armTokenTracker.token && armTokenTracker.token !== armToken) {
      setArmToken(armTokenTracker.token);
    }
  }, [armTokenTracker.token, armToken]);

  const [eas, setEas] = React.useState<LegacyEnrollmentAccount[]>([]);
  const [eaLoading, setEaLoading] = React.useState(false);
  const [eaError, setEaError] = React.useState<string | null>(null);
  const [enrollmentAccountId, setEnrollmentAccountIdState] =
    React.useState<string>(() => {
      try {
        return sessionStorage.getItem(STORAGE_EA) ?? "";
      } catch {
        return "";
      }
    });
  const setEnrollmentAccountId = React.useCallback((id: string) => {
    setEnrollmentAccountIdState(id);
    try {
      sessionStorage.setItem(STORAGE_EA, id);
    } catch {
      /* ignore */
    }
  }, []);

  // "Enter EA object id manually" escape hatch — the listing call hits
  // a preview ARM endpoint that some networks / browsers block with a
  // generic "Failed to fetch". Letting the operator paste the GUID
  // directly bypasses the listing entirely. The pasted GUID survives a
  // page nav within the tab via sessionStorage.
  const [manualMode, setManualMode] = React.useState(false);
  const [manualInput, setManualInput] = React.useState<string>(() => {
    try {
      return sessionStorage.getItem(STORAGE_MANUAL_GUID) ?? "";
    } catch {
      return "";
    }
  });
  // Mirror manualInput → sessionStorage so a tab-internal navigation
  // doesn't make the operator paste the GUID again.
  React.useEffect(() => {
    try {
      if (manualInput.trim()) {
        sessionStorage.setItem(STORAGE_MANUAL_GUID, manualInput.trim());
      } else {
        sessionStorage.removeItem(STORAGE_MANUAL_GUID);
      }
    } catch {
      /* ignore */
    }
  }, [manualInput]);

  // Bumping `listSeq` triggers a refetch of the enrollment-account
  // listing without reloading the page. Used by the "Refresh" button
  // and after the operator flips out of manual mode.
  const [listSeq, setListSeq] = React.useState(0);
  // Track the most recent listing run so a slower previous one can't
  // overwrite newer state if the operator quickly flips the account or
  // hits Refresh while a request is still in flight. The boolean
  // `cancelled` guard from the old code is preserved but `runIdRef`
  // gives strict last-writer-wins ordering across overlapping runs.
  const runIdRef = React.useRef(0);

  // Migrated to `useAbortableEffect` so on unmount / dep-change the signal
  // is aborted automatically. The two service helpers don't accept a
  // signal arg directly, but the post-resolution `signal.aborted` guards
  // still prevent stale-write races (runIdRef preserves last-writer-wins
  // ordering across overlapping refreshes; the signal handles teardown).
  useAbortableEffect(
    async (signal) => {
      if (!account) {
        setArmToken(null);
        setEas([]);
        return;
      }
      const myRunId = ++runIdRef.current;
      const actor = account.username;
      const tenantId = account.tenantId;
      setEaLoading(true);
      setEaError(null);
      try {
        // Tenant arg omitted so we pick up the operator's current active
        // tenant (was pinning to account.tenantId / the account's HOME
        // tenant — pre-switch).
        const tok = await getArmTokenForAccount(account.homeAccountId);
        if (signal.aborted || myRunId !== runIdRef.current) return;
        setArmToken(tok);
        const list = await listLegacyEnrollmentAccounts(tok);
        if (signal.aborted || myRunId !== runIdRef.current) return;
        setEas(list);
        if (list.length === 1 && enrollmentAccountId !== list[0]!.name) {
          setEnrollmentAccountId(list[0]!.name);
        } else if (
          enrollmentAccountId &&
          !list.some((e) => e.name === enrollmentAccountId)
        ) {
          setEnrollmentAccountId("");
        }
        // Success audit: which actor saw which enrollment accounts.
        auditLog.record({
          actor,
          action: "list_legacy_enrollment_accounts",
          target: tenantId,
          status: "success",
          details: { count: list.length },
        });
      } catch (err) {
        if (signal.aborted || myRunId !== runIdRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setEaError(msg);
        setEas([]);
        // "Failed to fetch" is a browser-level rejection (CORS, ad-
        // blocker, network policy, …) that lookups can't recover from.
        // Flip to manual mode so the operator can paste the GUID and
        // proceed — the create call hits a different path that may
        // succeed even when listing doesn't.
        if (/failed to fetch|networkerror|load failed/i.test(msg)) {
          setManualMode(true);
        }
        // Failure audit so silent listing problems are still observable
        // from the audit-log page.
        auditLog.record({
          actor,
          action: "list_legacy_enrollment_accounts",
          target: tenantId,
          status: "failure",
          error: msg,
        });
      } finally {
        if (!signal.aborted && myRunId === runIdRef.current) {
          setEaLoading(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account?.homeAccountId, account?.tenantId, listSeq],
  );

  const selectedEa = React.useMemo(() => {
    // In manual mode the synthetic row stands in for a listed one —
    // the GUID is all the createSubscription endpoint actually needs.
    const cleaned = extractEnrollmentGuid(manualInput);
    if (manualMode && UUID_RE.test(cleaned)) {
      return {
        id: `/providers/Microsoft.Billing/enrollmentAccounts/${cleaned}`,
        name: cleaned,
        principalName: undefined,
      };
    }
    return eas.find((e) => e.name === enrollmentAccountId) ?? null;
  }, [manualMode, manualInput, eas, enrollmentAccountId]);

  /* ----- Form state (draft survives full reload) ----------------- */
  // Persisted draft so a mid-fill reload doesn't lose the displayName /
  // offer / owners. Versioned envelope via `usePersistedState` so a future
  // shape change can migrate cleanly. The EA selection itself is in
  // sessionStorage (intentionally per-tab) — only the form *content*
  // survives a hard reload.
  const [draft, setDraft, resetDraft] = usePersistedState<LegacyEaDraft>(
    STORAGE_DRAFT,
    DRAFT_EMPTY,
    {
      version: STORAGE_DRAFT_VERSION,
      migrate: (raw) => {
        if (typeof raw !== "object" || raw === null) return undefined;
        const r = raw as Partial<LegacyEaDraft>;
        return {
          displayName: typeof r.displayName === "string" ? r.displayName : "",
          offerType:
            r.offerType === "MS-AZR-0148P" ? "MS-AZR-0148P" : "MS-AZR-0017P",
          owners: Array.isArray(r.owners)
            ? r.owners.filter(
                (o): o is string => typeof o === "string" && UUID_RE.test(o),
              )
            : [],
          updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
        };
      },
    },
  );
  // Snapshot of the draft as it was on first mount — used by the "draft
  // restored" banner so we only nag the operator once per page-visit, not
  // on every keystroke (which would also rewrite `updatedAt`).
  const draftOnMountRef = React.useRef<LegacyEaDraft>(draft);
  const [draftBannerDismissed, setDraftBannerDismissed] = React.useState(false);

  const displayName = draft.displayName;
  const offerType = draft.offerType;
  const owners = draft.owners;
  const setDisplayName = React.useCallback(
    (next: string) => {
      setDraft((prev) => ({
        ...prev,
        displayName: next,
        updatedAt: new Date().toISOString(),
      }));
    },
    [setDraft],
  );
  const setOfferType = React.useCallback(
    (next: "MS-AZR-0017P" | "MS-AZR-0148P") => {
      setDraft((prev) => ({
        ...prev,
        offerType: next,
        updatedAt: new Date().toISOString(),
      }));
    },
    [setDraft],
  );
  const setOwners = React.useCallback(
    (updater: React.SetStateAction<string[]>) => {
      setDraft((prev) => ({
        ...prev,
        owners:
          typeof updater === "function"
            ? (updater as (prev: string[]) => string[])(prev.owners)
            : updater,
        updatedAt: new Date().toISOString(),
      }));
    },
    [setDraft],
  );
  const [ownerInput, setOwnerInput] = React.useState("");

  // URL-state for the offer type so a deep link / shared URL can pre-set
  // it. Wins over the persisted draft only on first mount (subsequent
  // changes flow draft -> URL via a side-effect below).
  const [urlFilter, setUrlFilter] = useUrlState(
    { offer: "" },
    { replace: true, keys: ["offer"] },
  );
  React.useEffect(() => {
    // Hydrate offer type from the URL exactly once on mount when it's
    // present and valid.
    const u = String(urlFilter.offer ?? "");
    if (u === "MS-AZR-0017P" || u === "MS-AZR-0148P") {
      if (u !== draft.offerType) setOfferType(u);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    // Mirror draft.offerType -> URL so a refresh / share preserves it,
    // but only once the URL is already participating (URL contains the
    // key or the operator has changed offer type away from the default).
    // This keeps the URL clean for first-time visitors who never touch
    // the offer-type select.
    const offerInUrl = typeof urlFilter.offer === "string" && urlFilter.offer.length > 0;
    if (!offerInUrl && draft.offerType === "MS-AZR-0017P") return;
    if (urlFilter.offer !== draft.offerType) {
      setUrlFilter({ offer: draft.offerType });
    }
  }, [draft.offerType, urlFilter.offer, setUrlFilter]);

  const addOwner = React.useCallback(() => {
    const v = ownerInput.trim().toLowerCase();
    if (!UUID_RE.test(v)) return;
    if (owners.includes(v)) {
      setOwnerInput("");
      return;
    }
    setOwners((prev) => [...prev, v]);
    setOwnerInput("");
  }, [ownerInput, owners, setOwners]);

  const removeOwner = React.useCallback(
    (oid: string) => {
      setOwners((prev) => prev.filter((o) => o !== oid));
    },
    [setOwners],
  );

  const clearOwners = React.useCallback(() => {
    setOwners([]);
  }, [setOwners]);

  const displayNameTrimmed = displayName.trim();
  const displayNameTooLong = displayNameTrimmed.length > DISPLAY_NAME_MAX;
  const displayNameEmpty = displayNameTrimmed.length === 0;

  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [errorClass, setErrorClass] =
    React.useState<ErrorClass>(ERROR_CLASS_EMPTY);
  const [result, setResult] = React.useState<LegacyEaSubscriptionResult | null>(
    null,
  );
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // Track submit invocations so a slower earlier submit can't overwrite
  // the result of a newer one (rare but the symptom is a "succeeded"
  // toast referencing a stale subscription id).
  const submitIdRef = React.useRef(0);

  // Persistent (session-scoped) deprecation acknowledgement. The
  // confirmation dialog still re-prompts with a checkbox, but once the
  // operator has acknowledged it stays acknowledged for the whole tab
  // session — they don't have to re-check it for every submit.
  const [deprecationAck, setDeprecationAckState] = React.useState<boolean>(
    () => {
      try {
        return sessionStorage.getItem(STORAGE_ACK) === "1";
      } catch {
        return false;
      }
    },
  );
  const setDeprecationAck = React.useCallback((v: boolean) => {
    setDeprecationAckState(v);
    try {
      if (v) sessionStorage.setItem(STORAGE_ACK, "1");
      else sessionStorage.removeItem(STORAGE_ACK);
    } catch {
      /* ignore */
    }
  }, []);

  /* ----- Session history ----------------------------------------- */
  const [sessionHistory, setSessionHistory] = React.useState<SessionEntry[]>(
    () => loadSessionHistory(),
  );
  // Mirror history to sessionStorage on every change so a navigation
  // inside the tab preserves the timeline / export.
  React.useEffect(() => {
    saveSessionHistory(sessionHistory);
  }, [sessionHistory]);

  const successCount = React.useMemo(
    () => sessionHistory.filter((s) => s.outcome === "success").length,
    [sessionHistory],
  );
  const failureCount = sessionHistory.length - successCount;

  const clearHistory = React.useCallback(() => {
    setSessionHistory([]);
  }, []);

  /* ----- Submit gate --------------------------------------------- */
  const canSubmit =
    !submitting &&
    !!armToken &&
    !!selectedEa &&
    !!offerType &&
    !displayNameEmpty &&
    !displayNameTooLong &&
    deprecationAck;

  /** Aggregate list of reasons a draft would fail to submit right now.
   *  Used by the always-visible validation banner so the operator sees a
   *  full checklist of remaining work without having to click Submit and
   *  read a one-line tooltip. Empty array = the draft would post. */
  const validationIssues = React.useMemo(() => {
    const issues: { id: string; severity: "error" | "warn"; text: string }[] =
      [];
    if (!account) {
      issues.push({
        id: "account",
        severity: "error",
        text: "Pick a signed-in Azure account.",
      });
    }
    if (!armToken) {
      issues.push({
        id: "token",
        severity: "warn",
        text: "Waiting for ARM token to acquire — usually a second or two.",
      });
    }
    if (!selectedEa) {
      issues.push({
        id: "ea",
        severity: "error",
        text: manualMode
          ? "Paste a valid enrollment-account GUID above."
          : "Pick an enrollment account from the list above.",
      });
    }
    if (displayNameEmpty) {
      issues.push({
        id: "name",
        severity: "error",
        text: "Display name is required.",
      });
    } else if (displayNameTooLong) {
      issues.push({
        id: "name-long",
        severity: "error",
        text: `Display name must be ${DISPLAY_NAME_MAX} characters or fewer (currently ${displayNameTrimmed.length}).`,
      });
    }
    if (!deprecationAck) {
      issues.push({
        id: "ack",
        severity: "warn",
        text: "Acknowledge the deprecation banner at the top.",
      });
    }
    if (ownerInput.trim().length > 0 && !UUID_RE.test(ownerInput.trim())) {
      issues.push({
        id: "owner-pending",
        severity: "warn",
        text: "Pending owner input isn't a valid AAD object id — fix or clear it before submitting.",
      });
    }
    return issues;
  }, [
    account,
    armToken,
    selectedEa,
    manualMode,
    displayNameEmpty,
    displayNameTooLong,
    displayNameTrimmed.length,
    deprecationAck,
    ownerInput,
  ]);

  /** Why submit is disabled — surfaces inline so the disabled state
   *  doesn't feel mysterious. Empty when the button is usable. */
  const submitBlockedReason = (() => {
    if (submitting) return "Submitting…";
    if (!armToken) return "Waiting for ARM token to acquire.";
    if (!selectedEa) return "Pick an enrollment account first.";
    if (displayNameEmpty) return "Display name is required.";
    if (displayNameTooLong)
      return `Display name must be ${DISPLAY_NAME_MAX} characters or fewer.`;
    if (!deprecationAck)
      return "Acknowledge the deprecation banner above first.";
    return "";
  })();

  const submit = React.useCallback(async () => {
    if (!canSubmit || !armToken || !selectedEa) return;
    const mySubmitId = ++submitIdRef.current;
    setSubmitting(true);
    setSubmitError(null);
    setErrorClass(ERROR_CLASS_EMPTY);
    setResult(null);
    // Snapshot inputs at the moment of submission so a state change
    // mid-flight (operator types into displayName, swaps offer type)
    // doesn't make the audit log lie about what we actually sent.
    const snapshot = {
      enrollmentAccountId: selectedEa.name,
      enrollmentAccountOwner: selectedEa.principalName,
      displayName: displayNameTrimmed,
      offerType,
      owners: owners.slice(),
    };
    try {
      const r = await createLegacyEaSubscription(
        snapshot.enrollmentAccountId,
        {
          displayName: snapshot.displayName,
          offerType: snapshot.offerType,
          owners: snapshot.owners,
        },
        armToken,
      );
      if (mySubmitId !== submitIdRef.current) return; // stale
      setResult(r);
      auditLog.record({
        actor: account?.username ?? "",
        action: "create_legacy_ea_subscription",
        target: snapshot.displayName,
        status: "success",
        details: {
          enrollmentAccountObjectId: snapshot.enrollmentAccountId,
          enrollmentAccountOwner: snapshot.enrollmentAccountOwner,
          offerType: snapshot.offerType,
          ownerCount: snapshot.owners.length,
          subscriptionId: r.subscriptionId,
          httpStatus: r.status,
        },
      });
      setSessionHistory((prev) => [
        ...prev,
        {
          timestamp: new Date().toISOString(),
          displayName: snapshot.displayName,
          offerType: snapshot.offerType,
          enrollmentAccountId: snapshot.enrollmentAccountId,
          enrollmentAccountOwner: snapshot.enrollmentAccountOwner,
          subscriptionId: r.subscriptionId,
          subscriptionLink: r.subscriptionLink,
          httpStatus: r.status,
          ownerCount: snapshot.owners.length,
          outcome: "success",
        },
      ]);
      store.addNotification({
        type: "success",
        message: r.subscriptionId
          ? `Created subscription ${r.subscriptionId}.`
          : "Create accepted by ARM — subscription link is below.",
      });
    } catch (err) {
      if (mySubmitId !== submitIdRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setSubmitError(msg);
      setErrorClass(classifyError(msg));
      auditLog.record({
        actor: account?.username ?? "",
        action: "create_legacy_ea_subscription",
        target: snapshot.displayName,
        status: "failure",
        error: msg,
        details: {
          enrollmentAccountObjectId: snapshot.enrollmentAccountId,
          offerType: snapshot.offerType,
          ownerCount: snapshot.owners.length,
        },
      });
      setSessionHistory((prev) => [
        ...prev,
        {
          timestamp: new Date().toISOString(),
          displayName: snapshot.displayName,
          offerType: snapshot.offerType,
          enrollmentAccountId: snapshot.enrollmentAccountId,
          enrollmentAccountOwner: snapshot.enrollmentAccountOwner,
          httpStatus: 0,
          ownerCount: snapshot.owners.length,
          outcome: "failure",
          error: msg,
        },
      ]);
      store.addNotification({
        type: "error",
        message: `Legacy create failed: ${msg.slice(0, 120)}`,
      });
    } finally {
      if (mySubmitId === submitIdRef.current) setSubmitting(false);
    }
  }, [
    canSubmit,
    armToken,
    selectedEa,
    displayNameTrimmed,
    offerType,
    owners,
    account?.username,
    store,
  ]);

  /** Reset the form to its initial empty state — preserves the picked
   *  source account, enrollment-account selection, and history. Wires
   *  the "Reset" button under the result card. Also clears the
   *  localStorage-persisted draft so a subsequent reload starts clean. */
  const resetForm = React.useCallback(() => {
    resetDraft();
    setOwnerInput("");
    setSubmitError(null);
    setErrorClass(ERROR_CLASS_EMPTY);
    setResult(null);
    draftOnMountRef.current = DRAFT_EMPTY;
    setDraftBannerDismissed(true);
  }, [resetDraft]);

  /** Drop the persisted draft without disturbing anything else — wires
   *  the "Discard draft" button in the restored-draft banner. */
  const discardDraft = React.useCallback(() => {
    resetDraft();
    draftOnMountRef.current = DRAFT_EMPTY;
    setDraftBannerDismissed(true);
  }, [resetDraft]);

  /** Jump-to-modern helper — used by the deprecation banner and the
   *  CAIN ("Commerce Account Is Null") recovery panel. Sends the
   *  operator to **ea-sub-quick** (NOT the full ea-subscription page).
   *  The button labels promise "EA Sub Quick" so the navigation has
   *  to match — previously this navigated to /ea-subscription and
   *  seeded the wrong sessionStorage keys, leaving the user on the
   *  wrong page with no pre-fill.
   *
   *  Seeds the sessionStorage keys ea-sub-quick reads on mount so the
   *  account picker is pre-selected. The legacy flat enrollment-
   *  account namespace doesn't carry a parent billing-account, so we
   *  CAN'T pre-seed `ea-sub-quick:billing-account`; the operator
   *  picks it on the modern page and ea-sub-quick's BA→EA cascade
   *  takes over from there. We still seed the enrollment-account
   *  name as a hint that ea-sub-quick will apply once the matching
   *  BA is picked. */
  const jumpToModernPage = React.useCallback(() => {
    try {
      if (account?.homeAccountId) {
        sessionStorage.setItem(
          "ea-sub-quick:account",
          account.homeAccountId,
        );
      }
      if (selectedEa) {
        sessionStorage.setItem(
          "ea-sub-quick:enrollment-account",
          selectedEa.name,
        );
      }
    } catch {
      /* sessionStorage unavailable — non-fatal */
    }
    // COORDINATOR: path-based nav via outlet context (NOT useNavigate).
    navigateToPage("/ea-sub-quick");
  }, [account?.homeAccountId, selectedEa, navigateToPage]);

  /**
   * CAIN auto-pivot countdown. When the legacy endpoint returns
   * "Commerce Account Is Null", we know with high certainty this
   * enrollment will never succeed against the deprecated API. Rather
   * than leaving the operator staring at red text, count down 8s and
   * auto-fire `jumpToModernPage`. The countdown shows a Cancel
   * button so they can stay on the legacy page if they need to copy
   * the raw error for a support ticket. Cleared whenever the error
   * class changes or the operator cancels.
   */
  const [autoPivotSec, setAutoPivotSec] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!submitError || !errorClass.deprecated) {
      setAutoPivotSec(null);
      return;
    }
    setAutoPivotSec(8);
    const id = window.setInterval(() => {
      setAutoPivotSec((s) => {
        if (s === null) return null;
        if (s <= 1) {
          window.clearInterval(id);
          // Defer to next tick so React finishes this render cycle
          // before we navigate (avoids the navigation racing the
          // state update that cleared autoPivotSec).
          window.setTimeout(() => jumpToModernPage(), 0);
          return null;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [submitError, errorClass.deprecated, jumpToModernPage]);
  const cancelAutoPivot = React.useCallback(() => setAutoPivotSec(null), []);

  /* ----- Derived ------------------------------------------------- */

  const manualGuidExtracted = extractEnrollmentGuid(manualInput);
  const manualGuidValid =
    manualInput.length > 0 && UUID_RE.test(manualGuidExtracted);

  const ownersValid = ownerInput.length === 0 || UUID_RE.test(ownerInput.trim());

  // Build the curl-equivalent command up-front so the "Copy as az
  // command" button is instant.
  const azCommandPreview = React.useMemo(() => {
    if (!selectedEa) return "";
    return buildAzRestCommand(selectedEa.name, {
      displayName: displayNameTrimmed,
      offerType,
      owners,
    });
  }, [selectedEa, displayNameTrimmed, offerType, owners]);

  // JSON payload preview (kept identical to what the service layer
  // POSTs). Renders inside the confirmation dialog and a collapsible
  // "API details" panel below the form.
  const requestBodyPreview = React.useMemo(() => {
    const body: Record<string, unknown> = { offerType };
    if (displayNameTrimmed) body.displayName = displayNameTrimmed;
    if (owners.length > 0) {
      body.owners = owners.map((o) => ({ objectId: o }));
    }
    return JSON.stringify(body, null, 2);
  }, [offerType, displayNameTrimmed, owners]);

  // Last few session entries for the timeline strip — keep it tight so
  // it doesn't take over the page; the full list is in the ExportMenu.
  const recentEntries = sessionHistory.slice(-5).reverse();

  // React to global tenant-switch events from the app header. When the
  // operator switches tenants for an account that's in our eligible
  // candidates list, mirror the selection into the source-account
  // picker (and STORAGE_ACCOUNT) so subsequent ARM calls re-mint with
  // the right home identity.
  useTenantChange(undefined, (detail) => {
    const candidate = detail.homeAccountId;
    if (!candidates.some((c) => c.homeAccountId === candidate)) return;
    if (accountId === candidate) return;
    setAccountId(candidate);
  });

  /* ----- Render --------------------------------------------------- */

  if (candidates.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Create EA Sub (legacy API)"
          description="Provision a new EA subscription using the 2018-03-01-preview createSubscription endpoint."
        />
        <EmptyState
          icon={Crown}
          title="No Azure account signed in"
          description="Sign in with an account that holds Owner on at least one EA enrollment account."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <PageHeader
        title="Create EA Sub (legacy API)"
        description="Uses the legacy 2018-03-01-preview Subscription endpoint — POST /providers/Microsoft.Billing/enrollmentAccounts/{id}/providers/Microsoft.Subscription/createSubscription. Requires Owner on the enrollment account."
      >
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Session summary"
        >
          <Badge variant="warning" className="gap-1 text-2xs">
            <AlertTriangle className="h-3 w-3" aria-hidden /> Deprecated API
          </Badge>
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
          <SummaryStatItem
            label="Created"
            value={successCount}
            tone={successCount > 0 ? "success" : "muted"}
            compact
            ariaLabel={`Created this session: ${successCount}`}
          />
          {failureCount > 0 && (
            <SummaryStatItem
              label="Failed"
              value={failureCount}
              tone="destructive"
              compact
              ariaLabel={`Failed this session: ${failureCount}`}
            />
          )}
          <ExportMenu
            rows={sessionHistory}
            columns={[
              { header: "Timestamp", accessor: (r) => r.timestamp },
              { header: "Display name", accessor: (r) => r.displayName },
              { header: "Offer type", accessor: (r) => r.offerType },
              {
                header: "Enrollment account",
                accessor: (r) => r.enrollmentAccountId,
              },
              {
                header: "Subscription id",
                accessor: (r) => r.subscriptionId ?? "",
              },
              { header: "HTTP status", accessor: (r) => r.httpStatus },
              { header: "Owner count", accessor: (r) => r.ownerCount },
              { header: "Outcome", accessor: (r) => r.outcome },
              { header: "Error", accessor: (r) => r.error ?? "" },
            ]}
            filename="legacy-ea-subs-session"
            disabled={sessionHistory.length === 0}
            jsonMetadata={{ source: "legacy-ea-sub-creator-page" }}
          />
          {sessionHistory.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearHistory}
              aria-label="Clear session history"
              className="text-2xs"
            >
              <Trash2 className="h-3.5 w-3.5" /> Clear history
            </Button>
          )}
        </div>
      </PageHeader>

      {/* Strong, persistent deprecation banner pointing at the modern
          alias-API page. Renders ABOVE the form so operators see it
          before any keystrokes. The acknowledgement checkbox is what
          actually gates the submit button below. */}
      <Alert variant="warning">
        <AlertTriangle className="h-3.5 w-3.5" />
        <AlertDescription className="flex flex-col gap-2 text-2xs">
          <span>
            <strong>Deprecated path.</strong> The 2018-03-01-preview
            createSubscription endpoint is frozen and returns{" "}
            <code className="font-mono">Commerce Account Is Null</code>{" "}
            on most EA enrollments registered after 2022. Prefer the
            modern{" "}
            <code className="font-mono">
              /providers/Microsoft.Subscription/aliases
            </code>{" "}
            API — it supports the same enrollment-account billing scope
            plus cross-tenant ownership, dev/test, workload flags, and
            an alias name you can reference programmatically.
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-7 text-2xs"
              onClick={jumpToModernPage}
              aria-label="Open the modern EA Sub Quick page (alias API)"
            >
              <BadgeCheck className="h-3.5 w-3.5" /> Open EA Sub Quick
              (modern)
            </Button>
            <InfoTooltip
              ariaLabel="Difference between legacy and modern alias API"
              content={
                <span className="text-xs">
                  <strong>Legacy</strong> (this page) — POST to{" "}
                  <code>/enrollmentAccounts/.../createSubscription</code>,
                  Owner-on-enrollment, no cross-tenant landing, 5,000-sub
                  cap.<br />
                  <strong>Modern</strong> — PUT to{" "}
                  <code>/aliases/&#123;name&#125;</code>, supports
                  cross-tenant ownership, dev/test, workload flags, and is
                  the recommended path going forward.
                </span>
              }
            />
            <label className="ml-auto flex cursor-pointer items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-2xs">
              <Checkbox
                checked={deprecationAck}
                onCheckedChange={(v) => setDeprecationAck(v === true)}
                aria-label="Acknowledge deprecation"
              />
              <span className="select-none">
                I understand this API is deprecated and may return{" "}
                <code className="font-mono">Commerce Account Is Null</code>.
              </span>
            </label>
          </div>
        </AlertDescription>
      </Alert>

      <Alert>
        <Info className="h-3.5 w-3.5" />
        <AlertDescription className="text-2xs">
          <strong>This is the LEGACY preview API.</strong> Use this page
          only when an automation specifically targets the 2018-03-01-preview
          endpoint shape. Limit:{" "}
          <strong>{EA_SUBSCRIPTION_CAP.toLocaleString()}</strong>{" "}
          subscriptions per enrollment account — canceled, deleted and
          transferred subs all count toward the cap, and ARM will not
          increase it on this path.
        </AlertDescription>
      </Alert>

      {/* Quick-jump nudge — most operators should be on ea-sub-quick /
          ea-subscription rather than this page. Promote those buttons so
          they're impossible to miss while staying out of the way once the
          operator dismisses the deprecation banner. */}
      <Alert variant="warning" role="region" aria-label="Recommended pages">
        <ArrowRight className="h-3.5 w-3.5" />
        <AlertDescription className="flex flex-wrap items-center gap-2 text-2xs">
          <span>
            <strong>Use a modern flow instead?</strong> For new work the{" "}
            <code className="font-mono">/ea-sub-quick</code> page wraps
            the alias API and is what should be used for new automations.{" "}
            <code className="font-mono">/ea-subscription</code> gives the
            full alias-API form (cross-tenant owners, workload flag,
            etc.). This page exists only for runbooks pinned to the
            legacy 2018-03-01-preview shape.
          </span>
          <span className="ml-auto flex flex-wrap gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-2xs"
              onClick={() => navigateToPage("/ea-sub-quick")}
              aria-label="Open EA Sub Quick"
            >
              <Sparkles className="h-3 w-3" /> EA Sub Quick
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-2xs"
              onClick={() => navigateToPage("/ea-subscription")}
              aria-label="Open EA Subscription (full alias form)"
            >
              <BadgeCheck className="h-3 w-3" /> EA Subscription
            </Button>
          </span>
        </AlertDescription>
      </Alert>

      {/* Draft-restored banner — only renders when a meaningful draft was
          loaded from localStorage on mount and the operator hasn't yet
          dismissed it or interacted with the form. */}
      {isDraftMeaningful(draftOnMountRef.current) && !draftBannerDismissed && (
        <Alert>
          <Save className="h-3.5 w-3.5" />
          <AlertDescription className="flex flex-wrap items-center gap-2 text-2xs">
            <span>
              <strong>Draft restored.</strong> Display name / offer /
              owners were carried over from your last session
              {draftOnMountRef.current.updatedAt
                ? ` (saved ${timeAgo(draftOnMountRef.current.updatedAt)})`
                : ""}
              .
            </span>
            <div className="ml-auto flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-2xs"
                onClick={() => setDraftBannerDismissed(true)}
                aria-label="Keep restored draft and dismiss banner"
              >
                Keep
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-2xs"
                onClick={discardDraft}
                aria-label="Discard restored draft"
              >
                <Eraser className="h-3 w-3" /> Discard draft
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* ----- Scope picker -------------------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Building2 className="h-4 w-4 text-primary" />
            Enrollment account
          </CardTitle>
          <CardDescription>
            Pick the signed-in account and the enrollment account that
            will own the new subscription. The list comes from{" "}
            <code className="font-mono text-2xs">
              GET /providers/Microsoft.Billing/enrollmentAccounts
            </code>{" "}
            (api-version 2018-03-01-preview) — only accounts you hold
            Owner on appear.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Source account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick an account" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.homeAccountId} value={c.homeAccountId}>
                    <span className="flex flex-col">
                      <span className="text-sm">{c.name}</span>
                      <span className="text-2xs text-muted-foreground">
                        {c.username}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {account && (
              <p className="text-2xs text-muted-foreground">
                Active tenant:{" "}
                <code className="font-mono">{account.tenantId}</code>
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="flex items-center gap-1 text-xs">
                Enrollment account
                <InfoTooltip
                  ariaLabel="What is a commerce account / enrollment account"
                  content={
                    <span className="text-xs">
                      The <strong>enrollment account</strong> is the EA
                      billing scope that owns the new subscription's
                      charges. Internally ARM keys this off a{" "}
                      <strong>commerce account</strong> record — new EA
                      enrollments registered after 2022 may not have one
                      under the legacy namespace, which is why the modern
                      alias API is preferred.
                    </span>
                  }
                />
              </Label>
              <div className="flex items-center gap-1">
                {!manualMode && !eaLoading && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-2xs"
                    onClick={() => setListSeq((n) => n + 1)}
                    aria-label="Refresh enrollment-account listing"
                    title="Refresh listing"
                  >
                    <RefreshCw className="h-3 w-3" /> Refresh
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 text-2xs"
                  onClick={() => {
                    setManualMode((v) => !v);
                    setEaError(null);
                  }}
                  aria-label={
                    manualMode
                      ? "Switch back to listing enrollment accounts"
                      : "Enter enrollment-account GUID manually"
                  }
                >
                  {manualMode ? "Use the listing instead" : "Enter ID manually"}
                </Button>
              </div>
            </div>
            {manualMode ? (
              <>
                <div className="relative">
                  <Input
                    value={manualInput}
                    onChange={(e) => setManualInput(e.target.value)}
                    placeholder="Enrollment-account object id (UUID) or ARM path"
                    className="font-mono text-xs pr-9"
                    aria-invalid={
                      manualInput.length > 0 && !manualGuidValid
                        ? true
                        : undefined
                    }
                    aria-describedby="manual-guid-hint"
                  />
                  {manualInput.length > 0 && (
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                      {manualGuidValid ? (
                        <CheckCircle2
                          className="h-4 w-4 text-success"
                          aria-label="Valid GUID"
                        />
                      ) : (
                        <XCircle
                          className="h-4 w-4 text-destructive"
                          aria-label="Not a valid GUID"
                        />
                      )}
                    </span>
                  )}
                </div>
                {manualInput.length > 0 &&
                  manualGuidValid &&
                  manualGuidExtracted !== manualInput.trim() && (
                    <p className="text-2xs text-muted-foreground">
                      Will use{" "}
                      <code className="font-mono">{manualGuidExtracted}</code>{" "}
                      (extracted from the pasted path).
                    </p>
                  )}
                <p
                  id="manual-guid-hint"
                  className="text-2xs text-muted-foreground"
                >
                  Find this GUID in{" "}
                  <a
                    href="https://ea.azure.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    ea.azure.com
                  </a>{" "}
                  → Account → Manage. It's also the value the listing
                  endpoint returns as{" "}
                  <code className="font-mono">name</code>. You can paste a
                  full ARM path like{" "}
                  <code className="font-mono">
                    /providers/Microsoft.Billing/enrollmentAccounts/&lt;guid&gt;
                  </code>{" "}
                  and we'll extract the GUID for you.
                </p>
              </>
            ) : eaLoading ? (
              <p
                className="flex items-center gap-2 text-xs text-muted-foreground"
                aria-live="polite"
              >
                <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                Loading enrollment accounts…
              </p>
            ) : eaError ? (
              <Alert variant="destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                <AlertDescription className="flex flex-col gap-1 text-2xs">
                  <span>
                    <strong>Couldn't list enrollment accounts.</strong>{" "}
                    {/Failed to fetch|networkerror|load failed/i.test(eaError) ? (
                      <>
                        The browser refused the request — usually a CORS
                        block on the preview ARM path, a corporate proxy,
                        or an ad-blocker / extension. Switch to{" "}
                        <strong>Enter ID manually</strong> above and paste
                        the enrollment-account GUID. The actual create
                        call may still succeed.
                      </>
                    ) : (
                      <>
                        ARM rejected the listing call. You can still
                        proceed by pasting the GUID manually if you know
                        it (<strong>Enter ID manually</strong> above), or
                        click Refresh to retry.
                      </>
                    )}
                  </span>
                  <span className="break-all opacity-80">
                    Raw error: {eaError}
                  </span>
                  <div className="mt-1 flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-2xs"
                      onClick={() => setListSeq((n) => n + 1)}
                    >
                      <RefreshCw className="h-3 w-3" /> Retry
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-2xs"
                      onClick={() => {
                        setManualMode(true);
                        setEaError(null);
                      }}
                    >
                      Enter ID manually
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : eas.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No enrollment accounts visible to this account. The
                signed-in user must be an Owner on an enrollment account
                (Account Owner from the EA portal). Or click{" "}
                <strong>Enter ID manually</strong> above to paste a GUID.
              </p>
            ) : (
              <>
                <Select
                  value={enrollmentAccountId}
                  onValueChange={setEnrollmentAccountId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick an enrollment account" />
                  </SelectTrigger>
                  <SelectContent>
                    {eas.map((e) => (
                      <SelectItem key={e.name} value={e.name}>
                        <span className="flex flex-col">
                          <span className="font-mono text-2xs">{e.name}</span>
                          {e.principalName && (
                            <span className="text-2xs text-muted-foreground">
                              owner: {e.principalName}
                            </span>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-2xs text-muted-foreground">
                  {eas.length === 1
                    ? "1 enrollment account visible"
                    : `${eas.length} enrollment accounts visible`}
                  {" — "}each capped at{" "}
                  <strong>{EA_SUBSCRIPTION_CAP.toLocaleString()}</strong>{" "}
                  subs on this API.
                </p>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {!selectedEa ? (
        <EmptyState
          icon={BadgeCheck}
          title="Pick an enrollment account"
          description="The new subscription's billing is attached to whichever enrollment account you pick."
        />
      ) : (
        <>
          {/* ----- Subscription form ------------------------------- */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Plus className="h-4 w-4 text-primary" />
                New subscription
              </CardTitle>
              <CardDescription>
                The new subscription lands in the home tenant of the
                enrollment account's Account Owner (
                <code className="font-mono">
                  {selectedEa.principalName ?? "unknown"}
                </code>
                ). Cross-tenant landing isn't supported by this API —
                use the modern Create EA Sub page if you need that.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {/* Selected EA summary chip with one-click copy. */}
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-2 py-1.5 text-2xs">
                <Badge variant="outline" className="text-2xs">
                  Target EA
                </Badge>
                <CopyableText
                  value={selectedEa.name}
                  mono
                  alwaysVisibleButton
                  ariaLabel="Copy enrollment-account GUID"
                />
                {selectedEa.principalName && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">
                      owner:{" "}
                      <code className="font-mono">
                        {selectedEa.principalName}
                      </code>
                    </span>
                  </>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label className="flex items-center justify-between gap-1 text-xs">
                    <span>
                      Display name{" "}
                      <span className="text-destructive">*</span>
                      <InfoTooltip
                        ariaLabel="What ARM does with the display name"
                        className="ml-1"
                        content={
                          <span className="text-xs">
                            Free-form label shown in the portal's
                            Subscriptions blade. Can be renamed later. Max{" "}
                            {DISPLAY_NAME_MAX} characters. ARM does NOT
                            enforce uniqueness across an enrollment.
                          </span>
                        }
                      />
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-2xs"
                      onClick={() => setDisplayName(suggestDisplayName())}
                      aria-label="Auto-fill a timestamp-suffixed display name"
                    >
                      <Sparkles className="h-3 w-3" /> Auto
                    </Button>
                  </Label>
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Dev Team Subscription"
                    className="text-xs"
                    maxLength={DISPLAY_NAME_MAX + 16 /* let user see overflow then truncate via validation */}
                    aria-invalid={
                      displayNameTooLong ||
                      (displayName.length > 0 && displayNameEmpty)
                        ? true
                        : undefined
                    }
                    aria-describedby="display-name-help"
                  />
                  <p
                    id="display-name-help"
                    className={
                      displayNameTooLong
                        ? "text-2xs text-destructive"
                        : "text-2xs text-muted-foreground"
                    }
                  >
                    {displayNameTooLong
                      ? `Too long — ${displayNameTrimmed.length} of ${DISPLAY_NAME_MAX} max characters.`
                      : `${displayNameTrimmed.length} / ${DISPLAY_NAME_MAX} characters`}
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="flex items-center gap-1 text-xs">
                    Offer type{" "}
                    <span className="text-destructive">*</span>
                    <InfoTooltip
                      ariaLabel="Difference between EA offer types"
                      content={
                        <span className="text-xs">
                          <strong>MS-AZR-0017P</strong> — standard EA
                          production pricing.<br />
                          <strong>MS-AZR-0148P</strong> — EA dev/test
                          pricing (must be enabled in the EA portal
                          first; if not, ARM returns "offer is not
                          enabled" on submit).
                        </span>
                      }
                    />
                  </Label>
                  <Select
                    value={offerType}
                    onValueChange={(v) =>
                      setOfferType(v as "MS-AZR-0017P" | "MS-AZR-0148P")
                    }
                  >
                    <SelectTrigger aria-label="Offer type">
                      <SelectValue placeholder="Select offer type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MS-AZR-0017P">
                        <span className="flex flex-col">
                          <span className="text-sm">
                            MS-AZR-0017P — Production
                          </span>
                          <span className="text-2xs text-muted-foreground">
                            Regular Microsoft Enterprise Agreement.
                          </span>
                        </span>
                      </SelectItem>
                      <SelectItem value="MS-AZR-0148P">
                        <span className="flex flex-col">
                          <span className="text-sm">
                            MS-AZR-0148P — Dev/Test
                          </span>
                          <span className="text-2xs text-muted-foreground">
                            EA dev/test pricing; must be enabled in the
                            EA portal first.
                          </span>
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Owners list */}
              <div className="flex flex-col gap-1.5">
                <Label className="flex items-center gap-1 text-xs">
                  Owners (optional — AAD object ids)
                  <InfoTooltip
                    ariaLabel="What ARM does with owners"
                    content={
                      <span className="text-xs">
                        Each entry is granted Azure RBAC{" "}
                        <strong>Owner</strong> on the new subscription as
                        part of the create call. Without any entries, only
                        the EA Account Owner is granted access; you can
                        add more via the Subscription's IAM blade later.
                      </span>
                    }
                  />
                </Label>
                <div className="flex items-stretch gap-2">
                  <Input
                    value={ownerInput}
                    onChange={(e) => setOwnerInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addOwner();
                      }
                    }}
                    placeholder="11111111-2222-3333-4444-555555555555"
                    className="font-mono text-xs"
                    aria-invalid={!ownersValid ? true : undefined}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addOwner}
                    disabled={!UUID_RE.test(ownerInput.trim())}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add
                  </Button>
                </div>
                {owners.length > 0 && (
                  <>
                    <ul className="mt-1 flex flex-wrap gap-1">
                      {owners.map((o) => (
                        <li
                          key={o}
                          className="group/copy inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 font-mono text-2xs"
                        >
                          <User className="h-3 w-3 text-muted-foreground" />
                          <span title={o}>{o.slice(0, 8)}…</span>
                          <CopyButton
                            value={o}
                            ariaLabel={`Copy owner ${o}`}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className="ml-1 h-4 w-4"
                            onClick={() => removeOwner(o)}
                            aria-label={`Remove owner ${o}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                    <div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="text-2xs"
                        onClick={clearOwners}
                        aria-label="Clear all owners"
                      >
                        <Trash2 className="h-3 w-3" /> Clear all
                      </Button>
                    </div>
                  </>
                )}
                <p className="text-2xs text-muted-foreground">
                  Object ids come from{" "}
                  <code className="font-mono">az ad user show</code>{" "}
                  or AAD's Users blade.
                </p>
              </div>

              {submitError && errorClass.deprecated && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <AlertDescription className="flex flex-col gap-2">
                    <span>
                      <strong>
                        "Commerce Account Is Null" — the legacy
                        2018-03-01-preview API is deprecated for your
                        enrollment.
                      </strong>{" "}
                      Newer EA enrollments don't register a commerce
                      account under the legacy namespace, so this
                      endpoint can't service them. Microsoft moved every
                      EA subscription creation onto the modern{" "}
                      <code className="font-mono">
                        /providers/Microsoft.Subscription/aliases
                      </code>{" "}
                      API.
                    </span>
                    <span className="text-2xs">
                      The <strong>Create EA Sub Quick</strong> page in
                      this WebUI already wraps that modern API and
                      supports the same enrollment-account billing scope
                      (plus cross-tenant ownership, dev/test flags,
                      etc.).
                    </span>
                    {autoPivotSec !== null && (
                      <span className="rounded-md border border-warning/40 bg-warning/15 px-2 py-1 text-2xs text-warning-foreground">
                        Auto-pivoting to EA Sub Quick in{" "}
                        <strong>{autoPivotSec}s</strong>… Press
                        <em> Stay here</em> to keep this page open (e.g.
                        to copy the raw error for a support ticket).
                      </span>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className="h-7 text-2xs"
                        onClick={() => {
                          cancelAutoPivot();
                          jumpToModernPage();
                        }}
                      >
                        <BadgeCheck className="h-3.5 w-3.5" /> Go to EA
                        Sub Quick now
                      </Button>
                      {autoPivotSec !== null && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-2xs"
                          onClick={cancelAutoPivot}
                        >
                          Stay here
                        </Button>
                      )}
                    </div>
                    <span className="break-all text-[10px] opacity-80">
                      Raw error: {submitError}
                    </span>
                  </AlertDescription>
                </Alert>
              )}
              {submitError &&
                errorClass.invalidOffer &&
                !errorClass.deprecated && (
                  <Alert variant="warning">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <AlertDescription className="flex flex-col gap-1 text-2xs">
                      <span>
                        <strong>
                          Offer "{offerType}" isn't enabled on this
                          enrollment.
                        </strong>{" "}
                        For{" "}
                        <code className="font-mono">MS-AZR-0148P</code>{" "}
                        this usually means the EA admin hasn't accepted
                        the Dev/Test addendum at{" "}
                        <a
                          href="https://ea.azure.com"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-primary underline-offset-2 hover:underline"
                        >
                          ea.azure.com
                        </a>
                        .
                      </span>
                      <span className="break-all opacity-80">
                        Raw error: {submitError}
                      </span>
                    </AlertDescription>
                  </Alert>
                )}
              {submitError &&
                errorClass.expired &&
                !errorClass.deprecated && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <AlertDescription className="flex flex-col gap-1 text-2xs">
                      <span>
                        <strong>
                          Enrollment is expired or inactive.
                        </strong>{" "}
                        ARM won't accept new subscriptions on a terminated
                        EA enrollment. Renew the enrollment in the EA
                        portal, or pick a different enrollment account.
                      </span>
                      <span className="break-all opacity-80">
                        Raw error: {submitError}
                      </span>
                    </AlertDescription>
                  </Alert>
                )}
              {submitError &&
                errorClass.forbidden &&
                !errorClass.deprecated &&
                !errorClass.invalidOffer &&
                !errorClass.expired && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <AlertDescription className="flex flex-col gap-1 text-2xs">
                      <span>
                        <strong>
                          403 Forbidden — caller isn't Owner on this
                          enrollment.
                        </strong>{" "}
                        The legacy API requires Owner-on-enrollment, NOT
                        the modern "EA Subscription Creator" billing
                        role. Promote the signed-in user to Owner in the
                        EA portal, or sign in with an Account-Owner
                        identity.
                      </span>
                      <span className="break-all opacity-80">
                        Raw error: {submitError}
                      </span>
                    </AlertDescription>
                  </Alert>
                )}
              {submitError &&
                errorClass.unauthorized &&
                !errorClass.deprecated && (
                  <Alert variant="warning">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <AlertDescription className="flex flex-col gap-1 text-2xs">
                      <span>
                        <strong>
                          401 Unauthorized — ARM token rejected.
                        </strong>{" "}
                        The token may have expired between page load and
                        submit. Click <strong>Refresh token</strong> in
                        the header badge and try again.
                      </span>
                      <div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-2xs"
                          onClick={() => void armTokenTracker.refresh()}
                        >
                          <RefreshCw className="h-3 w-3" /> Refresh token
                          now
                        </Button>
                      </div>
                      <span className="break-all opacity-80">
                        Raw error: {submitError}
                      </span>
                    </AlertDescription>
                  </Alert>
                )}
              {submitError && errorClass.throttled && (
                <Alert variant="warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <AlertDescription className="flex flex-col gap-1 text-2xs">
                    <span>
                      <strong>429 Throttled.</strong> ARM is rate-limiting
                      this enrollment. Wait 30-60 seconds and retry; if
                      you're scripting bulk creates, space them at least
                      a few seconds apart.
                    </span>
                    <span className="break-all opacity-80">
                      Raw error: {submitError}
                    </span>
                  </AlertDescription>
                </Alert>
              )}
              {submitError &&
                !errorClass.deprecated &&
                !errorClass.invalidOffer &&
                !errorClass.expired &&
                !errorClass.forbidden &&
                !errorClass.unauthorized &&
                !errorClass.throttled && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <AlertDescription>{submitError}</AlertDescription>
                  </Alert>
                )}

              {/* Pre-submit validation banner — surfaces every reason the
                  current draft can't be submitted, in priority order, so
                  the operator doesn't have to click Submit + read a tooltip
                  to find out. Hidden once the draft is fully valid. */}
              {validationIssues.length > 0 && (
                <Alert
                  variant={
                    validationIssues.some((i) => i.severity === "error")
                      ? "warning"
                      : "default"
                  }
                  role="status"
                  aria-live="polite"
                  aria-label="Pre-submit validation"
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <AlertDescription className="flex flex-col gap-1 text-2xs">
                    <span>
                      <strong>Almost ready.</strong>{" "}
                      {validationIssues.length === 1
                        ? "One thing left:"
                        : `${validationIssues.length} things left:`}
                    </span>
                    <ul
                      className="ml-4 list-disc"
                      aria-label="Outstanding validation issues"
                    >
                      {validationIssues.map((i) => (
                        <li
                          key={i.id}
                          className={
                            i.severity === "error"
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }
                        >
                          {i.text}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="default"
                  onClick={() => setConfirmOpen(true)}
                  disabled={!canSubmit}
                  loading={submitting}
                  aria-label="Create EA subscription"
                  aria-disabled={!canSubmit}
                  title={submitBlockedReason || undefined}
                >
                  {!submitting && <CheckCircle2 />}
                  {submitting ? "Creating…" : "Create subscription"}
                </Button>
                {!canSubmit && !submitting && submitBlockedReason && (
                  <span
                    className="text-2xs text-muted-foreground"
                    aria-live="polite"
                  >
                    {submitBlockedReason}
                  </span>
                )}
                {/* Lightweight "draft saved" indicator so the operator
                    knows their inputs survive a reload. */}
                {(displayNameTrimmed.length > 0 || owners.length > 0) && (
                  <span
                    className="ml-auto inline-flex items-center gap-1 text-2xs text-muted-foreground"
                    aria-label="Draft is saved locally"
                    title="Form contents are saved in this browser and will be restored after a reload."
                  >
                    <Save className="h-3 w-3" aria-hidden /> draft saved
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ----- API details / az command ---------------------- */}
          <details className="group rounded-lg border border-dashed border-border bg-card/50">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
              <Terminal className="h-3.5 w-3.5" />
              <span className="font-medium">API request preview</span>
              <span className="text-2xs opacity-70">
                — JSON body + equivalent <code>az rest</code> command
              </span>
            </summary>
            <div className="flex flex-col gap-3 border-t border-border/60 p-3">
              <div className="flex flex-col gap-1">
                <Label className="text-2xs uppercase tracking-wider text-muted-foreground">
                  POST URL
                </Label>
                <div className="group/copy flex items-start gap-2 rounded-md bg-muted/40 p-2">
                  <code className="flex-1 break-all font-mono text-2xs">
                    https://management.azure.com/providers/Microsoft.Billing/enrollmentAccounts/
                    {selectedEa.name}
                    /providers/Microsoft.Subscription/createSubscription?api-version=2018-03-01-preview
                  </code>
                  <CopyButton
                    value={`https://management.azure.com/providers/Microsoft.Billing/enrollmentAccounts/${selectedEa.name}/providers/Microsoft.Subscription/createSubscription?api-version=2018-03-01-preview`}
                    alwaysVisible
                    ariaLabel="Copy POST URL"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Request body
                </Label>
                <div className="group/copy relative">
                  <pre className="max-h-48 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-2xs">
                    {requestBodyPreview}
                  </pre>
                  <span className="absolute right-1 top-1">
                    <CopyButton
                      value={requestBodyPreview}
                      alwaysVisible
                      ariaLabel="Copy request body JSON"
                    />
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Equivalent shell command
                </Label>
                <div className="group/copy relative">
                  <pre className="max-h-32 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-2xs">
                    {azCommandPreview}
                  </pre>
                  <span className="absolute right-1 top-1">
                    <CopyButton
                      value={azCommandPreview}
                      alwaysVisible
                      ariaLabel="Copy az rest command"
                    />
                  </span>
                </div>
                <p className="text-2xs text-muted-foreground">
                  Single line so it pastes cleanly into PowerShell or
                  bash. Requires{" "}
                  <code className="font-mono">az login</code> with an
                  identity that has Owner on the enrollment account.
                </p>
              </div>
            </div>
          </details>

          <ConfirmationDialog
            hidden={!confirmOpen}
            title="Create legacy EA subscription?"
            danger
            confirmText="Create subscription"
            cancelText="Cancel"
            loading={submitting}
            onCancel={() => {
              if (!submitting) setConfirmOpen(false);
            }}
            onConfirm={async () => {
              await submit();
              setConfirmOpen(false);
            }}
            message={
              <div className="flex flex-col gap-2 text-sm">
                <Alert variant="warning" className="border-warning/40">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <AlertDescription className="text-2xs">
                    This will POST to the <strong>deprecated</strong>{" "}
                    2018-03-01-preview createSubscription endpoint and
                    charge the enrollment-account billing scope going
                    forward. If you don't have an automation requirement
                    pinned to this exact API shape, prefer the modern
                    alias API instead.
                  </AlertDescription>
                </Alert>
                <ul className="ml-4 list-disc text-xs text-muted-foreground">
                  <li>
                    Display name:{" "}
                    <strong>{displayNameTrimmed || "—"}</strong>
                  </li>
                  <li>
                    Offer type:{" "}
                    <code className="font-mono">{offerType}</code>
                  </li>
                  <li>
                    Enrollment account:{" "}
                    <code className="font-mono">{selectedEa.name}</code>
                  </li>
                  <li>Owners: {owners.length}</li>
                </ul>
                <details className="rounded-md border border-border/60 bg-muted/30">
                  <summary className="cursor-pointer px-2 py-1 text-2xs text-muted-foreground hover:text-foreground">
                    Show JSON request body
                  </summary>
                  <pre className="max-h-40 overflow-auto px-2 py-1 font-mono text-2xs">
                    {requestBodyPreview}
                  </pre>
                </details>
                <span className="text-2xs text-muted-foreground">
                  Subscriptions count toward the{" "}
                  {EA_SUBSCRIPTION_CAP.toLocaleString()}-per-enrollment
                  cap even after they are canceled or transferred.
                </span>
              </div>
            }
          />

          {/* ----- Result ------------------------------------------ */}
          {result && (
            <Card className="border-success/30 bg-success/5">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Check className="h-4 w-4 text-success" /> Done
                </CardTitle>
                <CardDescription className="text-2xs">
                  ARM returned HTTP {result.status}. Use the link below in
                  any portal / CLI to start using the subscription.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-xs">
                {result.subscriptionId && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="success" className="text-2xs">
                      Subscription
                    </Badge>
                    <CopyableText
                      value={result.subscriptionId}
                      mono
                      alwaysVisibleButton
                      ariaLabel="Copy subscription id"
                    />
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-2xs">
                    Enrollment account
                  </Badge>
                  <CopyableText
                    value={selectedEa.name}
                    mono
                    alwaysVisibleButton
                    ariaLabel="Copy enrollment-account object id"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-2xs">
                    Display name
                  </Badge>
                  <CopyableText
                    value={displayNameTrimmed}
                    alwaysVisibleButton
                    ariaLabel="Copy display name"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-2xs">
                    Offer type
                  </Badge>
                  <CopyableText
                    value={offerType}
                    mono
                    alwaysVisibleButton
                    ariaLabel="Copy offer type"
                  />
                </div>
                {result.subscriptionLink && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-2xs">
                      ARM link
                    </Badge>
                    <CopyableText
                      value={result.subscriptionLink}
                      mono
                      alwaysVisibleButton
                      ariaLabel="Copy ARM subscription link"
                    />
                    {result.subscriptionId && (
                      <a
                        href={`https://portal.azure.com/#@/resource/subscriptions/${result.subscriptionId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-sm text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="Open subscription in Azure portal"
                      >
                        <ExternalLink className="h-3 w-3" /> Open in
                        portal
                      </a>
                    )}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-2 border-t border-success/20 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={resetForm}
                    aria-label="Reset form to create another subscription"
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Create another
                  </Button>
                  {result.subscriptionId && (
                    // Use the shared CopyButton (handles async-API +
                    // execCommand fallback + "Copied" pulse + cleanup
                    // timeout) so this page doesn't reinvent clipboard
                    // handling. The onCopied hook surfaces a toast for
                    // parity with the previous bespoke button.
                    <span
                      className="inline-flex items-center gap-1 text-2xs"
                      aria-label="Copy subscription id action"
                    >
                      <CopyButton
                        value={result.subscriptionId}
                        ariaLabel="Copy subscription id to clipboard"
                        alwaysVisible
                        iconSize={14}
                        onCopied={(v) =>
                          store.addNotification({
                            type: "success",
                            message: `Copied subscription id ${v}.`,
                          })
                        }
                      />
                      Copy ID
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ----- Session timeline -------------------------------- */}
      {recentEntries.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <History className="h-4 w-4 text-primary" />
              Recent submissions ({sessionHistory.length})
            </CardTitle>
            <CardDescription className="text-2xs">
              Session-scoped — full list survives navigation within this
              tab but is wiped by a full reload. Export above for a
              permanent record.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5">
            {recentEntries.map((e) => (
              // Stable key: timestamp + display name + sub id (when
              // present) — unique within a session even if two entries
              // share the same timestamp at second resolution.
              <div
                key={`${e.timestamp}|${e.displayName}|${e.subscriptionId ?? "x"}`}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2 py-1 text-2xs"
              >
                <StatusBadge
                  status={e.outcome === "success" ? "success" : "error"}
                  label={e.outcome}
                />
                <span className="font-medium" title={e.displayName}>
                  {e.displayName}
                </span>
                <code className="font-mono opacity-70">{e.offerType}</code>
                <span className="text-muted-foreground">
                  {timeAgo(e.timestamp)}
                </span>
                {e.subscriptionId && (
                  <CopyableText
                    value={e.subscriptionId}
                    mono
                    ariaLabel={`Copy subscription id ${e.subscriptionId}`}
                  />
                )}
                {e.subscriptionId && (
                  <a
                    href={`https://portal.azure.com/#@/resource/subscriptions/${e.subscriptionId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Open in portal"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {e.error && (
                  <span
                    className="break-all text-destructive opacity-90"
                    title={e.error}
                  >
                    error: {e.error.slice(0, 60)}
                    {e.error.length > 60 ? "…" : ""}
                  </span>
                )}
              </div>
            ))}
            {sessionHistory.length > recentEntries.length && (
              <p className="text-2xs text-muted-foreground">
                Showing the last {recentEntries.length} of{" "}
                {sessionHistory.length}. Use{" "}
                <strong>Export</strong> in the page header for the full
                list.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ----- Legacy vs Modern reference ---------------------- */}
      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Info className="h-4 w-4 text-primary" />
            Legacy vs modern API at a glance
          </CardTitle>
          <CardDescription className="text-2xs">
            Quick cheat-sheet for picking the right page next time.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-auto">
          <table className="w-full min-w-[480px] text-2xs">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="px-2 py-1 font-medium">&nbsp;</th>
                <th className="px-2 py-1 font-medium">
                  Legacy (this page)
                </th>
                <th className="px-2 py-1 font-medium">
                  Modern (EA Sub Quick)
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              <tr>
                <td className="px-2 py-1 font-medium">API version</td>
                <td className="px-2 py-1 font-mono">2018-03-01-preview</td>
                <td className="px-2 py-1 font-mono">2021-10-01</td>
              </tr>
              <tr>
                <td className="px-2 py-1 font-medium">HTTP shape</td>
                <td className="px-2 py-1 font-mono">
                  POST /enrollmentAccounts/&#123;id&#125;/createSubscription
                </td>
                <td className="px-2 py-1 font-mono">
                  PUT /aliases/&#123;name&#125;
                </td>
              </tr>
              <tr>
                <td className="px-2 py-1 font-medium">Required role</td>
                <td className="px-2 py-1">Owner on enrollment account</td>
                <td className="px-2 py-1">
                  EA Subscription Creator on billing scope
                </td>
              </tr>
              <tr>
                <td className="px-2 py-1 font-medium">
                  Cross-tenant landing
                </td>
                <td className="px-2 py-1">Not supported</td>
                <td className="px-2 py-1">Supported</td>
              </tr>
              <tr>
                <td className="px-2 py-1 font-medium">Alias name</td>
                <td className="px-2 py-1">N/A</td>
                <td className="px-2 py-1">Required (user-chosen)</td>
              </tr>
              <tr>
                <td className="px-2 py-1 font-medium">
                  Workload flag (Production / DevTest)
                </td>
                <td className="px-2 py-1">Implicit via offer type</td>
                <td className="px-2 py-1">Explicit field</td>
              </tr>
              <tr>
                <td className="px-2 py-1 font-medium">Per-EA cap</td>
                <td className="px-2 py-1">
                  {EA_SUBSCRIPTION_CAP.toLocaleString()}{" "}
                  (counts canceled subs)
                </td>
                <td className="px-2 py-1">
                  {EA_SUBSCRIPTION_CAP.toLocaleString()} (same cap, alias
                  reuse possible)
                </td>
              </tr>
              <tr>
                <td className="px-2 py-1 font-medium">Status</td>
                <td className="px-2 py-1 text-warning">
                  Deprecated — frozen
                </td>
                <td className="px-2 py-1 text-success">
                  GA — recommended
                </td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ArrowRight className="h-4 w-4 text-primary" />
            Related pages
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => navigateToPage("/ea-subscription")}
            aria-label="Open Modern Create EA Sub (alias API)"
          >
            <BadgeCheck className="h-3.5 w-3.5" /> Modern Create EA Sub
            (alias API)
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => navigateToPage("/ea-sub-quick")}
            aria-label="Open EA Sub Quick"
          >
            <Sparkles className="h-3.5 w-3.5" /> EA Sub Quick
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => navigateToPage("/department-admin")}
            aria-label="Open Department Admin"
          >
            <Building2 className="h-3.5 w-3.5" /> Department Admin
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => navigateToPage("/ea-billing-manager")}
            aria-label="Open EA Billing Manager"
          >
            <Crown className="h-3.5 w-3.5" /> EA Billing Manager
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};
