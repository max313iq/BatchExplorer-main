// COORDINATOR: OrchestratorAgent.execute(params) does NOT currently accept a
// second `{ signal }` argument. The page-improvement spec asks every list
// page to thread `useAbortableEffect`'s AbortSignal into orchestrator calls;
// for now we use the signal to guard post-await state writes (via the
// existing seq monotonic-guard for `list_tenant_users`) but don't pipe it
// into the agent layer. When the orchestrator interface gains a
// `(params, opts?: { signal }) => Promise<AgentResult>` overload, the
// `refreshUsers` callback and the capability-discovery effect in this file
// should switch to passing the signal through directly. Until then the seq
// guard + signal.aborted checks here are functionally equivalent.
/**
 * Tenant Users page — list users in a privileged tenant, reset passwords
 * (single or bulk), and inspect per-user activity / credentials. Bulk
 * operations stream progress via a sheet drawer with pause / resume /
 * per-row retry; destructive confirmations route through ConfirmationDialog.
 *
 * Design notes (2026-05-24 rewrite):
 *
 *  - The page is account-scoped: changing the account selector cancels
 *    in-flight enrichment + selection (each guarded by a monotonic seq).
 *
 *  - Reset path: identical for single-user and bulk — both call
 *    resetUserPassword, both audit success/failure with full context
 *    (mail, mailNickname guess, accountEnabled-at-time, bulk flag), both
 *    persist the resulting credential into the encrypted vault so the
 *    operator can re-launch a portal sign-in later from User Creator.
 *
 *  - Reset blockers: the dialog warns (does NOT silently allow) when the
 *    target is a guest (#EXT# or external user state), is disabled, or
 *    appears to be on-prem synced. Operator can override after reading.
 *
 *  - Quick filters live in the URL alongside `tenant` + `search`, so deep
 *    links survive reload and back/forward.
 *
 *  - All state derived from the user list (filtered/sorted, summary stats,
 *    selection) recomputes from a single `allRows` memo so the table,
 *    chips, and stats can never disagree.
 */
import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  Building2,
  CheckCircle2,
  CircleSlash,
  Cloud,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Loader2,
  LogIn,
  Mail,
  MoreHorizontal,
  Pause,
  Play,
  RotateCw,
  Search,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserCog,
  Users,
  UserX,
  Wand2,
  XCircle,
  Zap,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorState } from "@/components/ui/error-state";
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
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  cn,
  compareStrings,
  formatRelativeTime,
  pluralize,
} from "@/lib/utils";

import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { getActiveTenant, getGraphTokenForAccount } from "../../auth/msal-auth";
import { credentialVault } from "../../auth/credential-vault";
import {
  attemptInteractiveLogin,
  launchPortalAutoLogin,
} from "../../auth/portal-auto-login";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useUrlState } from "../../hooks/use-url-state";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { auditLog } from "../../services/audit-log";
import {
  canResetPasswords,
  getMyDirectoryRoles,
  listOrgSubscriptions,
  resetUserPassword,
} from "../../services/graph-service";
import { GraphUser } from "../../services/types";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton } from "../shared/copy-button";
import {
  DataTable,
  type DataTableColumn,
} from "../shared/enhanced-table";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";
import { PageHeader } from "../shared/page-header";
import { PortalLoginButton } from "../shared/portal-login-button";
import { type PageKey } from "../shared/sidebar-nav";

import {
  DeletedUsersPanel,
  type DeletedUserRow,
} from "./tenant-users-deleted-panel";

// =============================================================================
// Constants
// =============================================================================

const MIN_PASSWORD_LENGTH = 12;
const GENERATED_PASSWORD_LENGTH = 16;
const SEARCH_DEBOUNCE_MS = 200;

const RESET_AUTO_LOGIN_PREF_KEY = "tenant-users:auto-launch-portal";
const FORCE_CHANGE_PREF_KEY = "tenant-users:force-change-default";
const BULK_CONCURRENCY_PREF_KEY = "tenant-users:bulk-concurrency";
const BULK_CONCURRENCY_OPTIONS = [1, 3, 5, 10] as const;
const DEFAULT_BULK_CONCURRENCY = 3;

// Stale-user heuristic. Microsoft Graph signInActivity requires Premium P1 +
// AuditLog.Read.All which the service layer does not currently request, so we
// fall back to two soft signals available on the base /users select set:
//   1. accountEnabled === false   (cannot sign in at all)
//   2. createdDateTime older than STALE_DAYS_THRESHOLD AND no Azure sub roles
// The threshold is configurable via the persisted "stale-threshold-days" pref
// so an operator can tighten/loosen the heuristic without code changes.
const STALE_THRESHOLD_DAYS_PREF_KEY = "tenant-users:stale-threshold-days";
// Persisted toggle for the defender-side "Deleted users (last 30 days)"
// surface — wired from the offensive-tooling corpus as a READ-ONLY
// signal (corpus citations live in `tenant-users-deleted-panel.tsx`).
const SHOW_DELETED_PANEL_PREF_KEY = "tenant-users:show-deleted-panel";
const DEFAULT_STALE_DAYS = 90;
const STALE_DAYS_OPTIONS = [30, 60, 90, 180, 365] as const;
const MS_PER_DAY = 86_400_000;

// Quick-filter chip ids — kept short so the URL stays compact.
type QuickFilter =
  | "all"
  | "members"
  | "guests"
  | "enabled"
  | "disabled"
  | "subs"
  | "nosubs"
  | "stale";

const QUICK_FILTERS: { id: QuickFilter; label: string; hint: string }[] = [
  { id: "all", label: "All", hint: "Show every user in the tenant." },
  { id: "members", label: "Members", hint: "Cloud-only members of this directory (no #EXT# in UPN)." },
  { id: "guests", label: "Guests", hint: "External / B2B users (#EXT# or external mail-domain mismatch)." },
  { id: "enabled", label: "Enabled", hint: "Users with accountEnabled = true." },
  { id: "disabled", label: "Disabled", hint: "Users blocked from signing in (accountEnabled = false)." },
  { id: "subs", label: "Has sub", hint: "Users with one or more Azure subscriptions visible to the caller." },
  { id: "nosubs", label: "No sub", hint: "Users with no visible Azure subscription roles." },
  {
    id: "stale",
    label: "Stale",
    hint:
      "Heuristic-stale users: disabled OR (createdDateTime older than threshold AND no Azure sub roles). signInActivity is not consulted (requires Entra P1 + AuditLog.Read.All).",
  },
];

// =============================================================================
// Types / interfaces
// =============================================================================

interface PrivilegedAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
}

function selectionKey(account: PrivilegedAccount): string {
  return `${account.homeAccountId}::${account.tenantId}`;
}

interface UserRow extends GraphUser {
  subscriptionCount: number;
  createdDateTime?: string;
  /** Computed: is the user an external / B2B guest? */
  isGuest: boolean;
  /** Computed: does the user appear to be on-prem synced? Best-effort. */
  appearsOnPremSynced: boolean;
  /**
   * Computed: heuristic-stale (likely inactive). True when the account is
   * disabled, or the account was created more than `staleDaysThreshold` ago
   * AND the user has no visible Azure subscription role assignments.
   * signInActivity is NOT consulted (would require AuditLog.Read.All +
   * Entra P1 licensing the service layer does not currently request).
   */
  isStale: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

function pickRandom<T>(arr: T[], count: number, rng: () => number): T[] {
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rng() * arr.length);
    out.push(arr[idx]!);
  }
  return out;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function generateRandomPassword(): string {
  const lower = "abcdefghijklmnopqrstuvwxyz".split("");
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const digits = "0123456789".split("");
  const symbols = "!@#$%^&*()-_=+[]{}".split("");

  const buf = new Uint32Array(GENERATED_PASSWORD_LENGTH * 4);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) {
      buf[i] = Math.floor(Math.random() * 0xffffffff);
    }
  }
  let cursor = 0;
  const rng = (): number => {
    const v = buf[cursor++ % buf.length]!;
    return v / 0xffffffff;
  };

  const chunkSize = GENERATED_PASSWORD_LENGTH / 4;
  const chars = [
    ...pickRandom(lower, chunkSize, rng),
    ...pickRandom(upper, chunkSize, rng),
    ...pickRandom(digits, chunkSize, rng),
    ...pickRandom(symbols, chunkSize, rng),
  ];
  return shuffle(chars, rng).join("");
}

/**
 * Guest detection — explicit. Microsoft Graph guests have `#EXT#` in their
 * UPN, but external B2B accounts can also be detected when the mail domain
 * doesn't match the UPN domain (e.g. invited customer using a personal
 * mailbox). Both heuristics are conservative: false positives here only
 * cause a banner to show, never block the reset.
 */
function isGuestUser(u: GraphUser): boolean {
  const upn = (u.userPrincipalName ?? "").toLowerCase();
  if (upn.includes("#ext#")) return true;
  const mail = (u.mail ?? "").toLowerCase();
  if (!mail || !upn.includes("@")) return false;
  const mailDomain = mail.split("@")[1];
  const upnDomain = upn.split("@")[1];
  return Boolean(mailDomain && upnDomain && mailDomain !== upnDomain);
}

/**
 * On-prem-sync heuristic — we don't get `onPremisesSyncEnabled` from the
 * current service select set, so we fall back to a soft signal: a mail
 * address whose domain matches a non-`.onmicrosoft.com` tenant suffix
 * (suggests a verified-domain user, which is the typical AD-sync shape).
 * Returns false when we can't tell. This is informational only.
 */
function appearsOnPremSynced(u: GraphUser): boolean {
  const upn = (u.userPrincipalName ?? "").toLowerCase();
  if (!upn.includes("@")) return false;
  if (upn.includes("#ext#")) return false;
  const domain = upn.split("@")[1] ?? "";
  // `.onmicrosoft.com` users are definitively cloud-only.
  if (domain.endsWith(".onmicrosoft.com")) return false;
  // We have a verified non-onmicrosoft domain — could be cloud-only OR
  // synced. We can't tell without the `onPremisesSyncEnabled` field, so
  // we return false (conservative) and let a future service-layer
  // enhancement flip this to true when the field is available.
  return false;
}

/**
 * Heuristic-stale predicate. Returns true when:
 *   - accountEnabled is explicitly false (cannot sign in at all), OR
 *   - createdDateTime is older than `thresholdDays` AND the user has no
 *     visible Azure subscription role assignments (`subscriptionCount === 0`).
 *
 * The createdDateTime side is conservative: users with subs are kept out of
 * the "stale" bucket regardless of age, because an assigned sub is strong
 * evidence the account is still in active use. signInActivity is NOT
 * consulted (the service layer would need AuditLog.Read.All + Entra P1 to
 * select it, which isn't available in this WebUI's Graph scope).
 */
function isStaleUser(
  u: GraphUser & { createdDateTime?: string; subscriptionCount: number },
  thresholdDays: number,
  nowMs: number,
): boolean {
  if (u.accountEnabled === false) return true;
  if (u.subscriptionCount > 0) return false;
  const created = u.createdDateTime;
  if (!created) return false;
  const createdMs = Date.parse(created);
  if (!Number.isFinite(createdMs)) return false;
  const ageDays = (nowMs - createdMs) / MS_PER_DAY;
  return ageDays >= thresholdDays;
}

/**
 * Best-effort copy-to-clipboard with fallback. Returns ok/error so callers
 * can show a toast.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Simple password strength meter — counts character classes + length.
 * 0..4 scale; consumers map to a label + color.
 */
function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (pw.length === 0) return { score: 0, label: "Empty" };
  let classes = 0;
  if (/[a-z]/.test(pw)) classes += 1;
  if (/[A-Z]/.test(pw)) classes += 1;
  if (/[0-9]/.test(pw)) classes += 1;
  if (/[^A-Za-z0-9]/.test(pw)) classes += 1;
  const lengthScore = pw.length >= 20 ? 2 : pw.length >= 16 ? 1 : 0;
  const raw = Math.min(4, classes + lengthScore - (pw.length < MIN_PASSWORD_LENGTH ? 2 : 0));
  const score = Math.max(0, raw) as 0 | 1 | 2 | 3 | 4;
  const labels = ["Too weak", "Weak", "Fair", "Strong", "Excellent"];
  return { score, label: labels[score]! };
}

/** Azure Portal deep link for a user object id. */
function portalUserUrl(tenantId: string, userId: string): string {
  return `https://portal.azure.com/#@${tenantId}/blade/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/overview/userId/${encodeURIComponent(userId)}`;
}

function readPersistedBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

function writePersistedBoolean(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* non-fatal */
  }
}

function readPersistedNumber<T extends number>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (Number.isFinite(n) && allowed.includes(n as T)) return n as T;
    return fallback;
  } catch {
    return fallback;
  }
}

function writePersistedNumber(key: string, value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* non-fatal */
  }
}

// =============================================================================
// Summary stat card
// =============================================================================

interface SummaryStatProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  tone: "primary" | "info" | "success" | "warning" | "destructive" | "muted";
  hint?: string;
  /** Optional click — turns the stat into a chip-like filter affordance. */
  onClick?: () => void;
  active?: boolean;
}

const SummaryStat: React.FC<SummaryStatProps> = ({
  icon: Icon,
  label,
  value,
  tone,
  hint,
  onClick,
  active,
}) => {
  const toneClass =
    tone === "primary"
      ? "text-primary"
      : tone === "info"
        ? "text-info"
        : tone === "success"
          ? "text-success"
          : tone === "warning"
            ? "text-warning"
            : tone === "destructive"
              ? "text-destructive"
              : "text-muted-foreground";

  const inner = (
    <div className="flex items-center gap-2.5">
      <Icon className={cn("h-4 w-4", toneClass)} />
      <div className="flex flex-col">
        <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            "text-lg font-bold leading-tight tabular-nums",
            toneClass,
          )}
        >
          {value}
        </span>
      </div>
    </div>
  );

  if (onClick) {
    return (
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onClick}
              className={cn(
                "rounded-md px-2 py-1 text-left transition-colors duration-150 ease-out hover:bg-accent/10 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                active && "bg-primary/10 ring-1 ring-primary/40",
              )}
              aria-pressed={active ?? undefined}
            >
              {inner}
            </button>
          </TooltipTrigger>
          {hint && <TooltipContent side="bottom">{hint}</TooltipContent>}
        </Tooltip>
      </TooltipProvider>
    );
  }
  if (hint) {
    return (
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="px-2 py-1">{inner}</div>
          </TooltipTrigger>
          <TooltipContent side="bottom">{hint}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return <div className="px-2 py-1">{inner}</div>;
};

// =============================================================================
// Quick-filter chip strip
// =============================================================================

interface QuickFilterChipsProps {
  active: QuickFilter;
  onChange: (next: QuickFilter) => void;
  counts: Record<QuickFilter, number>;
}

const QuickFilterChips: React.FC<QuickFilterChipsProps> = ({
  active,
  onChange,
  counts,
}) => {
  return (
    <TooltipProvider delayDuration={250}>
      <div
        role="tablist"
        aria-label="Quick filters"
        className="flex flex-wrap items-center gap-1"
      >
        {QUICK_FILTERS.map((f) => {
          const isActive = f.id === active;
          const count = counts[f.id];
          return (
            <Tooltip key={f.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => onChange(f.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-2xs font-medium transition-all duration-150 ease-out motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                    isActive
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                  )}
                >
                  <span>{f.label}</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-px text-2xs tabular-nums",
                      isActive
                        ? "bg-primary/20 text-primary"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {count}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{f.hint}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
};

// =============================================================================
// Reset-password dialog (single user)
// =============================================================================

interface ResetPasswordDialogProps {
  user: UserRow | null;
  account: PrivilegedAccount | null;
  onClose: () => void;
  onSuccess: (upn: string) => void;
}

const ResetPasswordDialog: React.FC<ResetPasswordDialogProps> = ({
  user,
  account,
  onClose,
  onSuccess,
}) => {
  const [password, setPassword] = React.useState("");
  const [forceChange, setForceChange] = React.useState(() =>
    readPersistedBoolean(FORCE_CHANGE_PREF_KEY, true),
  );
  const [showPassword, setShowPassword] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [succeeded, setSucceeded] = React.useState<{
    upn: string;
    password: string;
    mustChangePassword: boolean;
  } | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [autoLoginEnabled, setAutoLoginEnabled] = React.useState<boolean>(
    () => readPersistedBoolean(RESET_AUTO_LOGIN_PREF_KEY, true),
  );
  React.useEffect(() => {
    writePersistedBoolean(RESET_AUTO_LOGIN_PREF_KEY, autoLoginEnabled);
  }, [autoLoginEnabled]);
  React.useEffect(() => {
    writePersistedBoolean(FORCE_CHANGE_PREF_KEY, forceChange);
  }, [forceChange]);

  const [autoLoginInflight, setAutoLoginInflight] = React.useState(false);
  const store = useMultiRegionStore();

  const runSignInChain = React.useCallback(
    async (
      params: {
        upn: string;
        password: string;
        mustChangePassword: boolean;
      },
      mode: "auto" | "manual-portal" | "manual-interactive",
    ) => {
      if (!account) return;
      setAutoLoginInflight(true);
      const actor = account.username || account.name || account.homeAccountId;
      try {
        if (mode === "manual-portal") {
          store.addNotification({
            type: "info",
            message: `Opening portal session for ${params.upn}…`,
          });
          const res = await launchPortalAutoLogin({
            upn: params.upn,
            password: params.password,
            tenantId: account.tenantId,
            mustChangePassword: params.mustChangePassword,
          });
          if (res.ok) {
            await credentialVault.touch(
              params.upn,
              account.tenantId,
              account.homeAccountId,
            );
            store.addNotification({
              type: "success",
              message: `Portal sign-in window opened for ${params.upn}.`,
            });
            auditLog.record({
              actor,
              action: "portal_auto_login",
              target: params.upn,
              status: "success",
              details: {
                tenantId: account.tenantId,
                from: "reset-dialog",
                manual: true,
              },
            });
          } else {
            auditLog.record({
              actor,
              action: "portal_auto_login",
              target: params.upn,
              status: "failure",
              error: res.error,
              details: {
                tenantId: account.tenantId,
                from: "reset-dialog",
                manual: true,
                status: res.status,
              },
            });
            store.addNotification({
              type: "error",
              message: `Portal sign-in failed for ${params.upn}: ${res.error ?? "unknown"}. (Portal flow — interactive sign-in below works independently.)`,
            });
          }
          return;
        }
        store.addNotification({
          type: "info",
          message: `Signing into WebUI as ${params.upn}…`,
        });
        const ires = await attemptInteractiveLogin({
          upn: params.upn,
          tenantId: account.tenantId,
        });
        if (ires.ok) {
          await credentialVault.touch(
            params.upn,
            account.tenantId,
            account.homeAccountId,
          );
          store.addNotification({
            type: "success",
            message: `Signed in as ${ires.account?.username ?? params.upn}. WebUI now runs as this user.`,
          });
          auditLog.record({
            actor,
            action: "interactive_login",
            target: params.upn,
            status: "success",
            details: {
              tenantId: account.tenantId,
              from: "reset-dialog",
              primary: true,
              manual: mode === "manual-interactive",
            },
          });
        } else {
          auditLog.record({
            actor,
            action: "interactive_login",
            target: params.upn,
            status: "failure",
            error: ires.error,
            details: {
              tenantId: account.tenantId,
              from: "reset-dialog",
              primary: true,
              manual: mode === "manual-interactive",
            },
          });
          store.addNotification({
            type: "error",
            message: `WebUI sign-in failed for ${params.upn}: ${ires.error ?? "unknown"}. Credential is saved — retry from User Creator → "Created by me" tab.`,
          });
        }
      } finally {
        setAutoLoginInflight(false);
      }
    },
    [account, store],
  );

  React.useEffect(() => {
    if (user) {
      setPassword("");
      setShowPassword(false);
      setSubmitting(false);
      setError(null);
      setSucceeded(null);
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [user]);

  const validationMessage = React.useMemo(() => {
    if (password.length === 0) return "Password is required.";
    if (/\s/.test(password))
      return "Password must not contain whitespace (likely an accidental paste).";
    if (password.length < MIN_PASSWORD_LENGTH)
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    return null;
  }, [password]);

  const strength = React.useMemo(() => passwordStrength(password), [password]);

  const handleGenerate = React.useCallback(() => {
    setPassword(generateRandomPassword());
    setShowPassword(true);
    setError(null);
  }, []);

  const handleCopyPassword = React.useCallback(async () => {
    if (!password) return;
    const ok = await copyToClipboard(password);
    store.addNotification({
      type: ok ? "success" : "error",
      message: ok ? "Password copied to clipboard." : "Failed to copy password.",
    });
  }, [password, store]);

  const handleSubmit = React.useCallback(async () => {
    if (!user || !account) return;
    if (validationMessage) {
      setError(validationMessage);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const token = await getGraphTokenForAccount(
        account.homeAccountId,
        account.tenantId,
      );
      await resetUserPassword(
        account.tenantId,
        user.id,
        password,
        forceChange,
        token,
      );
      const finalUpn = user.userPrincipalName || user.id;
      // Audit success with full context so the audit-log page surfaces
      // why this was done + whether it was a guest / disabled target.
      auditLog.record({
        actor: account.username || account.name || account.homeAccountId,
        action: "reset_password",
        target: finalUpn,
        status: "success",
        details: {
          tenantId: account.tenantId,
          forceChange,
          userId: user.id,
          mail: user.mail ?? undefined,
          accountEnabled: user.accountEnabled,
          isGuest: user.isGuest,
          appearsOnPremSynced: user.appearsOnPremSynced,
          bulk: false,
        },
      });
      try {
        await credentialVault.put({
          upn: finalUpn,
          password,
          tenantId: account.tenantId,
          homeAccountId: account.homeAccountId,
          displayName: user.displayName ?? undefined,
          createdAt: new Date().toISOString(),
          source: "reset",
          mustChangePassword: forceChange,
        });
      } catch (vaultErr) {
        console.warn("[tenant-users] vault.put failed", vaultErr);
      }
      const successPayload = {
        upn: finalUpn,
        password,
        mustChangePassword: forceChange,
      };
      setSucceeded(successPayload);
      if (autoLoginEnabled) {
        void runSignInChain(successPayload, "auto");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      auditLog.record({
        actor: account.username || account.name || account.homeAccountId,
        action: "reset_password",
        target: user.userPrincipalName || user.id,
        status: "failure",
        error: msg,
        details: {
          tenantId: account.tenantId,
          forceChange,
          userId: user.id,
          mail: user.mail ?? undefined,
          accountEnabled: user.accountEnabled,
          isGuest: user.isGuest,
          appearsOnPremSynced: user.appearsOnPremSynced,
          bulk: false,
        },
      });
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [
    user,
    account,
    password,
    forceChange,
    validationMessage,
    autoLoginEnabled,
    runSignInChain,
  ]);

  const handleDone = React.useCallback(() => {
    if (succeeded && user) {
      onSuccess(succeeded.upn);
    } else {
      onClose();
    }
  }, [succeeded, user, onSuccess, onClose]);

  const handleOpenChange = (open: boolean) => {
    if (!open && !submitting) handleDone();
  };

  const open = user !== null && account !== null;
  const descId = "reset-password-dialog-desc";

  // Pre-reset advisory banners — never block submit, but make the operator
  // confirm by reading. These are the "edge cases" the spec calls out.
  const blockers = React.useMemo(() => {
    if (!user) return [];
    const out: { kind: "warn" | "info"; msg: string }[] = [];
    if (user.isGuest) {
      out.push({
        kind: "warn",
        msg:
          "This is a guest / external user. Guests sign in via their home tenant — a password reset here will NOT change the credential they use to access this directory.",
      });
    }
    if (!user.accountEnabled) {
      out.push({
        kind: "warn",
        msg:
          "Account is disabled. The new password will be set, but the user can't sign in until you re-enable the account.",
      });
    }
    if (user.appearsOnPremSynced) {
      out.push({
        kind: "warn",
        msg:
          "User appears to be synchronized from on-premises Active Directory. Cloud password reset may be ignored or overwritten by the next AD sync.",
      });
    }
    if ((user.userPrincipalName ?? "").length === 0) {
      out.push({
        kind: "warn",
        msg:
          "This user has no userPrincipalName. Reset will use the object id, but the user has no way to sign in until a UPN is assigned.",
      });
    }
    return out;
  }, [user]);

  const strengthTone =
    strength.score <= 1
      ? "bg-destructive"
      : strength.score === 2
        ? "bg-warning"
        : strength.score === 3
          ? "bg-info"
          : "bg-success";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        aria-describedby={descId}
        onEscapeKeyDown={(e) => submitting && e.preventDefault()}
        onInteractOutside={(e) => submitting && e.preventDefault()}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            !submitting &&
            !succeeded &&
            !validationMessage
          ) {
            e.preventDefault();
            handleSubmit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {succeeded
              ? `Password reset for ${user?.displayName || user?.userPrincipalName}`
              : `Reset password for ${user?.displayName || user?.userPrincipalName}`}
          </DialogTitle>
          <DialogDescription id={descId}>
            {succeeded
              ? "The new password is in the encrypted vault. Click Sign in to Portal to launch a real Chromium window pre-filled with this credential."
              : "Set a new password for this user. They will sign in with this password until it is changed."}
          </DialogDescription>
        </DialogHeader>

        {/* Target user context block — gives the operator confidence they're
            about to reset the *right* user. */}
        {user && !succeeded && (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-2xs text-muted-foreground">
              <span className="font-mono text-foreground">
                {user.userPrincipalName || "(no UPN)"}
              </span>
              {user.mail && user.mail !== user.userPrincipalName && (
                <span>{user.mail}</span>
              )}
              {user.jobTitle && <span>{user.jobTitle}</span>}
              {user.department && <span>· {user.department}</span>}
              <span>·</span>
              <span
                className={cn(
                  user.accountEnabled ? "text-success" : "text-warning",
                )}
              >
                {user.accountEnabled ? "Enabled" : "Disabled"}
              </span>
              {user.isGuest && (
                <Badge variant="warning" className="gap-1">
                  <UserCog className="h-3 w-3" aria-hidden /> Guest
                </Badge>
              )}
              {user.subscriptionCount > 0 && (
                <Badge variant="info" className="gap-1">
                  <Cloud className="h-3 w-3" aria-hidden />
                  {user.subscriptionCount} sub
                  {user.subscriptionCount === 1 ? "" : "s"}
                </Badge>
              )}
            </div>
          </div>
        )}

        {blockers.length > 0 && !succeeded && (
          <div className="flex flex-col gap-1.5">
            {blockers.map((b, i) => (
              <Alert
                key={i}
                variant={b.kind === "warn" ? "destructive" : "default"}
                className="py-2"
              >
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-2xs">{b.msg}</AlertDescription>
              </Alert>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reset-password-input">New password</Label>
            <div className="relative">
              <Input
                ref={inputRef}
                id="reset-password-input"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
                aria-invalid={validationMessage ? true : undefined}
                aria-describedby="reset-password-help"
                disabled={submitting}
                className="pr-28 font-mono text-xs"
              />
              <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowPassword((p) => !p)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  disabled={submitting}
                  title={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleCopyPassword}
                  aria-label="Copy password to clipboard"
                  disabled={submitting || password.length === 0}
                  title="Copy password"
                >
                  <Copy />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleGenerate}
                  aria-label="Generate random password"
                  disabled={submitting}
                  title="Generate random password"
                >
                  <Wand2 />
                </Button>
              </div>
            </div>

            {/* Strength meter — purely client-side; does NOT replace the
                tenant password policy on the server. */}
            {password.length > 0 && (
              <div className="flex items-center gap-2">
                <div
                  className="h-1 flex-1 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={4}
                  aria-valuenow={strength.score}
                  aria-label="Password strength"
                >
                  <div
                    className={cn(
                      "h-full transition-all duration-200 ease-out motion-reduce:transition-none",
                      strengthTone,
                    )}
                    style={{ width: `${((strength.score + 1) / 5) * 100}%` }}
                  />
                </div>
                <span
                  className={cn(
                    "min-w-[5rem] text-right text-2xs font-medium tabular-nums",
                    strength.score <= 1
                      ? "text-destructive"
                      : strength.score === 2
                        ? "text-warning"
                        : strength.score === 3
                          ? "text-info"
                          : "text-success",
                  )}
                >
                  {strength.label}
                </span>
              </div>
            )}

            <p
              id="reset-password-help"
              className={cn(
                "text-2xs",
                validationMessage
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {validationMessage ??
                `Minimum ${MIN_PASSWORD_LENGTH} characters. Use the wand to generate one.`}
            </p>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <Checkbox
              checked={forceChange}
              onCheckedChange={(v) => setForceChange(Boolean(v))}
              disabled={submitting}
              aria-label="Force user to change password at next sign-in"
            />
            <span>Force user to change password at next sign-in</span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-primary/30 bg-primary/5 p-2.5 text-sm text-foreground">
            <Checkbox
              checked={autoLoginEnabled}
              onCheckedChange={(v) => setAutoLoginEnabled(Boolean(v))}
              disabled={submitting}
              aria-label="Auto-launch sign-in window after reset"
              className="mt-0.5"
            />
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 font-medium">
                <Zap className="h-3.5 w-3.5 text-primary" aria-hidden />
                Auto-launch sign-in after reset
              </span>
              <span className="text-2xs text-muted-foreground">
                Tries the dev-server portal launch first (real Chromium with
                pre-filled credentials), and falls back to an MSAL popup
                against this user&apos;s tenant if that fails. The new
                account becomes active in this WebUI on success.
              </span>
            </span>
          </label>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        {succeeded && account && (
          <Alert>
            <CheckCircle2 className="h-4 w-4 text-success" />
            <AlertDescription className="flex flex-col gap-2">
              <span className="flex items-center gap-2">
                Password reset for <strong>{succeeded.upn}</strong>.
                {succeeded.mustChangePassword
                  ? " The user will be asked to set a new password on first sign-in."
                  : ""}
                {autoLoginInflight && (
                  <span className="ml-auto flex items-center gap-1 text-2xs font-normal text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    Launching sign-in…
                  </span>
                )}
              </span>
              <span className="text-2xs text-muted-foreground">
                {autoLoginEnabled
                  ? "A sign-in window was launched automatically — re-launch, switch to interactive, or copy the email if needed:"
                  : "Auto-launch is off; trigger a sign-in manually or copy the email:"}
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={autoLoginInflight}
                  onClick={() =>
                    void runSignInChain(succeeded, "manual-portal")
                  }
                  aria-label={`Re-launch sign-in window for ${succeeded.upn}`}
                  title="POST /api/portal/auto-login (Playwright Chromium)"
                >
                  {autoLoginInflight ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <ExternalLink />
                  )}
                  {autoLoginEnabled ? "Re-launch sign-in" : "Launch sign-in"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={autoLoginInflight}
                  onClick={() =>
                    void runSignInChain(succeeded, "manual-interactive")
                  }
                  aria-label={`Interactive sign-in as ${succeeded.upn}`}
                  title="MSAL popup against the user's tenant — works cross-tenant; new account becomes active on success"
                >
                  <LogIn />
                  Interactive sign-in
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void copyToClipboard(succeeded.password)}
                  title="Copy the new password"
                  aria-label="Copy password to clipboard"
                >
                  <Copy />
                  Copy password
                </Button>
                <PortalLoginButton
                  upn={succeeded.upn}
                  tenantId={account.tenantId}
                  homeAccountId={account.homeAccountId}
                  password={succeeded.password}
                  mustChangePassword={succeeded.mustChangePassword}
                  size="sm"
                  variant="ghost"
                />
              </div>
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter className="gap-2">
          {succeeded ? (
            <Button
              type="button"
              variant="default"
              onClick={handleDone}
              aria-label="Done"
            >
              Done
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={handleSubmit}
                disabled={submitting || validationMessage !== null}
                aria-label="Reset password"
              >
                {submitting ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Resetting...
                  </>
                ) : (
                  <>
                    <KeyRound />
                    Reset password
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// =============================================================================
// Bulk-reset drawer
// =============================================================================

type BulkStatus =
  | "pending"
  | "running"
  | "success"
  | "failure"
  | "cancelled"
  | "skipped";

interface BulkRow {
  user: UserRow;
  status: BulkStatus;
  message?: string;
  password?: string;
  mustChangePassword?: boolean;
  /** Wall-clock milliseconds from row "running" → terminal. */
  durationMs?: number;
}

interface BulkProgressDrawerProps {
  open: boolean;
  rows: BulkRow[];
  running: boolean;
  paused: boolean;
  cancelRequested: boolean;
  startedAt: number | null;
  concurrency: number;
  onCancel: () => void;
  onTogglePause: () => void;
  onRetryRow: (index: number) => void;
  onClose: () => void;
  account: PrivilegedAccount | null;
}

const BULK_STATUS_TONE: Record<BulkStatus, string> = {
  pending: "text-muted-foreground",
  running: "text-warning",
  success: "text-success",
  failure: "text-destructive",
  cancelled: "text-muted-foreground",
  skipped: "text-muted-foreground",
};

const BulkProgressDrawer: React.FC<BulkProgressDrawerProps> = ({
  open,
  rows,
  running,
  paused,
  cancelRequested,
  startedAt,
  concurrency,
  onCancel,
  onTogglePause,
  onRetryRow,
  onClose,
  account,
}) => {
  const total = rows.length;
  const completed = rows.filter(
    (r) =>
      r.status === "success" ||
      r.status === "failure" ||
      r.status === "cancelled" ||
      r.status === "skipped",
  ).length;
  const successCount = rows.filter((r) => r.status === "success").length;
  const failureCount = rows.filter((r) => r.status === "failure").length;
  const progressValue = total === 0 ? 0 : Math.round((completed / total) * 100);

  // Wall-clock elapsed / ETA — re-ticked once per second when running.
  const [, forceTick] = React.useState(0);
  React.useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  const elapsedSec = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  const ratePerSec = elapsedSec > 0 ? completed / elapsedSec : 0;
  const remaining = total - completed;
  const etaSec = ratePerSec > 0 ? Math.round(remaining / ratePerSec) : null;

  const formatDuration = (s: number): string => {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${m}m ${ss}s`;
  };

  // Auto-scroll to the currently-running row so the operator sees motion.
  const listRef = React.useRef<HTMLUListElement | null>(null);
  React.useEffect(() => {
    if (!running) return;
    const el = listRef.current?.querySelector('[data-status="running"]');
    if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
      (el as HTMLElement).scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [running, rows]);

  // Copy all successful UPN+password pairs — useful for handoff to a CSV
  // or to paste into a secure channel.
  const handleCopySuccessCredentials = React.useCallback(async () => {
    const lines = rows
      .filter((r) => r.status === "success" && r.password)
      .map((r) => `${r.user.userPrincipalName ?? r.user.id}\t${r.password}`);
    if (lines.length === 0) return;
    await copyToClipboard(`UPN\tNewPassword\n${lines.join("\n")}`);
  }, [rows]);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && !running) onClose();
      }}
    >
      <SheetContent
        side="right"
        size="lg"
        className="flex flex-col"
        onEscapeKeyDown={(e) => running && e.preventDefault()}
        onInteractOutside={(e) => running && e.preventDefault()}
      >
        <SheetHeader>
          <SheetTitle>Bulk password reset</SheetTitle>
          <SheetDescription>
            {running
              ? cancelRequested
                ? "Cancellation requested. Finishing in-flight operations..."
                : paused
                  ? `Paused at ${completed} of ${total}. Click Resume to continue.`
                  : `Resetting passwords for ${pluralize(total, "user")} (parallelism ${concurrency})...`
              : completed === total
                ? `Done · ${successCount} succeeded · ${failureCount} failed`
                : `Stopped · ${completed} of ${total} processed`}
          </SheetDescription>
        </SheetHeader>
        <div className="px-6 pt-4">
          <Progress value={progressValue} aria-label="Bulk reset progress" />
          <div className="mt-1 flex items-center justify-between text-2xs text-muted-foreground tabular-nums">
            <span>
              {completed} / {total} · {successCount} ok · {failureCount} fail
            </span>
            <span>
              {progressValue}%
              {running &&
                elapsedSec > 0 &&
                ` · elapsed ${formatDuration(elapsedSec)}`}
              {running &&
                etaSec !== null &&
                etaSec > 0 &&
                ` · ETA ${formatDuration(etaSec)}`}
            </span>
          </div>
        </div>

        {successCount > 0 && !running && (
          <div className="px-6 pt-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void handleCopySuccessCredentials()}
              aria-label="Copy all UPN + new-password pairs to clipboard"
              title="Copies as TSV — paste into a spreadsheet or secure channel."
            >
              <Copy />
              Copy {successCount} UPN+password{successCount === 1 ? "" : "s"}
            </Button>
          </div>
        )}

        <SheetBody className="flex flex-col gap-1.5">
          <ul
            ref={listRef}
            role="list"
            aria-live="polite"
            className="flex flex-col gap-1"
          >
            {rows.map((r, idx) => (
              <li
                key={r.user.id}
                data-status={r.status}
                className={cn(
                  "flex items-start gap-2 rounded-md border bg-card px-3 py-2",
                  r.status === "running"
                    ? "border-warning/40 bg-warning/5"
                    : r.status === "failure"
                      ? "border-destructive/30"
                      : "border-border",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center",
                    BULK_STATUS_TONE[r.status],
                  )}
                  aria-hidden
                >
                  {r.status === "running" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                  ) : r.status === "success" ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : r.status === "failure" ? (
                    <XCircle className="h-3.5 w-3.5" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  )}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-xs text-foreground">
                    {r.user.displayName || r.user.userPrincipalName || r.user.id}
                  </span>
                  <span className="truncate font-mono text-2xs text-muted-foreground">
                    {r.user.userPrincipalName}
                  </span>
                  {r.message && (
                    <span
                      className={cn(
                        "mt-0.5 break-words text-2xs",
                        r.status === "failure"
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {r.message}
                    </span>
                  )}
                  {r.status === "success" && account && r.password && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <PortalLoginButton
                        upn={r.user.userPrincipalName || r.user.id}
                        tenantId={account.tenantId}
                        homeAccountId={account.homeAccountId}
                        password={r.password}
                        mustChangePassword={r.mustChangePassword ?? true}
                        size="xs"
                        label="Sign in to Portal"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => void copyToClipboard(r.password ?? "")}
                        aria-label="Copy this user's new password"
                        title="Copy new password"
                      >
                        <Copy />
                        Copy pw
                      </Button>
                    </div>
                  )}
                  {r.status === "failure" && (
                    <div className="mt-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => onRetryRow(idx)}
                        disabled={running}
                        aria-label={`Retry reset for ${r.user.userPrincipalName ?? r.user.id}`}
                        title="Retry this single row"
                      >
                        <RotateCw />
                        Retry
                      </Button>
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <span
                    className={cn(
                      "text-2xs font-medium uppercase tabular-nums",
                      BULK_STATUS_TONE[r.status],
                    )}
                  >
                    {r.status}
                  </span>
                  {r.durationMs !== undefined && (
                    <span className="text-2xs text-muted-foreground tabular-nums">
                      {(r.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </SheetBody>
        <SheetFooter className="gap-2">
          {running ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={onTogglePause}
                disabled={cancelRequested}
                aria-label={paused ? "Resume bulk reset" : "Pause bulk reset"}
              >
                {paused ? <Play /> : <Pause />}
                {paused ? "Resume" : "Pause"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={onCancel}
                disabled={cancelRequested}
                aria-label="Cancel bulk reset"
              >
                {cancelRequested ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Cancelling...
                  </>
                ) : (
                  "Cancel"
                )}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              aria-label="Close progress drawer"
            >
              Close
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

// =============================================================================
// User-details slide-over (read-only inspection)
// =============================================================================

interface UserDetailsSheetProps {
  user: UserRow | null;
  account: PrivilegedAccount | null;
  onClose: () => void;
  onReset: (u: UserRow) => void;
}

const UserDetailsSheet: React.FC<UserDetailsSheetProps> = ({
  user,
  account,
  onClose,
  onReset,
}) => {
  const state = useMultiRegionState();

  // Recent audit-log entries for this user — searches by target match.
  const recentAudit = React.useMemo(() => {
    if (!user) return [];
    const target = (user.userPrincipalName || user.id).toLowerCase();
    return state.auditEntries
      .filter((e) => (e.target ?? "").toLowerCase() === target)
      .slice(-8)
      .reverse();
  }, [user, state.auditEntries]);

  return (
    <Sheet open={user !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" size="lg" className="flex flex-col">
        <SheetHeader>
          <SheetTitle>{user?.displayName || user?.userPrincipalName || "User details"}</SheetTitle>
          <SheetDescription>
            Inspect, copy identifiers, and jump to actions for this user.
          </SheetDescription>
        </SheetHeader>
        {user && (
          <SheetBody className="flex flex-col gap-4">
            {/* Identity block — uses shared CopyButton via DetailRow so the
                hover-reveal pattern, success state, and ARIA labels match
                every other list page in the WebUI. */}
            <div className="flex flex-col gap-2">
              <DetailRow
                label="Display name"
                value={user.displayName || "(unnamed)"}
                copyValue={user.displayName ?? ""}
                hasValue={Boolean(user.displayName)}
              />
              <DetailRow
                label="UPN"
                value={user.userPrincipalName || "(none)"}
                mono
                copyValue={user.userPrincipalName ?? ""}
                hasValue={Boolean(user.userPrincipalName)}
              />
              <DetailRow
                label="Mail"
                value={user.mail || "(none)"}
                mono
                copyValue={user.mail ?? ""}
                hasValue={Boolean(user.mail)}
              />
              <DetailRow
                label="Object ID"
                value={user.id}
                mono
                copyValue={user.id}
                hasValue
              />
              {user.jobTitle && <DetailRow label="Job title" value={user.jobTitle} />}
              {user.department && <DetailRow label="Department" value={user.department} />}
            </div>

            {/* Flags */}
            <div className="flex flex-wrap items-center gap-1.5">
              {user.accountEnabled ? (
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="h-3 w-3" aria-hidden /> Enabled
                </Badge>
              ) : (
                <Badge variant="secondary" className="gap-1">
                  <CircleSlash className="h-3 w-3" aria-hidden /> Disabled
                </Badge>
              )}
              {user.isGuest ? (
                <Badge variant="warning" className="gap-1">
                  <UserCog className="h-3 w-3" aria-hidden /> Guest / external
                </Badge>
              ) : (
                <Badge variant="info" className="gap-1">
                  <UserCheck className="h-3 w-3" aria-hidden /> Member
                </Badge>
              )}
              {user.subscriptionCount > 0 && (
                <Badge variant="info" className="gap-1">
                  <Cloud className="h-3 w-3" aria-hidden />
                  {user.subscriptionCount} subscription
                  {user.subscriptionCount === 1 ? "" : "s"}
                </Badge>
              )}
              {user.appearsOnPremSynced && (
                <Badge variant="warning" className="gap-1">
                  <Building2 className="h-3 w-3" aria-hidden /> On-prem synced
                </Badge>
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => onReset(user)}
                aria-label={`Reset password for ${user.displayName || user.userPrincipalName}`}
              >
                <KeyRound /> Reset password
              </Button>
              {account && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  asChild
                  title="Open user blade in Azure Portal"
                >
                  <a
                    href={portalUserUrl(account.tenantId, user.id)}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <ExternalLink /> Open in Azure Portal
                  </a>
                </Button>
              )}
            </div>

            {/* Recent audit-log entries for this user */}
            <div className="flex flex-col gap-1.5">
              <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Recent activity
              </p>
              {recentAudit.length === 0 ? (
                <p className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-2xs text-muted-foreground">
                  No audit-log entries match this user yet. Actions taken from
                  this page (reset, sign-in launches) will appear here.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {recentAudit.map((e) => (
                    <li
                      key={e.id}
                      className="flex flex-col gap-0.5 rounded-md border border-border bg-card px-2.5 py-1.5"
                    >
                      <span className="flex items-center justify-between gap-2 text-2xs">
                        <span className="font-mono text-foreground">{e.action}</span>
                        <span
                          className={cn(
                            "font-semibold uppercase",
                            e.status === "success"
                              ? "text-success"
                              : "text-destructive",
                          )}
                        >
                          {e.status}
                        </span>
                      </span>
                      <span
                        className="text-2xs text-muted-foreground"
                        title={new Date(e.timestamp).toLocaleString()}
                      >
                        {formatRelativeTime(e.timestamp)} · {e.actor}
                      </span>
                      {e.error && (
                        <span className="break-words text-2xs text-destructive">
                          {e.error}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </SheetBody>
        )}
        <SheetFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

interface DetailRowProps {
  label: string;
  value: string;
  mono?: boolean;
  /**
   * Optional explicit value to copy (defaults to `value`). When set and
   * `hasValue` is true, a shared `<CopyButton>` is rendered to the right
   * of the value — visible only on hover/focus per the `group/copy`
   * Tailwind contract.
   */
  copyValue?: string;
  hasValue?: boolean;
}

const DetailRow: React.FC<DetailRowProps> = ({
  label,
  value,
  mono,
  copyValue,
  hasValue = true,
}) => {
  const toCopy = copyValue ?? value;
  const showCopy = hasValue && toCopy.length > 0;
  return (
    <div className="group/copy grid grid-cols-[7rem_1fr_auto] items-center gap-2">
      <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "truncate text-xs text-foreground",
          mono && "font-mono",
          !hasValue && "text-muted-foreground",
        )}
      >
        {value}
      </span>
      {showCopy ? (
        <CopyButton
          value={toCopy}
          ariaLabel={`Copy ${label.toLowerCase()}`}
          alwaysVisible={false}
          iconSize={14}
        />
      ) : (
        <span aria-hidden />
      )}
    </div>
  );
};

// =============================================================================
// Main page
// =============================================================================

export interface TenantUsersPageProps {
  orchestrator: OrchestratorAgent;
  onNavigate?: (key: PageKey) => void;
}

const TenantUsersPageInner: React.FC<TenantUsersPageProps> = ({
  orchestrator,
  onNavigate,
}) => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();

  const azureAccounts = state.azureAccounts ?? [];

  const [privilegedMap, setPrivilegedMap] = React.useState<Record<string, boolean>>({});
  const [discoveringPrivileges, setDiscoveringPrivileges] = React.useState(true);

  const accountKey = React.useMemo(
    () =>
      azureAccounts
        .map((a) => `${a.homeAccountId}|${a.tenantId}`)
        .sort()
        .join(","),
    [azureAccounts],
  );

  // Capability discovery — guarded by the per-render AbortSignal from
  // useAbortableEffect. When the account set changes (or the component
  // unmounts), `signal.aborted` flips true and we drop every in-flight
  // probe's result instead of clobbering newer state. Token / role calls
  // don't accept a signal directly (the MSAL + Graph wrappers predate
  // this hook), so we check `signal.aborted` after each await as the
  // moral equivalent.
  useAbortableEffect(
    async (signal) => {
      setDiscoveringPrivileges(true);
      const next: Record<string, boolean> = {};
      await Promise.allSettled(
        azureAccounts.map(async (a) => {
          if (!a.homeAccountId) return;
          const tenantId = getActiveTenant(a.homeAccountId) ?? a.tenantId;
          if (!tenantId) {
            next[a.homeAccountId] = false;
            return;
          }
          try {
            const token = await getGraphTokenForAccount(
              a.homeAccountId,
              tenantId,
            );
            if (signal.aborted) return;
            const roles = await getMyDirectoryRoles(tenantId, token);
            if (signal.aborted) return;
            const ok = canResetPasswords(roles);
            next[a.homeAccountId] = ok;
            store.setPasswordResetCapability(a.homeAccountId, ok);
          } catch {
            if (signal.aborted) return;
            next[a.homeAccountId] = false;
            store.setPasswordResetCapability(a.homeAccountId, false);
          }
        }),
      );
      if (signal.aborted) return;
      setPrivilegedMap(next);
      setDiscoveringPrivileges(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountKey, store],
  );

  const privilegedAccounts: PrivilegedAccount[] = React.useMemo(() => {
    return azureAccounts
      .filter((a) => privilegedMap[a.homeAccountId])
      .map((a) => ({
        homeAccountId: a.homeAccountId,
        tenantId: getActiveTenant(a.homeAccountId) ?? a.tenantId,
        username: a.username,
        name: a.name || a.username,
      }))
      .filter((a) => a.tenantId);
  }, [azureAccounts, privilegedMap]);

  // URL-synced filters: tenant selector, search text, quick filter chip.
  const [urlFilters, setUrlFilters] = useUrlState({
    tenant: "",
    search: "",
    filter: "all",
  });
  const activeKey = urlFilters.tenant as string;
  const searchQuery = urlFilters.search as string;
  const quickFilter = ((): QuickFilter => {
    const raw = urlFilters.filter as string;
    return (QUICK_FILTERS.find((f) => f.id === raw)?.id as QuickFilter) ?? "all";
  })();

  // Default the tenant param to the first privileged account once known.
  React.useEffect(() => {
    if (privilegedAccounts.length === 0) return;
    const exists = privilegedAccounts.some(
      (a) => selectionKey(a) === activeKey,
    );
    if (!exists) {
      const next = selectionKey(privilegedAccounts[0]!);
      setUrlFilters({ tenant: next });
    }
  }, [privilegedAccounts, activeKey, setUrlFilters]);

  const handleSelectAccount = React.useCallback(
    (key: string) => {
      setUrlFilters({ tenant: key });
    },
    [setUrlFilters],
  );

  const activeAccount: PrivilegedAccount | null = React.useMemo(() => {
    return (
      privilegedAccounts.find((a) => selectionKey(a) === activeKey) ?? null
    );
  }, [privilegedAccounts, activeKey]);

  // Debounced search input — instant local UI; URL update is debounced.
  const [searchInput, setSearchInput] = React.useState(searchQuery);
  const lastUrlSearchRef = React.useRef(searchQuery);
  React.useEffect(() => {
    if (searchQuery !== lastUrlSearchRef.current) {
      setSearchInput(searchQuery);
      lastUrlSearchRef.current = searchQuery;
    }
  }, [searchQuery]);
  const debounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const handleSearchInputChange = React.useCallback(
    (value: string) => {
      setSearchInput(value);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        lastUrlSearchRef.current = value;
        setUrlFilters({ search: value });
      }, SEARCH_DEBOUNCE_MS);
    },
    [setUrlFilters],
  );
  React.useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  // Ctrl/Cmd+K focuses search.
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [loadingUsers, setLoadingUsers] = React.useState(false);
  const [usersError, setUsersError] = React.useState<string | null>(null);
  const [userSubMap, setUserSubMap] = React.useState<Record<string, number>>({});
  const [lastRefreshedAt, setLastRefreshedAt] = React.useState<number | null>(null);

  const tenantUsers = activeAccount
    ? state.tenantUsers[activeAccount.tenantId] ?? []
    : [];

  // Guard last-fetch-wins when the operator switches tenants mid-load.
  const refreshUsersSeqRef = React.useRef(0);

  const refreshUsers = React.useCallback(async () => {
    if (!activeAccount) return;
    const seq = ++refreshUsersSeqRef.current;
    setLoadingUsers(true);
    setUsersError(null);
    try {
      const result = await orchestrator.execute({
        action: "list_tenant_users",
        payload: {
          tenantId: activeAccount.tenantId,
          homeAccountId: activeAccount.homeAccountId,
        },
      });
      if (seq !== refreshUsersSeqRef.current) return;
      if (result.status === "failed") {
        const err = (result.summary as Record<string, unknown> | undefined)
          ?.error;
        setUsersError(typeof err === "string" ? err : "Failed to load users.");
      }
      try {
        const token = await getGraphTokenForAccount(
          activeAccount.homeAccountId,
          activeAccount.tenantId,
        );
        const subRows = await listOrgSubscriptions(
          activeAccount.tenantId,
          token,
        );
        if (seq !== refreshUsersSeqRef.current) return;
        const map: Record<string, number> = {};
        for (const row of subRows) {
          map[row.userId] = row.subscriptionIds.length;
        }
        setUserSubMap(map);
      } catch {
        if (seq !== refreshUsersSeqRef.current) return;
        setUserSubMap({});
      }
      setLastRefreshedAt(Date.now());
    } catch (e: unknown) {
      if (seq !== refreshUsersSeqRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setUsersError(msg);
    } finally {
      if (seq === refreshUsersSeqRef.current) {
        setLoadingUsers(false);
      }
    }
  }, [orchestrator, activeAccount]);

  // Auto-load on account change. The refresh path itself is seq-guarded
  // (refreshUsersSeqRef) so a slow load can't clobber a newer one started
  // by an account change; we still wire this through useAbortableEffect
  // so an unmount aborts the wait. (orchestrator.execute does not yet
  // accept an AbortSignal — see COORDINATOR note below.)
  useAbortableEffect(
    async (signal) => {
      if (!activeAccount) return;
      await refreshUsers();
      if (signal.aborted) return;
    },
    [activeAccount, refreshUsers],
  );

  // Bump a re-render once a minute so the "Refreshed Xs ago" pill stays fresh.
  const [, forceRelativeTick] = React.useState(0);
  React.useEffect(() => {
    if (lastRefreshedAt === null) return undefined;
    const id = setInterval(() => forceRelativeTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [lastRefreshedAt]);

  // Stale-threshold preference — defaults to 90 days, configurable from the
  // toolbar. Persisted across sessions via the standard hook (versioned so
  // future shape changes can migrate cleanly).
  const [staleDaysThreshold, setStaleDaysThreshold] = usePersistedState<number>(
    STALE_THRESHOLD_DAYS_PREF_KEY,
    DEFAULT_STALE_DAYS,
    {
      version: 1,
      migrate: (raw) => {
        const n = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(n)) return DEFAULT_STALE_DAYS;
        return (STALE_DAYS_OPTIONS as readonly number[]).includes(n)
          ? n
          : DEFAULT_STALE_DAYS;
      },
    },
  );

  // ---- Defender-side: deleted-users surface ------------------------------
  // Corpus-derived READ-ONLY signal: users sitting in the 30-day soft-delete
  // recovery window (`/directory/deletedItems/microsoft.graph.user`). See
  // `tenant-users-deleted-panel.tsx` header for the full citation set —
  // primary refs are `_AZURE_BYPASS_PLAYBOOK.md` item 9 ("Hard delete user"
  // is one of the top-10 defender-audit signals) and
  // `_bypass_modify_delete.md` §4.7/4.9.
  //
  // The probe must NEVER invoke hard-delete or restore — those are
  // state-changing primitives the offensive playbook documents but this
  // defensive WebUI deliberately does not expose. The panel surfaces the
  // trail and provides a portal deep-link for any remediation; the
  // operator performs the actual restore in the audited Entra Portal UI.
  //
  // COORDINATOR: tenant-users needs graph-service.listDeletedUsers()
  // returning DeletedUserRow[] (see `tenant-users-deleted-panel.tsx`).
  // Suggested wire shape:
  //   GET /v1.0/directory/deletedItems/microsoft.graph.user
  //     ?$select=id,displayName,userPrincipalName,mail,deletedDateTime,
  //              accountEnabled
  //     &$orderby=deletedDateTime desc
  //     &$top=100
  // Requires Directory.AccessAsUser.All (delegated) or User.Read.All
  // (app-only). Until that lands, this page stubs the data path with an
  // empty array + a "Permission required" hint when the operator's
  // capability is unknown (no directory role discovery probed this).
  const [showDeletedPanel, setShowDeletedPanel] = usePersistedState<boolean>(
    SHOW_DELETED_PANEL_PREF_KEY,
    true,
    {
      version: 1,
      migrate: (raw) => Boolean(raw),
    },
  );
  const [deletedRows, setDeletedRows] = React.useState<DeletedUserRow[]>([]);
  const [deletedLoading, setDeletedLoading] = React.useState(false);
  const [deletedError, setDeletedError] = React.useState<string | null>(null);
  // Capability flag — once `graph-service.listDeletedUsers` exists this can
  // flip to true after a successful probe. Until then we default to false
  // so the panel renders the "Permission required" hint instead of an
  // empty-state that would lie about the state of the tenant.
  const [deletedPermissionGranted, setDeletedPermissionGranted] =
    React.useState(false);
  const deletedSeqRef = React.useRef(0);

  const refreshDeletedUsers = React.useCallback(async () => {
    if (!activeAccount) {
      setDeletedRows([]);
      setDeletedPermissionGranted(false);
      return;
    }
    const seq = ++deletedSeqRef.current;
    setDeletedLoading(true);
    setDeletedError(null);
    try {
      // COORDINATOR: replace this stub with
      //   const token = await getGraphTokenForAccount(...);
      //   const rows = await listDeletedUsers(activeAccount.tenantId, token);
      // and set deletedPermissionGranted from the resulting 200 / 403.
      const rows: DeletedUserRow[] = [];
      if (seq !== deletedSeqRef.current) return;
      setDeletedRows(rows);
      // Until the service method exists, we cannot prove the operator
      // has the right scope, so we leave the permission flag false to
      // surface the "Permission required" hint (instead of pretending
      // the tenant truly has zero deletions).
      setDeletedPermissionGranted(false);
    } catch (e: unknown) {
      if (seq !== deletedSeqRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setDeletedError(msg);
      setDeletedRows([]);
      setDeletedPermissionGranted(false);
    } finally {
      if (seq === deletedSeqRef.current) {
        setDeletedLoading(false);
      }
    }
  }, [activeAccount]);

  // Probe the deleted-users surface when the account or the toggle changes.
  // `useAbortableEffect`'s AbortSignal guards us if the operator switches
  // accounts mid-flight; the seq guard inside `refreshDeletedUsers` is
  // belt-and-braces for the post-await state writes.
  useAbortableEffect(
    async (signal) => {
      if (!activeAccount || !showDeletedPanel) {
        setDeletedRows([]);
        setDeletedError(null);
        setDeletedPermissionGranted(false);
        return;
      }
      await refreshDeletedUsers();
      if (signal.aborted) return;
    },
    [activeAccount, showDeletedPanel, refreshDeletedUsers],
  );

  // KPI tile value: how many deletions sit inside the 30-day window. We
  // count `deletedRows` directly (the corpus signal is "anything in the
  // bucket is a tracking surface") rather than filtering by age, because
  // the Graph endpoint itself only returns the last 30 days.
  const deletedCount = deletedRows.length;

  // Per-row enrichment: derive isGuest / appearsOnPremSynced / isStale once.
  // We snapshot Date.now() into the memo so a single tenant load uses one
  // reference time across all rows; the memo refreshes whenever the source
  // data, subscription map, or stale threshold changes.
  const allRows: UserRow[] = React.useMemo(() => {
    const nowMs = Date.now();
    return tenantUsers.map((u) => {
      const createdDateTime = (u as unknown as { createdDateTime?: string })
        .createdDateTime;
      const subscriptionCount = userSubMap[u.id] ?? 0;
      return {
        ...u,
        subscriptionCount,
        createdDateTime,
        isGuest: isGuestUser(u),
        appearsOnPremSynced: appearsOnPremSynced(u),
        isStale: isStaleUser(
          { ...u, createdDateTime, subscriptionCount },
          staleDaysThreshold,
          nowMs,
        ),
      };
    });
  }, [tenantUsers, userSubMap, staleDaysThreshold]);

  // Quick-filter predicate.
  const matchesQuickFilter = React.useCallback(
    (u: UserRow): boolean => {
      switch (quickFilter) {
        case "members":
          return !u.isGuest;
        case "guests":
          return u.isGuest;
        case "enabled":
          return u.accountEnabled;
        case "disabled":
          return !u.accountEnabled;
        case "subs":
          return u.subscriptionCount > 0;
        case "nosubs":
          return u.subscriptionCount === 0;
        case "stale":
          return u.isStale;
        case "all":
        default:
          return true;
      }
    },
    [quickFilter],
  );

  const filteredRows = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allRows.filter((u) => {
      if (!matchesQuickFilter(u)) return false;
      if (!q) return true;
      const fields = [
        u.displayName,
        u.userPrincipalName,
        u.mail ?? "",
        u.jobTitle ?? "",
        u.department ?? "",
        u.id, // allow object-id search
      ];
      return fields.some((f) => f.toLowerCase().includes(q));
    });
  }, [allRows, searchQuery, matchesQuickFilter]);

  // Per-chip counts so the chip strip can show "Members (47)" etc.
  const chipCounts = React.useMemo<Record<QuickFilter, number>>(() => {
    const counts: Record<QuickFilter, number> = {
      all: allRows.length,
      members: 0,
      guests: 0,
      enabled: 0,
      disabled: 0,
      subs: 0,
      nosubs: 0,
      stale: 0,
    };
    for (const u of allRows) {
      if (u.isGuest) counts.guests += 1;
      else counts.members += 1;
      if (u.accountEnabled) counts.enabled += 1;
      else counts.disabled += 1;
      if (u.subscriptionCount > 0) counts.subs += 1;
      else counts.nosubs += 1;
      if (u.isStale) counts.stale += 1;
    }
    return counts;
  }, [allRows]);

  // Stats derived from the unfiltered set so they describe the tenant, not
  // the current view.
  const totalUsers = allRows.length;
  const memberCount = chipCounts.members;
  const guestCount = chipCounts.guests;
  const disabledCount = chipCounts.disabled;
  const staleCount = chipCounts.stale;
  const subCount = React.useMemo(
    () => allRows.reduce((sum, u) => sum + u.subscriptionCount, 0),
    [allRows],
  );
  const usersWithSubs = chipCounts.subs;

  // ---- Single-user reset --------------------------------------------------
  const [resetTarget, setResetTarget] = React.useState<UserRow | null>(null);
  const [detailsTarget, setDetailsTarget] = React.useState<UserRow | null>(null);

  const handleResetSuccess = React.useCallback(
    (upn: string) => {
      store.addNotification({
        type: "success",
        message: `Password reset for ${upn}`,
      });
      setResetTarget(null);
    },
    [store],
  );

  // ---- Bulk reset ---------------------------------------------------------
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = React.useState(false);
  const [bulkDrawerOpen, setBulkDrawerOpen] = React.useState(false);
  const [bulkRows, setBulkRows] = React.useState<BulkRow[]>([]);
  const [bulkRunning, setBulkRunning] = React.useState(false);
  const [bulkStartedAt, setBulkStartedAt] = React.useState<number | null>(null);
  const cancelRequestedRef = React.useRef(false);
  const [cancelRequested, setCancelRequested] = React.useState(false);
  const pausedRef = React.useRef(false);
  const [paused, setPaused] = React.useState(false);

  // Bulk concurrency (1/3/5/10) — persisted.
  const [bulkConcurrency, setBulkConcurrency] = React.useState<number>(() =>
    readPersistedNumber(
      BULK_CONCURRENCY_PREF_KEY,
      DEFAULT_BULK_CONCURRENCY,
      BULK_CONCURRENCY_OPTIONS,
    ),
  );
  React.useEffect(() => {
    writePersistedNumber(BULK_CONCURRENCY_PREF_KEY, bulkConcurrency);
  }, [bulkConcurrency]);

  // Reset selection AND any in-flight bulk drawer state when the tenant
  // selection changes — the selected ids belong to the previous tenant.
  React.useEffect(() => {
    setSelectedIds(new Set());
    if (!bulkRunning) {
      setBulkDrawerOpen(false);
      setBulkRows([]);
    }
  }, [activeKey, bulkRunning]);

  // Prune selected ids that no longer exist after a refresh (rare but
  // happens when a user is deleted between fetches).
  React.useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(allRows.map((u) => u.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [allRows]);

  const selectedUsers = React.useMemo(() => {
    if (selectedIds.size === 0) return [] as UserRow[];
    return allRows.filter((u) => selectedIds.has(u.id));
  }, [allRows, selectedIds]);

  const tenantDisplayName = activeAccount
    ? activeAccount.name || activeAccount.username || activeAccount.tenantId
    : "";

  /**
   * Run a single reset and return the resulting BulkRow. Pulled out so the
   * concurrency worker and the per-row Retry button share one code path.
   */
  const runOneReset = React.useCallback(
    async (target: UserRow, token: string): Promise<BulkRow> => {
      const start = Date.now();
      const password = generateRandomPassword();
      try {
        await resetUserPassword(
          activeAccount!.tenantId,
          target.id,
          password,
          true,
          token,
        );
        auditLog.record({
          actor:
            activeAccount!.username ||
            activeAccount!.name ||
            activeAccount!.homeAccountId,
          action: "reset_password",
          target: target.userPrincipalName || target.id,
          status: "success",
          details: {
            tenantId: activeAccount!.tenantId,
            forceChange: true,
            userId: target.id,
            mail: target.mail ?? undefined,
            accountEnabled: target.accountEnabled,
            isGuest: target.isGuest,
            appearsOnPremSynced: target.appearsOnPremSynced,
            bulk: true,
          },
        });
        try {
          await credentialVault.put({
            upn: target.userPrincipalName || target.id,
            password,
            tenantId: activeAccount!.tenantId,
            homeAccountId: activeAccount!.homeAccountId,
            displayName: target.displayName ?? undefined,
            createdAt: new Date().toISOString(),
            source: "reset",
            mustChangePassword: true,
          });
        } catch (vaultErr) {
          console.warn("[tenant-users] bulk vault.put failed", vaultErr);
        }
        return {
          user: target,
          status: "success",
          message: "Password reset.",
          password,
          mustChangePassword: true,
          durationMs: Date.now() - start,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        auditLog.record({
          actor:
            activeAccount!.username ||
            activeAccount!.name ||
            activeAccount!.homeAccountId,
          action: "reset_password",
          target: target.userPrincipalName || target.id,
          status: "failure",
          error: msg,
          details: {
            tenantId: activeAccount!.tenantId,
            forceChange: true,
            userId: target.id,
            mail: target.mail ?? undefined,
            accountEnabled: target.accountEnabled,
            isGuest: target.isGuest,
            appearsOnPremSynced: target.appearsOnPremSynced,
            bulk: true,
          },
        });
        return {
          user: target,
          status: "failure",
          message: msg,
          durationMs: Date.now() - start,
        };
      }
    },
    [activeAccount],
  );

  const handleStartBulkReset = React.useCallback(async () => {
    if (!activeAccount || selectedUsers.length === 0) return;
    setBulkConfirmOpen(false);
    cancelRequestedRef.current = false;
    setCancelRequested(false);
    pausedRef.current = false;
    setPaused(false);
    const initial: BulkRow[] = selectedUsers.map((u) => ({
      user: u,
      status: "pending",
    }));
    setBulkRows(initial);
    setBulkDrawerOpen(true);
    setBulkRunning(true);
    setBulkStartedAt(Date.now());

    try {
      const token = await getGraphTokenForAccount(
        activeAccount.homeAccountId,
        activeAccount.tenantId,
      );

      // Work queue with worker-pool concurrency. We loop through indices,
      // dispatching up to N at a time, and pause/cancel with awaitable
      // small sleeps so the UI never freezes.
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));

      let nextIdx = 0;
      let activeWorkers = 0;
      const total = initial.length;
      let succeeded = 0;
      let failed = 0;

      await new Promise<void>((resolveAll) => {
        const tryDispatch = () => {
          if (cancelRequestedRef.current) {
            // Snapshot remaining pending rows as cancelled.
            setBulkRows((prev) =>
              prev.map((r) =>
                r.status === "pending"
                  ? { ...r, status: "cancelled" }
                  : r,
              ),
            );
            // Wait for in-flight workers to drain before resolving.
            if (activeWorkers === 0) resolveAll();
            return;
          }
          if (pausedRef.current) {
            // Pause loop — re-check every 200ms.
            setTimeout(tryDispatch, 200);
            return;
          }
          while (
            activeWorkers < bulkConcurrency &&
            nextIdx < total &&
            !cancelRequestedRef.current &&
            !pausedRef.current
          ) {
            const idx = nextIdx++;
            activeWorkers += 1;
            const target = initial[idx]!.user;
            setBulkRows((prev) =>
              prev.map((r, i) =>
                i === idx ? { ...r, status: "running" } : r,
              ),
            );
            void runOneReset(target, token).then((row) => {
              setBulkRows((prev) =>
                prev.map((r, i) => (i === idx ? row : r)),
              );
              if (row.status === "success") succeeded += 1;
              else if (row.status === "failure") failed += 1;
              activeWorkers -= 1;
              if (activeWorkers === 0 && nextIdx >= total) {
                resolveAll();
              } else {
                tryDispatch();
              }
            });
          }
          if (
            activeWorkers === 0 &&
            (nextIdx >= total || cancelRequestedRef.current)
          ) {
            resolveAll();
          }
        };
        tryDispatch();
        // Defensive idle tick (in case the initial dispatch found nothing).
        void sleep(0).then(() => {
          if (activeWorkers === 0 && nextIdx >= total) resolveAll();
        });
      });

      // Count cancelled rows for the summary toast.
      const cancelledCount = initial.length - succeeded - failed;

      const summaryParts = [
        `${succeeded} succeeded`,
        `${failed} failed`,
        cancelledCount > 0 ? `${cancelledCount} cancelled` : null,
      ].filter((p): p is string => p !== null);
      store.addNotification({
        type: failed > 0 ? "error" : "success",
        message: `Bulk reset complete · ${summaryParts.join(" · ")}`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      store.addNotification({
        type: "error",
        message: `Bulk reset failed: ${msg}`,
      });
      setBulkRows((prev) =>
        prev.map((r) =>
          r.status === "pending" || r.status === "running"
            ? { ...r, status: "failure", message: msg }
            : r,
        ),
      );
    } finally {
      setBulkRunning(false);
      cancelRequestedRef.current = false;
      setCancelRequested(false);
      pausedRef.current = false;
      setPaused(false);
    }
  }, [activeAccount, selectedUsers, store, runOneReset, bulkConcurrency]);

  const handleRetryBulkRow = React.useCallback(
    async (index: number) => {
      if (!activeAccount) return;
      if (bulkRunning) return;
      const target = bulkRows[index]?.user;
      if (!target) return;
      setBulkRows((prev) =>
        prev.map((r, i) => (i === index ? { ...r, status: "running" } : r)),
      );
      try {
        const token = await getGraphTokenForAccount(
          activeAccount.homeAccountId,
          activeAccount.tenantId,
        );
        const next = await runOneReset(target, token);
        setBulkRows((prev) => prev.map((r, i) => (i === index ? next : r)));
        store.addNotification({
          type: next.status === "success" ? "success" : "error",
          message:
            next.status === "success"
              ? `Retry succeeded for ${target.userPrincipalName ?? target.id}.`
              : `Retry failed for ${target.userPrincipalName ?? target.id}: ${next.message ?? "unknown"}.`,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setBulkRows((prev) =>
          prev.map((r, i) =>
            i === index ? { ...r, status: "failure", message: msg } : r,
          ),
        );
      }
    },
    [activeAccount, bulkRows, bulkRunning, runOneReset, store],
  );

  const handleCancelBulk = React.useCallback(() => {
    cancelRequestedRef.current = true;
    setCancelRequested(true);
  }, []);

  const handleTogglePause = React.useCallback(() => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  }, []);

  const handleCloseBulkDrawer = React.useCallback(() => {
    setBulkDrawerOpen(false);
  }, []);

  // ---- Bulk copy actions --------------------------------------------------
  const handleCopySelectedUpns = React.useCallback(async () => {
    if (selectedUsers.length === 0) return;
    const text = selectedUsers
      .map((u) => u.userPrincipalName ?? u.id)
      .join("\n");
    const ok = await copyToClipboard(text);
    store.addNotification({
      type: ok ? "success" : "error",
      message: ok
        ? `Copied ${selectedUsers.length} UPN${selectedUsers.length === 1 ? "" : "s"}.`
        : "Failed to copy UPNs.",
    });
  }, [selectedUsers, store]);

  const handleCopySelectedObjectIds = React.useCallback(async () => {
    if (selectedUsers.length === 0) return;
    const text = selectedUsers.map((u) => u.id).join("\n");
    const ok = await copyToClipboard(text);
    store.addNotification({
      type: ok ? "success" : "error",
      message: ok
        ? `Copied ${selectedUsers.length} object id${selectedUsers.length === 1 ? "" : "s"}.`
        : "Failed to copy object ids.",
    });
  }, [selectedUsers, store]);

  const handleCopyUpn = React.useCallback(
    async (u: UserRow) => {
      const text = u.userPrincipalName ?? "";
      if (!text) {
        store.addNotification({
          type: "error",
          message: "User has no UPN to copy.",
        });
        return;
      }
      const ok = await copyToClipboard(text);
      store.addNotification({
        type: ok ? "success" : "error",
        message: ok ? `Copied ${text}.` : "Failed to copy UPN.",
      });
    },
    [store],
  );

  const handleCopyObjectId = React.useCallback(
    async (u: UserRow) => {
      const ok = await copyToClipboard(u.id);
      store.addNotification({
        type: ok ? "success" : "error",
        message: ok ? `Copied object id ${u.id.slice(0, 8)}…` : "Failed to copy object id.",
      });
    },
    [store],
  );

  // ---- Export columns -----------------------------------------------------
  // Headless column descriptors for the shared ExportMenu. The DataTable's
  // built-in CSV button already exports the visible columns, so this menu
  // gives the operator a richer "full matrix" dump including computed
  // fields (isGuest, isStale, appearsOnPremSynced) that aren't surfaced
  // as table columns. JSON export ships the full row shape.
  const exportColumns = React.useMemo<ExportColumn<UserRow>[]>(
    () => [
      { header: "Display Name", accessor: (u) => u.displayName },
      { header: "UPN", accessor: (u) => u.userPrincipalName },
      { header: "Mail", accessor: (u) => u.mail ?? "" },
      { header: "Object ID", accessor: (u) => u.id },
      { header: "Type", accessor: (u) => (u.isGuest ? "Guest" : "Member") },
      {
        header: "Status",
        accessor: (u) => (u.accountEnabled ? "Enabled" : "Disabled"),
      },
      { header: "Job Title", accessor: (u) => u.jobTitle ?? "" },
      { header: "Department", accessor: (u) => u.department ?? "" },
      {
        header: "Subscription Count",
        accessor: (u) => u.subscriptionCount,
      },
      {
        header: "Created",
        accessor: (u) => u.createdDateTime ?? "",
      },
      {
        header: "On-prem Synced (heuristic)",
        accessor: (u) => (u.appearsOnPremSynced ? "yes" : "no"),
      },
      {
        header: "Stale (heuristic)",
        accessor: (u) => (u.isStale ? "yes" : "no"),
      },
    ],
    [],
  );

  // ---- Columns ------------------------------------------------------------
  const columns = React.useMemo<DataTableColumn<UserRow>[]>(
    () => [
      {
        id: "displayName",
        header: "Display Name",
        cell: (u) => (
          <button
            type="button"
            className="truncate text-left text-xs text-foreground hover:text-primary hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              setDetailsTarget(u);
            }}
            title="Open details"
            aria-label={`Open details for ${u.displayName || u.userPrincipalName}`}
          >
            {u.displayName || "(unnamed)"}
          </button>
        ),
        sort: (a, b) => compareStrings(a.displayName, b.displayName),
        csv: (u) => u.displayName,
      },
      {
        id: "userPrincipalName",
        header: "User Principal Name",
        cell: (u) => {
          const upn = u.userPrincipalName ?? "";
          const at = upn.indexOf("@");
          if (at < 0) {
            return (
              <span className="text-xs text-muted-foreground">{upn}</span>
            );
          }
          return (
            <span className="flex items-baseline gap-0 truncate text-xs">
              <span className="text-foreground">{upn.slice(0, at + 1)}</span>
              <span className="font-mono text-muted-foreground">
                {upn.slice(at + 1)}
              </span>
            </span>
          );
        },
        sort: (a, b) =>
          compareStrings(a.userPrincipalName, b.userPrincipalName),
        csv: (u) => u.userPrincipalName,
      },
      {
        id: "userType",
        header: "Type",
        cell: (u) =>
          u.isGuest ? (
            <Badge variant="warning" className="gap-1">
              <UserCog className="h-3 w-3" aria-hidden /> Guest
            </Badge>
          ) : (
            <Badge variant="info" className="gap-1">
              <UserCheck className="h-3 w-3" aria-hidden /> Member
            </Badge>
          ),
        sort: (a, b) => Number(a.isGuest) - Number(b.isGuest),
        csv: (u) => (u.isGuest ? "Guest" : "Member"),
      },
      {
        id: "jobTitle",
        header: "Job Title",
        cell: (u) => (
          <span className="truncate text-xs text-muted-foreground">
            {u.jobTitle || "—"}
          </span>
        ),
        sort: (a, b) => compareStrings(a.jobTitle ?? "", b.jobTitle ?? ""),
        csv: (u) => u.jobTitle ?? "",
        defaultHidden: true,
      },
      {
        id: "department",
        header: "Department",
        cell: (u) => (
          <span className="truncate text-xs text-muted-foreground">
            {u.department || "—"}
          </span>
        ),
        sort: (a, b) => compareStrings(a.department ?? "", b.department ?? ""),
        csv: (u) => u.department ?? "",
        defaultHidden: true,
      },
      {
        id: "accountEnabled",
        header: "Status",
        cell: (u) =>
          u.accountEnabled ? (
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="h-3 w-3" aria-hidden />
              Enabled
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1">
              <CircleSlash className="h-3 w-3" aria-hidden />
              Disabled
            </Badge>
          ),
        sort: (a, b) => Number(b.accountEnabled) - Number(a.accountEnabled),
        csv: (u) => (u.accountEnabled ? "Enabled" : "Disabled"),
      },
      {
        id: "subscriptionCount",
        header: "Has Sub",
        cell: (u) =>
          u.subscriptionCount > 0 ? (
            <Badge variant="info" className="gap-1">
              <Cloud className="h-3 w-3" aria-hidden />
              {u.subscriptionCount} sub{u.subscriptionCount === 1 ? "" : "s"}
            </Badge>
          ) : (
            <span className="text-2xs text-muted-foreground">—</span>
          ),
        sort: (a, b) => b.subscriptionCount - a.subscriptionCount,
        csv: (u) => u.subscriptionCount,
      },
      {
        id: "createdDateTime",
        header: "Created",
        cell: (u) =>
          u.createdDateTime ? (
            <span
              className="text-2xs text-muted-foreground tabular-nums"
              title={new Date(u.createdDateTime).toLocaleString()}
            >
              {formatRelativeTime(u.createdDateTime)}
            </span>
          ) : (
            <span className="text-2xs text-muted-foreground">—</span>
          ),
        sort: (a, b) =>
          compareStrings(a.createdDateTime ?? "", b.createdDateTime ?? ""),
        csv: (u) => u.createdDateTime ?? "",
      },
      {
        id: "actions",
        header: "Actions",
        cell: (u) => (
          <div className="flex items-center justify-end gap-1">
            <TooltipProvider delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      setResetTarget(u);
                    }}
                    aria-label={`Reset password for ${u.displayName || u.userPrincipalName}`}
                  >
                    <KeyRound />
                    Reset
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  Set a new password for this user (single).
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="More actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setDetailsTarget(u)}>
                  <Info className="mr-2 h-3.5 w-3.5" />
                  View details
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void handleCopyUpn(u)}>
                  <Copy className="mr-2 h-3.5 w-3.5" />
                  Copy UPN
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void handleCopyObjectId(u)}>
                  <Copy className="mr-2 h-3.5 w-3.5" />
                  Copy object id
                </DropdownMenuItem>
                {u.mail && (
                  <DropdownMenuItem
                    onSelect={() => void copyToClipboard(u.mail ?? "")}
                  >
                    <Mail className="mr-2 h-3.5 w-3.5" />
                    Copy mail
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setResetTarget(u)}>
                  <KeyRound className="mr-2 h-3.5 w-3.5" />
                  Reset password
                </DropdownMenuItem>
                {activeAccount && (
                  <DropdownMenuItem asChild>
                    <a
                      href={portalUserUrl(activeAccount.tenantId, u.id)}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="flex items-center"
                    >
                      <ExternalLink className="mr-2 h-3.5 w-3.5" />
                      Open in Azure Portal
                    </a>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [activeAccount, handleCopyObjectId, handleCopyUpn],
  );

  // React to global tenant-switch events by re-pointing the URL `tenant`
  // param at the matching privileged account (composite key shape matches
  // selectionKey()). Skip if the candidate isn't in the eligible list or is
  // already the active selection.
  useTenantChange(undefined, (detail) => {
    const candidate = `${detail.homeAccountId}::${detail.tenantId}`;
    if (!privilegedAccounts.some((a) => selectionKey(a) === candidate)) return;
    if (activeKey === candidate) return;
    setUrlFilters({ tenant: candidate });
  });

  // ---- Render branches -----------------------------------------------------
  if (discoveringPrivileges && privilegedAccounts.length === 0) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <PageHeader
          title="Tenant Users"
          description="Reset passwords and audit who can sign in to this tenant."
        />
        <div
          role="status"
          className="flex items-center justify-center rounded-lg border border-dashed border-border bg-card px-6 py-10 text-sm text-muted-foreground"
        >
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Discovering directory roles...
        </div>
      </div>
    );
  }

  if (privilegedAccounts.length === 0) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <PageHeader
          title="Tenant Users"
          description="Reset passwords and audit who can sign in to this tenant."
        />
        <EmptyState
          icon={ShieldCheck}
          title="No tenant-administrative access"
          description="Sign in with an account that holds a User Administrator, Helpdesk Administrator, Password Administrator, Authentication Administrator, Privileged Authentication Administrator, or Global Administrator role to manage tenant users."
          action={
            onNavigate
              ? {
                  label: "Go to Azure Accounts",
                  onClick: () => onNavigate("azure-accounts"),
                }
              : undefined
          }
        />
      </div>
    );
  }

  const selectedCount = selectedIds.size;

  return (
    <div className="flex flex-col gap-4 py-4">
      <PageHeader
        title="Tenant Users"
        description="Reset passwords and audit who can sign in to this tenant."
      >
        <Select value={activeKey} onValueChange={handleSelectAccount}>
          <SelectTrigger className="h-8 w-72 text-xs">
            <SelectValue placeholder="Select account / tenant" />
          </SelectTrigger>
          <SelectContent>
            {privilegedAccounts.map((a) => {
              const k = selectionKey(a);
              return (
                <SelectItem key={k} value={k}>
                  <span className="truncate">
                    {a.name || a.username}
                    <span className="ml-1 text-muted-foreground">
                      ({(a.tenantId ?? "unknown").slice(0, 8)}...)
                    </span>
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <TooltipProvider delayDuration={250}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={refreshUsers}
                disabled={loadingUsers || !activeAccount}
                aria-label="Refresh users"
              >
                {loadingUsers ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RotateCw />
                )}
                Refresh
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {lastRefreshedAt
                ? `Last refresh ${formatRelativeTime(new Date(lastRefreshedAt).toISOString())} · all pages via Graph $top=999 + @odata.nextLink`
                : "Reload the tenant user list from Microsoft Graph."}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </PageHeader>

      {/* Toolbar: search + quick filters + bulk action bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={searchInputRef}
            type="search"
            value={searchInput}
            onChange={(e) => handleSearchInputChange(e.target.value)}
            placeholder="Search name, UPN, mail, title, dept, object id..."
            aria-label="Search users"
            className="h-8 w-80 pl-7 pr-14 text-xs transition-shadow duration-200 ease-out focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          />
          <span
            className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 select-none rounded border border-border bg-muted px-1 py-0.5 text-2xs font-medium text-muted-foreground sm:inline-block"
            aria-hidden
          >
            Ctrl+K
          </span>
        </div>
        <QuickFilterChips
          active={quickFilter}
          onChange={(next) => setUrlFilters({ filter: next })}
          counts={chipCounts}
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {selectedCount > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-2xs font-medium text-primary"
              aria-live="polite"
            >
              <Checkbox checked disabled className="h-3 w-3" aria-hidden />
              {selectedCount} selected
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="ml-1 underline-offset-2 hover:underline focus:outline-none focus-visible:underline"
                aria-label="Clear selection"
              >
                Clear
              </button>
            </span>
          )}
          {/* Bulk copy menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={selectedCount === 0}
                aria-label="Bulk copy menu"
                title="Copy identifiers for selected users"
              >
                <Copy />
                Copy ({selectedCount})
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => void handleCopySelectedUpns()}
                disabled={selectedCount === 0}
              >
                Copy UPNs ({selectedCount})
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void handleCopySelectedObjectIds()}
                disabled={selectedCount === 0}
              >
                Copy object ids ({selectedCount})
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Full-matrix export (CSV + JSON). DataTable has its own CSV button
              scoped to visible columns; this menu dumps the full row shape
              including computed fields (isGuest, isStale, appearsOnPremSynced)
              so the operator can audit the matrix outside the UI. */}
          <ExportMenu<UserRow>
            rows={filteredRows}
            columns={exportColumns}
            filename={`tenant-users-${activeAccount?.tenantId ?? "unknown"}`}
            jsonMetadata={{
              tenantId: activeAccount?.tenantId,
              actor: activeAccount?.username,
              quickFilter,
              searchQuery,
              staleDaysThreshold,
            }}
            label="Export matrix"
          />
          {/* Stale-threshold picker — only visible when the Stale filter or
              KPI is in play. Persists across sessions. */}
          <TooltipProvider delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Select
                  value={String(staleDaysThreshold)}
                  onValueChange={(v) => setStaleDaysThreshold(Number(v))}
                >
                  <SelectTrigger
                    className="h-8 w-28 text-xs"
                    aria-label="Stale threshold in days"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STALE_DAYS_OPTIONS.map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        Stale ≥{n}d
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Age threshold for the "Stale" heuristic. A user counts as
                stale when accountEnabled = false OR (createdDateTime older
                than this AND subscriptionCount === 0). Persisted across
                sessions.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {/* Bulk concurrency picker — only meaningful when something selected */}
          <TooltipProvider delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Select
                  value={String(bulkConcurrency)}
                  onValueChange={(v) => setBulkConcurrency(Number(v))}
                >
                  <SelectTrigger
                    className="h-8 w-24 text-xs"
                    aria-label="Bulk reset parallelism"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BULK_CONCURRENCY_OPTIONS.map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}× parallel
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                How many Graph PATCH /users/{"{id}"} calls to run in parallel
                during a bulk reset. Higher values finish faster but increase
                the chance of 429 throttling.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={selectedCount === 0 ? 0 : -1}>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => setBulkConfirmOpen(true)}
                    disabled={selectedCount === 0 || bulkRunning}
                    aria-label={`Reset passwords for ${selectedCount} selected users`}
                  >
                    <KeyRound />
                    Reset passwords ({selectedCount})
                  </Button>
                </span>
              </TooltipTrigger>
              {selectedCount === 0 && (
                <TooltipContent side="bottom">
                  Select one or more rows in the table to enable bulk reset.
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Summary stats — also act as one-click filters (where it makes sense) */}
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-lg border border-border bg-card px-3 py-3 shadow-sm"
        role="status"
        aria-live="polite"
      >
        <SummaryStat
          icon={Users}
          label="Total"
          value={totalUsers}
          tone="primary"
          hint="All users returned by Microsoft Graph for this tenant (paginated server-side)."
          onClick={() => setUrlFilters({ filter: "all" })}
          active={quickFilter === "all"}
        />
        <SummaryStat
          icon={UserCheck}
          label="Members"
          value={memberCount}
          tone="info"
          hint="Cloud-only members (UPN does not contain #EXT# and mail domain matches UPN)."
          onClick={() => setUrlFilters({ filter: "members" })}
          active={quickFilter === "members"}
        />
        <SummaryStat
          icon={UserCog}
          label="Guests"
          value={guestCount}
          tone="warning"
          hint="External / B2B users — they sign in via their home tenant."
          onClick={() => setUrlFilters({ filter: "guests" })}
          active={quickFilter === "guests"}
        />
        <SummaryStat
          icon={UserX}
          label="Disabled"
          value={disabledCount}
          tone="destructive"
          hint="Users with accountEnabled = false (cannot sign in)."
          onClick={() => setUrlFilters({ filter: "disabled" })}
          active={quickFilter === "disabled"}
        />
        <SummaryStat
          icon={AlertTriangle}
          label="Stale"
          value={staleCount}
          tone="warning"
          hint={`Heuristic-stale users (≥${staleDaysThreshold}d old with no subs, or disabled). signInActivity is NOT consulted (requires Entra P1 + AuditLog.Read.All).`}
          onClick={() => setUrlFilters({ filter: "stale" })}
          active={quickFilter === "stale"}
        />
        <SummaryStat
          icon={Trash2}
          label="Deleted 30d"
          value={deletedCount}
          tone="warning"
          hint={
            deletedPermissionGranted
              ? "Users sitting in the 30-day soft-delete recovery window (defender-side audit surface — corpus: _AZURE_BYPASS_PLAYBOOK.md item 9, _bypass_modify_delete.md §4.7/4.9)."
              : "Permission required (Directory.AccessAsUser.All / User.Read.All). Toggle the deleted-users panel below to see the hint."
          }
          onClick={() => setShowDeletedPanel(!showDeletedPanel)}
          active={showDeletedPanel}
        />
        <SummaryStat
          icon={Cloud}
          label="Has Sub"
          value={usersWithSubs}
          tone="success"
          hint="Users assigned to at least one Azure subscription visible to the caller."
          onClick={() => setUrlFilters({ filter: "subs" })}
          active={quickFilter === "subs"}
        />
        <SummaryStat
          icon={ShieldCheck}
          label="Sub Count"
          value={subCount}
          tone="info"
          hint="Total subscription-role assignments across all users."
        />
        <div className="ml-auto flex items-center gap-2 text-2xs text-muted-foreground">
          <span>
            Showing{" "}
            <span className="font-semibold text-foreground tabular-nums">
              {filteredRows.length}
            </span>{" "}
            of{" "}
            <span className="tabular-nums">{totalUsers}</span>
          </span>
          {lastRefreshedAt && (
            <span
              className="rounded-md border border-border bg-muted px-1.5 py-0.5"
              title={new Date(lastRefreshedAt).toLocaleString()}
            >
              {formatRelativeTime(new Date(lastRefreshedAt).toISOString())}
            </span>
          )}
        </div>
      </div>

      {usersError && (
        <ErrorState
          message="Failed to load users."
          detail={usersError}
          onRetry={refreshUsers}
          retryDisabled={loadingUsers}
        />
      )}

      <DataTable<UserRow>
        tableId="tenant-users"
        rows={filteredRows}
        columns={columns}
        rowKey={(u) => u.id}
        loading={loadingUsers && allRows.length === 0}
        selection={selectedIds}
        onSelectionChange={setSelectedIds}
        onRowActivate={(u) => setDetailsTarget(u)}
        initialSort={{ column: "displayName", direction: "asc" }}
        csvFileName="tenant-users.csv"
        jsonFileName="tenant-users.json"
        empty={
          searchQuery.trim() || quickFilter !== "all" ? (
            <EmptyState
              icon={Mail}
              title="No users match the current filters"
              description={
                searchQuery.trim()
                  ? `No users in this tenant match "${searchQuery}" with the "${QUICK_FILTERS.find((f) => f.id === quickFilter)?.label ?? "All"}" filter active. Clear the search or change the filter.`
                  : `No users match the "${QUICK_FILTERS.find((f) => f.id === quickFilter)?.label ?? "All"}" filter. Switch to "All" to see every user.`
              }
              action={{
                label: "Clear filters",
                onClick: () => {
                  setSearchInput("");
                  setUrlFilters({ search: "", filter: "all" });
                },
              }}
            />
          ) : (
            <EmptyState
              icon={Mail}
              title="No users found"
              description="The selected tenant returned an empty user list. Try refreshing or pick a different account."
              action={{
                label: "Refresh",
                onClick: refreshUsers,
                icon: RotateCw,
              }}
            />
          )
        }
      />

      <ResetPasswordDialog
        user={resetTarget}
        account={activeAccount}
        onClose={() => setResetTarget(null)}
        onSuccess={handleResetSuccess}
      />

      <UserDetailsSheet
        user={detailsTarget}
        account={activeAccount}
        onClose={() => setDetailsTarget(null)}
        onReset={(u) => {
          setDetailsTarget(null);
          setResetTarget(u);
        }}
      />

      <ConfirmationDialog
        hidden={!bulkConfirmOpen}
        title="Reset passwords for selected users?"
        message={
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              Reset passwords for{" "}
              <strong className="text-foreground">
                {pluralize(selectedCount, "user")}
              </strong>{" "}
              in <strong className="text-foreground">{tenantDisplayName}</strong>?
              Each user will receive a randomly generated password and will be
              required to change it at next sign-in. This cannot be undone.
            </p>
            {/* Surface edge-case risks so the operator confirms with eyes open. */}
            {(() => {
              const guests = selectedUsers.filter((u) => u.isGuest).length;
              const disabled = selectedUsers.filter(
                (u) => !u.accountEnabled,
              ).length;
              const synced = selectedUsers.filter(
                (u) => u.appearsOnPremSynced,
              ).length;
              if (guests + disabled + synced === 0) return null;
              return (
                <ul className="flex flex-col gap-1 rounded-md border border-warning/30 bg-warning/5 p-2 text-2xs text-warning">
                  {guests > 0 && (
                    <li className="flex items-center gap-1.5">
                      <UserCog className="h-3 w-3" aria-hidden />
                      {guests} guest{guests === 1 ? "" : "s"} selected — guest
                      sign-ins happen at their home tenant; this reset has no
                      effect there.
                    </li>
                  )}
                  {disabled > 0 && (
                    <li className="flex items-center gap-1.5">
                      <CircleSlash className="h-3 w-3" aria-hidden />
                      {disabled} disabled account
                      {disabled === 1 ? "" : "s"} selected — they can't sign in
                      until re-enabled.
                    </li>
                  )}
                  {synced > 0 && (
                    <li className="flex items-center gap-1.5">
                      <Building2 className="h-3 w-3" aria-hidden />
                      {synced} on-prem-synced account
                      {synced === 1 ? "" : "s"} selected — AD sync may overwrite
                      the new password.
                    </li>
                  )}
                </ul>
              );
            })()}
            <p className="text-2xs">
              Parallelism:{" "}
              <span className="font-semibold text-foreground">
                {bulkConcurrency}× concurrent
              </span>{" "}
              · You can pause, cancel, or retry individual rows from the
              progress drawer.
            </p>
          </div>
        }
        confirmText={`Reset ${selectedCount} ${selectedCount === 1 ? "password" : "passwords"}`}
        cancelText="Cancel"
        danger
        onConfirm={handleStartBulkReset}
        onCancel={() => setBulkConfirmOpen(false)}
      />

      <BulkProgressDrawer
        open={bulkDrawerOpen}
        rows={bulkRows}
        running={bulkRunning}
        paused={paused}
        cancelRequested={cancelRequested}
        startedAt={bulkStartedAt}
        concurrency={bulkConcurrency}
        onCancel={handleCancelBulk}
        onTogglePause={handleTogglePause}
        onRetryRow={(idx) => void handleRetryBulkRow(idx)}
        onClose={handleCloseBulkDrawer}
        account={activeAccount}
      />

      {/* Defender-side surface: deleted-users (30-day recovery window).
          READ-ONLY signal from the offensive-tooling corpus — see panel
          file header for full citation (`_AZURE_BYPASS_PLAYBOOK.md`
          item 9 + `_bypass_modify_delete.md` §4.7/4.9). Toggleable
          via the "Deleted 30d" KPI tile above; default-open so an
          operator running this against their own tenant sees the
          signal immediately. */}
      {showDeletedPanel && activeAccount && (
        <DeletedUsersPanel
          tenantId={activeAccount.tenantId}
          actor={
            activeAccount.username ||
            activeAccount.name ||
            activeAccount.homeAccountId
          }
          rows={deletedRows}
          permissionGranted={deletedPermissionGranted}
          loading={deletedLoading}
          error={deletedError}
          onRefresh={() => void refreshDeletedUsers()}
        />
      )}
    </div>
  );
};

export const TenantUsersPage: React.FC<TenantUsersPageProps> = (props) => (
  <ErrorBoundary>
    <TenantUsersPageInner {...props} />
  </ErrorBoundary>
);
