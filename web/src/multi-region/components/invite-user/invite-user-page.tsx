/**
 * Invite User page — bulk B2B guest invitations via Microsoft Graph's
 * `/invitations` endpoint, with an optional follow-up Owner role grant on an
 * Azure subscription.
 *
 * What this page does (in order):
 *   1. Resolves a privileged inviter account (auto-detect via directory
 *      role probe, or manual pick — for tenants whose authorizationPolicy
 *      lets all members invite).
 *   2. Accepts a free-form email list (newline / comma / semicolon
 *      separated), parses it into a deduplicated, validated chip list, and
 *      lets the operator remove individual chips before submit.
 *   3. Submits invites with bounded concurrency (no fan-out storms even
 *      for 50+ recipients) and live per-row progress.
 *   4. Surfaces the redemption URL for every successful invite + one-click
 *      copy / open / TSV-of-all.
 *   5. Optionally assigns the Owner role at the chosen subscription
 *      scope to each newly-invited principal. Failed grants can be
 *      retried individually or in bulk afterwards.
 *
 * Things the page protects against (the inheriting requirements):
 *   - Race conditions: per-row updates are keyed by stable index (not by
 *     `email`, which used to mis-merge when the same address appeared
 *     more than once after a paste-reuse).
 *   - Stale ARM tokens during a long batch: `useArmToken` auto-refreshes
 *     ~60s before expiry. The badge in the header surfaces remaining time.
 *   - Mid-flight cancellation: the operator can stop a running batch
 *     without unmounting the page. Pending rows are marked "cancelled".
 *   - Idempotent re-runs: `assignSubscriptionRole` already handles
 *     `RoleAssignmentExists` — surfaced as "already had it".
 *   - Tenant pollution: invitation goes to the *inviter's* tenant, not
 *     the operator's active tenant. The selector caption spells out the
 *     destination tenantId so it's never ambiguous.
 *
 * Things explicitly NOT changed:
 *   - `useArmToken` + `TokenExpiryBadge` (preserved per spec).
 *   - Existing audit-log shape (`invite_guest`, `assign_subscription_role`).
 *   - No edits to services / store / shared components / page-router.
 */
import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Filter,
  Info,
  Key,
  Loader2,
  Mail,
  MailCheck,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  X,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { auditLog } from "../../services/audit-log";
import {
  getActiveTenant,
  getArmTokenForAccount,
  getGraphTokenForAccount,
  listAccessibleTenants,
} from "../../auth/msal-auth";
import { useArmToken } from "../../auth/use-arm-token";
import { useTenantChange } from "../../hooks/use-tenant-change";
import {
  assignSubscriptionRole,
  AZURE_ROLE_OWNER,
  createUser,
  getMyDirectoryRoles,
  inviteGuest,
  listSubscriptions,
  listVerifiedDomains,
  ROLE_GLOBAL_ADMIN,
  ROLE_USER_ADMIN,
} from "../../services";
import type { ArmSubscription, TenantInfo } from "../../services";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Guest Inviter directory role template id — least-privileged role with
 * User.Invite.All. Operators using this role specifically can drive the
 * invitation flow without holding broader user-management permissions.
 */
const ROLE_GUEST_INVITER = "95e79109-95c0-4d8e-aee3-d01accf2d47b";

/**
 * The full set of directory roles whose holders can issue invitations.
 * Anything outside this set will lack `User.Invite.All` and Graph will 403.
 */
const INVITE_ROLES = new Set<string>([
  ROLE_GUEST_INVITER,
  ROLE_GLOBAL_ADMIN,
  ROLE_USER_ADMIN,
]);

const DEFAULT_REDIRECT_URL = "https://myapplications.microsoft.com";

/** Common "where Graph drops a user after they consent" presets. */
const REDIRECT_PRESETS: ReadonlyArray<{ label: string; url: string }> = [
  { label: "My Apps (default)", url: "https://myapplications.microsoft.com" },
  { label: "Azure Portal", url: "https://portal.azure.com" },
  { label: "Microsoft 365", url: "https://www.office.com" },
  { label: "Teams", url: "https://teams.microsoft.com" },
];

/**
 * Maximum concurrent invite + Owner-grant operations.
 *
 * Sequential (1) was painfully slow for large batches (~1s per recipient
 * doing Graph POST + ARM PUT). Unbounded fan-out (Promise.all over 50
 * recipients) routinely got throttled by Graph's per-tenant ratelimits
 * and by ARM's role-assignment write-side throttling. A small bounded
 * pool of 4 keeps wall-clock low without tripping either limit in
 * practice; users can override via the UI slider.
 */
const DEFAULT_CONCURRENCY = 4;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 10;

const STORAGE_INVITER_MODE = "invite-user:inviter-mode";
const STORAGE_MANUAL_ACCOUNT = "invite-user:manual-account";
const STORAGE_LAST_SUBSCRIPTION = "invite-user:last-subscription";
const STORAGE_REDIRECT_URL = "invite-user:redirect-url";
const STORAGE_CONCURRENCY = "invite-user:concurrency";
const STORAGE_SEND_EMAIL = "invite-user:send-email";
const STORAGE_GRANT_OWNER = "invite-user:grant-owner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PrivilegedInviter {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
  /** Human-readable tenant label (e.g. "Contoso") when known. */
  tenantDisplayName?: string;
  /** True when this tenant is the account's home/issuing tenant. */
  isHomeTenant: boolean;
}

/**
 * Composite key used to address a (account, destination-tenant) pair in
 * the inviter selector. Stable, dedupes correctly across the N×M shape
 * of the new multi-tenant selector.
 */
function inviterKey(i: { homeAccountId: string; tenantId: string }): string {
  return `${i.homeAccountId}|${i.tenantId}`;
}

/**
 * Per-row outcome of a submitted invite batch. Keyed by stable index so
 * duplicate emails (legal in input — the parser dedups but we still
 * defensively avoid email-matching) don't cross-pollinate state writes.
 */
interface PerEmailOutcome {
  /** Stable row id — used as React key and to address mutations. */
  rowId: number;
  email: string;
  invite:
    | { state: "queued" }
    | { state: "running" }
    | {
        state: "success";
        userId: string;
        upn?: string;
        displayName?: string;
        redeemUrl: string;
        emailed: boolean;
        graphStatus?: string;
      }
    | { state: "failure"; error: string; errorCode?: string }
    | { state: "cancelled" };
  ownerGrant:
    | { state: "skipped" }
    | { state: "queued" }
    | { state: "running" }
    | { state: "success"; alreadyExisted: boolean }
    | { state: "failure"; error: string }
    | { state: "cancelled" };
}

/**
 * How the page resolves which signed-in account can issue an invite.
 *
 * `auto` is safe-by-default — probes every signed-in account's directory
 * roles and filters to the holders. But it produces false negatives in
 * tenants whose authorizationPolicy sets `allowInvitesFrom: everyone` or
 * `adminsGuestInvitersAndAllMembers`, where ANY member can invite without
 * holding a role. For those tenants the operator can switch to `manual`.
 */
type InviterMode = "auto" | "manual";

/** Status filters for the post-submit results card. */
type OutcomeStatusFilter = "all" | "success" | "failure" | "pending";

/** Column descriptors for the post-submit results export (CSV/JSON). */
const OUTCOME_EXPORT_COLUMNS: ReadonlyArray<ExportColumn<PerEmailOutcome>> = [
  { header: "Email", accessor: (o) => o.email },
  { header: "Invite status", accessor: (o) => o.invite.state },
  {
    header: "Invited user id",
    accessor: (o) => (o.invite.state === "success" ? o.invite.userId : ""),
  },
  {
    header: "Invited UPN",
    accessor: (o) =>
      o.invite.state === "success" ? (o.invite.upn ?? "") : "",
  },
  {
    header: "Display name",
    accessor: (o) =>
      o.invite.state === "success" ? (o.invite.displayName ?? "") : "",
  },
  {
    header: "Emailed by Microsoft",
    accessor: (o) =>
      o.invite.state === "success" ? (o.invite.emailed ? "yes" : "no") : "",
  },
  {
    header: "Redeem URL",
    accessor: (o) => (o.invite.state === "success" ? o.invite.redeemUrl : ""),
  },
  {
    header: "Graph status",
    accessor: (o) =>
      o.invite.state === "success" ? (o.invite.graphStatus ?? "") : "",
  },
  {
    header: "Invite error",
    accessor: (o) => (o.invite.state === "failure" ? o.invite.error : ""),
  },
  { header: "Owner grant status", accessor: (o) => o.ownerGrant.state },
  {
    header: "Owner grant alreadyExisted",
    accessor: (o) =>
      o.ownerGrant.state === "success" ? o.ownerGrant.alreadyExisted : "",
  },
  {
    header: "Owner grant error",
    accessor: (o) =>
      o.ownerGrant.state === "failure" ? o.ownerGrant.error : "",
  },
];

// ---------------------------------------------------------------------------
// sessionStorage helpers (safe no-op when storage is disabled / quota'd)
// ---------------------------------------------------------------------------

function readSession(key: string, fallback = ""): string {
  try {
    return sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* sessionStorage may be unavailable in private mode / disk-full */
  }
}

// ---------------------------------------------------------------------------
// Email parsing & classification
// ---------------------------------------------------------------------------

/**
 * RFC-5322-ish lite check: at least one `@`, no whitespace, has a dot in
 * the domain part, total length <= 254. Good enough for "did the operator
 * paste something that resembles an address" without false-rejecting
 * tagged addresses (`alice+work@example.com`) or unusual TLDs.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Optional "did the operator paste a tenant-internal address that
 * Microsoft will reject" heuristic. Returns a hint string (or null
 * if the address looks externally invitable).
 *
 * Today this is a single rule (.onmicrosoft.com), but the signature
 * leaves room for tenant-specific checks (e.g. "this address already
 * belongs to a member of the inviter's tenant").
 */
function inferInviteWarning(email: string): string | null {
  // .onmicrosoft.com addresses are tenant-internal — Graph rejects invites
  // targeting any onmicrosoft.com subdomain. Surface so the operator
  // doesn't waste a retry loop.
  const lower = email.toLowerCase();
  if (lower.endsWith(".onmicrosoft.com")) {
    return "Microsoft-managed (.onmicrosoft.com) — typically can't be invited as guest.";
  }
  return null;
}

/**
 * Parse a free-text block (newline / comma / semicolon / whitespace
 * separated) into deduplicated valid / invalid lists. Case is preserved
 * for display, but dedup is case-insensitive (most SMTP servers treat
 * the local part case-insensitively, and operators expect a paste
 * containing both `Alice@x` and `alice@X` to result in one chip).
 *
 * Returns the original index of each input token so duplicates can be
 * surfaced to the operator (e.g. "alice@example.com appears 3x — kept once").
 */
function parseEmailList(raw: string): {
  valid: string[];
  invalid: string[];
  duplicates: string[];
} {
  const seen = new Set<string>();
  const duplicateSet = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  const tokens = raw
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (seen.has(lower)) {
      duplicateSet.add(t);
      continue;
    }
    seen.add(lower);
    if (EMAIL_REGEX.test(t) && t.length <= 254) {
      valid.push(t);
    } else {
      invalid.push(t);
    }
  }
  return { valid, invalid, duplicates: Array.from(duplicateSet) };
}

// ---------------------------------------------------------------------------
// Bounded-concurrency runner
// ---------------------------------------------------------------------------

/**
 * Run `worker(item, index)` over `items` with at most `limit` in flight.
 * Resolves once every worker has settled. Errors per item are NOT
 * re-thrown — the worker is expected to record outcome itself; this
 * helper is just a scheduler.
 *
 * `shouldAbort` is checked between dispatches so a cancellation mid-batch
 * still leaves pending items "unstarted" rather than racing to completion.
 */
async function runBoundedConcurrent<T>(
  items: readonly T[],
  limit: number,
  shouldAbort: () => boolean,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const safeLimit = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(limit)));
  let cursor = 0;
  const inFlight: Promise<void>[] = [];
  const next = (): Promise<void> | null => {
    if (shouldAbort()) return null;
    const idx = cursor++;
    if (idx >= items.length) return null;
    const p = (async () => {
      try {
        await worker(items[idx]!, idx);
      } catch {
        /* worker swallows its own errors into per-row state */
      }
    })();
    return p;
  };
  for (let i = 0; i < safeLimit; i++) {
    const p = next();
    if (p) inFlight.push(p);
  }
  while (inFlight.length > 0) {
    const settled = await Promise.race(
      inFlight.map((p, i) => p.then(() => i)),
    );
    inFlight.splice(settled, 1);
    const followup = next();
    if (followup) inFlight.push(followup);
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const InviteUserPage: React.FC = () => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const azureAccounts = state.azureAccounts ?? [];

  // -------------------------------------------------------------------------
  // Inviter resolution: auto-detect (role probe) or manual pick.
  // -------------------------------------------------------------------------
  const [inviterMode, setInviterModeState] = React.useState<InviterMode>(() =>
    readSession(STORAGE_INVITER_MODE) === "manual" ? "manual" : "auto",
  );
  const [manualInviterId, setManualInviterIdState] = React.useState<string>(
    () => readSession(STORAGE_MANUAL_ACCOUNT),
  );

  const handleSetInviterMode = React.useCallback((mode: InviterMode) => {
    setInviterModeState(mode);
    writeSession(STORAGE_INVITER_MODE, mode);
  }, []);

  const handleSetManualInviterId = React.useCallback((id: string) => {
    setManualInviterIdState(id);
    writeSession(STORAGE_MANUAL_ACCOUNT, id);
  }, []);

  // Per-account map of every tenant the account can access via ARM. An
  // account that's a guest in N tenants will surface up to N entries
  // here — each one is a valid invitation destination (subject to the
  // role probe below). Populated lazily by `listAccessibleTenants`.
  const [accessibleTenantsByAccount, setAccessibleTenantsByAccount] =
    React.useState<Record<string, TenantInfo[]>>({});
  // Per (account, tenant) probe — true when the account holds an Invite
  // role in that tenant. Auto-detect mode filters the inviter list down
  // to entries where this is true. Manual mode ignores it entirely.
  const [privilegedTenantsByAccount, setPrivilegedTenantsByAccount] =
    React.useState<Record<string, Record<string, boolean>>>({});
  const [discovering, setDiscovering] = React.useState(true);

  const accountKey = React.useMemo(
    () =>
      azureAccounts
        .map((a) => `${a.homeAccountId}|${a.tenantId}`)
        .sort()
        .join(","),
    [azureAccounts],
  );

  React.useEffect(() => {
    if (azureAccounts.length === 0) {
      setDiscovering(false);
      return;
    }
    let cancelled = false;
    setDiscovering(true);
    (async () => {
      const tenantsResults: Record<string, TenantInfo[]> = {};
      const privilegedResults: Record<string, Record<string, boolean>> = {};

      await Promise.allSettled(
        azureAccounts.map(async (a) => {
          if (!a.homeAccountId) return;

          // ---- Phase 1: enumerate accessible tenants for this account.
          // Best-effort — a Graph-only / token-imported account may have
          // no ARM consent and 401 here. Fall back to the account's
          // home tenant so the operator can still pick it manually.
          let tenants: TenantInfo[] = [];
          try {
            tenants = await listAccessibleTenants(a.homeAccountId);
          } catch {
            tenants = [];
          }
          // ARM's /tenants occasionally omits the home tenant for guest-
          // primary accounts — synthesise an entry so the home tenant is
          // always offered as a destination.
          if (
            a.tenantId &&
            !tenants.some((t) => t.tenantId === a.tenantId)
          ) {
            tenants = [
              { tenantId: a.tenantId, displayName: a.tenantId },
              ...tenants,
            ];
          }
          tenantsResults[a.homeAccountId] = tenants;

          // ---- Phase 2: probe directory roles per tenant (auto mode).
          // Manual mode skips the probe — operator opts into showing
          // every accessible tenant regardless of role.
          if (inviterMode !== "auto") return;
          const tenantPrivileged: Record<string, boolean> = {};
          await Promise.allSettled(
            tenants.map(async (t) => {
              if (!t.tenantId) {
                return;
              }
              try {
                // forceRefresh: MSAL's silent cache may hold a Graph
                // token whose `tid` claim is the account's HOME tenant,
                // not `t.tenantId`. Silent acquire returns the cached
                // token ignoring authority — so getMyDirectoryRoles
                // would probe roles in the wrong tenant.
                const token = await getGraphTokenForAccount(
                  a.homeAccountId,
                  t.tenantId,
                  { forceRefresh: true },
                );
                const roles = await getMyDirectoryRoles(t.tenantId, token);
                tenantPrivileged[t.tenantId] = roles.some((r) =>
                  INVITE_ROLES.has(r.roleTemplateId),
                );
              } catch {
                tenantPrivileged[t.tenantId] = false;
              }
            }),
          );
          privilegedResults[a.homeAccountId] = tenantPrivileged;
        }),
      );

      if (!cancelled) {
        setAccessibleTenantsByAccount(tenantsResults);
        setPrivilegedTenantsByAccount(privilegedResults);
        setDiscovering(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountKey, azureAccounts, inviterMode]);

  /**
   * Flat list of every (account, destination-tenant) pair the operator
   * can invite from. Auto mode filters to pairs where the account holds
   * an Invite role; manual mode lists every accessible tenant.
   */
  const inviters: PrivilegedInviter[] = React.useMemo(() => {
    const out: PrivilegedInviter[] = [];
    for (const a of azureAccounts) {
      if (!a.homeAccountId) continue;
      // Default tenant set when ARM enumeration hasn't completed: just
      // the account's home tenant. Keeps the page usable while discovery
      // is racing.
      const tenants =
        accessibleTenantsByAccount[a.homeAccountId] ??
        (a.tenantId
          ? [{ tenantId: a.tenantId, displayName: a.tenantId } as TenantInfo]
          : []);
      for (const t of tenants) {
        if (!t.tenantId) continue;
        if (
          inviterMode === "auto" &&
          !privilegedTenantsByAccount[a.homeAccountId]?.[t.tenantId]
        ) {
          continue;
        }
        out.push({
          homeAccountId: a.homeAccountId,
          tenantId: t.tenantId,
          username: a.username,
          name: a.name || a.username,
          tenantDisplayName:
            t.displayName && t.displayName !== t.tenantId
              ? t.displayName
              : t.defaultDomain,
          isHomeTenant: t.tenantId === a.tenantId,
        });
      }
    }
    return out;
  }, [
    azureAccounts,
    accessibleTenantsByAccount,
    privilegedTenantsByAccount,
    inviterMode,
  ]);

  const [selectedInviterId, setSelectedInviterId] = React.useState<string>("");
  React.useEffect(() => {
    // Back-compat: if storage holds a legacy bare homeAccountId (pre
    // multi-tenant), upgrade by matching the FIRST inviter row for that
    // account. The operator can then re-pick a different destination
    // tenant if they want.
    const upgradedManualKey = (() => {
      if (!manualInviterId) return "";
      if (manualInviterId.includes("|")) return manualInviterId;
      const first = inviters.find((i) => i.homeAccountId === manualInviterId);
      return first ? inviterKey(first) : "";
    })();
    if (
      inviterMode === "manual" &&
      upgradedManualKey &&
      inviters.some((i) => inviterKey(i) === upgradedManualKey) &&
      selectedInviterId !== upgradedManualKey
    ) {
      setSelectedInviterId(upgradedManualKey);
      return;
    }
    if (!selectedInviterId && inviters.length > 0) {
      setSelectedInviterId(inviterKey(inviters[0]!));
    }
    if (
      selectedInviterId &&
      !inviters.some((i) => inviterKey(i) === selectedInviterId)
    ) {
      setSelectedInviterId(inviters.length > 0 ? inviterKey(inviters[0]!) : "");
    }
  }, [inviters, selectedInviterId, inviterMode, manualInviterId]);

  /**
   * Auto-sync the selected inviter row to the operator's active-tenant
   * choices. Solves two bugs the operator was hitting:
   *
   *   Bug 1 — single-account: switching active tenant globally (header
   *   switcher / Azure Accounts) didn't update the inviter row, so the
   *   invite silently went to the account's HOME tenant. Graph rejects
   *   with "domain is a verified domain of this directory" when the
   *   invitee's email is on a domain verified in the home tenant.
   *
   *   Bug 2 — multi-account: when the operator has accounts A and B
   *   signed in, switching account B's tenant should update the
   *   inviter row to (B, newTenant). The previous implementation used
   *   `selectedInviterAccountId` to pick which account to read active
   *   tenant for — but that's the CURRENTLY-SELECTED row's account,
   *   not the account whose tenant just changed. The result: B's
   *   tenant switch was silently ignored because A was still selected.
   *
   * Behaviour:
   *
   *   - Initial mount picks the inviter row matching the PRIMARY
   *     account's active tenant (the same account the header switcher
   *     pill represents). If there's no matching row (operator lacks
   *     invite-capable role in the active tenant), falls back to
   *     whatever the existing back-compat effect resolved to.
   *
   *   - On TENANT_CHANGED_EVENT, reads `detail.homeAccountId` and
   *     `detail.tenantId` DIRECTLY from the event — so a switch on
   *     ANY account flips the inviter row to match, even if that
   *     account isn't currently selected. (Predictable behaviour:
   *     "the tenant I just switched to is the one I want to invite
   *     into".)
   *
   *   - Both paths bail when no matching inviter row exists rather
   *     than overwriting with a bogus value — the inline warning
   *     Alert elsewhere on the page surfaces the mismatch.
   */
  const initialSyncDoneRef = React.useRef(false);
  React.useEffect(() => {
    if (initialSyncDoneRef.current) return;
    if (inviters.length === 0) return;
    const primaryAccount = azureAccounts[0];
    if (!primaryAccount) return;
    const activeTenantId = getActiveTenant(primaryAccount.homeAccountId);
    if (!activeTenantId) return;
    const candidate = `${primaryAccount.homeAccountId}|${activeTenantId}`;
    if (!inviters.some((i) => inviterKey(i) === candidate)) return;
    if (selectedInviterId === candidate) {
      initialSyncDoneRef.current = true;
      return;
    }
    setSelectedInviterId(candidate);
    if (inviterMode === "manual") {
      handleSetManualInviterId(candidate);
    }
    initialSyncDoneRef.current = true;
  }, [
    inviters,
    azureAccounts,
    selectedInviterId,
    inviterMode,
    handleSetManualInviterId,
  ]);

  // Live tenant-change propagation. Use detail.homeAccountId + detail
  // .tenantId DIRECTLY — that's the account whose tenant just changed,
  // which is the natural target for "switch the invite to use this".
  useTenantChange(undefined, (detail) => {
    const candidate = `${detail.homeAccountId}|${detail.tenantId}`;
    if (!inviters.some((i) => inviterKey(i) === candidate)) return;
    if (selectedInviterId === candidate) return;
    setSelectedInviterId(candidate);
    if (inviterMode === "manual") {
      handleSetManualInviterId(candidate);
    }
  });

  // -------------------------------------------------------------------------
  // Form state
  // -------------------------------------------------------------------------
  const [inviteeEmails, setInviteeEmails] = React.useState("");
  // Per-chip suppression — operator can remove individual emails from the
  // parsed list without re-typing the whole textarea. Stored as a lowercase
  // set since the parser dedups case-insensitively.
  const [suppressedEmails, setSuppressedEmails] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [displayName, setDisplayName] = React.useState("");
  const [customMessage, setCustomMessage] = React.useState("");
  const [redirectUrl, setRedirectUrl] = React.useState(() => {
    const saved = readSession(STORAGE_REDIRECT_URL);
    return saved || DEFAULT_REDIRECT_URL;
  });
  const [sendEmail, setSendEmail] = React.useState(
    () => readSession(STORAGE_SEND_EMAIL) === "1",
  );
  const [concurrency, setConcurrency] = React.useState<number>(() => {
    const raw = parseInt(readSession(STORAGE_CONCURRENCY, ""), 10);
    return Number.isFinite(raw) && raw >= MIN_CONCURRENCY && raw <= MAX_CONCURRENCY
      ? raw
      : DEFAULT_CONCURRENCY;
  });

  // Persist the bits that survive a reload.
  React.useEffect(() => {
    writeSession(STORAGE_REDIRECT_URL, redirectUrl);
  }, [redirectUrl]);
  React.useEffect(() => {
    writeSession(STORAGE_SEND_EMAIL, sendEmail ? "1" : "0");
  }, [sendEmail]);
  React.useEffect(() => {
    writeSession(STORAGE_CONCURRENCY, String(concurrency));
  }, [concurrency]);

  // -------------------------------------------------------------------------
  // Owner-grant section
  // -------------------------------------------------------------------------
  const [grantOwner, setGrantOwner] = React.useState(
    () => readSession(STORAGE_GRANT_OWNER, "1") === "1",
  );
  React.useEffect(() => {
    writeSession(STORAGE_GRANT_OWNER, grantOwner ? "1" : "0");
  }, [grantOwner]);

  const [subscriptions, setSubscriptions] = React.useState<ArmSubscription[]>(
    [],
  );
  const [subsLoading, setSubsLoading] = React.useState(false);
  const [subsError, setSubsError] = React.useState<string | null>(null);
  const [selectedSubscriptionId, setSelectedSubscriptionId] = React.useState<
    string
  >(() => readSession(STORAGE_LAST_SUBSCRIPTION));
  React.useEffect(() => {
    if (selectedSubscriptionId)
      writeSession(STORAGE_LAST_SUBSCRIPTION, selectedSubscriptionId);
  }, [selectedSubscriptionId]);

  // -------------------------------------------------------------------------
  // Submit-side state
  // -------------------------------------------------------------------------
  const [submitting, setSubmitting] = React.useState(false);
  const [bulkGrantInFlight, setBulkGrantInFlight] = React.useState(false);
  const [retryRowId, setRetryRowId] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [outcomes, setOutcomes] = React.useState<PerEmailOutcome[]>([]);
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const [outcomeFilter, setOutcomeFilter] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<OutcomeStatusFilter>(
    "all",
  );
  const [showConfirm, setShowConfirm] = React.useState(false);
  const [showBulkGrantConfirm, setShowBulkGrantConfirm] = React.useState(false);

  /**
   * Hard cancellation flag for the submit loop. We use a ref (not state)
   * because the inner async worker captures this object reference at
   * dispatch time — flipping `cancelledRef.current = true` from anywhere
   * (component unmount, "Cancel batch" button) stops further dispatches
   * AND lets in-flight ones see the flag and short-circuit cleanly.
   */
  const cancelledRef = React.useRef(false);
  React.useEffect(
    () => () => {
      cancelledRef.current = true;
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  const selectedInviter = inviters.find(
    (i) => inviterKey(i) === selectedInviterId,
  );

  const armTokenTracker = useArmToken(
    selectedInviter?.homeAccountId,
    selectedInviter?.tenantId,
  );

  // Reload subscription list when inviter (or its destination tenant)
  // changes. Pass the destination tenant explicitly so the listing
  // matches the tenant the operator just picked — without this the
  // ARM token would default to the per-account active tenant which can
  // diverge from the inviter destination after a multi-tenant pick.
  React.useEffect(() => {
    if (!selectedInviter) {
      setSubscriptions([]);
      return;
    }
    let cancelled = false;
    setSubsLoading(true);
    setSubsError(null);
    (async () => {
      try {
        // forceRefresh: MSAL's silent cache may return an ARM token
        // whose `tid` claim is for the account's HOME tenant instead
        // of `selectedInviter.tenantId`, causing listSubscriptions to
        // return the wrong tenant's subs.
        const armToken = await getArmTokenForAccount(
          selectedInviter.homeAccountId,
          selectedInviter.tenantId,
          { forceRefresh: true },
        );
        const subs = await listSubscriptions(armToken);
        if (cancelled) return;
        setSubscriptions(subs);
        // Auto-pick when there's exactly one subscription so the operator
        // doesn't have to interact with the dropdown.
        if (subs.length === 1) {
          setSelectedSubscriptionId(subs[0]!.subscriptionId);
        } else if (
          subs.length > 0 &&
          !subs.some((s) => s.subscriptionId === selectedSubscriptionId)
        ) {
          // Persisted sub isn't visible to this inviter — clear so the
          // dropdown shows the placeholder rather than a phantom id.
          setSelectedSubscriptionId("");
        }
      } catch (err) {
        if (cancelled) return;
        setSubsError(err instanceof Error ? err.message : String(err));
        setSubscriptions([]);
      } finally {
        if (!cancelled) setSubsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // selectedSubscriptionId intentionally excluded — re-running on its
    // own change would clobber the operator's pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInviter?.homeAccountId, selectedInviter?.tenantId]);

  /**
   * Active recipient list = parser output minus chips the operator
   * removed. Kept as a memo so chip-removal & textarea changes share
   * the same derivation pipeline.
   */
  const parsedEmails = React.useMemo(() => {
    const raw = parseEmailList(inviteeEmails);
    const activeValid = raw.valid.filter(
      (e) => !suppressedEmails.has(e.toLowerCase()),
    );
    return { ...raw, activeValid };
  }, [inviteeEmails, suppressedEmails]);

  /** Heuristic warnings for the active recipients (e.g. onmicrosoft.com). */
  const recipientWarnings = React.useMemo(() => {
    const warnings: Array<{ email: string; warning: string }> = [];
    for (const email of parsedEmails.activeValid) {
      const w = inferInviteWarning(email);
      if (w) warnings.push({ email, warning: w });
    }
    return warnings;
  }, [parsedEmails.activeValid]);

  /**
   * Verified-domain pre-flight check for the destination tenant.
   *
   * Graph's `POST /invitations` REQUIRES the invitee's email domain to
   * NOT be a verified domain of the inviter's tenant — if the domain
   * IS verified, the invitee should already exist as a member (or be
   * added via `POST /users`). Pre-fetching the verified-domain list
   * lets us flag conflicting recipients BEFORE the operator clicks
   * Submit, instead of letting Graph reject one row at a time.
   *
   * - Cache keyed by tenantId (per inviter) — domains are stable, no
   *   need to refetch on every render.
   * - Lazy: only fetches when an inviter is selected.
   * - Best-effort: a 403 / 401 just sets the cache to null, the
   *   pre-flight badges hide, and the operator falls back to the
   *   post-submit error path (which already has the verified-domain
   *   classifier).
   * - Re-fetches when the destination tenant changes (different
   *   inviter row picked OR active tenant flipped + auto-sync moved
   *   the row).
   */
  const [verifiedDomainsByTenant, setVerifiedDomainsByTenant] = React.useState<
    Record<string, string[] | null>
  >({});
  React.useEffect(() => {
    if (!selectedInviter) return;
    const tenantId = selectedInviter.tenantId;
    if (!tenantId) return;
    if (verifiedDomainsByTenant[tenantId] !== undefined) return; // cache hit
    let cancelled = false;
    void (async () => {
      try {
        // forceRefresh: domain-verification probe must hit the chosen
        // tenant — MSAL's silent cache could otherwise return the
        // home-tenant Graph token and we'd query the wrong tenant's
        // verifiedDomains, producing a misleading "domain conflict"
        // decision for the invite flow.
        const token = await getGraphTokenForAccount(
          selectedInviter.homeAccountId,
          tenantId,
          { forceRefresh: true },
        );
        const domains = await listVerifiedDomains(tenantId, token);
        if (cancelled) return;
        setVerifiedDomainsByTenant((prev) => ({
          ...prev,
          [tenantId]: domains.map((d) => d.name.toLowerCase()),
        }));
      } catch {
        if (cancelled) return;
        // Mark as "fetched but unavailable" so we don't retry the
        // probe on every render. The submit path's verified-domain
        // error classifier still fires post-Graph for these.
        setVerifiedDomainsByTenant((prev) => ({
          ...prev,
          [tenantId]: null,
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    selectedInviter,
    verifiedDomainsByTenant,
  ]);

  /**
   * Per-recipient verified-domain conflicts — emails whose domain
   * appears in the destination tenant's verified-domains list. These
   * WILL fail with `Request_BadRequest verified domain` if submitted
   * as an invitation; the operator should either remove them OR use
   * the "Add as members instead" path below.
   */
  const verifiedDomainConflicts = React.useMemo<string[]>(() => {
    if (!selectedInviter) return [];
    const verified = verifiedDomainsByTenant[selectedInviter.tenantId];
    if (!verified || verified.length === 0) return [];
    const out: string[] = [];
    for (const email of parsedEmails.activeValid) {
      const domain = email.split("@")[1]?.toLowerCase();
      if (domain && verified.includes(domain)) {
        out.push(email);
      }
    }
    return out;
  }, [
    parsedEmails.activeValid,
    selectedInviter,
    verifiedDomainsByTenant,
  ]);

  /**
   * "Add as members instead" fallback. When Graph won't B2B-invite
   * (domain is verified in destination), the appropriate API is
   * `POST /users` with a temporary password — exactly the same
   * primitive the Create User page uses. We auto-generate a strong
   * password and write the result to the existing per-row outcome
   * table so the operator sees password + UPN inline.
   */
  /**
   * Per-conflict results from "Add as members instead". Rendered in a
   * separate panel below the inviter card (NOT mixed into the invite
   * results table — different shape, different lifecycle, and the
   * password material needs its own copy affordances + hide-tokens
   * treatment).
   */
  interface AddMemberResult {
    email: string;
    ok: boolean;
    upn?: string;
    password?: string;
    userId?: string;
    error?: string;
  }
  const [addMemberResults, setAddMemberResults] = React.useState<
    AddMemberResult[]
  >([]);
  const [addingAsMembers, setAddingAsMembers] = React.useState(false);
  const handleAddAsMembers = React.useCallback(async () => {
    if (!selectedInviter || verifiedDomainConflicts.length === 0) return;
    setAddingAsMembers(true);
    setAddMemberResults([]);
    try {
      const tenantId = selectedInviter.tenantId;
      // forceRefresh: the create-user-in-destination-tenant flow only
      // succeeds when the Graph token's `tid` matches the destination
      // tenant. MSAL's silent cache may return a stale home-tenant
      // token whose audience/scopes match — would create the user in
      // the WRONG directory.
      const token = await getGraphTokenForAccount(
        selectedInviter.homeAccountId,
        tenantId,
        { forceRefresh: true },
      );
      // Strong-password generator — 20 chars, 4 character classes
      // guaranteed in the first 4 positions (which the AAD policy
      // engine usually scans).
      const genPw = (): string => {
        const lo = "abcdefghijkmnpqrstuvwxyz";
        const hi = "ABCDEFGHJKLMNPQRSTUVWXYZ";
        const dg = "23456789";
        const sy = "!@#$%^&*-_=+";
        const all = lo + hi + dg + sy;
        const buf = new Uint32Array(20);
        crypto.getRandomValues(buf);
        let pw = "";
        for (let i = 0; i < 20; i += 1) {
          pw += all[buf[i]! % all.length];
        }
        pw =
          lo[buf[0]! % lo.length] +
          hi[buf[1]! % hi.length] +
          dg[buf[2]! % dg.length] +
          sy[buf[3]! % sy.length] +
          pw.slice(4);
        return pw;
      };
      const tenantSuffix = selectedInviter.tenantDisplayName ?? tenantId;
      const results: AddMemberResult[] = [];
      for (const email of verifiedDomainConflicts) {
        try {
          const local = email.split("@")[0] ?? "user";
          const password = genPw();
          const result = await createUser(
            tenantId,
            {
              userPrincipalName: email,
              displayName: email,
              mailNickname: local,
              password,
              forceChangePasswordNextSignIn: true,
              accountEnabled: true,
            },
            token,
          );
          results.push({
            email,
            ok: true,
            upn: result.userPrincipalName,
            userId: result.id,
            password,
          });
          auditLog.record({
            actor: selectedInviter.username,
            action: "create_user_as_member_fallback",
            target: email,
            status: "success",
            details: {
              tenantId,
              userId: result.id,
              originalAction: "invite_guest",
              reason: "verified_domain_conflict",
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ email, ok: false, error: msg });
          auditLog.record({
            actor: selectedInviter.username,
            action: "create_user_as_member_fallback",
            target: email,
            status: "failure",
            error: msg,
            details: { tenantId },
          });
        }
      }
      setAddMemberResults(results);
      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;
      store.addNotification({
        type: okCount > 0 ? "success" : "error",
        message:
          `Add-as-member into ${tenantSuffix}: ${okCount} created, ${failCount} failed. ` +
          `Generated passwords are visible in the panel below — copy them before navigating away.`,
      });
    } finally {
      setAddingAsMembers(false);
    }
  }, [
    selectedInviter,
    verifiedDomainConflicts,
    store,
  ]);

  const redirectIsHttps = React.useMemo(() => {
    try {
      const u = new URL(redirectUrl.trim());
      return u.protocol === "https:";
    } catch {
      return false;
    }
  }, [redirectUrl]);

  const canSubmit =
    !submitting &&
    !!selectedInviter &&
    parsedEmails.activeValid.length > 0 &&
    redirectUrl.trim().length > 0 &&
    redirectIsHttps &&
    (!grantOwner || selectedSubscriptionId.length > 0);

  // -------------------------------------------------------------------------
  // Submit pipeline
  // -------------------------------------------------------------------------

  /**
   * Mutate a single row in the outcomes array by stable rowId. Avoids
   * the "match-by-email" bug where duplicate emails would cross-write
   * each other's state.
   */
  const updateRow = React.useCallback(
    (rowId: number, patch: Partial<PerEmailOutcome>) => {
      setOutcomes((prev) =>
        prev.map((o) => (o.rowId === rowId ? { ...o, ...patch } : o)),
      );
    },
    [],
  );

  /**
   * Process a single recipient row end-to-end: Graph invite, optional
   * Owner-grant. Cancellation-aware between the two phases.
   *
   * Tokens are pulled fresh at row-dispatch time so a long batch (5+
   * minutes) doesn't fail late rows with stale-token 401s. `useArmToken`
   * keeps MSAL warm in parallel.
   */
  const processOneRow = React.useCallback(
    async (
      row: PerEmailOutcome,
      inviter: PrivilegedInviter,
      opts: {
        sendEmail: boolean;
        displayName: string;
        customMessage: string;
        redirectUrl: string;
        grantOwner: boolean;
        subscriptionId: string;
      },
    ): Promise<void> => {
      if (cancelledRef.current) {
        updateRow(row.rowId, {
          invite: { state: "cancelled" },
          ownerGrant:
            row.ownerGrant.state === "skipped"
              ? row.ownerGrant
              : { state: "cancelled" },
        });
        return;
      }
      updateRow(row.rowId, { invite: { state: "running" } });

      // --- Invite step ----------------------------------------------------
      // `inviter.tenantId` is the EXACT tenant the operator picked from
      // the (account × accessible-tenant) selector — already per-row, NOT
      // the account's home. The auto-sync effect below keeps this row in
      // step with the global active tenant on switch, so by the time we
      // get here `inviter.tenantId` is always the right destination.
      //
      // `forceRefresh: true` is REQUIRED here. The Graph /invitations
      // endpoint isn't tenant-scoped in the URL — the destination tenant
      // comes from the access token's `tid` claim. MSAL's silent-acquire
      // cache may hold a previously-minted Graph token whose scopes
      // match, and silent acquire returns the cached token IGNORING the
      // requested `authority` parameter. Result: the invite is sent to
      // the cached token's tenant and the redeem URL points at that
      // (wrong) tenant. Forcing a refresh skips the silent cache and
      // mints a fresh token authority-scoped to `inviter.tenantId`.
      let invitedUserId: string | null = null;
      let inviteOk = false;
      try {
        const graphToken = await getGraphTokenForAccount(
          inviter.homeAccountId,
          inviter.tenantId,
          { forceRefresh: true },
        );
        const res = await inviteGuest(
          inviter.tenantId,
          {
            invitedUserEmailAddress: row.email,
            invitedUserDisplayName: opts.displayName.trim() || undefined,
            inviteRedirectUrl: opts.redirectUrl.trim(),
            sendInvitationMessage: opts.sendEmail,
            customizedMessageBody:
              opts.sendEmail && opts.customMessage.trim()
                ? opts.customMessage.trim()
                : undefined,
          },
          graphToken,
        );
        invitedUserId = res.invitedUser.id;
        inviteOk = true;
        updateRow(row.rowId, {
          invite: {
            state: "success",
            userId: res.invitedUser.id,
            upn: res.invitedUser.userPrincipalName,
            displayName: res.invitedUser.displayName,
            redeemUrl: res.inviteRedeemUrl,
            emailed: res.sendInvitationMessage,
            graphStatus: res.status,
          },
        });
        auditLog.record({
          actor: inviter.username,
          action: "invite_guest",
          target: row.email,
          status: "success",
          details: {
            tenantId: inviter.tenantId,
            invitedUserId: res.invitedUser.id,
            sendInvitationMessage: res.sendInvitationMessage,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Extract Graph error code from the message — used for hint UI.
        const codeMatch = /\b([A-Z][A-Za-z]+(?:Error|Exists|Denied)?)\b/.exec(
          msg,
        );
        // Classify the specific "domain is a verified domain of this
        // directory" 400 so the operator sees an actionable hint
        // instead of the raw Graph error. This fires when the
        // invitee's email belongs to a domain already verified in
        // the inviter's tenant — Graph requires an `addUser` instead
        // of an `invitation` in that case, OR the operator just
        // picked the wrong tenant (e.g. they meant to invite into a
        // sibling tenant where the email's domain isn't verified).
        const isVerifiedDomainError =
          /verified domain of this directory/i.test(msg) ||
          /Request_BadRequest.*verified domain/i.test(msg);
        const enrichedError = isVerifiedDomainError
          ? `${msg}\n\nHint: the invitee's email domain is verified in the destination tenant (${inviter.tenantDisplayName ?? inviter.tenantId}). Either (a) the user already exists as a member in this directory — invite them directly instead, or (b) you picked the wrong tenant — switch to a tenant where the email's domain is NOT verified (header tenant switcher / Azure Accounts page) and try again.`
          : msg;
        updateRow(row.rowId, {
          invite: {
            state: "failure",
            error: enrichedError,
            errorCode: isVerifiedDomainError
              ? "VerifiedDomainConflict"
              : codeMatch?.[1],
          },
        });
        auditLog.record({
          actor: inviter.username,
          action: "invite_guest",
          target: row.email,
          status: "failure",
          error: msg,
          details: {
            tenantId: inviter.tenantId,
            tenantDisplayName: inviter.tenantDisplayName,
            classification: isVerifiedDomainError
              ? "verified_domain_conflict"
              : undefined,
          },
        });
      }

      // --- Owner-grant step ----------------------------------------------
      if (!opts.grantOwner) return;
      if (!inviteOk || !invitedUserId) {
        updateRow(row.rowId, {
          ownerGrant: {
            state: "failure",
            error: "skipped — invite failed",
          },
        });
        return;
      }
      if (cancelledRef.current) {
        updateRow(row.rowId, { ownerGrant: { state: "cancelled" } });
        return;
      }
      updateRow(row.rowId, { ownerGrant: { state: "running" } });

      try {
        // Tenant pinned to the inviter's destination tenant so the role
        // assignment lands in the same tenant that issued the invite.
        // forceRefresh prevents MSAL's silent cache from handing back
        // a home-tenant ARM token — that would grant the role in the
        // WRONG tenant (or 401 if the sub belongs to a different one).
        const armToken = await getArmTokenForAccount(
          inviter.homeAccountId,
          inviter.tenantId,
          { forceRefresh: true },
        );
        const r = await assignSubscriptionRole(
          opts.subscriptionId,
          invitedUserId,
          AZURE_ROLE_OWNER,
          armToken,
          { principalType: "User" },
        );
        updateRow(row.rowId, {
          ownerGrant: {
            state: "success",
            alreadyExisted: r.alreadyExisted,
          },
        });
        auditLog.record({
          actor: inviter.username,
          action: "assign_subscription_role",
          target: row.email,
          status: "success",
          details: {
            subscriptionId: opts.subscriptionId,
            principalId: invitedUserId,
            roleDefinitionId: AZURE_ROLE_OWNER,
            roleLabel: "Owner",
            alreadyExisted: r.alreadyExisted,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        updateRow(row.rowId, {
          ownerGrant: { state: "failure", error: msg },
        });
        auditLog.record({
          actor: inviter.username,
          action: "assign_subscription_role",
          target: row.email,
          status: "failure",
          error: msg,
          details: {
            subscriptionId: opts.subscriptionId,
            principalId: invitedUserId,
            roleDefinitionId: AZURE_ROLE_OWNER,
            roleLabel: "Owner",
          },
        });
      }
    },
    [updateRow],
  );

  const submitInvites = React.useCallback(async () => {
    if (!selectedInviter || parsedEmails.activeValid.length === 0) return;
    cancelledRef.current = false;
    setSubmitting(true);
    setError(null);
    setCopiedKey(null);

    // Seed outcome rows with stable row ids. We freeze the recipient list
    // by reading from `parsedEmails.activeValid` once at submit time so
    // the form being edited mid-batch can't mutate the active queue.
    const rows: PerEmailOutcome[] = parsedEmails.activeValid.map(
      (email, i) => ({
        rowId: i,
        email,
        invite: { state: "queued" },
        ownerGrant: grantOwner
          ? { state: "queued" }
          : { state: "skipped" },
      }),
    );
    setOutcomes(rows);

    const subId = selectedSubscriptionId;
    const opts = {
      sendEmail,
      displayName,
      customMessage,
      redirectUrl,
      grantOwner,
      subscriptionId: subId,
    };

    auditLog.record({
      actor: selectedInviter.username,
      action: "invite_guest_batch_started",
      // Use a synthetic "@batch" target so the audit-log page's filter-by-target
      // can group all rows of a batch by the actor + this marker without
      // overflowing the column with a comma-joined list of 50 emails.
      target: `@batch:${rows.length}`,
      status: "success",
      details: {
        tenantId: selectedInviter.tenantId,
        recipientCount: rows.length,
        recipients: rows.map((r) => r.email),
        grantOwner,
        subscriptionId: grantOwner ? subId : undefined,
        sendInvitationMessage: sendEmail,
        concurrency,
      },
    });

    await runBoundedConcurrent(
      rows,
      concurrency,
      () => cancelledRef.current,
      async (row) => {
        await processOneRow(row, selectedInviter, opts);
      },
    );

    // Final cancelled fan-out: any row still queued at this point was
    // never dispatched (operator hit Cancel mid-batch). Flip them so
    // the UI doesn't sit on "queued" forever.
    setOutcomes((prev) =>
      prev.map((o) =>
        o.invite.state === "queued"
          ? {
              ...o,
              invite: { state: "cancelled" },
              ownerGrant:
                o.ownerGrant.state === "queued"
                  ? { state: "cancelled" }
                  : o.ownerGrant,
            }
          : o,
      ),
    );

    setSubmitting(false);

    // Headline toast — keep it short; the per-row UI carries the detail.
    setOutcomes((prev) => {
      const succeeded = prev.filter((o) => o.invite.state === "success").length;
      const failed = prev.filter((o) => o.invite.state === "failure").length;
      const cancelled = prev.filter((o) => o.invite.state === "cancelled")
        .length;
      const ownerOk = prev.filter((o) => o.ownerGrant.state === "success")
        .length;
      const ownerFail = prev.filter((o) => o.ownerGrant.state === "failure")
        .length;
      const bits: string[] = [];
      bits.push(`Invited ${succeeded} of ${prev.length}`);
      if (failed > 0) bits.push(`${failed} invite failed`);
      if (cancelled > 0) bits.push(`${cancelled} cancelled`);
      if (grantOwner) {
        bits.push(`Owner granted ${ownerOk}`);
        if (ownerFail > 0) bits.push(`${ownerFail} grant failed`);
      }
      store.addNotification({
        type:
          cancelledRef.current
            ? "warning"
            : failed > 0 || ownerFail > 0
              ? "warning"
              : "success",
        message: bits.join(" · "),
      });
      return prev;
    });
  }, [
    selectedInviter,
    parsedEmails.activeValid,
    displayName,
    customMessage,
    redirectUrl,
    sendEmail,
    grantOwner,
    selectedSubscriptionId,
    concurrency,
    processOneRow,
    store,
  ]);

  /**
   * Retry a single failed invite row (or its owner-grant if the invite
   * succeeded but the grant failed). We re-use `processOneRow` and reset
   * the relevant state to "queued" first so the spinners reappear.
   */
  const retryRow = React.useCallback(
    async (rowId: number) => {
      if (!selectedInviter) return;
      const target = outcomes.find((o) => o.rowId === rowId);
      if (!target) return;
      setRetryRowId(rowId);
      const inviteFailed = target.invite.state === "failure";
      const ownerFailed = target.ownerGrant.state === "failure";
      const inviteSucceeded = target.invite.state === "success";

      try {
        if (inviteFailed) {
          // Full re-run: invite + (optionally) owner.
          updateRow(rowId, {
            invite: { state: "queued" },
            ownerGrant: grantOwner
              ? { state: "queued" }
              : { state: "skipped" },
          });
          cancelledRef.current = false;
          await processOneRow(target, selectedInviter, {
            sendEmail,
            displayName,
            customMessage,
            redirectUrl,
            grantOwner,
            subscriptionId: selectedSubscriptionId,
          });
        } else if (ownerFailed && inviteSucceeded) {
          // Owner-grant-only retry — re-grant against the already-invited
          // principal id, no second invite POST.
          const invitedUserId =
            target.invite.state === "success" ? target.invite.userId : null;
          if (!invitedUserId || !selectedSubscriptionId) {
            updateRow(rowId, {
              ownerGrant: {
                state: "failure",
                error: "no subscription / principal id for retry",
              },
            });
            return;
          }
          updateRow(rowId, { ownerGrant: { state: "running" } });
          try {
            // Tenant pinned to the inviter's destination tenant (same
            // reason as the primary submit path — keep the assignment
            // and the invite in the same tenant). forceRefresh skips
            // MSAL's silent cache so we don't accidentally grant in
            // the home tenant.
            const armToken = await getArmTokenForAccount(
              selectedInviter.homeAccountId,
              selectedInviter.tenantId,
              { forceRefresh: true },
            );
            const r = await assignSubscriptionRole(
              selectedSubscriptionId,
              invitedUserId,
              AZURE_ROLE_OWNER,
              armToken,
              { principalType: "User" },
            );
            updateRow(rowId, {
              ownerGrant: {
                state: "success",
                alreadyExisted: r.alreadyExisted,
              },
            });
            auditLog.record({
              actor: selectedInviter.username,
              action: "assign_subscription_role",
              target: target.email,
              status: "success",
              details: {
                subscriptionId: selectedSubscriptionId,
                principalId: invitedUserId,
                roleDefinitionId: AZURE_ROLE_OWNER,
                roleLabel: "Owner",
                alreadyExisted: r.alreadyExisted,
                retry: true,
              },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            updateRow(rowId, {
              ownerGrant: { state: "failure", error: msg },
            });
            auditLog.record({
              actor: selectedInviter.username,
              action: "assign_subscription_role",
              target: target.email,
              status: "failure",
              error: msg,
              details: {
                subscriptionId: selectedSubscriptionId,
                principalId: invitedUserId,
                roleDefinitionId: AZURE_ROLE_OWNER,
                roleLabel: "Owner",
                retry: true,
              },
            });
          }
        }
      } finally {
        setRetryRowId(null);
      }
    },
    [
      outcomes,
      selectedInviter,
      grantOwner,
      sendEmail,
      displayName,
      customMessage,
      redirectUrl,
      selectedSubscriptionId,
      processOneRow,
      updateRow,
    ],
  );

  /**
   * Bulk Owner-grant against ALL successfully-invited principals that
   * don't yet have a successful grant. Useful when the operator forgot
   * to pre-tick "Grant Owner" or wants to retry every failed grant in
   * one go.
   *
   * Requires `selectedSubscriptionId` — if blank, the operator is
   * prompted to pick one before the action enables.
   */
  const bulkGrantOwner = React.useCallback(async () => {
    if (!selectedInviter || !selectedSubscriptionId) return;
    const candidates = outcomes.filter(
      (o) =>
        o.invite.state === "success" &&
        o.ownerGrant.state !== "success" &&
        o.ownerGrant.state !== "running",
    );
    if (candidates.length === 0) return;
    setBulkGrantInFlight(true);

    try {
      // Tenant pinned to the inviter's destination tenant so bulk
      // grants land in the same tenant the invitations were issued in.
      // forceRefresh: bulk-grant operates on already-invited principals
      // in the inviter's destination tenant; MSAL silent cache could
      // hand back a home-tenant ARM token and cause every grant in the
      // bulk to fire against the wrong tenant.
      const armToken = await getArmTokenForAccount(
        selectedInviter.homeAccountId,
        selectedInviter.tenantId,
        { forceRefresh: true },
      );
      await runBoundedConcurrent(
        candidates,
        concurrency,
        () => false,
        async (o) => {
          if (o.invite.state !== "success") return;
          updateRow(o.rowId, { ownerGrant: { state: "running" } });
          try {
            const r = await assignSubscriptionRole(
              selectedSubscriptionId,
              o.invite.userId,
              AZURE_ROLE_OWNER,
              armToken,
              { principalType: "User" },
            );
            updateRow(o.rowId, {
              ownerGrant: {
                state: "success",
                alreadyExisted: r.alreadyExisted,
              },
            });
            auditLog.record({
              actor: selectedInviter.username,
              action: "assign_subscription_role",
              target: o.email,
              status: "success",
              details: {
                subscriptionId: selectedSubscriptionId,
                principalId: o.invite.userId,
                roleDefinitionId: AZURE_ROLE_OWNER,
                roleLabel: "Owner",
                alreadyExisted: r.alreadyExisted,
                bulkGrant: true,
              },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            updateRow(o.rowId, {
              ownerGrant: { state: "failure", error: msg },
            });
            auditLog.record({
              actor: selectedInviter.username,
              action: "assign_subscription_role",
              target: o.email,
              status: "failure",
              error: msg,
              details: {
                subscriptionId: selectedSubscriptionId,
                principalId: o.invite.userId,
                roleDefinitionId: AZURE_ROLE_OWNER,
                roleLabel: "Owner",
                bulkGrant: true,
              },
            });
          }
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.addNotification({
        type: "error",
        message: `Bulk Owner grant failed: ${msg}`,
      });
    } finally {
      setBulkGrantInFlight(false);
    }
  }, [
    outcomes,
    selectedInviter,
    selectedSubscriptionId,
    concurrency,
    updateRow,
    store,
  ]);

  /** Clipboard helper with toast-on-fallback. */
  const copyText = React.useCallback(
    async (text: string, key: string) => {
      if (!text) return;
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        // Fallback: dummy textarea (works in non-secure contexts too).
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "absolute";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand("copy");
          document.body.removeChild(ta);
        } catch {
          ok = false;
        }
      }
      if (ok) {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1800);
      } else {
        store.addNotification({
          type: "error",
          message: "Could not write to clipboard.",
        });
      }
    },
    [store],
  );

  /** Build the TSV header + rows for the "copy all redeem URLs" shortcut. */
  const buildRedeemUrlTsv = React.useCallback((): string => {
    const lines = ["Email\tUPN\tEmailed\tRedeem URL"];
    for (const o of outcomes) {
      if (o.invite.state !== "success") continue;
      lines.push(
        [
          o.email,
          o.invite.upn ?? "",
          o.invite.emailed ? "yes" : "no",
          o.invite.redeemUrl,
        ].join("\t"),
      );
    }
    return lines.join("\n");
  }, [outcomes]);

  const resetForm = React.useCallback(() => {
    setInviteeEmails("");
    setSuppressedEmails(new Set());
    setDisplayName("");
    setCustomMessage("");
    setError(null);
    setOutcomes([]);
    setCopiedKey(null);
    setOutcomeFilter("");
    setStatusFilter("all");
  }, []);

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  const inviterModeBar = (
    <Card className="border-border/60 bg-surface-sunken/30">
      <CardContent className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            Inviter discovery
            <InfoTooltip
              size={12}
              content={
                <div className="space-y-1.5">
                  <p className="m-0 text-xs">
                    <strong>Auto-detect</strong> probes each signed-in
                    account&apos;s directory roles and keeps the ones holding
                    Guest Inviter, User Administrator, or Global Administrator.
                  </p>
                  <p className="m-0 text-xs">
                    <strong>Manual pick</strong> skips the probe — useful when
                    the tenant&apos;s authorizationPolicy lets every member
                    invite, where the probe would otherwise return no
                    candidates.
                  </p>
                </div>
              }
              ariaLabel="About inviter discovery modes"
            />
          </span>
          <span className="text-2xs text-muted-foreground">
            {inviterMode === "auto"
              ? "Filtering to (account, tenant) pairs where the account holds Guest Inviter / User Admin / Global Admin."
              : "Showing every (account, tenant) pair the operator can reach. Graph will accept or reject the invite based on the chosen account's actual rights in the chosen tenant."}
          </span>
        </div>
        <div
          role="radiogroup"
          aria-label="Inviter discovery mode"
          className="inline-flex rounded-md border border-border bg-background p-0.5"
        >
          <Button
            type="button"
            role="radio"
            aria-checked={inviterMode === "auto"}
            size="sm"
            variant={inviterMode === "auto" ? "default" : "ghost"}
            className="h-7 px-3 text-xs"
            onClick={() => handleSetInviterMode("auto")}
          >
            Auto-detect
          </Button>
          <Button
            type="button"
            role="radio"
            aria-checked={inviterMode === "manual"}
            size="sm"
            variant={inviterMode === "manual" ? "default" : "ghost"}
            className="h-7 px-3 text-xs"
            onClick={() => handleSetInviterMode("manual")}
          >
            Manual pick
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  // -------------------------------------------------------------------------
  // Loading / empty states
  // -------------------------------------------------------------------------

  if (discovering && azureAccounts.length > 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Invite User"
          description="Send a B2B invitation so an external user can join one of your tenants."
        />
        {inviterModeBar}
        <Card>
          <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            Enumerating accessible tenants and checking which (account,
            tenant) pairs can issue invitations…
          </CardContent>
        </Card>
      </div>
    );
  }

  if (inviters.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Invite User"
          description="Send a B2B invitation so an external user can join one of your tenants. Requires Guest Inviter, User Administrator, or Global Administrator on the inviting account — OR a tenant policy that lets all members invite (toggle Manual pick to bypass the role probe)."
        />
        {inviterModeBar}
        <EmptyState
          icon={ShieldCheck}
          title={
            inviterMode === "auto"
              ? "No (account, tenant) pair can invite users"
              : "No signed-in accounts"
          }
          description={
            inviterMode === "auto"
              ? "None of the signed-in accounts hold a directory role with User.Invite.All in any tenant they can reach. If a target tenant's authorizationPolicy lets all members invite, switch to Manual pick above to surface every accessible (account, tenant) pair."
              : "Sign in with at least one account, then come back here."
          }
          action={
            inviterMode === "auto"
              ? {
                  label: "Switch to manual pick",
                  onClick: () => handleSetInviterMode("manual"),
                  icon: UserPlus,
                }
              : undefined
          }
        />
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Main render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Invite User"
        description="Email a B2B invitation, or copy the redemption URL and hand it over via your own channel. Supports bulk paste, concurrent dispatch, and a follow-up Owner role grant."
      >
        <TokenExpiryBadge
          secondsUntilExpiry={armTokenTracker.secondsUntilExpiry}
          loading={armTokenTracker.loading}
          onRefresh={() => void armTokenTracker.refresh()}
          needsReauth={armTokenTracker.needsReauth}
          onReauth={() =>
            void armTokenTracker.reauth({
              tenantId: selectedInviter?.tenantId,
              loginHint: selectedInviter?.username,
            })
          }
        />
      </PageHeader>

      {inviterModeBar}

      {/* ===================================================================
          Form card
          =================================================================== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4 text-primary" />
            New invitation
          </CardTitle>
          <CardDescription>
            The invitation is created in the inviter&apos;s tenant. The
            invitee opens the redemption URL, signs in (or signs up), and
            consents — they then appear as a guest under{" "}
            <code className="font-mono">#EXT#</code> in that tenant.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* ---------- Emails textarea + chip preview ---------------- */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="invite-emails" className="flex items-center gap-1.5">
                Emails to invite{" "}
                <span className="text-destructive">*</span>
                <InfoTooltip
                  size={12}
                  content={
                    <div className="space-y-1.5">
                      <p className="m-0 text-xs">
                        Paste one address per line, or comma / semicolon
                        separated. Duplicates are merged. Invalid tokens
                        are surfaced below but never submitted.
                      </p>
                      <p className="m-0 text-xs">
                        Each valid address becomes a removable chip — strike
                        out a chip to exclude that recipient without re-typing
                        the whole textarea.
                      </p>
                    </div>
                  }
                  ariaLabel="About bulk email input"
                />
              </Label>
              {(parsedEmails.valid.length > 0 || inviteeEmails.length > 0) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setInviteeEmails("");
                    setSuppressedEmails(new Set());
                  }}
                  disabled={submitting}
                  className="text-2xs"
                  aria-label="Clear all recipients"
                >
                  <Trash2 />
                  Clear
                </Button>
              )}
            </div>
            <textarea
              id="invite-emails"
              autoComplete="off"
              spellCheck={false}
              placeholder={
                "alice@example.com\nbob@example.com, carol@example.com"
              }
              value={inviteeEmails}
              onChange={(e) => setInviteeEmails(e.target.value)}
              disabled={submitting}
              rows={4}
              className="flex min-h-[88px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              aria-describedby="invite-emails-summary"
            />
            <p
              id="invite-emails-summary"
              className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground"
            >
              <Users className="h-3 w-3" aria-hidden />
              <span>
                One per line — or comma / semicolon-separated. Case-insensitive
                deduplication.
              </span>
              {parsedEmails.activeValid.length > 0 && (
                <Badge variant="success" className="text-2xs">
                  {parsedEmails.activeValid.length} to send
                </Badge>
              )}
              {suppressedEmails.size > 0 && (
                <Badge variant="outline" className="text-2xs">
                  {suppressedEmails.size} excluded
                </Badge>
              )}
              {parsedEmails.duplicates.length > 0 && (
                <Badge variant="secondary" className="text-2xs">
                  {parsedEmails.duplicates.length} duplicate
                  {parsedEmails.duplicates.length === 1 ? "" : "s"} merged
                </Badge>
              )}
              {parsedEmails.invalid.length > 0 && (
                <Badge variant="destructive" className="text-2xs">
                  {parsedEmails.invalid.length} invalid: skipped
                </Badge>
              )}
            </p>

            {/* Chip-list preview — visible whenever any address has been
                parsed. Clicking a chip's × removes it from the active set
                without mangling the textarea content. */}
            {parsedEmails.valid.length > 0 && (
              <div
                role="list"
                aria-label="Parsed recipients"
                className="flex flex-wrap gap-1.5 rounded-md border border-dashed border-border bg-muted/20 p-2"
              >
                {parsedEmails.valid.map((email) => {
                  const isSuppressed = suppressedEmails.has(email.toLowerCase());
                  return (
                    <span
                      key={email}
                      role="listitem"
                      className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors ${
                        isSuppressed
                          ? "border-border bg-muted/50 text-muted-foreground line-through"
                          : "border-success/30 bg-success/10 text-success"
                      }`}
                    >
                      <Mail className="h-3 w-3 shrink-0" aria-hidden />
                      <code className="truncate font-mono text-2xs">
                        {email}
                      </code>
                      <button
                        type="button"
                        onClick={() => {
                          setSuppressedEmails((prev) => {
                            const next = new Set(prev);
                            if (isSuppressed) {
                              next.delete(email.toLowerCase());
                            } else {
                              next.add(email.toLowerCase());
                            }
                            return next;
                          });
                        }}
                        disabled={submitting}
                        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        aria-label={
                          isSuppressed
                            ? `Re-include ${email}`
                            : `Exclude ${email} from this batch`
                        }
                        title={
                          isSuppressed
                            ? `Re-include ${email}`
                            : `Exclude ${email}`
                        }
                      >
                        {isSuppressed ? (
                          <Plus className="h-2.5 w-2.5" aria-hidden />
                        ) : (
                          <X className="h-2.5 w-2.5" aria-hidden />
                        )}
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            {parsedEmails.invalid.length > 0 && (
              <p className="break-words text-2xs text-destructive">
                Not invited: {parsedEmails.invalid.join(", ")}
              </p>
            )}

            {recipientWarnings.length > 0 && (
              <Alert variant="default" className="border-warning/40 bg-warning/5">
                <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />
                <AlertDescription>
                  <span className="font-medium text-warning">
                    Heads up — {recipientWarnings.length} address
                    {recipientWarnings.length === 1 ? "" : "es"} may not be
                    invitable:
                  </span>
                  <ul className="mt-1 space-y-0.5 text-2xs">
                    {recipientWarnings.map((w) => (
                      <li key={w.email}>
                        <code className="font-mono">{w.email}</code> —{" "}
                        {w.warning}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
          </div>

          {/* ---------- Inviter selector ------------------------------- */}
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="invite-inviter"
              className="flex items-center gap-1.5"
            >
              Inviting account &amp; destination tenant{" "}
              <span className="text-destructive">*</span>
              <InfoTooltip
                size={12}
                content="Each row pairs a signed-in account with one of the tenants it can reach. The invitation is created in the tenant you pick here — accounts that are guests in multiple tenants surface one row per tenant so you can target each directory directly."
                ariaLabel="About inviting account"
              />
            </Label>
            <Select
              value={selectedInviterId}
              onValueChange={(v) => {
                setSelectedInviterId(v);
                if (inviterMode === "manual") handleSetManualInviterId(v);
              }}
              disabled={submitting}
            >
              <SelectTrigger id="invite-inviter">
                <SelectValue placeholder="Select an account + tenant" />
              </SelectTrigger>
              <SelectContent>
                {inviters.map((i) => {
                  const k = inviterKey(i);
                  const tenantLabel = i.tenantDisplayName
                    ? `${i.tenantDisplayName} (${(i.tenantId ?? "").slice(0, 8)}…)`
                    : (i.tenantId ?? "").length > 8
                      ? `${(i.tenantId ?? "").slice(0, 8)}…`
                      : i.tenantId || "—";
                  return (
                    <SelectItem key={k} value={k}>
                      <div className="flex flex-col">
                        <span className="font-medium">
                          {i.name}
                          <span className="ml-1 text-2xs font-normal text-muted-foreground">
                            → {tenantLabel}
                          </span>
                          {i.isHomeTenant ? (
                            <Badge
                              variant="outline"
                              className="ml-1.5 px-1 py-0 text-3xs"
                            >
                              home
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="ml-1.5 px-1 py-0 text-3xs"
                            >
                              guest
                            </Badge>
                          )}
                        </span>
                        <span className="text-2xs text-muted-foreground">
                          {i.username}
                        </span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {selectedInviter && (
              <p className="flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
                <Info className="h-3 w-3" aria-hidden />
                <span>Guests will join tenant</span>
                {selectedInviter.tenantDisplayName && (
                  <span className="font-medium text-foreground">
                    {selectedInviter.tenantDisplayName}
                  </span>
                )}
                <CopyableText
                  value={selectedInviter.tenantId}
                  mono
                  alwaysVisibleButton
                  ariaLabel="Copy tenant id"
                />
                {!selectedInviter.isHomeTenant && (
                  <Badge variant="secondary" className="text-3xs">
                    cross-tenant — inviter is a guest in this directory
                  </Badge>
                )}
              </p>
            )}
            {/* Verified-domain pre-flight warning. Catches the
                Request_BadRequest "domain is a verified domain of this
                directory" 400 BEFORE the operator hits Submit. */}
            {selectedInviter &&
              verifiedDomainConflicts.length > 0 && (
                <Alert variant="warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <AlertDescription className="flex flex-col gap-2 text-2xs">
                    <span>
                      <strong>
                        {verifiedDomainConflicts.length} recipient
                        {verifiedDomainConflicts.length === 1 ? "" : "s"}{" "}
                        cannot be B2B-invited
                      </strong>{" "}
                      — their email domain is already a verified domain
                      of{" "}
                      <strong>
                        {selectedInviter.tenantDisplayName ??
                          selectedInviter.tenantId}
                      </strong>
                      , so Graph will reject the invite with{" "}
                      <code className="font-mono">
                        Request_BadRequest
                      </code>
                      . These users already belong to the directory and
                      should be added as <strong>members</strong>{" "}
                      directly (POST /users) rather than invited (POST
                      /invitations).
                    </span>
                    <ul className="ml-4 list-disc text-2xs opacity-90">
                      {verifiedDomainConflicts.slice(0, 8).map((e) => (
                        <li key={e} className="font-mono">
                          {e}
                        </li>
                      ))}
                      {verifiedDomainConflicts.length > 8 && (
                        <li className="italic opacity-70">
                          …and {verifiedDomainConflicts.length - 8} more
                        </li>
                      )}
                    </ul>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className="h-7 text-2xs"
                        onClick={handleAddAsMembers}
                        loading={addingAsMembers}
                        disabled={addingAsMembers}
                      >
                        <UserPlus className="h-3.5 w-3.5" />
                        Add {verifiedDomainConflicts.length} as member
                        {verifiedDomainConflicts.length === 1 ? "" : "s"}{" "}
                        instead
                      </Button>
                      <span className="self-center text-3xs opacity-70">
                        Generates a strong password per user · force
                        change at next sign-in · audited
                      </span>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
            {/* Add-as-member result panel — shows the generated
                passwords inline with copy buttons. Visible only after
                a run completes. */}
            {addMemberResults.length > 0 && (
              <div className="flex flex-col gap-2 rounded-md border border-success/30 bg-success/5 p-3">
                <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-success">
                  <UserPlus className="h-3.5 w-3.5" />
                  Add-as-member results (
                  {addMemberResults.filter((r) => r.ok).length}/
                  {addMemberResults.length})
                </div>
                <p className="text-3xs text-muted-foreground">
                  Copy the passwords NOW — they are not persisted. The
                  user must change them at next sign-in.
                </p>
                <table className="w-full border-collapse text-2xs">
                  <thead>
                    <tr className="border-b border-border text-left text-3xs uppercase tracking-wider text-muted-foreground">
                      <th className="py-1.5 pr-2">Email</th>
                      <th className="py-1.5 pr-2">UPN</th>
                      <th className="py-1.5 pr-2">Password</th>
                      <th className="py-1.5 pr-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {addMemberResults.map((r) => (
                      <tr
                        key={r.email}
                        className="border-b border-border/50"
                      >
                        <td className="py-1.5 pr-2 font-mono">{r.email}</td>
                        <td className="py-1.5 pr-2 font-mono">
                          {r.ok && r.upn ? (
                            <span className="inline-flex items-center gap-1">
                              {r.upn}
                              <CopyableText
                                value={r.upn}
                                mono={false}
                                alwaysVisibleButton
                                ariaLabel={`Copy UPN ${r.upn}`}
                              />
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-1.5 pr-2 font-mono">
                          {r.ok && r.password ? (
                            <span className="inline-flex items-center gap-1">
                              <code>{r.password}</code>
                              <CopyableText
                                value={r.password}
                                mono={false}
                                alwaysVisibleButton
                                ariaLabel="Copy password"
                              />
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-1.5 pr-2">
                          {r.ok ? (
                            <Badge variant="outline" className="text-3xs">
                              created
                            </Badge>
                          ) : (
                            <span
                              className="text-destructive"
                              title={r.error}
                            >
                              failed
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-2xs"
                    onClick={() => {
                      const tsv = addMemberResults
                        .filter((r) => r.ok)
                        .map((r) => `${r.email}\t${r.upn ?? ""}\t${r.password ?? ""}`)
                        .join("\n");
                      const header = "Email\tUPN\tPassword\n";
                      void navigator.clipboard
                        ?.writeText(header + tsv)
                        .then(() =>
                          store.addNotification({
                            type: "success",
                            message: `Copied ${addMemberResults.filter((r) => r.ok).length} UPN+password rows as TSV`,
                          }),
                        )
                        .catch(() =>
                          store.addNotification({
                            type: "error",
                            message: "Clipboard write failed — copy manually",
                          }),
                        );
                    }}
                  >
                    Copy all as TSV
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 text-2xs"
                    onClick={() => setAddMemberResults([])}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* ---------- Owner-grant section ---------------------------- */}
          <div className="flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-3">
            <label
              htmlFor="invite-grant-owner"
              className="flex cursor-pointer items-start gap-2 text-sm"
            >
              <Checkbox
                id="invite-grant-owner"
                checked={grantOwner}
                onCheckedChange={(v) => setGrantOwner(v === true)}
                disabled={submitting}
                className="mt-0.5"
              />
              <span className="flex flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 font-medium">
                  <Key className="h-3.5 w-3.5 text-primary" aria-hidden />
                  Grant Owner role on an Azure subscription
                  <InfoTooltip
                    size={12}
                    content="When on, each successful invite is immediately followed by a Microsoft.Authorization/roleAssignments PUT granting Owner at /subscriptions/{id}. You can also leave this off and use the bulk-grant button on the Results card after the invites land."
                    ariaLabel="About Owner grant"
                  />
                </span>
                <span className="text-2xs text-muted-foreground">
                  After each invite succeeds, assign the Owner role at the
                  subscription scope so the guest can manage every resource
                  inside. The grant is best-effort per recipient — failures
                  are reported but do not undo the invite.
                </span>
              </span>
            </label>

            {grantOwner && (
              <div className="flex flex-col gap-1.5 pl-6">
                <Label
                  htmlFor="invite-subscription"
                  className="flex items-center gap-1.5 text-xs"
                >
                  Subscription{" "}
                  <span className="text-destructive">*</span>
                  <InfoTooltip
                    size={12}
                    content="Owner is granted at /subscriptions/{id} scope. Your ARM token must hold Microsoft.Authorization/roleAssignments/write at that scope (Owner or User Access Administrator)."
                    ariaLabel="About subscription scope"
                  />
                </Label>
                {subsLoading ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                    Loading subscriptions for {selectedInviter?.username}…
                  </p>
                ) : subsError ? (
                  <Alert variant="destructive">
                    <AlertDescription>
                      Failed to load subscriptions: {subsError}
                    </AlertDescription>
                  </Alert>
                ) : subscriptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No subscriptions visible to{" "}
                    <code className="font-mono">
                      {selectedInviter?.username}
                    </code>
                    . Sign in with an account that owns at least one
                    subscription in this tenant.
                  </p>
                ) : (
                  <Select
                    value={selectedSubscriptionId}
                    onValueChange={setSelectedSubscriptionId}
                    disabled={submitting}
                  >
                    <SelectTrigger id="invite-subscription">
                      <SelectValue placeholder="Pick a subscription" />
                    </SelectTrigger>
                    <SelectContent>
                      {subscriptions.map((s) => (
                        <SelectItem
                          key={s.subscriptionId}
                          value={s.subscriptionId}
                        >
                          <div className="flex flex-col">
                            <span className="font-medium">{s.displayName}</span>
                            <span className="font-mono text-2xs text-muted-foreground">
                              {s.subscriptionId} · {s.state}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <p className="text-2xs text-muted-foreground">
                  You must hold Owner or User Access Administrator on this
                  subscription for the grant to succeed.
                </p>
              </div>
            )}
          </div>

          {/* ---------- Optional settings ------------------------------ */}
          <details className="rounded-md border border-border/60 bg-muted/30 p-3">
            <summary className="cursor-pointer text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Optional settings
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invite-display-name" className="text-xs">
                  Display name
                </Label>
                <Input
                  id="invite-display-name"
                  placeholder="Defaults to the email address"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={submitting}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label
                  htmlFor="invite-redirect"
                  className="flex items-center gap-1.5 text-xs"
                >
                  Redirect URL after redemption
                  <InfoTooltip
                    size={12}
                    content="Lands the invitee here after consent. Must be HTTPS and a URL Microsoft allows (any https:// origin you own, or a Microsoft surface like myapplications.microsoft.com)."
                    ariaLabel="About redirect URL"
                  />
                </Label>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Input
                    id="invite-redirect"
                    type="url"
                    placeholder={DEFAULT_REDIRECT_URL}
                    value={redirectUrl}
                    onChange={(e) => setRedirectUrl(e.target.value)}
                    disabled={submitting}
                    aria-invalid={!redirectIsHttps}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9 px-2 text-2xs"
                        disabled={submitting}
                      >
                        Presets <ChevronDown className="ml-1 h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel className="text-2xs">
                        Common landing surfaces
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {REDIRECT_PRESETS.map((p) => (
                        <DropdownMenuItem
                          key={p.url}
                          onSelect={() => setRedirectUrl(p.url)}
                          className="text-xs"
                        >
                          {p.label}
                          <span className="ml-2 truncate font-mono text-3xs text-muted-foreground">
                            {p.url.replace(/^https?:\/\//, "")}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {!redirectIsHttps && (
                  <p className="text-2xs text-destructive">
                    Redirect URL must be a valid HTTPS URL.
                  </p>
                )}
                <p className="text-2xs text-muted-foreground">
                  Where the invitee lands after consenting. Defaults to My
                  Apps.
                </p>
              </div>

              <label
                htmlFor="invite-send-email"
                className="flex cursor-pointer items-start gap-2 text-xs"
              >
                <Checkbox
                  id="invite-send-email"
                  checked={sendEmail}
                  onCheckedChange={(v) => setSendEmail(v === true)}
                  disabled={submitting}
                  className="mt-0.5"
                />
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="font-medium">
                    Send invitation email from Microsoft
                  </span>
                  <span className="text-2xs text-muted-foreground">
                    Off by default — copy the redemption URL below and hand
                    it over via your own channel (Teams DM, ticket, etc.).
                    With this on Graph sends a templated email to every
                    recipient.
                  </span>
                </span>
              </label>

              {sendEmail && (
                <div className="flex flex-col gap-1.5 pl-6">
                  <Label
                    htmlFor="invite-custom-message"
                    className="flex items-center gap-1.5 text-xs"
                  >
                    Custom message (optional)
                    <InfoTooltip
                      size={12}
                      content="Appended to the templated Microsoft invitation email. Plain text; URLs auto-linkify. Same body is used for every recipient in the batch."
                      ariaLabel="About custom message"
                    />
                  </Label>
                  <textarea
                    id="invite-custom-message"
                    placeholder="Hi — joining you to our shared Azure resources. Click the link to accept."
                    value={customMessage}
                    onChange={(e) => setCustomMessage(e.target.value)}
                    disabled={submitting}
                    rows={3}
                    className="flex min-h-[64px] w-full rounded-md border border-input bg-background px-3 py-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label
                  htmlFor="invite-concurrency"
                  className="flex items-center gap-1.5 text-xs"
                >
                  Concurrency
                  <InfoTooltip
                    size={12}
                    content="Maximum number of invite + Owner-grant operations in flight at once. Lower is gentler on Graph/ARM throttling; higher is faster for large batches. Default 4 is a sweet spot for ~50 recipients."
                    ariaLabel="About concurrency"
                  />
                </Label>
                <div className="flex items-center gap-3">
                  <input
                    id="invite-concurrency"
                    type="range"
                    min={MIN_CONCURRENCY}
                    max={MAX_CONCURRENCY}
                    step={1}
                    value={concurrency}
                    onChange={(e) =>
                      setConcurrency(parseInt(e.target.value, 10))
                    }
                    disabled={submitting}
                    className="flex-1 accent-primary"
                  />
                  <span className="inline-flex h-7 min-w-[2.5rem] items-center justify-center rounded-md border border-border bg-background px-2 font-mono text-xs tabular-nums">
                    {concurrency}
                  </span>
                </div>
                <p className="text-2xs text-muted-foreground">
                  Up to {concurrency} invites + grants run in parallel.
                </p>
              </div>
            </div>
          </details>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* ---------- Submit / cancel bar ---------------------------- */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() => {
                const needsConfirm =
                  sendEmail ||
                  grantOwner ||
                  parsedEmails.activeValid.length >= 5;
                if (needsConfirm) {
                  setShowConfirm(true);
                } else {
                  void submitInvites();
                }
              }}
              disabled={!canSubmit}
              loading={submitting}
              aria-label={`Invite ${parsedEmails.activeValid.length || "users"}`}
            >
              {!submitting && <UserPlus />}
              {submitting
                ? "Inviting…"
                : parsedEmails.activeValid.length > 1
                  ? `Invite ${parsedEmails.activeValid.length} users${grantOwner ? " + grant Owner" : ""}`
                  : `Send invitation${grantOwner ? " + grant Owner" : ""}`}
            </Button>
            {submitting && (
              <Button
                type="button"
                variant="warning"
                size="sm"
                onClick={() => {
                  cancelledRef.current = true;
                  store.addNotification({
                    type: "warning",
                    message:
                      "Cancellation requested — in-flight invites will finish.",
                  });
                }}
                aria-label="Cancel running batch"
              >
                <X />
                Cancel batch
              </Button>
            )}
            {(outcomes.length > 0 || error) && !submitting && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={resetForm}
                aria-label="Start a new invitation batch"
              >
                <Sparkles />
                New batch
              </Button>
            )}
            {!canSubmit && !submitting && parsedEmails.activeValid.length > 0 && (
              <span className="text-2xs text-muted-foreground" role="status">
                {!selectedInviter
                  ? "Pick an inviting account."
                  : !redirectIsHttps
                    ? "Redirect URL must be HTTPS."
                    : grantOwner && !selectedSubscriptionId
                      ? "Pick a subscription for the Owner grant."
                      : ""}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ===================================================================
          Results card
          =================================================================== */}
      {outcomes.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Check className="h-4 w-4 text-primary" />
                  Results
                </CardTitle>
                <CardDescription>
                  Per-recipient invite + Owner-grant status. Copy any
                  redemption URL, retry a failure inline, or export the
                  full batch as CSV / JSON.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {/* Live aria-live region so screen readers are notified when a
                batch completes (the visible stats convey the same info). */}
            <div className="sr-only" aria-live="polite" aria-atomic="true">
              {submitting
                ? `Invitation batch in progress — ${
                    outcomes.filter((o) => o.invite.state === "success").length
                  } of ${outcomes.length} succeeded so far.`
                : `Invitation batch complete — ${
                    outcomes.filter((o) => o.invite.state === "success").length
                  } of ${outcomes.length} succeeded.`}
            </div>

            {/* Summary stats — at-a-glance health of the batch. */}
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Batch summary"
            >
              <SummaryStatItem
                label="Total"
                value={outcomes.length}
                tone="info"
                compact
              />
              <SummaryStatItem
                label="Sent"
                value={
                  outcomes.filter((o) => o.invite.state === "success").length
                }
                tone="success"
                compact
              />
              <SummaryStatItem
                label="Failed"
                value={
                  outcomes.filter((o) => o.invite.state === "failure").length
                }
                tone="destructive"
                compact
              />
              <SummaryStatItem
                label="Pending"
                value={
                  outcomes.filter(
                    (o) =>
                      o.invite.state === "running" ||
                      o.invite.state === "queued",
                  ).length
                }
                tone="warning"
                compact
              />
              <SummaryStatItem
                label="Cancelled"
                value={
                  outcomes.filter((o) => o.invite.state === "cancelled").length
                }
                tone="muted"
                compact
              />
              {grantOwner && (
                <>
                  <SummaryStatItem
                    label="Owner ok"
                    value={
                      outcomes.filter(
                        (o) => o.ownerGrant.state === "success",
                      ).length
                    }
                    tone="success"
                    compact
                  />
                  <SummaryStatItem
                    label="Owner failed"
                    value={
                      outcomes.filter(
                        (o) => o.ownerGrant.state === "failure",
                      ).length
                    }
                    tone="destructive"
                    compact
                  />
                </>
              )}
            </div>

            {/* Toolbar: search-filter + status filter + copy-all + export. */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px] flex-1">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  type="search"
                  placeholder="Filter by email, UPN, or error…"
                  value={outcomeFilter}
                  onChange={(e) => setOutcomeFilter(e.target.value)}
                  className="h-8 pl-7 text-xs"
                  aria-label="Filter results"
                />
              </div>

              {/* Status filter — quick way to focus on failures only when
                  triaging a large batch. Multi-state radio-style group. */}
              <div
                role="radiogroup"
                aria-label="Filter by status"
                className="inline-flex rounded-md border border-border bg-background p-0.5"
              >
                {(
                  [
                    { v: "all", label: "All", icon: Filter },
                    { v: "success", label: "Success", icon: Check },
                    { v: "failure", label: "Failed", icon: X },
                    { v: "pending", label: "Pending", icon: Loader2 },
                  ] as ReadonlyArray<{
                    v: OutcomeStatusFilter;
                    label: string;
                    icon: typeof Filter;
                  }>
                ).map(({ v, label, icon: Icon }) => (
                  <Button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={statusFilter === v}
                    size="sm"
                    variant={statusFilter === v ? "default" : "ghost"}
                    className="h-7 gap-1 px-2 text-2xs"
                    onClick={() => setStatusFilter(v)}
                  >
                    <Icon className="h-3 w-3" aria-hidden />
                    {label}
                  </Button>
                ))}
              </div>

              {/* Copy-all redeem URLs (TSV) — preserves header row so it
                  pastes cleanly into Excel / Sheets / a Teams chat. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copyText(buildRedeemUrlTsv(), "tsv-all")}
                disabled={
                  outcomes.filter((o) => o.invite.state === "success")
                    .length === 0
                }
                className="text-xs"
                aria-label="Copy all redemption URLs as TSV"
              >
                {copiedKey === "tsv-all" ? <Check /> : <Copy />}
                {copiedKey === "tsv-all" ? "Copied" : "Copy URLs (TSV)"}
              </Button>

              <ExportMenu<PerEmailOutcome>
                rows={outcomes}
                columns={OUTCOME_EXPORT_COLUMNS}
                filename="invite-user-results"
                jsonMetadata={{
                  inviter: selectedInviter?.username,
                  tenantId: selectedInviter?.tenantId,
                  grantOwner,
                  subscriptionId: grantOwner
                    ? selectedSubscriptionId
                    : undefined,
                  concurrency,
                  sentEmailFromMicrosoft: sendEmail,
                }}
              />
            </div>

            {/* Bulk-grant action — appears whenever there's at least one
                successful invite that doesn't yet have a successful grant.
                Useful when (a) the operator forgot to pre-tick "Grant
                Owner" or (b) wants to retry every failed grant in one go. */}
            {(() => {
              const grantCandidates = outcomes.filter(
                (o) =>
                  o.invite.state === "success" &&
                  o.ownerGrant.state !== "success" &&
                  o.ownerGrant.state !== "running",
              ).length;
              if (grantCandidates === 0) return null;
              return (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 p-2">
                  <span className="flex items-center gap-1.5 text-xs">
                    <Key className="h-3.5 w-3.5 text-primary" aria-hidden />
                    <span>
                      <strong>{grantCandidates}</strong> invited user
                      {grantCandidates === 1 ? "" : "s"} without a
                      successful Owner grant
                      {selectedSubscriptionId
                        ? ` on ${selectedSubscriptionId.slice(0, 8)}…`
                        : ""}
                      .
                    </span>
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {!selectedSubscriptionId && (
                      <span className="text-2xs text-muted-foreground">
                        Pick a subscription above to enable.
                      </span>
                    )}
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      loading={bulkGrantInFlight}
                      disabled={
                        bulkGrantInFlight ||
                        submitting ||
                        !selectedSubscriptionId
                      }
                      onClick={() => setShowBulkGrantConfirm(true)}
                      className="text-xs"
                      aria-label={`Grant Owner to all ${grantCandidates} invited users`}
                    >
                      {!bulkGrantInFlight && <ShieldCheck />}
                      Grant Owner to {grantCandidates}
                    </Button>
                  </div>
                </div>
              );
            })()}

            {/* Per-row outcome list. */}
            {(() => {
              const filterText = outcomeFilter.trim().toLowerCase();
              const visible = outcomes.filter((o) => {
                // Status filter first — cheaper short-circuit.
                if (statusFilter === "success" && o.invite.state !== "success")
                  return false;
                if (statusFilter === "failure" && o.invite.state !== "failure")
                  return false;
                if (
                  statusFilter === "pending" &&
                  o.invite.state !== "running" &&
                  o.invite.state !== "queued"
                )
                  return false;
                // Free-text filter against email / UPN / error texts.
                if (filterText.length === 0) return true;
                if ((o.email ?? "").toLowerCase().includes(filterText))
                  return true;
                if (
                  o.invite.state === "success" &&
                  ((o.invite.upn ?? "").toLowerCase().includes(filterText) ||
                    (o.invite.displayName ?? "")
                      .toLowerCase()
                      .includes(filterText))
                )
                  return true;
                if (
                  o.invite.state === "failure" &&
                  (o.invite.error ?? "").toLowerCase().includes(filterText)
                )
                  return true;
                if (
                  o.ownerGrant.state === "failure" &&
                  (o.ownerGrant.error ?? "")
                    .toLowerCase()
                    .includes(filterText)
                )
                  return true;
                return false;
              });
              if (visible.length === 0) {
                return (
                  <EmptyState
                    icon={Search}
                    title="No matches"
                    description={
                      outcomeFilter.length > 0
                        ? `Nothing matches "${outcomeFilter}". Clear the filter to see every result.`
                        : `No results in the "${statusFilter}" filter — switch to All to see every result.`
                    }
                    size="compact"
                    action={{
                      label:
                        outcomeFilter.length > 0
                          ? "Clear filter"
                          : "Show all",
                      onClick: () => {
                        setOutcomeFilter("");
                        setStatusFilter("all");
                      },
                    }}
                  />
                );
              }
              return (
                <div className="flex flex-col gap-2">
                  {visible.map((o) => (
                    <ResultRow
                      key={o.rowId}
                      outcome={o}
                      copiedKey={copiedKey}
                      retryInFlight={retryRowId === o.rowId}
                      grantOwnerEnabled={grantOwner}
                      hasSubscription={!!selectedSubscriptionId}
                      onCopyUrl={(url) =>
                        void copyText(url, `url-${o.rowId}`)
                      }
                      onRetry={() => void retryRow(o.rowId)}
                    />
                  ))}
                </div>
              );
            })()}
          </CardContent>
        </Card>
      )}

      {/* ===================================================================
          Pre-submit confirmation
          =================================================================== */}
      <ConfirmationDialog
        hidden={!showConfirm}
        title={
          parsedEmails.activeValid.length > 1
            ? `Send ${parsedEmails.activeValid.length} invitations?`
            : "Send invitation?"
        }
        message={
          <div className="flex flex-col gap-2 text-sm">
            <p>
              {parsedEmails.activeValid.length > 1
                ? `Microsoft will create ${parsedEmails.activeValid.length} guest users in tenant `
                : `Microsoft will create a guest user in tenant `}
              <code className="font-mono text-xs">
                {selectedInviter?.tenantId ?? ""}
              </code>
              .
            </p>
            {sendEmail && (
              <p>
                <strong>Mail will be sent</strong> from Microsoft to each
                recipient at the addresses you entered.
              </p>
            )}
            {grantOwner && (
              <p>
                Each newly-invited user will receive the{" "}
                <strong>Owner</strong> role on subscription{" "}
                <code className="font-mono text-xs">
                  {selectedSubscriptionId}
                </code>
                . They will gain full control of every resource in that
                subscription.
              </p>
            )}
            {recipientWarnings.length > 0 && (
              <p className="rounded border border-warning/40 bg-warning/5 p-2 text-xs text-warning">
                <AlertCircle
                  className="mr-1 inline h-3 w-3 -translate-y-px"
                  aria-hidden
                />
                {recipientWarnings.length} address
                {recipientWarnings.length === 1 ? "" : "es"} may not be
                invitable (.onmicrosoft.com etc.). They&apos;ll surface as
                per-row failures.
              </p>
            )}
          </div>
        }
        confirmText={
          parsedEmails.activeValid.length > 1
            ? `Send ${parsedEmails.activeValid.length} invitations`
            : "Send invitation"
        }
        danger={grantOwner || sendEmail}
        onConfirm={() => {
          setShowConfirm(false);
          void submitInvites();
        }}
        onCancel={() => setShowConfirm(false)}
      />

      {/* ===================================================================
          Bulk-grant confirmation
          =================================================================== */}
      <ConfirmationDialog
        hidden={!showBulkGrantConfirm}
        title="Grant Owner to invited users?"
        message={
          <div className="flex flex-col gap-2 text-sm">
            <p>
              Every successfully-invited user without a current Owner role
              on{" "}
              <code className="font-mono text-xs">
                {selectedSubscriptionId}
              </code>{" "}
              will receive the <strong>Owner</strong> role.
            </p>
            <p className="text-xs text-muted-foreground">
              This grants full control over every resource in the
              subscription. The operation is idempotent — already-granted
              principals are surfaced as &quot;already had it&quot;.
            </p>
          </div>
        }
        confirmText="Grant Owner"
        danger
        onConfirm={() => {
          setShowBulkGrantConfirm(false);
          void bulkGrantOwner();
        }}
        onCancel={() => setShowBulkGrantConfirm(false)}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// ResultRow — extracted for readability + so visible-rows don't reconcile
// every render of unrelated rows in the same list.
// ---------------------------------------------------------------------------

interface ResultRowProps {
  outcome: PerEmailOutcome;
  copiedKey: string | null;
  retryInFlight: boolean;
  grantOwnerEnabled: boolean;
  hasSubscription: boolean;
  onCopyUrl: (url: string) => void;
  onRetry: () => void;
}

const ResultRow: React.FC<ResultRowProps> = ({
  outcome: o,
  copiedKey,
  retryInFlight,
  grantOwnerEnabled,
  hasSubscription,
  onCopyUrl,
  onRetry,
}) => {
  const inviteOk = o.invite.state === "success";
  const redeemUrl =
    o.invite.state === "success" ? o.invite.redeemUrl : "";
  const urlKey = `url-${o.rowId}`;
  const canRetry =
    !retryInFlight &&
    (o.invite.state === "failure" ||
      (o.ownerGrant.state === "failure" && inviteOk));
  const ownerRetryNeedsSub =
    o.invite.state === "success" &&
    o.ownerGrant.state === "failure" &&
    !hasSubscription;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <code className="truncate font-mono text-xs">{o.email}</code>

        {/* Invite badge */}
        {o.invite.state === "queued" && (
          <Badge variant="outline" className="text-2xs">
            Queued
          </Badge>
        )}
        {o.invite.state === "running" && (
          <Badge variant="secondary" className="gap-1 text-2xs">
            <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />{" "}
            Inviting…
          </Badge>
        )}
        {o.invite.state === "success" && (
          <Badge variant="success" className="gap-1 text-2xs">
            {o.invite.emailed ? (
              <MailCheck className="h-3 w-3" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            {o.invite.emailed ? "Invited + emailed" : "Invited"}
          </Badge>
        )}
        {o.invite.state === "failure" && (
          <Badge variant="destructive" className="gap-1 text-2xs">
            <X className="h-3 w-3" /> Invite failed
          </Badge>
        )}
        {o.invite.state === "cancelled" && (
          <Badge variant="outline" className="gap-1 text-2xs">
            Cancelled
          </Badge>
        )}

        {/* Owner-grant badge */}
        {o.ownerGrant.state === "skipped" && grantOwnerEnabled && (
          <Badge variant="outline" className="text-2xs">
            Owner: skipped
          </Badge>
        )}
        {o.ownerGrant.state === "queued" && (
          <Badge variant="outline" className="text-2xs">
            Owner: queued
          </Badge>
        )}
        {o.ownerGrant.state === "running" && (
          <Badge variant="secondary" className="gap-1 text-2xs">
            <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />{" "}
            Granting Owner…
          </Badge>
        )}
        {o.ownerGrant.state === "success" && (
          <Badge variant="success" className="gap-1 text-2xs">
            <Key className="h-3 w-3" />
            {o.ownerGrant.alreadyExisted
              ? "Owner: already had it"
              : "Owner: granted"}
          </Badge>
        )}
        {o.ownerGrant.state === "failure" && (
          <Badge variant="destructive" className="gap-1 text-2xs">
            <X className="h-3 w-3" /> Owner grant failed
          </Badge>
        )}
        {o.ownerGrant.state === "cancelled" && (
          <Badge variant="outline" className="text-2xs">
            Owner: cancelled
          </Badge>
        )}

        {/* Right-aligned retry button for failed rows. */}
        {canRetry && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto h-6 gap-1 text-2xs"
            onClick={onRetry}
            disabled={retryInFlight || ownerRetryNeedsSub}
            loading={retryInFlight}
            title={
              ownerRetryNeedsSub
                ? "Pick a subscription above to retry the grant."
                : "Retry this row"
            }
            aria-label={`Retry ${o.email}`}
          >
            {!retryInFlight && <RefreshCw />}
            Retry
          </Button>
        )}
      </div>

      {o.invite.state === "success" && o.invite.upn && (
        <p className="text-2xs text-muted-foreground">
          Provisioned as{" "}
          <code className="font-mono">{o.invite.upn}</code>
          {o.invite.displayName ? ` (${o.invite.displayName})` : ""}
          {o.invite.emailed
            ? " · Microsoft emailed the invitee."
            : " · email not sent — share the URL below."}
          {o.invite.graphStatus
            ? ` · status: ${o.invite.graphStatus}`
            : ""}
        </p>
      )}

      {o.invite.state === "failure" && (
        <div className="break-words text-2xs text-destructive">
          <p className="m-0 flex items-start gap-1">
            <AlertCircle
              className="mt-0.5 h-3 w-3 shrink-0"
              aria-hidden
            />
            <span className="flex-1">{o.invite.error}</span>
          </p>
          {o.invite.errorCode && (
            <p className="m-0 mt-0.5 pl-4 text-3xs text-muted-foreground">
              Code: <code className="font-mono">{o.invite.errorCode}</code>
            </p>
          )}
        </div>
      )}

      {o.ownerGrant.state === "failure" && (
        <p className="break-words text-2xs text-destructive">
          <Key
            className="mr-1 inline h-3 w-3 -translate-y-px"
            aria-hidden
          />
          Owner grant: {o.ownerGrant.error}
        </p>
      )}

      {inviteOk && redeemUrl && (
        <div className="flex items-stretch gap-2">
          <Input
            readOnly
            value={redeemUrl}
            className="font-mono text-2xs"
            onFocus={(e) => e.currentTarget.select()}
            aria-label={`Redemption URL for ${o.email}`}
          />
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => onCopyUrl(redeemUrl)}
            aria-label={
              copiedKey === urlKey
                ? `Copied redemption URL for ${o.email}`
                : `Copy redemption URL for ${o.email}`
            }
          >
            {copiedKey === urlKey ? <Check /> : <Copy />}
            {copiedKey === urlKey ? "Copied" : "Copy"}
          </Button>
          <Button type="button" variant="ghost" size="sm" asChild>
            <a
              href={redeemUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open redemption URL for ${o.email}`}
            >
              <ExternalLink />
              Open
            </a>
          </Button>
        </div>
      )}

      {o.invite.state === "success" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Pencil className="h-3 w-3" aria-hidden />
            <span>User id:</span>
            <CopyableText
              value={o.invite.userId}
              mono
              alwaysVisibleButton
              ariaLabel={`Copy invited user id for ${o.email}`}
            />
          </span>
        </div>
      )}
    </div>
  );
};
