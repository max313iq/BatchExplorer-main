/**
 * User Creator page — provisions Microsoft Entra ID (Azure AD) users in a
 * tenant where the signed-in account holds a User Administrator role.
 * Includes real-time UPN availability probing, AD attribute presets, and
 * zod-backed inline validation. Does NOT manage subscription role
 * assignments — that lives in the Account Provisioning page.
 */
import * as React from "react";
import {
  AlertCircle,
  ArrowLeftRight,
  AtSign,
  BadgeCheck,
  Building2,
  Check,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Filter,
  FileJson,
  HardDrive,
  IdCard,
  KeyRound,
  LogIn,
  Loader2,
  PartyPopper,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { z } from "zod";

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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, sleep } from "@/lib/utils";

import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { getActiveTenant, getGraphTokenForAccount } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { usePersistedState } from "../../hooks/use-persisted-state";
import {
  credentialVault,
  type CredentialEntry,
} from "../../auth/credential-vault";
import {
  attemptInteractiveLogin,
  launchPortalAutoLogin,
} from "../../auth/portal-auto-login";
import { auditLog } from "../../services/audit-log";
import {
  canCreateUsers,
  createUser,
  getMyDirectoryRoles,
  listVerifiedDomains,
} from "../../services/graph-service";
import type { VerifiedDomain } from "../../services/graph-service";
import { GraphUser } from "../../services/types";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { EmptyState } from "../shared/empty-state";
import { SignInRequired } from "../shared/sign-in-required";
import { EnhancedColumn, EnhancedTable } from "../shared/enhanced-table";
import { ErrorBoundary } from "../shared/error-boundary";
import { PageHeader } from "../shared/page-header";
import { PortalLoginButton } from "../shared/portal-login-button";
import { type PageKey } from "../shared/sidebar-nav";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

const ACTIVE_ACCOUNT_KEY = "user-creator:active-account";
const TAB_KEY = "user-creator:tab";
const ACCOUNT_MODE_KEY = "user-creator:account-mode";
const AUTO_LOGIN_PREF_KEY = "user-creator:auto-launch-portal";
const SHOW_ALL_PW_KEY = "user-creator:show-all-pw";
const SAVED_TEMPLATES_KEY = "user-creator:saved-templates";
/**
 * Count threshold above which a bulk quick-mode create requires an explicit
 * confirmation step. Single-user creates skip the dialog (low-risk happy
 * path). Anything bigger triggers a "you are about to provision N users in
 * tenant X" confirmation so an accidental finger-slip on the up-arrow can't
 * spawn 50 Entra accounts.
 */
const BULK_CONFIRM_THRESHOLD = 1;

const VALID_TABS = ["create", "browse", "created"] as const;
type TabValue = (typeof VALID_TABS)[number];
const isValidTab = (v: string | null | undefined): v is TabValue =>
  !!v && (VALID_TABS as readonly string[]).includes(v);

/**
 * Account selection mode.
 * - `auto`   → only show accounts where directory-role discovery found a
 *              user-creation role (User Admin, Global Admin, etc).
 * - `manual` → show every signed-in Azure account; the create call may
 *              still fail with 403 if the account lacks the role, but
 *              the user can attempt it (useful when role discovery
 *              misfires due to a cross-tenant Graph quirk).
 */
type AccountMode = "auto" | "manual";
const MIN_PASSWORD_LENGTH = 12;
const GENERATED_PASSWORD_LENGTH = 16;
const USER_PREFIX_RE = /^[a-zA-Z0-9._-]{1,40}$/;
// 300ms hits the sweet spot — long enough to ignore mid-typing strokes
// (typical inter-keystroke gap is ~120-180ms for sustained typing), short
// enough that the spinner appears almost instantly when the user pauses.
// Previously 400ms which felt unresponsive on the success-card flow.
const AVAILABILITY_DEBOUNCE_MS = 300;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// Sign-in helpers (Playwright auto-login, MSAL interactive popup) live in
// ../../auth/portal-auto-login so the password-reset flow on the Tenant Users
// page can share the exact same chain.

const USAGE_LOCATIONS: Array<{ code: string; label: string }> = [
  { code: "US", label: "United States (US)" },
  { code: "GB", label: "United Kingdom (GB)" },
  { code: "DE", label: "Germany (DE)" },
  { code: "FR", label: "France (FR)" },
  { code: "IN", label: "India (IN)" },
  { code: "JP", label: "Japan (JP)" },
  { code: "AU", label: "Australia (AU)" },
  { code: "CA", label: "Canada (CA)" },
  { code: "BR", label: "Brazil (BR)" },
  { code: "NL", label: "Netherlands (NL)" },
  { code: "SG", label: "Singapore (SG)" },
];

interface PresetDefinition {
  key: string;
  label: string;
  description: string;
  jobTitle: string;
  department: string;
  usageLocation: string;
  forceChangePassword: boolean;
  accountEnabled: boolean;
}

const PRESETS: PresetDefinition[] = [
  {
    key: "standard",
    label: "Standard User",
    description: "Default tenant member with no elevated attributes.",
    jobTitle: "Member",
    department: "General",
    usageLocation: "US",
    forceChangePassword: true,
    accountEnabled: true,
  },
  {
    key: "admin",
    label: "Admin",
    description: "Engineering admin with elevated metadata.",
    jobTitle: "Administrator",
    department: "IT",
    usageLocation: "US",
    forceChangePassword: true,
    accountEnabled: true,
  },
  {
    key: "readonly",
    label: "Read-only",
    description: "Read-only auditor with restricted profile.",
    jobTitle: "Auditor",
    department: "Compliance",
    usageLocation: "US",
    forceChangePassword: true,
    accountEnabled: true,
  },
  {
    key: "service",
    label: "Service Account",
    description: "Long-lived non-interactive account; no forced reset.",
    jobTitle: "Service Account",
    department: "Platform",
    usageLocation: "US",
    forceChangePassword: false,
    accountEnabled: true,
  },
  {
    key: "contractor",
    label: "Contractor",
    description: "External contributor; account starts disabled until vetted.",
    jobTitle: "Contractor",
    department: "External",
    usageLocation: "US",
    forceChangePassword: true,
    accountEnabled: false,
  },
];

interface PrivilegedAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
}

/**
 * Operator-saved quick-mode template — captures the per-tenant attribute
 * shape (preset role + display-name pattern + optional post-create redirect
 * URL) so the operator can re-apply a frequently-used combo with one click.
 *
 * Persisted in localStorage via `usePersistedState` keyed by SAVED_TEMPLATES_KEY.
 * `displayNamePattern` supports `{first}` / `{last}` / `{prefix}` placeholders
 * — empty pattern falls back to the default title-cased prefix.
 * `redirectUrl` is informational only; the success-card sign-in flow still
 * uses the WebUI origin. It's stored for operator reference.
 */
interface SavedTemplate {
  id: string;
  name: string;
  presetKey: string;
  displayNamePattern: string;
  redirectUrl: string;
  count: number;
  createdAt: string;
}

type AvailabilityState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available" }
  | { status: "taken" }
  | { status: "error"; message: string };

const userFormSchema = z.object({
  prefix: z
    .string()
    .min(1, "User ID is required.")
    .regex(
      USER_PREFIX_RE,
      "Letters, numbers, dot, dash, or underscore. Max 40 characters.",
    ),
  domain: z.string().min(1, "Select a domain."),
  displayName: z.string().trim().min(1, "Display name is required."),
  givenName: z.string(),
  surname: z.string(),
  jobTitle: z.string(),
  department: z.string(),
  usageLocation: z.string().min(1, "Select a usage location."),
  password: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    ),
  forceChange: z.boolean(),
  accountEnabled: z.boolean(),
});

type UserFormValues = z.infer<typeof userFormSchema>;

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

function titleCase(value: string): string {
  if (!value) return "";
  return value
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(" ");
}

function deriveGivenName(prefix: string): string {
  const cased = titleCase(prefix);
  const space = cased.indexOf(" ");
  return space >= 0 ? cased.slice(0, space) : cased;
}

function deriveSurname(prefix: string): string {
  const cased = titleCase(prefix);
  const space = cased.indexOf(" ");
  return space >= 0 ? cased.slice(space + 1) : "";
}

function truncateMiddle(value: string, head = 8, tail = 4): string {
  if (!value || value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

// ---------------------------------------------------------------------------
// Quick-mode batch generator — when the operator picks "Role + Count" and
// nothing else, we synthesize plausible name + UPN + password tuples here.
// ---------------------------------------------------------------------------

const QUICK_MODE_KEY = "user-creator:quick-mode";
const QUICK_COUNT_MIN = 1;
const QUICK_COUNT_MAX = 50;

const FIRST_NAMES = [
  "alex", "jamie", "taylor", "jordan", "morgan", "casey", "riley",
  "drew", "quinn", "avery", "cameron", "blake", "skyler", "reese",
  "finley", "hayden", "kai", "rowan", "sage", "emerson", "harper",
  "logan", "parker", "phoenix", "remy", "shawn", "sloan",
];

const LAST_NAMES = [
  "smith", "johnson", "lee", "brown", "davis", "miller", "wilson",
  "garcia", "martinez", "anderson", "thomas", "moore", "white",
  "harris", "clark", "lewis", "young", "walker", "hall", "allen",
  "kim", "patel", "nguyen", "rivera", "torres", "ng", "okafor",
];

function randHex(n: number): string {
  const buf = new Uint8Array(Math.ceil(n / 2));
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++)
      buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, n);
}

function pickOne<T>(arr: T[]): T {
  if (arr.length === 0) throw new Error("pickOne: empty array");
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return arr[buf[0]! % arr.length]!;
  }
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export interface QuickUserPayload {
  prefix: string;
  upn: string;
  displayName: string;
  givenName: string;
  surname: string;
  password: string;
  jobTitle: string;
  department: string;
  usageLocation: string;
  forceChange: boolean;
  accountEnabled: boolean;
}

function generateBatchPayload(
  count: number,
  preset: PresetDefinition,
  domain: string,
): QuickUserPayload[] {
  const used = new Set<string>();
  const out: QuickUserPayload[] = [];
  for (let i = 0; i < count; i++) {
    let prefix: string;
    let attempts = 0;
    do {
      const fn = pickOne(FIRST_NAMES);
      const ln = pickOne(LAST_NAMES);
      prefix = `${fn}.${ln}.${randHex(4)}`;
      attempts++;
    } while (used.has(prefix) && attempts < 10);
    used.add(prefix);
    const [first, last] = prefix.split(".") as [string, string, string];
    out.push({
      prefix,
      upn: `${prefix}@${domain}`,
      displayName: `${titleCase(first)} ${titleCase(last)}`,
      givenName: titleCase(first),
      surname: titleCase(last),
      password: generateRandomPassword(),
      jobTitle: preset.jobTitle,
      department: preset.department,
      usageLocation: preset.usageLocation,
      forceChange: preset.forceChangePassword,
      accountEnabled: preset.accountEnabled,
    });
  }
  return out;
}

/**
 * Parse an operator-pasted CSV blob into a list of QuickUserPayload rows.
 *
 * Accepted column shapes (per row, header row optional):
 *   - `prefix`                              (1 col, falls back to titleCase)
 *   - `prefix,displayName`                  (2 cols)
 *   - `prefix,displayName,jobTitle`         (3 cols)
 *   - `prefix,displayName,jobTitle,dept`    (4 cols)
 *
 * Header rows (`prefix,displayName,...`) are skipped if detected. Comment
 * lines starting with `#` and blank lines are ignored. UPN prefix is
 * validated against USER_PREFIX_RE; rows that fail validation are
 * collected into the `errors` output so the operator can fix them
 * without retyping everything.
 *
 * Password + accountEnabled + force-change are taken from the active
 * preset (not from CSV) — keeping the CSV operator-friendly and the
 * sensitive bits server-derived.
 */
interface ParsedCsv {
  rows: QuickUserPayload[];
  errors: Array<{ line: number; text: string; reason: string }>;
}

function parseCsvPayload(
  text: string,
  preset: PresetDefinition,
  domain: string,
): ParsedCsv {
  const rows: QuickUserPayload[] = [];
  const errors: Array<{ line: number; text: string; reason: string }> = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    // Header sniff — first non-blank line, contains "prefix" and a comma.
    if (
      rows.length === 0 &&
      errors.length === 0 &&
      /^prefix\b/i.test(trimmed) &&
      trimmed.includes(",")
    ) {
      continue;
    }
    // Simple CSV split — we don't expect quoted fields in this minimal
    // contract; if someone needs commas in display names they can edit
    // post-create. Keeps the parser predictable.
    const parts = trimmed.split(",").map((p) => p.trim());
    const prefix = parts[0] ?? "";
    if (!prefix) {
      errors.push({ line: i + 1, text: raw, reason: "empty prefix" });
      continue;
    }
    if (!USER_PREFIX_RE.test(prefix)) {
      errors.push({
        line: i + 1,
        text: raw,
        reason: "invalid prefix (use letters/numbers/._- max 40)",
      });
      continue;
    }
    if (seen.has(prefix.toLowerCase())) {
      errors.push({
        line: i + 1,
        text: raw,
        reason: "duplicate prefix in CSV",
      });
      continue;
    }
    seen.add(prefix.toLowerCase());
    const givenName = parts[1] ? deriveGivenName(parts[1]) : deriveGivenName(prefix);
    const surname = parts[1] ? deriveSurname(parts[1]) : deriveSurname(prefix);
    const displayName = parts[1] || titleCase(prefix);
    const jobTitle = parts[2] || preset.jobTitle;
    const department = parts[3] || preset.department;
    rows.push({
      prefix,
      upn: `${prefix}@${domain}`,
      displayName,
      givenName,
      surname,
      password: generateRandomPassword(),
      jobTitle,
      department,
      usageLocation: preset.usageLocation,
      forceChange: preset.forceChangePassword,
      accountEnabled: preset.accountEnabled,
    });
  }
  return { rows, errors };
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "-";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "-";
  let diff = Date.now() - ms;
  // Negative diff = clock skew or future date. Show as "in Xs" rather than
  // "-5s ago" which is meaningless. The previous Math.round path turned
  // 59.6s into "60s ago" — switching to Math.floor avoids that edge.
  const future = diff < 0;
  if (future) diff = -diff;
  const sec = Math.floor(diff / 1000);
  if (sec < 1) return "just now";
  const fmt = (n: number, unit: string): string =>
    future ? `in ${n}${unit}` : `${n}${unit} ago`;
  if (sec < 60) return fmt(sec, "s");
  const min = Math.floor(sec / 60);
  if (min < 60) return fmt(min, "m");
  const hr = Math.floor(min / 60);
  if (hr < 48) return fmt(hr, "h");
  const day = Math.floor(hr / 24);
  if (day < 60) return fmt(day, "d");
  const mo = Math.floor(day / 30);
  if (mo < 24) return fmt(mo, "mo");
  const yr = Math.floor(mo / 12);
  return fmt(yr, "y");
}

// CSV-cell escape: wrap in quotes if it contains comma/quote/newline, and
// double up internal quotes. Used by the vault bulk-export flow.
function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Trigger a browser download for the given text content. Uses
// URL.createObjectURL + <a download> + revokeObjectURL to avoid leaking
// memory. SSR-safe (returns silently if window is undefined).
function downloadTextFile(filename: string, content: string, mime: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Safe clipboard write with a single notification helper. Returns true on
// success so callers can avoid showing a "copied" toast when the platform
// silently denies clipboard access.
async function tryWriteClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

interface BrowseRow extends GraphUser {
  tenantId: string;
  createdDateTime?: string | null;
}

export interface UserCreatorPageProps {
  orchestrator?: OrchestratorAgent;
  // COORDINATOR: prop kept as PageKey for backward compat with legacy
  // adapter signature. The page-router adapter passes `navigateToPage`
  // directly here; PageKey is a subset of `string`, and navigateToPage
  // accepts both PageKey strings AND full paths, so direct pass-through
  // is type-safe at the call site. Internally we call onNavigate("…page…")
  // with PageKey literals only. If we migrate to path-strings later,
  // bump the type to `(target: string) => void`.
  onNavigate?: (k: PageKey) => void;
}

/**
 * Segmented toggle that lets the operator opt out of the role-discovery
 * filter. `auto` (default) only surfaces accounts where Graph reported a
 * user-creation role; `manual` exposes every signed-in account so the
 * operator can attempt the create call against any of them — useful
 * when role discovery misfires due to a cross-tenant Graph permission
 * quirk. The badge counts give the operator a quick read on what each
 * mode would unlock before they switch.
 */
const AccountModeToggle: React.FC<{
  mode: AccountMode;
  onChange: (m: AccountMode) => void;
  autoCount: number;
  manualCount: number;
  discovering?: boolean;
  onRefresh?: () => void;
}> = ({ mode, onChange, autoCount, manualCount, discovering, onRefresh }) => {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
      <span className="font-semibold uppercase tracking-wide text-muted-foreground">
        Account mode
      </span>
      <div
        role="radiogroup"
        aria-label="Account selection mode"
        className="inline-flex overflow-hidden rounded-md border border-border"
      >
        <button
          type="button"
          role="radio"
          aria-checked={mode === "auto"}
          onClick={() => onChange("auto")}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1 transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            mode === "auto"
              ? "bg-primary/15 text-foreground"
              : "text-muted-foreground hover:bg-muted/50",
          )}
        >
          <Wand2 className="h-3.5 w-3.5" aria-hidden />
          <span>Auto-detect</span>
          <Badge
            variant={mode === "auto" ? "secondary" : "outline"}
            className="ml-0.5 text-2xs"
          >
            {autoCount}
          </Badge>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "manual"}
          onClick={() => onChange("manual")}
          className={cn(
            "flex items-center gap-1.5 border-l border-border px-2.5 py-1 transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            mode === "manual"
              ? "bg-primary/15 text-foreground"
              : "text-muted-foreground hover:bg-muted/50",
          )}
        >
          <IdCard className="h-3.5 w-3.5" aria-hidden />
          <span>Manual pick</span>
          <Badge
            variant={mode === "manual" ? "secondary" : "outline"}
            className="ml-0.5 text-2xs"
          >
            {manualCount}
          </Badge>
        </button>
      </div>
      <span className="text-2xs text-muted-foreground">
        {mode === "auto"
          ? "Only accounts with detected user-creation roles."
          : "Every signed-in account — 403 if role is missing."}
      </span>
      {onRefresh && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={discovering}
          aria-label="Re-probe directory roles"
          title="Re-run the User Admin / Global Admin probe against every signed-in account. Useful when role-discovery misfired or you just granted yourself the role."
          className="ml-auto h-7 px-2"
        >
          {discovering ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          <span className="ml-1.5 text-2xs">Re-probe</span>
        </Button>
      )}
    </div>
  );
};

const UserCreatorPageInner: React.FC<UserCreatorPageProps> = ({
  onNavigate,
}) => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();

  const azureAccounts = state.azureAccounts ?? [];

  // Account-mode toggle — lifted above the discovery effect so its
  // sessionStorage hydration runs before any gate is evaluated. In
  // `manual` mode we bypass the privileged-role gate entirely.
  const [accountMode, setAccountMode] = React.useState<AccountMode>(() => {
    try {
      const raw = sessionStorage.getItem(ACCOUNT_MODE_KEY);
      return raw === "manual" ? "manual" : "auto";
    } catch {
      return "auto";
    }
  });

  const handleAccountModeChange = React.useCallback((mode: AccountMode) => {
    setAccountMode(mode);
    try {
      sessionStorage.setItem(ACCOUNT_MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, []);

  const [privilegedMap, setPrivilegedMap] = React.useState<
    Record<string, boolean>
  >({});
  const [discovering, setDiscovering] = React.useState(true);

  const accountKey = React.useMemo(
    () =>
      azureAccounts
        .map((a) => `${a.homeAccountId}|${a.tenantId}`)
        .sort()
        .join(","),
    [azureAccounts],
  );

  // Track probe errors separately from the privileged map so the UI can
  // distinguish "Graph said no role" from "Graph call failed entirely"
  // (the latter is recoverable — usually a token-acquisition hiccup).
  const [probeErrors, setProbeErrors] = React.useState<
    Record<string, string>
  >({});
  const [probeNonce, setProbeNonce] = React.useState(0);
  const refreshProbe = React.useCallback(() => {
    setProbeNonce((n) => n + 1);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setDiscovering(true);
    // Drop stale errors immediately so the picker reflects "probing" not
    // "the last attempt failed" while the new one runs.
    setProbeErrors({});
    (async () => {
      const next: Record<string, boolean> = {};
      const errs: Record<string, string> = {};
      await Promise.allSettled(
        azureAccounts.map(async (a) => {
          if (!a.homeAccountId) return;
          const tenantId =
            getActiveTenant(a.homeAccountId) ??
            resolveActiveTenantId(a) ??
            a.tenantId;
          if (!tenantId) {
            next[a.homeAccountId] = false;
            errs[a.homeAccountId] = "Missing active tenant.";
            return;
          }
          try {
            const token = await getGraphTokenForAccount(
              a.homeAccountId,
              tenantId,
            );
            if (cancelled) return; // bail out early — prevent setState after unmount
            const roles = await getMyDirectoryRoles(tenantId, token);
            if (cancelled) return;
            next[a.homeAccountId] = canCreateUsers(roles);
          } catch (err) {
            next[a.homeAccountId] = false;
            errs[a.homeAccountId] =
              err instanceof Error ? err.message : String(err);
          }
        }),
      );
      if (!cancelled) {
        setPrivilegedMap(next);
        setProbeErrors(errs);
        setDiscovering(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountKey, azureAccounts, probeNonce]);

  const privilegedAccounts: PrivilegedAccount[] = React.useMemo(() => {
    return azureAccounts
      .filter((a) => privilegedMap[a.homeAccountId])
      .map((a) => ({
        homeAccountId: a.homeAccountId,
        tenantId:
          getActiveTenant(a.homeAccountId) ??
          resolveActiveTenantId(a) ??
          a.tenantId,
        username: a.username,
        name: a.name || a.username,
      }))
      .filter((a) => a.tenantId);
  }, [azureAccounts, privilegedMap]);

  /**
   * Accounts the picker actually shows. In `auto` mode this is
   * `privilegedAccounts` (current behavior). In `manual` mode it's
   * every signed-in account projected to the same shape — the user
   * can pick any of them and try the create call, and if the role is
   * missing we surface the resulting Graph 403 in the form.
   */
  const effectiveAccounts: PrivilegedAccount[] = React.useMemo(() => {
    if (accountMode === "manual") {
      return azureAccounts
        .map((a) => ({
          homeAccountId: a.homeAccountId,
          tenantId:
            getActiveTenant(a.homeAccountId) ??
            resolveActiveTenantId(a) ??
            a.tenantId,
          username: a.username,
          name: a.name || a.username,
        }))
        .filter((a) => a.tenantId && a.homeAccountId);
    }
    return privilegedAccounts;
  }, [accountMode, azureAccounts, privilegedAccounts]);

  const [activeAccountId, setActiveAccountId] = React.useState<string>(() => {
    try {
      return sessionStorage.getItem(ACTIVE_ACCOUNT_KEY) ?? "";
    } catch {
      return "";
    }
  });

  React.useEffect(() => {
    if (effectiveAccounts.length === 0) return;
    const exists = effectiveAccounts.some(
      (a) => a.homeAccountId === activeAccountId,
    );
    if (!exists) {
      const first = effectiveAccounts[0]!.homeAccountId;
      setActiveAccountId(first);
      try {
        sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, first);
      } catch {
        /* ignore */
      }
    }
  }, [effectiveAccounts, activeAccountId]);

  const handleSelectAccount = React.useCallback((id: string) => {
    setActiveAccountId(id);
    try {
      sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  const activeAccount: PrivilegedAccount | null = React.useMemo(() => {
    return (
      effectiveAccounts.find((a) => a.homeAccountId === activeAccountId) ??
      null
    );
  }, [effectiveAccounts, activeAccountId]);

  // ARM-token tracker — this page only uses Graph tokens for its own
  // calls, but we still subscribe to the centralized ARM-token hook so
  // the operator sees a single consistent expiry badge across pages and
  // benefits from auto-refresh + tenant-switch re-mint behavior. Future
  // ARM-touching features added to this page will get a fresh token
  // for free.
  const armTokenTracker = useArmToken(
    activeAccount?.homeAccountId,
    activeAccount?.tenantId,
  );

  // In manual mode, flag accounts where role-discovery did NOT find a
  // user-creation role so the picker can show a subtle "may fail" hint
  // next to them. We use the raw probe map so the hint is accurate even
  // for accounts the auto-list would have filtered out.
  const isPrivileged = React.useCallback(
    (homeAccountId: string) => !!privilegedMap[homeAccountId],
    [privilegedMap],
  );

  // Tab state — synced to both ?tab= search param and sessionStorage. URL
  // wins on initial load so a deep-link / refresh keeps the operator on the
  // tab they had open. Whitelist enforced via isValidTab/VALID_TABS (above
  // the component) so a garbage ?tab=foo doesn't silently break Radix Tabs.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get("tab");
  const [tab, setTabState] = React.useState<TabValue>(() => {
    if (isValidTab(urlTab)) return urlTab;
    try {
      const stored = sessionStorage.getItem(TAB_KEY);
      if (isValidTab(stored)) return stored;
    } catch {
      /* ignore */
    }
    return "create";
  });

  // Stay in sync if the URL changes underneath us (back/forward / external nav).
  React.useEffect(() => {
    if (isValidTab(urlTab) && urlTab !== tab) {
      setTabState(urlTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);

  const handleTabChange = React.useCallback(
    (v: string) => {
      if (!isValidTab(v)) return;
      setTabState(v);
      try {
        sessionStorage.setItem(TAB_KEY, v);
      } catch {
        /* ignore */
      }
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set("tab", v);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // React to global tenant-switch events — when another page (or any other
  // surface) flips the active account, mirror the change here so we don't
  // drift out of sync. Only acts when the broadcast candidate is in our
  // eligible list and isn't already the active one.
  useTenantChange(undefined, (detail) => {
    const candidate = detail.homeAccountId;
    if (!effectiveAccounts.some((a) => a.homeAccountId === candidate)) return;
    if (activeAccountId === candidate) return;
    setActiveAccountId(candidate);
    try {
      sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, candidate);
    } catch {
      /* ignore */
    }
  });

  // Only block on the discovery probe in `auto` mode — manual mode is
  // an explicit opt-out of the gate, so the user shouldn't have to
  // wait for role discovery to finish before picking an account.
  if (accountMode === "auto" && discovering && privilegedAccounts.length === 0) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <PageHeader
          title="Create AD User"
          description="Provision an Azure AD user under a tenant where you have User Administrator privileges."
        />
        <AccountModeToggle
          mode={accountMode}
          onChange={handleAccountModeChange}
          autoCount={privilegedAccounts.length}
          manualCount={azureAccounts.length}
          discovering={discovering}
          onRefresh={refreshProbe}
        />
        <div
          role="status"
          className="flex items-center justify-center rounded-lg border border-dashed border-border bg-card px-6 py-10 text-sm text-muted-foreground"
        >
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Discovering directory roles…
        </div>
      </div>
    );
  }

  if (effectiveAccounts.length === 0) {
    // Two distinct empty states. In `auto` mode the user has signed-in
    // accounts but none cleared the role gate — offer the manual-pick
    // escape hatch. In `manual` mode the issue is "no signed-in
    // accounts at all" → send the user to Azure Accounts.
    const inAutoWithoutRole =
      accountMode === "auto" && azureAccounts.length > 0;
    return (
      <div className="flex flex-col gap-4 py-4">
        <PageHeader
          title="Create AD User"
          description="Provision an Azure AD user under a tenant where you have User Administrator privileges."
        />
        <AccountModeToggle
          mode={accountMode}
          onChange={handleAccountModeChange}
          autoCount={privilegedAccounts.length}
          manualCount={azureAccounts.length}
          discovering={discovering}
          onRefresh={refreshProbe}
        />
        {inAutoWithoutRole ? (
          <EmptyState
            icon={ShieldAlert}
            title="No user-creation access detected"
            description="Auto-detect didn't find any signed-in account with a User Administrator or Global Administrator role. Switch to manual pick above if you want to attempt the create with a specific account anyway — useful when role discovery misfires on a cross-tenant Graph call."
            action={{
              label: "Switch to manual pick",
              onClick: () => handleAccountModeChange("manual"),
            }}
          />
        ) : (
          <SignInRequired
            whatYouCantDo="Create a directory user"
            why="an Azure account with User Administrator or Global Administrator role in the target tenant"
            allowTokenImport={false}
            onNavigate={onNavigate}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <PageHeader
        title="Create AD User"
        description="Provision an Azure AD user under a tenant where you have User Administrator privileges."
      >
        <TokenExpiryBadge
          secondsUntilExpiry={armTokenTracker.secondsUntilExpiry}
          loading={armTokenTracker.loading}
          onRefresh={() => void armTokenTracker.refresh()}
          needsReauth={armTokenTracker.needsReauth}
          onReauth={() =>
            void armTokenTracker.reauth({
              loginHint: activeAccount?.username,
            })
          }
        />
        <Select value={activeAccountId} onValueChange={handleSelectAccount}>
          <SelectTrigger
            className="h-8 w-72 text-xs"
            aria-label={
              accountMode === "manual"
                ? "Select account (manual mode)"
                : "Select privileged account"
            }
          >
            <SelectValue
              placeholder={
                accountMode === "manual"
                  ? "Select account"
                  : "Select privileged account"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {effectiveAccounts.map((a) => {
              const flagged =
                accountMode === "manual" && !isPrivileged(a.homeAccountId);
              return (
                <SelectItem key={a.homeAccountId} value={a.homeAccountId}>
                  <span className="flex items-center gap-1.5 truncate">
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
                    {flagged && (
                      <Badge
                        variant="warning"
                        className="ml-auto shrink-0 text-2xs"
                      >
                        no role
                      </Badge>
                    )}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </PageHeader>

      <AccountModeToggle
        mode={accountMode}
        onChange={handleAccountModeChange}
        autoCount={privilegedAccounts.length}
        manualCount={azureAccounts.length}
        discovering={discovering}
        onRefresh={refreshProbe}
      />

      {/*
        Surface the most recent probe failure for the active account when
        we're in auto mode without a result — usually a token-refresh
        hiccup that resolves on re-probe.
      */}
      {accountMode === "auto" &&
        activeAccount &&
        probeErrors[activeAccount.homeAccountId] && (
          <Alert variant="warning" className="text-xs">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Role probe failed for{" "}
              <span className="font-semibold">{activeAccount.username}</span>:{" "}
              <span className="font-mono text-2xs">
                {probeErrors[activeAccount.homeAccountId]}
              </span>{" "}
              ·{" "}
              <button
                type="button"
                onClick={refreshProbe}
                className="underline underline-offset-2 hover:no-underline"
              >
                retry probe
              </button>
            </AlertDescription>
          </Alert>
        )}

      {accountMode === "manual" &&
        activeAccount &&
        !isPrivileged(activeAccount.homeAccountId) && (
          <Alert variant="warning" className="text-xs">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <span className="font-semibold">{activeAccount.username}</span>{" "}
              isn't known to hold a user-creation role (User Admin / Global
              Admin). The create call may fail with a 403. Switch to{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:no-underline"
                onClick={() => handleAccountModeChange("auto")}
              >
                auto-detect
              </button>{" "}
              to filter the picker to verified accounts only.
            </AlertDescription>
          </Alert>
        )}

      <Tabs value={tab} onValueChange={handleTabChange} className="w-full">
        <TabsList aria-label="User creator tabs">
          <TabsTrigger value="create" aria-label="Create user">
            <UserPlus className="mr-1.5 h-3.5 w-3.5" />
            Create User
          </TabsTrigger>
          <TabsTrigger value="browse" aria-label="Browse existing users">
            <Building2 className="mr-1.5 h-3.5 w-3.5" />
            Browse Existing Users
          </TabsTrigger>
          <TabsTrigger
            value="created"
            aria-label="Users created in this browser"
          >
            <HardDrive className="mr-1.5 h-3.5 w-3.5" />
            Created by me
          </TabsTrigger>
        </TabsList>

        <TabsContent value="create">
          <CreateUserForm
            account={activeAccount}
            onCreated={() => {
              /* keep user on tab */
            }}
            store={store}
          />
        </TabsContent>

        <TabsContent value="browse">
          <BrowseUsers
            tenantUsers={state.tenantUsers}
            azureAccounts={azureAccounts}
            privilegedAccounts={privilegedAccounts}
            onSwitchToCreateTab={(targetAccountId) => {
              handleSelectAccount(targetAccountId);
              handleTabChange("create");
              const target = privilegedAccounts.find(
                (p) => p.homeAccountId === targetAccountId,
              );
              if (target) {
                store.addNotification({
                  type: "info",
                  message: `Switched to tenant ${truncateMiddle(target.tenantId)}`,
                });
              }
            }}
            onNavigate={onNavigate}
          />
        </TabsContent>

        <TabsContent value="created">
          <CreatedByMeTab
            account={activeAccount}
            store={store}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};

interface CreateUserFormProps {
  account: PrivilegedAccount | null;
  onCreated: () => void;
  store: ReturnType<typeof useMultiRegionStore>;
}

interface FormSectionProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children: React.ReactNode;
}

const FormSection: React.FC<FormSectionProps> = ({
  icon: Icon,
  title,
  description,
  children,
}) => (
  <section
    aria-labelledby={`section-${title.replace(/\s+/g, "-").toLowerCase()}`}
    className="flex flex-col gap-3 rounded-md border border-border/60 bg-surface-overlay/40 p-4 transition-colors duration-200 ease-out hover:border-primary/30 motion-reduce:transition-none"
  >
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="flex flex-col gap-0.5">
        <h3
          id={`section-${title.replace(/\s+/g, "-").toLowerCase()}`}
          className="text-xs font-semibold uppercase tracking-wider text-foreground"
        >
          {title}
        </h3>
        {description && (
          <p className="text-2xs text-muted-foreground">{description}</p>
        )}
      </div>
    </div>
    {children}
  </section>
);

const CreateUserForm: React.FC<CreateUserFormProps> = ({
  account,
  onCreated,
  store,
}) => {
  const [domains, setDomains] = React.useState<VerifiedDomain[]>([]);
  const [domainsLoading, setDomainsLoading] = React.useState(false);
  const [domainsError, setDomainsError] = React.useState<string | null>(null);
  const [selectedDomain, setSelectedDomain] = React.useState<string>("");

  const [prefix, setPrefix] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [displayNameTouched, setDisplayNameTouched] = React.useState(false);
  const [givenName, setGivenName] = React.useState("");
  const [givenNameTouched, setGivenNameTouched] = React.useState(false);
  const [surname, setSurname] = React.useState("");
  const [surnameTouched, setSurnameTouched] = React.useState(false);
  const [jobTitle, setJobTitle] = React.useState("");
  const [department, setDepartment] = React.useState("");
  const [usageLocation, setUsageLocation] = React.useState("US");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [forceChange, setForceChange] = React.useState(true);
  const [accountEnabled, setAccountEnabled] = React.useState(true);
  const [presetKey, setPresetKey] = React.useState<string>("");
  /**
   * Whether to fire the /api/portal/auto-login endpoint right after a
   * successful create. Persisted across reloads so the operator's
   * preference (typically "on, please") survives page refreshes.
   */
  const [autoLoginEnabled, setAutoLoginEnabled] = React.useState<boolean>(
    () => {
      if (typeof window === "undefined") return true;
      try {
        const raw = window.localStorage.getItem(AUTO_LOGIN_PREF_KEY);
        if (raw === null) return true; // default ON
        return raw === "1";
      } catch {
        return true;
      }
    },
  );
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        AUTO_LOGIN_PREF_KEY,
        autoLoginEnabled ? "1" : "0",
      );
    } catch {
      /* localStorage may be disabled — non-fatal, default still applies. */
    }
  }, [autoLoginEnabled]);
  const [autoLoginInflight, setAutoLoginInflight] = React.useState(false);

  /**
   * Quick mode — operator picks ONLY a role + count; everything else (UPN,
   * display name, given/surname, password, domain, force-change, enabled)
   * is auto-generated from a built-in name pool + the active preset. Default
   * is ON; the existing detailed form is preserved as opt-out.
   */
  const [quickMode, setQuickMode] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const raw = window.localStorage.getItem(QUICK_MODE_KEY);
      if (raw === null) return true;
      return raw === "1";
    } catch {
      return true;
    }
  });
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(QUICK_MODE_KEY, quickMode ? "1" : "0");
    } catch {
      /* localStorage may be unavailable. */
    }
  }, [quickMode]);
  const [count, setCount] = React.useState<number>(1);
  /**
   * Bumping this seed regenerates the preview list — operator clicks
   * "Generate new names" if they don't like the current draft.
   */
  const [batchSeed, setBatchSeed] = React.useState(0);
  const [bulkSubmitting, setBulkSubmitting] = React.useState(false);
  const [bulkProgress, setBulkProgress] = React.useState<{
    done: number;
    total: number;
    current?: string;
  } | null>(null);
  /**
   * Two-step confirm for any bulk create that would provision more than
   * BULK_CONFIRM_THRESHOLD users. Single-user creates skip the dialog
   * (low-risk happy path). The dialog renders a summary of what will be
   * created so the operator can sanity-check before committing to N
   * Graph writes.
   */
  const [bulkConfirmOpen, setBulkConfirmOpen] = React.useState(false);

  /**
   * Persisted operator templates — captures preset + display-name pattern
   * + optional redirect URL so the operator can re-apply a frequently-used
   * combo with one click. Lives in localStorage (per-browser); no tenant
   * scoping because templates are operator-personal, not tenant-state.
   *
   * COORDINATOR: if a sibling page wants to share these templates (e.g.
   * tenant-users password-reset flow re-applying the same role preset),
   * promote the storage key to a shared module — for now it's local.
   */
  const [savedTemplates, setSavedTemplates] = usePersistedState<
    SavedTemplate[]
  >(SAVED_TEMPLATES_KEY, [], { version: 1 });
  /**
   * CSV-paste mode — operator pastes a multi-line CSV (`prefix,displayName,role?`)
   * to drive a batch create with explicit per-row UPNs instead of synthesized
   * names. Toggled off by default; lives inside quick-mode because it's a
   * quick-mode variant.
   *
   * COORDINATOR: user-creator has CSV paste, consider import-batch. The
   * import-batch page may want to delegate single-tenant CSV creates here
   * rather than re-implementing the row→Graph-write loop.
   */
  const [csvMode, setCsvMode] = React.useState(false);
  const [csvText, setCsvText] = React.useState("");
  const [csvError, setCsvError] = React.useState<string | null>(null);

  const [availability, setAvailability] = React.useState<AvailabilityState>({
    status: "idle",
  });

  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  /**
   * The most recently created user during this form's lifetime — drives the
   * inline "Sign in to Portal" button below. Cleared whenever the form is
   * reset for a new user.
   */
  const [lastCreated, setLastCreated] = React.useState<{
    upn: string;
    password: string;
    mustChangePassword: boolean;
  } | null>(null);

  React.useEffect(() => {
    if (!account) {
      setDomains([]);
      setSelectedDomain("");
      return;
    }
    let cancelled = false;
    setDomainsLoading(true);
    setDomainsError(null);
    (async () => {
      try {
        const token = await getGraphTokenForAccount(
          account.homeAccountId,
          account.tenantId,
        );
        const list = await listVerifiedDomains(account.tenantId, token);
        if (cancelled) return;
        setDomains(list);
        const def = list.find((d) => d.isDefault) ?? list[0];
        setSelectedDomain(def?.name ?? "");
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setDomainsError(msg);
        setDomains([]);
        setSelectedDomain("");
      } finally {
        if (!cancelled) setDomainsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account]);

  React.useEffect(() => {
    setPrefix("");
    setDisplayName("");
    setDisplayNameTouched(false);
    setGivenName("");
    setGivenNameTouched(false);
    setSurname("");
    setSurnameTouched(false);
    setJobTitle("");
    setDepartment("");
    setPassword("");
    setShowPassword(false);
    setForceChange(true);
    setAccountEnabled(true);
    setPresetKey("");
    setAvailability({ status: "idle" });
    setSubmitError(null);
  }, [account?.homeAccountId, account?.tenantId]);

  React.useEffect(() => {
    if (!displayNameTouched) {
      setDisplayName(titleCase(prefix));
    }
    if (!givenNameTouched) {
      setGivenName(deriveGivenName(prefix));
    }
    if (!surnameTouched) {
      setSurname(deriveSurname(prefix));
    }
  }, [prefix, displayNameTouched, givenNameTouched, surnameTouched]);

  const upn = prefix && selectedDomain ? `${prefix}@${selectedDomain}` : "";
  const prefixValid = USER_PREFIX_RE.test(prefix);

  // Real-time availability probe — debounced 400ms, cancellable on input change.
  React.useEffect(() => {
    if (!account || !upn || !prefixValid) {
      setAvailability({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setAvailability({ status: "checking" });
    (async () => {
      try {
        await sleep(AVAILABILITY_DEBOUNCE_MS, controller.signal);
        const token = await getGraphTokenForAccount(
          account.homeAccountId,
          account.tenantId,
        );
        if (cancelled) return;
        const url = `${GRAPH_BASE}/users/${encodeURIComponent(upn)}?$select=id`;
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        });
        if (cancelled) return;
        if (response.status === 404) {
          setAvailability({ status: "available" });
        } else if (response.ok) {
          setAvailability({ status: "taken" });
        } else {
          const body = await response.json().catch(() => ({}));
          const msg =
            (body as { error?: { message?: string } })?.error?.message ??
            `Probe failed: HTTP ${response.status}`;
          setAvailability({ status: "error", message: msg });
        }
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        const msg = err instanceof Error ? err.message : String(err);
        setAvailability({ status: "error", message: msg });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [account, upn, prefixValid]);

  const handlePresetChange = React.useCallback((key: string) => {
    setPresetKey(key);
    const preset = PRESETS.find((p) => p.key === key);
    if (!preset) return;
    setJobTitle(preset.jobTitle);
    setDepartment(preset.department);
    setUsageLocation(preset.usageLocation);
    setForceChange(preset.forceChangePassword);
    setAccountEnabled(preset.accountEnabled);
    setSubmitError(null);
  }, []);

  const formValues: UserFormValues = React.useMemo(
    () => ({
      prefix,
      domain: selectedDomain,
      displayName,
      givenName,
      surname,
      jobTitle,
      department,
      usageLocation,
      password,
      forceChange,
      accountEnabled,
    }),
    [
      prefix,
      selectedDomain,
      displayName,
      givenName,
      surname,
      jobTitle,
      department,
      usageLocation,
      password,
      forceChange,
      accountEnabled,
    ],
  );

  const validation = React.useMemo(
    () => userFormSchema.safeParse(formValues),
    [formValues],
  );
  const fieldErrors: Partial<Record<keyof UserFormValues, string>> =
    React.useMemo(() => {
      if (validation.success) return {};
      const out: Partial<Record<keyof UserFormValues, string>> = {};
      for (const issue of validation.error.issues) {
        const k = issue.path[0] as keyof UserFormValues | undefined;
        if (k && out[k] === undefined) {
          out[k] = issue.message;
        }
      }
      return out;
    }, [validation]);

  const formValid =
    !!account &&
    validation.success &&
    availability.status === "available";

  const handleGeneratePassword = React.useCallback(() => {
    setPassword(generateRandomPassword());
    setShowPassword(true);
    setSubmitError(null);
  }, []);

  const handleCopyTenant = React.useCallback(async () => {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account.tenantId);
      store.addNotification({
        type: "info",
        message: "Tenant ID copied to clipboard.",
      });
    } catch {
      /* clipboard may be unavailable */
    }
  }, [account, store]);

  const handleSubmitClick = React.useCallback(() => {
    if (!formValid) return;
    setSubmitError(null);
    setConfirmOpen(true);
  }, [formValid]);

  // ---- Quick-mode preview + submit -------------------------------------

  const activePresetForQuick = React.useMemo<PresetDefinition>(() => {
    return PRESETS.find((p) => p.key === presetKey) ?? PRESETS[0]!;
  }, [presetKey]);

  /**
   * Synthesized batch — regenerates whenever the inputs change OR the
   * operator clicks "Generate new names" (which bumps `batchSeed`).
   *
   * `batchSeed` is intentionally referenced inside the memo even though it's
   * not used in the body — it's the cache-bust signal so the memo recomputes
   * on demand. ESLint will see it in the dep array; a void-cast in the body
   * tells humans it's load-bearing.
   */
  const batchPreview = React.useMemo<QuickUserPayload[]>(() => {
    void batchSeed;
    if (!quickMode) return [];
    if (!selectedDomain) return [];
    // CSV-paste branch — operator-driven UPNs override synthesized names.
    // Parser failures DON'T crash the preview; they surface via csvError
    // below the preview list.
    if (csvMode) {
      if (!csvText.trim()) return [];
      const parsed = parseCsvPayload(csvText, activePresetForQuick, selectedDomain);
      // Cap CSV-parsed rows to QUICK_COUNT_MAX — protects the operator
      // from accidentally pasting a 10k-row export.
      return parsed.rows.slice(0, QUICK_COUNT_MAX);
    }
    const safeCount = Math.max(
      QUICK_COUNT_MIN,
      Math.min(QUICK_COUNT_MAX, Math.floor(count) || 1),
    );
    return generateBatchPayload(safeCount, activePresetForQuick, selectedDomain);
  }, [
    quickMode,
    count,
    activePresetForQuick,
    selectedDomain,
    batchSeed,
    csvMode,
    csvText,
  ]);

  /**
   * CSV-parse errors — re-derived alongside batchPreview so we can surface
   * the offending rows to the operator without coupling preview rendering
   * to the error path.
   */
  const csvParseErrors = React.useMemo(() => {
    if (!csvMode || !selectedDomain || !csvText.trim()) return [];
    return parseCsvPayload(csvText, activePresetForQuick, selectedDomain).errors;
  }, [csvMode, csvText, selectedDomain, activePresetForQuick]);

  // Surface CSV parser errors as a single-line submitError-style hint —
  // separate from submitError so a partial CSV doesn't block clearing.
  React.useEffect(() => {
    if (csvMode && csvParseErrors.length > 0) {
      setCsvError(
        `${csvParseErrors.length} CSV row${csvParseErrors.length === 1 ? "" : "s"} ignored: ${csvParseErrors
          .slice(0, 3)
          .map((e) => `line ${e.line} (${e.reason})`)
          .join("; ")}${csvParseErrors.length > 3 ? "; …" : ""}`,
      );
    } else {
      setCsvError(null);
    }
  }, [csvMode, csvParseErrors]);

  const quickValid =
    !!account && quickMode && batchPreview.length > 0 && !bulkSubmitting;

  /**
   * Bulk-create everything in `batchPreview`. We call `createUser`
   * sequentially (not parallel) so we don't fan out N concurrent Graph
   * writes — Azure AD's per-tenant write throttle is much tighter than
   * read throttle, and even 5 parallel POSTs can trip 429s on a busy
   * tenant. Sequential is slow (~1-2s per user) but predictable.
   *
   * For count==1 we still fire the auto-login chain. For count>1 we
   * surface a summary toast and switch the active tab to "Created by me"
   * so the operator can pick which users to actually sign in as.
   */
  const handleQuickSubmit = React.useCallback(async () => {
    if (!account || batchPreview.length === 0) return;
    setBulkSubmitting(true);
    setSubmitError(null);
    setBulkProgress({ done: 0, total: batchPreview.length });
    const actor = account.username || account.name || account.homeAccountId;
    let token: string;
    try {
      token = await getGraphTokenForAccount(
        account.homeAccountId,
        account.tenantId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSubmitError(`Token acquisition failed: ${msg}`);
      setBulkSubmitting(false);
      setBulkProgress(null);
      return;
    }
    let succeeded = 0;
    let failed = 0;
    let lastSuccess: QuickUserPayload | null = null;
    for (let i = 0; i < batchPreview.length; i++) {
      const p = batchPreview[i]!;
      setBulkProgress({
        done: i,
        total: batchPreview.length,
        current: p.upn,
      });
      try {
        const result = await createUser(
          account.tenantId,
          {
            userPrincipalName: p.upn,
            displayName: p.displayName,
            mailNickname: p.prefix,
            password: p.password,
            forceChangePasswordNextSignIn: p.forceChange,
            accountEnabled: p.accountEnabled,
            usageLocation: p.usageLocation,
            givenName: p.givenName,
            surname: p.surname,
            jobTitle: p.jobTitle,
            department: p.department,
          },
          token,
        );
        const finalUpn = result.userPrincipalName || p.upn;
        auditLog.record({
          actor,
          action: "create_user",
          target: finalUpn,
          status: "success",
          details: {
            tenantId: account.tenantId,
            accountEnabled: p.accountEnabled,
            forceChangePassword: p.forceChange,
            presetKey: activePresetForQuick.key,
            quickMode: true,
            batchIndex: i,
            batchSize: batchPreview.length,
          },
        });
        try {
          await credentialVault.put({
            upn: finalUpn,
            password: p.password,
            tenantId: account.tenantId,
            homeAccountId: account.homeAccountId,
            displayName: p.displayName,
            createdAt: new Date().toISOString(),
            source: "create",
            mustChangePassword: p.forceChange,
          });
          auditLog.record({
            actor,
            action: "vault_put",
            target: finalUpn,
            status: "success",
            details: {
              tenantId: account.tenantId,
              reason: "quick-create",
              batchIndex: i,
              batchSize: batchPreview.length,
            },
          });
        } catch (vaultErr) {
          const vmsg =
            vaultErr instanceof Error ? vaultErr.message : String(vaultErr);
          console.warn("[user-creator] quick vault.put failed", vaultErr);
          auditLog.record({
            actor,
            action: "vault_put",
            target: finalUpn,
            status: "failure",
            error: vmsg,
            details: {
              tenantId: account.tenantId,
              reason: "quick-create",
              batchIndex: i,
              batchSize: batchPreview.length,
            },
          });
        }
        succeeded += 1;
        lastSuccess = { ...p, upn: finalUpn };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditLog.record({
          actor,
          action: "create_user",
          target: p.upn,
          status: "failure",
          error: msg,
          details: {
            tenantId: account.tenantId,
            presetKey: activePresetForQuick.key,
            quickMode: true,
            batchIndex: i,
            batchSize: batchPreview.length,
          },
        });
        failed += 1;
      }
    }
    setBulkProgress({
      done: batchPreview.length,
      total: batchPreview.length,
    });
    // Single-user happy path — fire the auto-login chain + show the
    // success card with the 3 sign-in buttons.
    if (
      batchPreview.length === 1 &&
      succeeded === 1 &&
      lastSuccess !== null
    ) {
      setLastCreated({
        upn: lastSuccess.upn,
        password: lastSuccess.password,
        mustChangePassword: lastSuccess.forceChange,
      });
      store.addNotification({
        type: "success",
        message: `Created user ${lastSuccess.upn}`,
      });
      if (autoLoginEnabled) {
        setAutoLoginInflight(true);
        store.addNotification({
          type: "info",
          message: lastSuccess.forceChange
            ? `Auto sign-in for ${lastSuccess.upn} (will auto-set fresh password)…`
            : `Auto sign-in for ${lastSuccess.upn}…`,
        });
        // Full-auto WebUI sign-in via Playwright. Same shape as the
        // detailed-mode chain: generate newPassword if mustChange,
        // patch vault on success.
        const successSnapshot = lastSuccess;
        const newPassword = successSnapshot.forceChange
          ? generateRandomPassword()
          : undefined;
        void (async () => {
          try {
            const res = await launchPortalAutoLogin({
              upn: successSnapshot.upn,
              password: successSnapshot.password,
              tenantId: account.tenantId,
              mustChangePassword: successSnapshot.forceChange,
              newPassword,
              target: "webui",
              webuiUrl:
                typeof window !== "undefined"
                  ? window.location.origin + "/"
                  : undefined,
            });
            if (res.ok) {
              if (newPassword) {
                try {
                  await credentialVault.put({
                    upn: successSnapshot.upn,
                    password: newPassword,
                    tenantId: account.tenantId,
                    homeAccountId: account.homeAccountId,
                    displayName: successSnapshot.displayName,
                    createdAt: new Date().toISOString(),
                    source: "create",
                    mustChangePassword: false,
                  });
                  auditLog.record({
                    actor,
                    action: "vault_put",
                    target: successSnapshot.upn,
                    status: "success",
                    details: {
                      tenantId: account.tenantId,
                      reason: "quick-mode-change-pw-patch",
                    },
                  });
                  setLastCreated({
                    upn: successSnapshot.upn,
                    password: newPassword,
                    mustChangePassword: false,
                  });
                } catch (vaultErr) {
                  const vmsg =
                    vaultErr instanceof Error
                      ? vaultErr.message
                      : String(vaultErr);
                  console.warn(
                    "[user-creator] quick-mode vault patch failed",
                    vaultErr,
                  );
                  auditLog.record({
                    actor,
                    action: "vault_put",
                    target: successSnapshot.upn,
                    status: "failure",
                    error: vmsg,
                    details: {
                      tenantId: account.tenantId,
                      reason: "quick-mode-change-pw-patch",
                    },
                  });
                }
              }
              store.addNotification({
                type: "success",
                message: newPassword
                  ? `Signed in as ${successSnapshot.upn} with a fresh password. Vault updated.`
                  : `Signed in to WebUI as ${successSnapshot.upn} in a new browser window.`,
              });
              auditLog.record({
                actor,
                action: "webui_auto_login",
                target: successSnapshot.upn,
                status: "success",
                details: {
                  tenantId: account.tenantId,
                  mustChangePassword: successSnapshot.forceChange,
                  newPasswordSet: !!newPassword,
                  quickMode: true,
                },
              });
            } else {
              auditLog.record({
                actor,
                action: "webui_auto_login",
                target: successSnapshot.upn,
                status: "failure",
                error: res.error,
                details: {
                  tenantId: account.tenantId,
                  mustChangePassword: successSnapshot.forceChange,
                  status: res.status,
                  quickMode: true,
                },
              });
              store.addNotification({
                type: "error",
                message: `Auto sign-in failed for ${successSnapshot.upn}: ${res.error ?? "unknown"}. Credential is saved — retry from the "Created by me" tab.`,
              });
            }
          } finally {
            setAutoLoginInflight(false);
          }
        })();
      }
    } else {
      // Multi-user batch — just summary toast + tab switch hint.
      store.addNotification({
        type: failed > 0 ? "warning" : "success",
        message: `Created ${succeeded} of ${batchPreview.length} users${failed > 0 ? ` · ${failed} failed` : ""}. Open the "Created by me" tab to sign in as any of them.`,
      });
      if (failed > 0) {
        setSubmitError(
          `Bulk create finished with ${failed} failure${failed === 1 ? "" : "s"}. Check the audit log for details.`,
        );
      }
    }
    // Bump the seed so a fresh preview shows for the next run.
    setBatchSeed((s) => s + 1);
    setBulkSubmitting(false);
    setBulkProgress(null);
    onCreated();
  }, [
    account,
    batchPreview,
    activePresetForQuick,
    autoLoginEnabled,
    store,
    onCreated,
  ]);

  const handleConfirm = React.useCallback(async () => {
    if (!account) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const token = await getGraphTokenForAccount(
        account.homeAccountId,
        account.tenantId,
      );
      const result = await createUser(
        account.tenantId,
        {
          userPrincipalName: upn,
          displayName: displayName.trim(),
          mailNickname: prefix,
          password,
          forceChangePasswordNextSignIn: forceChange,
          accountEnabled,
          usageLocation: usageLocation || undefined,
          givenName: givenName.trim() || undefined,
          surname: surname.trim() || undefined,
          jobTitle: jobTitle.trim() || undefined,
          department: department.trim() || undefined,
        },
        token,
      );
      auditLog.record({
        actor: account.username || account.name || account.homeAccountId,
        action: "create_user",
        target: result.userPrincipalName || upn,
        status: "success",
        details: {
          tenantId: account.tenantId,
          accountEnabled,
          forceChangePassword: forceChange,
          presetKey: presetKey || undefined,
        },
      });
      // Capture the credential in the encrypted vault so the user can later
      // launch an Azure portal sign-in for this UPN via PortalLoginButton.
      // Failures here are non-fatal — the user creation already succeeded.
      const finalUpn = result.userPrincipalName || upn;
      const auditActor =
        account.username || account.name || account.homeAccountId;
      try {
        await credentialVault.put({
          upn: finalUpn,
          password,
          tenantId: account.tenantId,
          homeAccountId: account.homeAccountId,
          displayName: displayName.trim() || undefined,
          createdAt: new Date().toISOString(),
          source: "create",
          mustChangePassword: forceChange,
        });
        auditLog.record({
          actor: auditActor,
          action: "vault_put",
          target: finalUpn,
          status: "success",
          details: {
            tenantId: account.tenantId,
            reason: "detailed-create",
          },
        });
        setLastCreated({
          upn: finalUpn,
          password,
          mustChangePassword: forceChange,
        });
      } catch (vaultErr) {
        const vmsg =
          vaultErr instanceof Error ? vaultErr.message : String(vaultErr);
        console.warn("[user-creator] vault.put failed", vaultErr);
        auditLog.record({
          actor: auditActor,
          action: "vault_put",
          target: finalUpn,
          status: "failure",
          error: vmsg,
          details: {
            tenantId: account.tenantId,
            reason: "detailed-create",
          },
        });
      }
      store.addNotification({
        type: "success",
        message: `Created user ${result.userPrincipalName}`,
      });
      // Fire-and-forget the portal auto-login. We don't await on the success
      // path — the dev-server endpoint launches a real Chromium window and
      // returns 200 only after Playwright has filled the email + password,
      // which can take a few seconds. Blocking the success toast on that
      // would make the form feel stuck. We DO surface a separate toast when
      // the launch resolves (success or failure) so the operator knows the
      // window is on its way.
      if (autoLoginEnabled) {
        setAutoLoginInflight(true);
        store.addNotification({
          type: "info",
          message: forceChange
            ? `Auto sign-in for ${finalUpn} (will auto-set fresh password)…`
            : `Auto sign-in for ${finalUpn}…`,
        });
        const actor =
          account.username || account.name || account.homeAccountId;
        // Full-auto WebUI sign-in:
        //   1. Generate newPassword if mustChangePassword (so the
        //      Playwright change-password form auto-fills cleanly).
        //   2. Fire the Playwright endpoint with target: "webui" so the
        //      resulting browser session is signed into this app, not
        //      portal.azure.com.
        //   3. On success, patch the vault with the new password (if
        //      one was set) and clear mustChangePassword so subsequent
        //      sign-ins skip the reset prompt.
        //   4. On failure, the credential is still in the vault from
        //      the create flow — operator can retry from "Created by me"
        //      or fall back to MSAL popup on the success card.
        const newPassword = forceChange ? generateRandomPassword() : undefined;
        const upnSnapshot = finalUpn;
        const passwordSnapshot = password;
        const tenantSnapshot = account.tenantId;
        const homeAccountSnapshot = account.homeAccountId;
        const displaySnapshot = displayName.trim() || undefined;
        void (async () => {
          try {
            const res = await launchPortalAutoLogin({
              upn: upnSnapshot,
              password: passwordSnapshot,
              tenantId: tenantSnapshot,
              mustChangePassword: forceChange,
              newPassword,
              target: "webui",
              webuiUrl:
                typeof window !== "undefined"
                  ? window.location.origin + "/"
                  : undefined,
            });
            if (res.ok) {
              if (newPassword) {
                try {
                  await credentialVault.put({
                    upn: upnSnapshot,
                    password: newPassword,
                    tenantId: tenantSnapshot,
                    homeAccountId: homeAccountSnapshot,
                    displayName: displaySnapshot,
                    createdAt: new Date().toISOString(),
                    source: "create",
                    mustChangePassword: false,
                  });
                  auditLog.record({
                    actor,
                    action: "vault_put",
                    target: upnSnapshot,
                    status: "success",
                    details: {
                      tenantId: tenantSnapshot,
                      reason: "auto-change-password-patch",
                    },
                  });
                  setLastCreated({
                    upn: upnSnapshot,
                    password: newPassword,
                    mustChangePassword: false,
                  });
                } catch (vaultErr) {
                  const vmsg =
                    vaultErr instanceof Error
                      ? vaultErr.message
                      : String(vaultErr);
                  console.warn(
                    "[user-creator] vault patch after auto change-password failed",
                    vaultErr,
                  );
                  auditLog.record({
                    actor,
                    action: "vault_put",
                    target: upnSnapshot,
                    status: "failure",
                    error: vmsg,
                    details: {
                      tenantId: tenantSnapshot,
                      reason: "auto-change-password-patch",
                    },
                  });
                }
              }
              store.addNotification({
                type: "success",
                message: newPassword
                  ? `Signed in as ${upnSnapshot} with a fresh password. Vault updated.`
                  : `Signed in to WebUI as ${upnSnapshot} in a new browser window.`,
              });
              auditLog.record({
                actor,
                action: "webui_auto_login",
                target: upnSnapshot,
                status: "success",
                details: {
                  tenantId: tenantSnapshot,
                  mustChangePassword: forceChange,
                  newPasswordSet: !!newPassword,
                },
              });
              return;
            }
            auditLog.record({
              actor,
              action: "webui_auto_login",
              target: upnSnapshot,
              status: "failure",
              error: res.error,
              details: {
                tenantId: tenantSnapshot,
                mustChangePassword: forceChange,
                status: res.status,
              },
            });
            store.addNotification({
              type: "error",
              message: `Auto sign-in failed for ${upnSnapshot}: ${res.error ?? "unknown"}. Use "MSAL popup (manual)" on the success card to sign in by typing the password yourself.`,
            });
          } finally {
            setAutoLoginInflight(false);
          }
        })();
      }
      setConfirmOpen(false);
      setPrefix("");
      setDisplayName("");
      setDisplayNameTouched(false);
      setGivenName("");
      setGivenNameTouched(false);
      setSurname("");
      setSurnameTouched(false);
      setJobTitle("");
      setDepartment("");
      setPassword("");
      setShowPassword(false);
      setForceChange(true);
      setAccountEnabled(true);
      setPresetKey("");
      setAvailability({ status: "idle" });
      onCreated();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      auditLog.record({
        actor: account.username || account.name || account.homeAccountId,
        action: "create_user",
        target: upn,
        status: "failure",
        error: msg,
        details: {
          tenantId: account.tenantId,
          accountEnabled,
          forceChangePassword: forceChange,
          presetKey: presetKey || undefined,
        },
      });
      setSubmitError(msg);
      setConfirmOpen(false);
    } finally {
      setSubmitting(false);
    }
  }, [
    account,
    upn,
    displayName,
    prefix,
    password,
    forceChange,
    accountEnabled,
    usageLocation,
    givenName,
    surname,
    jobTitle,
    department,
    presetKey,
    store,
    onCreated,
    autoLoginEnabled,
  ]);

  if (!account) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Select a privileged account to begin creating a user.
        </CardContent>
      </Card>
    );
  }

  const activePreset = PRESETS.find((p) => p.key === presetKey);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-4 w-4 text-primary" />
            New user details
          </CardTitle>
          <CardDescription>
            Tenant ID is auto-derived from the selected account. The UPN prefix
            is the only required user-entered identifier.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {/*
            Quick mode toggle — collapses the form to "Role + Count" only.
            Everything else is auto-generated from a built-in name pool +
            the active preset. Detailed mode preserves the full attribute
            editor for power users who want to override individual fields.
          */}
          <div className="flex items-start gap-3 rounded-md border border-primary/30 bg-primary/5 p-3">
            <Switch
              id="user-creator-quick-mode"
              checked={quickMode}
              onCheckedChange={(v) => {
                setQuickMode(Boolean(v));
                setSubmitError(null);
              }}
              aria-label="Quick mode — pick role and count, everything else auto-generated"
              className="mt-0.5"
            />
            <div className="flex flex-1 flex-col gap-0.5">
              <Label
                htmlFor="user-creator-quick-mode"
                className="flex cursor-pointer items-center gap-1.5 text-sm font-medium"
              >
                <Zap className="h-3.5 w-3.5 text-primary" aria-hidden />
                Quick mode — Role + Count only
              </Label>
              <p className="text-2xs text-muted-foreground">
                Operator picks a role and how many users to create; UPNs,
                display names, passwords, domain, and all other attributes
                auto-generated from the role preset and a built-in name
                pool. Turn off for full per-field control.
              </p>
            </div>
          </div>

          {quickMode && (
            <div className="flex flex-col gap-4">
              {/* Tenant + domain summary (read-only in quick mode) */}
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/60 px-3 py-2 text-2xs text-muted-foreground">
                <Building2 className="h-3.5 w-3.5" aria-hidden />
                <span>
                  Tenant{" "}
                  <code className="font-mono text-foreground">
                    {truncateMiddle(account.tenantId)}
                  </code>
                </span>
                <span>·</span>
                <span>
                  Domain{" "}
                  {domainsLoading ? (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      loading…
                    </span>
                  ) : selectedDomain ? (
                    <code className="font-mono text-foreground">
                      {selectedDomain}
                    </code>
                  ) : (
                    <span className="text-warning">no verified domain</span>
                  )}
                </span>
                {domains.length > 1 && (
                  <Select
                    value={selectedDomain}
                    onValueChange={setSelectedDomain}
                  >
                    <SelectTrigger
                      className="ml-auto h-7 w-44 text-2xs"
                      aria-label="Switch domain"
                    >
                      <SelectValue placeholder="Switch domain" />
                    </SelectTrigger>
                    <SelectContent>
                      {domains.map((d) => (
                        <SelectItem key={d.name} value={d.name}>
                          {d.name}
                          {d.isDefault ? " (default)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {/* Role picker — bigger, primary */}
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label
                    htmlFor="user-creator-quick-role"
                    className="text-xs font-medium"
                  >
                    Role
                  </Label>
                  <Select
                    value={presetKey || PRESETS[0]!.key}
                    onValueChange={handlePresetChange}
                  >
                    <SelectTrigger
                      id="user-creator-quick-role"
                      aria-label="Select role"
                    >
                      <SelectValue placeholder="Choose a role" />
                    </SelectTrigger>
                    <SelectContent>
                      {PRESETS.map((p) => (
                        <SelectItem key={p.key} value={p.key}>
                          <span className="flex flex-col">
                            <span className="text-sm">{p.label}</span>
                            <span className="text-2xs text-muted-foreground">
                              {p.description}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-2xs text-muted-foreground">
                    Determines job title, department, usage location,
                    force-change-password, and account-enabled defaults.
                  </p>
                </div>

                {/* Count input */}
                <div className="flex flex-col gap-1.5">
                  <Label
                    htmlFor="user-creator-quick-count"
                    className={cn(
                      "text-xs font-medium",
                      csvMode && "text-muted-foreground",
                    )}
                  >
                    How many users{csvMode ? " (from CSV)" : ""}
                  </Label>
                  <Input
                    id="user-creator-quick-count"
                    type="number"
                    min={QUICK_COUNT_MIN}
                    max={QUICK_COUNT_MAX}
                    step={1}
                    value={csvMode ? batchPreview.length : count}
                    disabled={csvMode}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) {
                        setCount(
                          Math.max(
                            QUICK_COUNT_MIN,
                            Math.min(QUICK_COUNT_MAX, Math.floor(v)),
                          ),
                        );
                      }
                    }}
                    aria-label="Number of users to create"
                    aria-describedby="user-creator-quick-count-help"
                    className="font-mono"
                  />
                  <p
                    id="user-creator-quick-count-help"
                    className="text-2xs text-muted-foreground"
                  >
                    {csvMode
                      ? `Derived from pasted CSV (${batchPreview.length} valid row${batchPreview.length === 1 ? "" : "s"}).`
                      : `${QUICK_COUNT_MIN}–${QUICK_COUNT_MAX}.`}
                  </p>
                </div>
              </div>

              {/* Auto-launch toggle (only meaningful for count==1; shown but
                  ignored when count>1 to keep the surface consistent). */}
              <div className="flex items-start gap-3 rounded-md border border-border p-3">
                <Switch
                  id="user-creator-quick-auto-login"
                  checked={autoLoginEnabled}
                  onCheckedChange={(v) => setAutoLoginEnabled(Boolean(v))}
                  aria-label="Auto-launch sign-in window after single create"
                  className="mt-0.5"
                  disabled={count > 1}
                />
                <div className="flex flex-1 flex-col gap-0.5">
                  <Label
                    htmlFor="user-creator-quick-auto-login"
                    className={cn(
                      "flex cursor-pointer items-center gap-1.5 text-sm font-medium",
                      count > 1 && "text-muted-foreground",
                    )}
                  >
                    <Zap
                      className={cn(
                        "h-3.5 w-3.5",
                        count > 1 ? "text-muted-foreground" : "text-primary",
                      )}
                      aria-hidden
                    />
                    Auto sign-in to WebUI as the new user
                  </Label>
                  <p className="text-2xs text-muted-foreground">
                    {count > 1
                      ? "Disabled for batch creation — popping up N MSAL popups in a row is hostile. Sign in to each new user one at a time from the \"Created by me\" tab."
                      : "MSAL popup against the new user's tenant; on success the new account becomes the active WebUI session. Portal session is a separate manual button on the success card."}
                  </p>
                </div>
              </div>

              {/*
                Saved templates — one-click re-apply of a previously saved
                (preset, count) combo. Persisted in localStorage via
                usePersistedState. Tenant-agnostic; the operator is free
                to apply the same template across multiple tenants.
              */}
              <div className="flex flex-col gap-2 rounded-md border border-border bg-card/60 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
                  <BadgeCheck
                    className="h-3.5 w-3.5 text-primary"
                    aria-hidden
                  />
                  <span>Saved templates</span>
                  <span className="text-2xs text-muted-foreground">
                    ({savedTemplates.length})
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    disabled={bulkSubmitting || !activePresetForQuick}
                    onClick={() => {
                      const name = window.prompt(
                        `Save current settings as a template?\n\nPreset: ${activePresetForQuick.label}\nCount: ${count}\n\nEnter a name:`,
                        `${activePresetForQuick.label} ×${count}`,
                      );
                      if (!name || !name.trim()) return;
                      const tpl: SavedTemplate = {
                        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                        name: name.trim().slice(0, 60),
                        presetKey: activePresetForQuick.key,
                        displayNamePattern: "",
                        redirectUrl: "",
                        count: Math.max(
                          QUICK_COUNT_MIN,
                          Math.min(QUICK_COUNT_MAX, Math.floor(count) || 1),
                        ),
                        createdAt: new Date().toISOString(),
                      };
                      setSavedTemplates((prev) => [tpl, ...prev].slice(0, 20));
                    }}
                    aria-label="Save current settings as a template"
                    title="Save the current preset + count combo for one-click re-apply"
                  >
                    <Sparkles />
                    Save current
                  </Button>
                </div>
                {savedTemplates.length === 0 ? (
                  <p className="text-2xs text-muted-foreground">
                    No saved templates yet. Click &ldquo;Save current&rdquo; to
                    capture the current preset + count for later.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {savedTemplates.map((tpl) => (
                      <div
                        key={tpl.id}
                        className="flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-2xs"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            handlePresetChange(tpl.presetKey);
                            setCount(tpl.count);
                            setBatchSeed((s) => s + 1);
                          }}
                          disabled={bulkSubmitting}
                          className="font-medium text-foreground hover:text-primary"
                          aria-label={`Apply template ${tpl.name}`}
                          title={`Apply preset ${tpl.presetKey} × ${tpl.count}`}
                        >
                          {tpl.name}
                        </button>
                        <span className="text-muted-foreground">
                          ×{tpl.count}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setSavedTemplates((prev) =>
                              prev.filter((t) => t.id !== tpl.id),
                            );
                          }}
                          disabled={bulkSubmitting}
                          aria-label={`Delete template ${tpl.name}`}
                          title="Delete template"
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/*
                CSV-paste mode — operator-driven UPN list instead of synthesized
                names. COORDINATOR: if the import-batch page grows a single-
                tenant CSV path, prefer delegating here rather than re-
                implementing the row → Graph-write loop.
              */}
              <div className="flex flex-col gap-2 rounded-md border border-border bg-card/60 p-3">
                <div className="flex items-start gap-3">
                  <Switch
                    id="user-creator-csv-mode"
                    checked={csvMode}
                    onCheckedChange={(v) => {
                      setCsvMode(Boolean(v));
                      setSubmitError(null);
                    }}
                    aria-label="CSV-paste mode"
                    className="mt-0.5"
                    disabled={bulkSubmitting}
                  />
                  <div className="flex flex-1 flex-col gap-0.5">
                    <Label
                      htmlFor="user-creator-csv-mode"
                      className="flex cursor-pointer items-center gap-1.5 text-sm font-medium"
                    >
                      <FileJson
                        className="h-3.5 w-3.5 text-primary"
                        aria-hidden
                      />
                      CSV-paste mode (operator-supplied UPN list)
                    </Label>
                    <p className="text-2xs text-muted-foreground">
                      Override synthesized names with a pasted CSV. Format:{" "}
                      <code className="font-mono">
                        prefix,displayName,jobTitle,department
                      </code>
                      . Header row optional. Passwords + force-change still come
                      from the active preset.
                    </p>
                  </div>
                </div>
                {csvMode && (
                  <>
                    <textarea
                      value={csvText}
                      onChange={(ev) => {
                        setCsvText(ev.target.value);
                        setSubmitError(null);
                      }}
                      placeholder={
                        "# prefix,displayName,jobTitle,department\nalex.doe,Alex Doe,Engineer,Platform\njamie.lee,Jamie Lee,Auditor,Compliance"
                      }
                      rows={6}
                      aria-label="CSV rows"
                      className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-2xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      disabled={bulkSubmitting}
                    />
                    {csvError && (
                      <Alert variant="warning" className="text-2xs">
                        <AlertCircle className="h-3.5 w-3.5" />
                        <AlertDescription>{csvError}</AlertDescription>
                      </Alert>
                    )}
                  </>
                )}
              </div>

              {/* Live preview of the synthesized batch */}
              <div className="flex flex-col gap-2 rounded-md border border-border bg-card/60 p-3">
                <div className="flex items-center gap-2 text-xs font-medium">
                  <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
                  Preview ({batchPreview.length}{" "}
                  {batchPreview.length === 1 ? "user" : "users"})
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => setBatchSeed((s) => s + 1)}
                    aria-label="Generate new names"
                    disabled={bulkSubmitting}
                  >
                    <Wand2 />
                    Generate new names
                  </Button>
                </div>
                {batchPreview.length === 0 ? (
                  <p className="text-2xs text-muted-foreground">
                    {!selectedDomain
                      ? "Waiting for a verified domain to be selected."
                      : "No preview yet."}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1 max-h-64 overflow-auto">
                    {batchPreview.map((p) => (
                      <li
                        key={p.upn}
                        className="flex flex-wrap items-center gap-2 text-2xs"
                      >
                        <BadgeCheck
                          className="h-3 w-3 text-success"
                          aria-hidden
                        />
                        <code className="font-mono text-foreground">
                          {p.upn}
                        </code>
                        <span className="text-muted-foreground">
                          · {p.displayName}
                        </span>
                        <span className="ml-auto text-muted-foreground">
                          {p.jobTitle} · {p.department}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {bulkProgress && (
                <Alert>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <AlertDescription>
                    Creating {bulkProgress.done + 1} of {bulkProgress.total}
                    {bulkProgress.current ? ` — ${bulkProgress.current}` : ""}
                    …
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="default"
                  onClick={() => {
                    // Bulk → require confirm dialog. Single → fire directly
                    // (low-risk happy path; the auto-login flow is the
                    // surfacing UX for the operator).
                    if (batchPreview.length > BULK_CONFIRM_THRESHOLD) {
                      setBulkConfirmOpen(true);
                    } else {
                      void handleQuickSubmit();
                    }
                  }}
                  disabled={!quickValid}
                  aria-label={`Create ${batchPreview.length || count} user${(batchPreview.length || count) === 1 ? "" : "s"}`}
                >
                  {bulkSubmitting ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <UserPlus />
                  )}
                  Create {batchPreview.length || count}{" "}
                  {(batchPreview.length || count) === 1 ? "user" : "users"}
                </Button>
              </div>
            </div>
          )}

          {!quickMode && (<>
          <FormSection
            icon={Building2}
            title="Tenant & Domain"
            description="Auto-derived from the selected privileged account."
          >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label className="text-2xs uppercase tracking-wider text-muted-foreground">
                Tenant ID
              </Label>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 truncate rounded bg-background px-2 py-1 font-mono text-xs text-foreground">
                  {account.tenantId}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleCopyTenant}
                  aria-label="Copy tenant ID"
                  title="Copy tenant ID"
                >
                  <Copy />
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-2xs uppercase tracking-wider text-muted-foreground">
                Source account
              </Label>
              <span className="truncate rounded bg-background px-2 py-1 font-mono text-xs text-foreground">
                {account.username || account.name}
              </span>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label
                htmlFor="user-creator-domain"
                className="text-2xs uppercase tracking-wider text-muted-foreground"
              >
                Domain
              </Label>
              {domainsLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading domains...
                </div>
              ) : domainsError ? (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{domainsError}</AlertDescription>
                </Alert>
              ) : domains.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No verified domains available for this tenant.
                </p>
              ) : (
                <Select
                  value={selectedDomain}
                  onValueChange={setSelectedDomain}
                >
                  <SelectTrigger
                    id="user-creator-domain"
                    aria-label="Select domain"
                  >
                    <SelectValue placeholder="Select a domain" />
                  </SelectTrigger>
                  <SelectContent>
                    {domains.map((d) => (
                      <SelectItem key={d.name} value={d.name}>
                        <span className="flex items-center gap-1.5">
                          <span>{d.name}</span>
                          {d.isDefault && (
                            <Badge variant="info" className="text-2xs">
                              default
                            </Badge>
                          )}
                          {d.isInitial && !d.isDefault && (
                            <Badge variant="secondary" className="text-2xs">
                              initial
                            </Badge>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
          </FormSection>

          <FormSection
            icon={IdCard}
            title="Identity"
            description="UPN, display name, and personal attributes."
          >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="user-creator-preset">Preset</Label>
            <Select value={presetKey} onValueChange={handlePresetChange}>
              <SelectTrigger
                id="user-creator-preset"
                aria-label="Select attribute preset"
              >
                <SelectValue placeholder="Choose a preset to pre-fill attributes" />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    <span className="flex flex-col">
                      <span className="text-sm">{p.label}</span>
                      <span className="text-2xs text-muted-foreground">
                        {p.description}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {activePreset && (
              <p className="text-2xs text-muted-foreground">
                Preset applied. You can still edit any field below.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="user-creator-prefix">User ID (UPN prefix)</Label>
              <div className="relative">
                <AtSign
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  id="user-creator-prefix"
                  type="text"
                  autoComplete="off"
                  value={prefix}
                  onChange={(e) => {
                    setPrefix(e.target.value);
                    setSubmitError(null);
                  }}
                  className="pl-8 pr-9 font-mono"
                  aria-invalid={
                    prefix.length > 0 && !prefixValid ? true : undefined
                  }
                  aria-describedby="user-creator-prefix-help"
                  placeholder="alex.doe"
                  required
                />
                <div
                  className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
                  aria-live="polite"
                >
                  {availability.status === "checking" && (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                      aria-label="Checking availability"
                    />
                  )}
                  {availability.status === "available" && (
                    <Check
                      className="h-3.5 w-3.5 text-success"
                      aria-label="Available"
                    />
                  )}
                  {availability.status === "taken" && (
                    <X
                      className="h-3.5 w-3.5 text-destructive"
                      aria-label="Already taken"
                    />
                  )}
                  {availability.status === "error" && (
                    <AlertCircle
                      className="h-3.5 w-3.5 text-warning"
                      aria-label="Probe failed"
                    />
                  )}
                </div>
              </div>
              <p
                id="user-creator-prefix-help"
                className={cn(
                  "text-2xs",
                  prefix.length > 0 && fieldErrors.prefix
                    ? "text-destructive"
                    : availability.status === "taken"
                      ? "text-destructive"
                      : availability.status === "available"
                        ? "text-success"
                        : availability.status === "error"
                          ? "text-warning"
                          : "text-muted-foreground",
                )}
              >
                {prefix.length > 0 && fieldErrors.prefix
                  ? fieldErrors.prefix
                  : availability.status === "checking"
                    ? "Checking availability..."
                    : availability.status === "available"
                      ? `Available — ${upn}`
                      : availability.status === "taken"
                        ? `Already taken — ${upn} exists in this tenant.`
                        : availability.status === "error"
                          ? `Could not verify availability: ${availability.message}`
                          : upn
                            ? `Full UPN: ${upn}`
                            : "Letters, numbers, dot, dash, or underscore. Max 40 characters."}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-creator-display">Display Name</Label>
              <Input
                id="user-creator-display"
                type="text"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setDisplayNameTouched(true);
                  setSubmitError(null);
                }}
                aria-required
                aria-invalid={
                  displayNameTouched && fieldErrors.displayName
                    ? true
                    : undefined
                }
                placeholder="Alex Doe"
                required
              />
              {displayNameTouched && fieldErrors.displayName && (
                <p className="text-2xs text-destructive">
                  {fieldErrors.displayName}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-creator-given">Given Name</Label>
              <Input
                id="user-creator-given"
                type="text"
                value={givenName}
                onChange={(e) => {
                  setGivenName(e.target.value);
                  setGivenNameTouched(true);
                }}
                placeholder="Alex"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-creator-surname">Surname</Label>
              <Input
                id="user-creator-surname"
                type="text"
                value={surname}
                onChange={(e) => {
                  setSurname(e.target.value);
                  setSurnameTouched(true);
                }}
                placeholder="Doe"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-creator-jobtitle">Job Title</Label>
              <Input
                id="user-creator-jobtitle"
                type="text"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                placeholder="Engineer"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-creator-department">Department</Label>
              <Input
                id="user-creator-department"
                type="text"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder="Platform"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-creator-usage">Usage Location</Label>
              <Select value={usageLocation} onValueChange={setUsageLocation}>
                <SelectTrigger
                  id="user-creator-usage"
                  aria-label="Select usage location"
                >
                  <SelectValue placeholder="Select usage location" />
                </SelectTrigger>
                <SelectContent>
                  {USAGE_LOCATIONS.map((u) => (
                    <SelectItem key={u.code} value={u.code}>
                      {u.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

          </div>
          </FormSection>

          <FormSection
            icon={KeyRound}
            title="Credentials & Activation"
            description="Initial password, forced reset, and account activation."
          >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="user-creator-password">Initial Password</Label>
              <div className="relative">
                <Input
                  id="user-creator-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setSubmitError(null);
                  }}
                  className="pr-20 font-mono"
                  aria-invalid={
                    password.length > 0 && fieldErrors.password
                      ? true
                      : undefined
                  }
                  aria-describedby="user-creator-password-help"
                />
                <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setShowPassword((p) => !p)}
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    aria-pressed={showPassword}
                  >
                    {showPassword ? <EyeOff /> : <Eye />}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleGeneratePassword}
                    aria-label="Generate random password"
                    title="Generate random password"
                  >
                    <Wand2 />
                  </Button>
                </div>
              </div>
              <p
                id="user-creator-password-help"
                className={cn(
                  "text-2xs",
                  password.length > 0 && fieldErrors.password
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {password.length > 0 && fieldErrors.password
                  ? fieldErrors.password
                  : `Minimum ${MIN_PASSWORD_LENGTH} characters. Use the wand to generate one.`}
              </p>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground sm:col-span-2">
              <Checkbox
                checked={forceChange}
                onCheckedChange={(v) => setForceChange(Boolean(v))}
                aria-label="Force user to change password at next sign-in"
              />
              <span>Force user to change password at next sign-in</span>
            </label>

            <div className="flex items-center gap-3 sm:col-span-2">
              <Switch
                id="user-creator-enabled"
                checked={accountEnabled}
                onCheckedChange={(v) => setAccountEnabled(Boolean(v))}
                aria-label="Account enabled"
              />
              <Label
                htmlFor="user-creator-enabled"
                className="cursor-pointer text-sm"
              >
                Account enabled
              </Label>
            </div>

            <div className="flex items-start gap-3 rounded-md border border-primary/30 bg-primary/5 p-3 sm:col-span-2">
              <Switch
                id="user-creator-auto-login"
                checked={autoLoginEnabled}
                onCheckedChange={(v) => setAutoLoginEnabled(Boolean(v))}
                aria-label="Auto-launch sign-in window after creation"
                className="mt-0.5"
              />
              <div className="flex flex-1 flex-col gap-0.5">
                <Label
                  htmlFor="user-creator-auto-login"
                  className="flex cursor-pointer items-center gap-1.5 text-sm font-medium"
                >
                  <Zap
                    className="h-3.5 w-3.5 text-primary"
                    aria-hidden
                  />
                  Auto sign-in to WebUI as the new user
                </Label>
                <p className="text-2xs text-muted-foreground">
                  Opens an MSAL popup against the new user&apos;s tenant; on
                  success the new account becomes the active WebUI session.
                  Use the &ldquo;Open portal session&rdquo; button on the
                  success card if you also want a portal.azure.com browser
                  window.
                </p>
              </div>
            </div>
          </div>
          </FormSection>
          </>)}

          {submitError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}

          {!quickMode && submitting && (
            <Alert>
              <Loader2 className="h-4 w-4 animate-spin" />
              <AlertDescription>Creating user {upn}...</AlertDescription>
            </Alert>
          )}

          {lastCreated && account && (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-col gap-2 rounded-md border border-success/40 bg-success/10 p-4 transition-colors duration-200 ease-out motion-reduce:transition-none"
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-success">
                <PartyPopper className="h-4 w-4" aria-hidden />
                <span>User created</span>
                <Sparkles className="h-3.5 w-3.5 opacity-70" aria-hidden />
                {autoLoginInflight && (
                  <span className="ml-auto flex items-center gap-1 text-2xs font-normal text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    Launching sign-in window…
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-foreground">
                <BadgeCheck className="h-4 w-4 text-success" aria-hidden />
                <span>
                  <strong className="font-mono">{lastCreated.upn}</strong> is
                  ready.{" "}
                  {autoLoginEnabled
                    ? "MSAL popup launched automatically — retry or open a portal session below:"
                    : "Auto sign-in is off; pick how you want to authenticate:"}
                </span>
                {/*
                  PRIMARY: Full-auto sign-in via Playwright. Opens a
                  Chromium window pointed at the WebUI's auth URL, fills
                  email + password, and (when mustChangePassword) walks
                  the change-password form by filling Old + New + Confirm
                  with a freshly-generated strong password. The new
                  password is then patched back into the encrypted vault
                  via credentialVault.put so the operator never loses
                  track of which password is current. The Playwright
                  browser ends up signed into THIS WebUI as the new user.
                */}
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={autoLoginInflight}
                  onClick={async () => {
                    if (!lastCreated || !account) return;
                    setAutoLoginInflight(true);
                    store.addNotification({
                      type: "info",
                      message: lastCreated.mustChangePassword
                        ? `Auto-filling sign-in for ${lastCreated.upn} (will set a fresh password during reset)…`
                        : `Auto-filling sign-in for ${lastCreated.upn}…`,
                    });
                    const actor =
                      account.username || account.name || account.homeAccountId;
                    const newPassword = lastCreated.mustChangePassword
                      ? generateRandomPassword()
                      : undefined;
                    const res = await launchPortalAutoLogin({
                      upn: lastCreated.upn,
                      password: lastCreated.password,
                      tenantId: account.tenantId,
                      mustChangePassword: lastCreated.mustChangePassword,
                      newPassword,
                      target: "webui",
                      webuiUrl:
                        typeof window !== "undefined"
                          ? window.location.origin + "/"
                          : undefined,
                    });
                    setAutoLoginInflight(false);
                    if (res.ok) {
                      // If we set a fresh password during the change-
                      // password flow, persist it to the vault and clear
                      // the must-change flag so future sign-ins skip the
                      // reset prompt entirely. Note the original temp
                      // password is now invalid on Azure's side; the
                      // vault is the source of truth.
                      if (newPassword) {
                        try {
                          await credentialVault.put({
                            upn: lastCreated.upn,
                            password: newPassword,
                            tenantId: account.tenantId,
                            homeAccountId: account.homeAccountId,
                            createdAt: new Date().toISOString(),
                            source: "create",
                            mustChangePassword: false,
                          });
                          auditLog.record({
                            actor,
                            action: "vault_put",
                            target: lastCreated.upn,
                            status: "success",
                            details: {
                              tenantId: account.tenantId,
                              reason: "success-card-change-pw-patch",
                            },
                          });
                          // Update local state so the success card
                          // reflects the new password if the operator
                          // hits the button again.
                          setLastCreated({
                            upn: lastCreated.upn,
                            password: newPassword,
                            mustChangePassword: false,
                          });
                        } catch (vaultErr) {
                          const vmsg =
                            vaultErr instanceof Error
                              ? vaultErr.message
                              : String(vaultErr);
                          console.warn(
                            "[user-creator] vault patch failed after auto change-password",
                            vaultErr,
                          );
                          auditLog.record({
                            actor,
                            action: "vault_put",
                            target: lastCreated.upn,
                            status: "failure",
                            error: vmsg,
                            details: {
                              tenantId: account.tenantId,
                              reason: "success-card-change-pw-patch",
                            },
                          });
                        }
                      }
                      store.addNotification({
                        type: "success",
                        message: newPassword
                          ? `Signed in as ${lastCreated.upn} with a fresh password. Vault updated.`
                          : `Signed in to WebUI as ${lastCreated.upn} in a new browser window.`,
                      });
                      auditLog.record({
                        actor,
                        action: "webui_auto_login",
                        target: lastCreated.upn,
                        status: "success",
                        details: {
                          tenantId: account.tenantId,
                          mustChangePassword:
                            !!lastCreated.mustChangePassword,
                          newPasswordSet: !!newPassword,
                        },
                      });
                    } else {
                      store.addNotification({
                        type: "error",
                        message: `Auto sign-in failed for ${lastCreated.upn}: ${res.error ?? "unknown error"}. Use "MSAL popup (manual)" below to sign in by typing the password yourself.`,
                      });
                      auditLog.record({
                        actor,
                        action: "webui_auto_login",
                        target: lastCreated.upn,
                        status: "failure",
                        error: res.error,
                        details: {
                          tenantId: account.tenantId,
                          mustChangePassword:
                            !!lastCreated.mustChangePassword,
                          status: res.status,
                        },
                      });
                    }
                  }}
                  aria-label={`Auto sign-in to WebUI as ${lastCreated.upn}`}
                  title="Opens a Chromium window via Playwright, fills email + password, and walks the must-change-password form if needed. Resulting browser is signed into this WebUI as the new user."
                >
                  {autoLoginInflight ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <LogIn />
                  )}
                  {lastCreated.mustChangePassword
                    ? "Auto sign-in (fills + resets password)"
                    : "Auto sign-in to WebUI"}
                </Button>
                {/*
                  FALLBACK: MSAL popup in this tab. Doesn't auto-fill the
                  password — operator types it manually. Useful when:
                  Playwright isn't installed, or the operator wants the
                  new account to become the active session in THIS tab
                  instead of opening a separate Chromium window.
                */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={autoLoginInflight}
                  onClick={async () => {
                    if (!lastCreated || !account) return;
                    setAutoLoginInflight(true);
                    store.addNotification({
                      type: "info",
                      message: `Opening MSAL popup for ${lastCreated.upn}…`,
                    });
                    const actor =
                      account.username || account.name || account.homeAccountId;
                    const ires = await attemptInteractiveLogin({
                      upn: lastCreated.upn,
                      tenantId: account.tenantId,
                    });
                    setAutoLoginInflight(false);
                    if (ires.ok) {
                      store.addNotification({
                        type: "success",
                        message: `Signed in as ${ires.account?.username ?? lastCreated.upn}. WebUI now runs as this user.`,
                      });
                      auditLog.record({
                        actor,
                        action: "interactive_login",
                        target: lastCreated.upn,
                        status: "success",
                        details: {
                          tenantId: account.tenantId,
                          manual: true,
                          fallback: true,
                        },
                      });
                    } else {
                      store.addNotification({
                        type: "error",
                        message: `MSAL sign-in failed for ${lastCreated.upn}: ${ires.error ?? "unknown error"}.`,
                      });
                      auditLog.record({
                        actor,
                        action: "interactive_login",
                        target: lastCreated.upn,
                        status: "failure",
                        error: ires.error,
                        details: {
                          tenantId: account.tenantId,
                          manual: true,
                          fallback: true,
                        },
                      });
                    }
                  }}
                  aria-label={`MSAL popup sign-in as ${lastCreated.upn}`}
                  title="MSAL popup in this tab — manual password entry, but signs THIS WebUI tab in as the new user (no separate browser window)"
                >
                  <LogIn />
                  MSAL popup (manual)
                </Button>
                {/*
                  SECONDARY: Open a portal.azure.com session via the
                  dev-server's Playwright endpoint. Note this hits
                  portal.azure.com directly, NOT the WebUI — useful only
                  if the operator wants to sanity-check the credential
                  in a separate browser. May fail with AADSTS50011 in
                  tenants that don't permit portal.azure.com sign-in
                  for guest users.
                */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={autoLoginInflight}
                  onClick={async () => {
                    if (!lastCreated || !account) return;
                    setAutoLoginInflight(true);
                    store.addNotification({
                      type: "info",
                      message: `Opening portal session for ${lastCreated.upn}…`,
                    });
                    const actor =
                      account.username || account.name || account.homeAccountId;
                    const res = await launchPortalAutoLogin({
                      upn: lastCreated.upn,
                      password: lastCreated.password,
                      tenantId: account.tenantId,
                      mustChangePassword: lastCreated.mustChangePassword,
                    });
                    setAutoLoginInflight(false);
                    if (res.ok) {
                      store.addNotification({
                        type: "success",
                        message: `Portal sign-in window opened for ${lastCreated.upn}.`,
                      });
                      auditLog.record({
                        actor,
                        action: "portal_auto_login",
                        target: lastCreated.upn,
                        status: "success",
                        details: { tenantId: account.tenantId, manual: true },
                      });
                    } else {
                      store.addNotification({
                        type: "error",
                        message: `Portal sign-in failed for ${lastCreated.upn}: ${res.error ?? "unknown error"}. (Portal access can be restricted per-tenant; the WebUI sign-in above works independently.)`,
                      });
                      auditLog.record({
                        actor,
                        action: "portal_auto_login",
                        target: lastCreated.upn,
                        status: "failure",
                        error: res.error,
                        details: {
                          tenantId: account.tenantId,
                          manual: true,
                          status: res.status,
                        },
                      });
                    }
                  }}
                  aria-label={`Open portal.azure.com session for ${lastCreated.upn}`}
                  title="POST /api/portal/auto-login — opens portal.azure.com in a separate Chromium window. Independent of WebUI session."
                >
                  <ExternalLink />
                  Open portal session
                </Button>
                <PortalLoginButton
                  upn={lastCreated.upn}
                  tenantId={account.tenantId}
                  homeAccountId={account.homeAccountId}
                  password={lastCreated.password}
                  mustChangePassword={lastCreated.mustChangePassword}
                  size="sm"
                  variant="ghost"
                />
              </div>
            </div>
          )}

          {!quickMode && (
            <div className="flex justify-end">
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={!formValid && !submitting ? 0 : -1}>
                      <Button
                        type="button"
                        variant="default"
                        onClick={handleSubmitClick}
                        disabled={!formValid || submitting}
                        aria-label="Create user"
                        className="transition-all duration-200 ease-out motion-reduce:transition-none"
                      >
                        <UserPlus />
                        Create User
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {!formValid && !submitting && (
                    <TooltipContent side="top">
                      {!account
                        ? "Select a privileged account first."
                        : availability.status === "checking"
                          ? "Checking UPN availability..."
                          : availability.status === "taken"
                            ? "This UPN is already taken in the tenant."
                            : availability.status === "error"
                              ? "Could not verify UPN availability."
                              : availability.status !== "available"
                                ? "Pick a UPN prefix and wait for availability."
                                : !validation.success
                                  ? "Resolve form errors to continue."
                                  : "Form not yet valid."}
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmationDialog
        hidden={!confirmOpen}
        title="Create user"
        message={
          <span>
            Create user <strong>{upn}</strong> in tenant{" "}
            <code className="font-mono text-xs">{account.tenantId}</code>?
          </span>
        }
        confirmText="Create user"
        loading={submitting}
        onConfirm={handleConfirm}
        onCancel={() => {
          if (!submitting) setConfirmOpen(false);
        }}
      />

      <ConfirmationDialog
        hidden={!bulkConfirmOpen}
        title={`Create ${batchPreview.length} users`}
        danger={batchPreview.length >= 10}
        message={
          <span>
            About to provision <strong>{batchPreview.length}</strong> users in
            tenant{" "}
            <code className="font-mono text-xs">{account.tenantId}</code>{" "}
            (preset{" "}
            <strong>{activePresetForQuick.label}</strong>
            {csvMode ? ", from pasted CSV" : ""}). Each user will receive a
            randomly-generated password{" "}
            {activePresetForQuick.forceChangePassword
              ? "and be forced to change it on first sign-in"
              : "with no forced reset"}
            . Continue?
          </span>
        }
        confirmText={`Create ${batchPreview.length} users`}
        loading={bulkSubmitting}
        onConfirm={async () => {
          setBulkConfirmOpen(false);
          await handleQuickSubmit();
        }}
        onCancel={() => {
          if (!bulkSubmitting) setBulkConfirmOpen(false);
        }}
      />
    </>
  );
};

// ---------------------------------------------------------------------------
// CreatedByMeTab — persistent list of users created in this browser.
//
// Reads CredentialEntry rows from the encrypted localStorage vault
// (already populated by handleConfirm above), scoped to the active
// privileged account's homeAccountId. Each row exposes three sign-in
// paths so even if the dev-server's Playwright auto-login is broken
// AND the MSAL popup gets blocked, the operator can still recover the
// new account's credentials manually:
//
//   1. Launch sign-in window  — POST /api/portal/auto-login (Playwright)
//   2. Interactive sign-in    — MSAL popup against the user's tenant
//   3. Copy email             — clipboard fallback for any sign-in flow
//
// Plus a Delete (red) button per row to evict stale entries. The whole
// vault is encrypted at rest, but we still let the operator clean up.
// ---------------------------------------------------------------------------

// Small helper button that copies a string with a built-in copied-flash.
// Lives in this file because we don't want to grow shared/* for it.
const CopyChip: React.FC<{
  value: string;
  label: string;
  onCopied?: (value: string) => void;
  onCopyFailed?: () => void;
}> = ({ value, label, onCopied, onCopyFailed }) => {
  const [copied, setCopied] = React.useState(false);
  const handleClick = React.useCallback(async () => {
    const ok = await tryWriteClipboard(value);
    if (ok) {
      setCopied(true);
      onCopied?.(value);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      onCopyFailed?.();
    }
  }, [value, onCopied, onCopyFailed]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={() => void handleClick()}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      className={cn(copied && "text-success")}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
};

// Small stat-pill used by both Browse and Created-by-me tabs. Lives here
// rather than in shared/* because the tone variants are tailored to this
// page's iconography.
const StatChip: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  tone: "primary" | "success" | "info" | "warning" | "muted";
}> = ({ icon: Icon, label, value, tone }) => {
  const toneClass: Record<string, string> = {
    primary: "border-primary/30 bg-primary/5 text-primary",
    success: "border-success/30 bg-success/10 text-success",
    info: "border-info/30 bg-info/10 text-info",
    warning: "border-warning/30 bg-warning/10 text-warning",
    muted: "border-border bg-card text-muted-foreground",
  };
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-2",
        toneClass[tone] ?? toneClass.muted,
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <div className="flex flex-col leading-tight">
        <span className="text-base font-semibold text-foreground tabular-nums">
          {value}
        </span>
        <span className="text-2xs uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
    </div>
  );
};

interface CreatedByMeTabProps {
  account: PrivilegedAccount | null;
  store: ReturnType<typeof useMultiRegionStore>;
}

const CreatedByMeTab: React.FC<CreatedByMeTabProps> = ({ account, store }) => {
  const [entries, setEntries] = React.useState<CredentialEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  /**
   * Parallel-safe busy tracking. Each key in the set is "this entry has a
   * sign-in in flight" — supports the bulk runner which fires N concurrent
   * sign-ins at once. Replaces the previous single-string busyKey which
   * couldn't represent more than one running operation.
   */
  const [busyKeys, setBusyKeys] = React.useState<Set<string>>(() => new Set());
  const [revealedKeys, setRevealedKeys] = React.useState<Set<string>>(
    () => new Set(),
  );
  /** Per-row checkbox state for bulk select. */
  const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(
    () => new Set(),
  );
  /**
   * Concurrent sign-in workers. Higher values open more Chromium windows in
   * parallel; lower values are gentler on the dev-server and on AAD's
   * per-IP throttle (which kicks in around 10-20 simultaneous auth flows).
   */
  const [threads, setThreads] = React.useState<number>(3);
  const [bulkRunning, setBulkRunning] = React.useState(false);
  const [bulkLaunched, setBulkLaunched] = React.useState(0);
  const [bulkTotal, setBulkTotal] = React.useState(0);
  // Pending vault-removal target — drives <ConfirmationDialog>. Replaces
  // the legacy window.confirm() so the destructive flow matches the rest
  // of the app's confirmation UX.
  const [pendingRemoval, setPendingRemoval] =
    React.useState<CredentialEntry | null>(null);
  const [removalSubmitting, setRemovalSubmitting] = React.useState(false);

  // Search + filter — the list grows fast on busy days, so we let the
  // operator narrow it by free text (matches upn/displayName/tenantId)
  // and by status (must-change-pending / source = create vs reset).
  const [searchText, setSearchText] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<
    "all" | "must-change" | "ready" | "created" | "reset"
  >("all");
  // Show-passwords-by-default toggle. Off by default for shoulder-surfing
  // safety; persisted in sessionStorage so the operator's preference
  // survives tab switches.
  const [showAllPasswords, setShowAllPasswords] = React.useState<boolean>(
    () => {
      try {
        return sessionStorage.getItem(SHOW_ALL_PW_KEY) === "1";
      } catch {
        return false;
      }
    },
  );
  React.useEffect(() => {
    try {
      sessionStorage.setItem(SHOW_ALL_PW_KEY, showAllPasswords ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [showAllPasswords]);

  const markBusy = React.useCallback((key: string) => {
    setBusyKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);
  const clearBusy = React.useCallback((key: string) => {
    setBusyKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const reload = React.useCallback(async () => {
    if (!account) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      const list = await credentialVault.list({
        homeAccountId: account.homeAccountId,
      });
      // Newest first.
      list.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      setEntries(list);
    } catch (err) {
      console.warn("[user-creator] vault.list failed", err);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [account]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const rowKey = (e: CredentialEntry) =>
    `${e.tenantId}::${e.upn}::${e.homeAccountId}`;

  const togglePassword = React.useCallback((key: string) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const runPlaywright = React.useCallback(
    async (e: CredentialEntry) => {
      const key = rowKey(e);
      markBusy(key);
      const actor = account?.username || account?.name || e.homeAccountId;
      store.addNotification({
        type: "info",
        message: `Launching sign-in window for ${e.upn}…`,
      });
      const res = await launchPortalAutoLogin({
        upn: e.upn,
        password: e.password,
        tenantId: e.tenantId,
        mustChangePassword: e.mustChangePassword ?? false,
      });
      clearBusy(key);
      if (res.ok) {
        await credentialVault.touch(e.upn, e.tenantId, e.homeAccountId);
        store.addNotification({
          type: "success",
          message: `Sign-in window opened for ${e.upn}.`,
        });
        auditLog.record({
          actor,
          action: "portal_auto_login",
          target: e.upn,
          status: "success",
          details: { tenantId: e.tenantId, fromTab: "created-by-me" },
        });
        await reload();
      } else {
        store.addNotification({
          type: "error",
          message: `Auto-login failed for ${e.upn}: ${res.error ?? "unknown"}.`,
        });
        auditLog.record({
          actor,
          action: "portal_auto_login",
          target: e.upn,
          status: "failure",
          error: res.error,
          details: {
            tenantId: e.tenantId,
            fromTab: "created-by-me",
            status: res.status,
          },
        });
      }
    },
    [account, store, reload],
  );

  const runInteractive = React.useCallback(
    async (e: CredentialEntry) => {
      const key = rowKey(e);
      markBusy(key);
      const actor = account?.username || account?.name || e.homeAccountId;
      store.addNotification({
        type: "info",
        message: `Opening interactive sign-in for ${e.upn}…`,
      });
      const ires = await attemptInteractiveLogin({
        upn: e.upn,
        tenantId: e.tenantId,
      });
      clearBusy(key);
      if (ires.ok) {
        await credentialVault.touch(e.upn, e.tenantId, e.homeAccountId);
        store.addNotification({
          type: "success",
          message: `Signed in as ${ires.account?.username ?? e.upn}.`,
        });
        auditLog.record({
          actor,
          action: "interactive_login",
          target: e.upn,
          status: "success",
          details: { tenantId: e.tenantId, fromTab: "created-by-me" },
        });
        await reload();
      } else {
        store.addNotification({
          type: "error",
          message: `Interactive sign-in failed for ${e.upn}: ${ires.error ?? "unknown"}.`,
        });
        auditLog.record({
          actor,
          action: "interactive_login",
          target: e.upn,
          status: "failure",
          error: ires.error,
          details: { tenantId: e.tenantId, fromTab: "created-by-me" },
        });
      }
    },
    [account, store, reload],
  );

  /**
   * Full-auto WebUI sign-in via Playwright. Mirrors the success-card flow:
   * fills email + password, walks the change-password form when
   * mustChangePassword is set (using a freshly-generated newPassword that
   * gets patched back into this vault entry), and lands the resulting
   * Chromium window inside this WebUI as the new user.
   */
  /**
   * Inner worker — does the actual Playwright dispatch + vault patch + audit
   * record. Returns `{ ok }` so both the per-row caller (which fires its own
   * toast) and the bulk caller (which only toasts on totals) can wrap it
   * the way they need to. Marks `busyKeys` for the duration so the row
   * disables its action buttons.
   */
  const runAutoSignInImpl = React.useCallback(
    async (
      e: CredentialEntry,
      opts: { silent?: boolean } = {},
    ): Promise<{ ok: boolean; error?: string }> => {
      const key = rowKey(e);
      markBusy(key);
      const actor = account?.username || account?.name || e.homeAccountId;
      const mustChange = e.mustChangePassword === true;
      const newPassword = mustChange ? generateRandomPassword() : undefined;
      try {
        const res = await launchPortalAutoLogin({
          upn: e.upn,
          password: e.password,
          tenantId: e.tenantId,
          mustChangePassword: mustChange,
          newPassword,
          target: "webui",
          webuiUrl:
            typeof window !== "undefined"
              ? window.location.origin + "/"
              : undefined,
        });
        if (res.ok) {
          if (newPassword) {
            try {
              await credentialVault.put({
                upn: e.upn,
                password: newPassword,
                tenantId: e.tenantId,
                homeAccountId: e.homeAccountId,
                displayName: e.displayName,
                createdAt: e.createdAt,
                source: e.source,
                mustChangePassword: false,
              });
              auditLog.record({
                actor,
                action: "vault_put",
                target: e.upn,
                status: "success",
                details: {
                  tenantId: e.tenantId,
                  reason: "auto-change-password-patch",
                  fromTab: "created-by-me",
                  ...(opts.silent ? { bulk: true } : {}),
                },
              });
            } catch (vaultErr) {
              const vmsg =
                vaultErr instanceof Error
                  ? vaultErr.message
                  : String(vaultErr);
              console.warn(
                "[user-creator] created-by-me vault patch failed",
                vaultErr,
              );
              auditLog.record({
                actor,
                action: "vault_put",
                target: e.upn,
                status: "failure",
                error: vmsg,
                details: {
                  tenantId: e.tenantId,
                  reason: "auto-change-password-patch",
                  fromTab: "created-by-me",
                  ...(opts.silent ? { bulk: true } : {}),
                },
              });
            }
          }
          try {
            await credentialVault.touch(e.upn, e.tenantId, e.homeAccountId);
          } catch {
            /* touch is best-effort */
          }
          auditLog.record({
            actor,
            action: "webui_auto_login",
            target: e.upn,
            status: "success",
            details: {
              tenantId: e.tenantId,
              fromTab: "created-by-me",
              mustChangePassword: mustChange,
              newPasswordSet: !!newPassword,
              ...(opts.silent ? { bulk: true } : {}),
            },
          });
          return { ok: true };
        }
        auditLog.record({
          actor,
          action: "webui_auto_login",
          target: e.upn,
          status: "failure",
          error: res.error,
          details: {
            tenantId: e.tenantId,
            fromTab: "created-by-me",
            mustChangePassword: mustChange,
            status: res.status,
            ...(opts.silent ? { bulk: true } : {}),
          },
        });
        return { ok: false, error: res.error };
      } finally {
        clearBusy(key);
      }
    },
    [account, markBusy, clearBusy],
  );

  /**
   * Per-row caller — fires its own toasts and reloads the vault list on
   * success (so the must-change badge clears immediately).
   */
  const runAutoSignIn = React.useCallback(
    async (e: CredentialEntry) => {
      const mustChange = e.mustChangePassword === true;
      store.addNotification({
        type: "info",
        message: mustChange
          ? `Auto sign-in for ${e.upn} (will auto-set fresh password)…`
          : `Auto sign-in for ${e.upn}…`,
      });
      const res = await runAutoSignInImpl(e);
      if (res.ok) {
        store.addNotification({
          type: "success",
          message: mustChange
            ? `Signed in as ${e.upn} with a fresh password. Vault updated.`
            : `Signed in to WebUI as ${e.upn} in a new browser window.`,
        });
        await reload();
      } else {
        store.addNotification({
          type: "error",
          message: `Auto sign-in failed for ${e.upn}: ${res.error ?? "unknown"}. Use Manual (MSAL) to type the password yourself.`,
        });
      }
    },
    [runAutoSignInImpl, store, reload],
  );

  /**
   * Bulk runner — iterates over every selected entry with a concurrency-
   * bounded worker pool. Each worker pulls the next entry from a shared
   * cursor, fires runAutoSignInImpl({silent: true}), and continues until
   * the cursor is exhausted. Threads is capped to [1, 10] — going higher
   * tends to trip AAD's per-IP auth throttle (~20 concurrent flows).
   *
   * Progress is tracked via bulkLaunched + bulkTotal so the toolbar shows
   * "12 / 30 launched" while running. After every entry's worker resolves,
   * we reload the vault list once so freshly-rotated must-change badges
   * clear in batch.
   */
  const runBulkAutoSignIn = React.useCallback(async () => {
    // Match against ALL entries (not filteredEntries) so a row selected
    // before the user typed a filter doesn't silently get dropped.
    const targets = entries.filter((e) => selectedKeys.has(rowKey(e)));
    if (targets.length === 0) {
      store.addNotification({
        type: "info",
        message: "Select at least one account first.",
      });
      return;
    }
    const concurrency = Math.max(1, Math.min(10, Math.floor(threads) || 3));
    setBulkRunning(true);
    setBulkLaunched(0);
    setBulkTotal(targets.length);
    let succeeded = 0;
    let failed = 0;
    let cursor = 0;
    const startedAt = Date.now();
    store.addNotification({
      type: "info",
      message: `Starting bulk auto sign-in: ${targets.length} accounts, ${concurrency} thread${
        concurrency === 1 ? "" : "s"
      }…`,
    });
    const worker = async (): Promise<void> => {
      while (true) {
        const idx = cursor++;
        if (idx >= targets.length) return;
        const entry = targets[idx]!;
        const res = await runAutoSignInImpl(entry, { silent: true });
        if (res.ok) succeeded += 1;
        else failed += 1;
        setBulkLaunched(succeeded + failed);
      }
    };
    const workers = Array.from({
      length: Math.min(concurrency, targets.length),
    }).map(() => worker());
    await Promise.all(workers);
    setBulkRunning(false);
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    store.addNotification({
      type: failed > 0 ? "warning" : "success",
      message: `Bulk auto sign-in done: ${succeeded} launched, ${failed} failed in ${elapsedSec}s.`,
    });
    auditLog.record({
      actor: account?.username || account?.name || "anonymous",
      action: "webui_auto_login",
      target: `bulk(${targets.length})`,
      status: failed === 0 ? "success" : "failure",
      details: {
        bulk: true,
        threads: concurrency,
        succeeded,
        failed,
        elapsedSec,
      },
    });
    // Reload once at the end so all the must-change badges clear in batch.
    await reload();
    // Clear selection after a successful run so the operator doesn't
    // accidentally re-fire on the same set.
    if (failed === 0) {
      setSelectedKeys(new Set());
    }
  }, [
    entries,
    selectedKeys,
    threads,
    runAutoSignInImpl,
    store,
    reload,
    account,
  ]);

  // ---- Filtering, stats, and export ------------------------------------

  const filteredEntries = React.useMemo(() => {
    let out = entries;
    // Status filter
    if (statusFilter === "must-change") {
      out = out.filter((e) => e.mustChangePassword === true);
    } else if (statusFilter === "ready") {
      out = out.filter((e) => e.mustChangePassword !== true);
    } else if (statusFilter === "created") {
      out = out.filter((e) => e.source === "create");
    } else if (statusFilter === "reset") {
      out = out.filter((e) => e.source === "reset");
    }
    // Free-text search — case-insensitive substring match against upn,
    // displayName, and tenantId. Empty query returns the current set.
    const q = searchText.trim().toLowerCase();
    if (q) {
      out = out.filter((e) => {
        return (
          e.upn.toLowerCase().includes(q) ||
          (e.displayName ?? "").toLowerCase().includes(q) ||
          e.tenantId.toLowerCase().includes(q)
        );
      });
    }
    return out;
  }, [entries, statusFilter, searchText]);

  const stats = React.useMemo(() => {
    const total = entries.length;
    let mustChange = 0;
    let ready = 0;
    let created = 0;
    let reset = 0;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - thirtyDaysMs;
    let recent = 0;
    for (const e of entries) {
      if (e.mustChangePassword === true) mustChange += 1;
      else ready += 1;
      if (e.source === "create") created += 1;
      else if (e.source === "reset") reset += 1;
      const ts = e.createdAt ? Date.parse(e.createdAt) : NaN;
      if (!Number.isNaN(ts) && ts >= cutoff) recent += 1;
    }
    return { total, mustChange, ready, created, reset, recent };
  }, [entries]);

  /**
   * Export the currently-visible (filteredEntries) vault rows as either a
   * CSV or JSON file. Sensitive: the operator confirmed an explicit
   * action; we still tone the toast so they remember the file contains
   * plaintext passwords. Records `vault_export` in the audit log with the
   * row count + format but never the actual credentials.
   */
  const exportVault = React.useCallback(
    (format: "csv" | "json") => {
      const rows = filteredEntries;
      if (rows.length === 0) {
        store.addNotification({
          type: "info",
          message: "Nothing to export — no entries match the current filters.",
        });
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `azbm-vault-${stamp}.${format}`;
      if (format === "csv") {
        const header = [
          "upn",
          "password",
          "tenantId",
          "displayName",
          "source",
          "mustChangePassword",
          "createdAt",
          "lastUsedAt",
        ];
        const lines = [header.map(csvCell).join(",")];
        for (const e of rows) {
          lines.push(
            [
              csvCell(e.upn),
              csvCell(e.password),
              csvCell(e.tenantId),
              csvCell(e.displayName ?? ""),
              csvCell(e.source),
              csvCell(e.mustChangePassword === true ? "true" : "false"),
              csvCell(e.createdAt ?? ""),
              csvCell(e.lastUsedAt ?? ""),
            ].join(","),
          );
        }
        downloadTextFile(filename, lines.join("\n"), "text/csv");
      } else {
        const payload = rows.map((e) => ({
          upn: e.upn,
          password: e.password,
          tenantId: e.tenantId,
          displayName: e.displayName ?? null,
          source: e.source,
          mustChangePassword: e.mustChangePassword === true,
          createdAt: e.createdAt ?? null,
          lastUsedAt: e.lastUsedAt ?? null,
        }));
        downloadTextFile(
          filename,
          JSON.stringify(payload, null, 2),
          "application/json",
        );
      }
      store.addNotification({
        type: "warning",
        message: `Exported ${rows.length} credential${rows.length === 1 ? "" : "s"} to ${filename}. Contains plaintext passwords — handle with care.`,
      });
      auditLog.record({
        actor: account?.username || account?.name || "anonymous",
        action: "vault_export",
        target: filename,
        status: "success",
        details: {
          rowCount: rows.length,
          format,
          filterStatus: statusFilter,
          searchActive: searchText.trim().length > 0,
        },
      });
    },
    [filteredEntries, store, account, statusFilter, searchText],
  );

  const toggleSelectAll = React.useCallback(() => {
    // Always work against the currently visible (filtered) entries so
    // "Select all" with an active filter only flips the visible rows.
    setSelectedKeys((prev) => {
      const visibleKeys = filteredEntries.map(rowKey);
      const allVisibleSelected =
        visibleKeys.length > 0 &&
        visibleKeys.every((k) => prev.has(k));
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const k of visibleKeys) next.delete(k);
        return next;
      }
      const next = new Set(prev);
      for (const k of visibleKeys) next.add(k);
      return next;
    });
  }, [filteredEntries]);

  const toggleSelectRow = React.useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const copyEmail = React.useCallback(
    async (e: CredentialEntry) => {
      try {
        await navigator.clipboard.writeText(e.upn);
        store.addNotification({
          type: "success",
          message: `Email ${e.upn} copied.`,
        });
      } catch {
        store.addNotification({
          type: "error",
          message: `Could not copy ${e.upn} — clipboard blocked.`,
        });
      }
    },
    [store],
  );

  const copyPassword = React.useCallback(
    async (e: CredentialEntry) => {
      try {
        await navigator.clipboard.writeText(e.password);
        store.addNotification({
          type: "success",
          message: `Password for ${e.upn} copied.`,
        });
      } catch {
        store.addNotification({
          type: "error",
          message: `Could not copy password — clipboard blocked.`,
        });
      }
    },
    [store],
  );

  // Open the confirmation dialog. The actual removal lives in
  // confirmRemoveEntry so the dialog's onConfirm can drive it.
  const removeEntry = React.useCallback((e: CredentialEntry) => {
    setPendingRemoval(e);
  }, []);

  const confirmRemoveEntry = React.useCallback(async () => {
    const e = pendingRemoval;
    if (!e) return;
    setRemovalSubmitting(true);
    try {
      await credentialVault.remove(e.upn, e.tenantId, e.homeAccountId);
      auditLog.record({
        actor: account?.username || account?.name || e.homeAccountId,
        action: "vault_remove",
        target: e.upn,
        status: "success",
        details: { tenantId: e.tenantId },
      });
      store.addNotification({
        type: "info",
        message: `Removed vault entry for ${e.upn}.`,
      });
      await reload();
    } finally {
      setRemovalSubmitting(false);
      setPendingRemoval(null);
    }
  }, [pendingRemoval, account, store, reload]);

  if (!account) {
    return (
      <EmptyState
        icon={Users}
        title="No privileged account selected"
        description="Select a privileged account to view its created users."
      />
    );
  }

  return (
    <>
      <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="h-4 w-4 text-primary" />
          Users created in this browser
        </CardTitle>
        <CardDescription>
          Persisted encrypted in <code className="font-mono">localStorage</code>{" "}
          under the active account&apos;s key. Survives page reloads.
          &ldquo;Auto sign-in&rdquo; opens a Chromium window with the
          password pre-filled (and walks the must-change-password form when
          needed). &ldquo;Manual (MSAL)&rdquo; opens a popup in this tab so
          the new user becomes the active session here. &ldquo;Portal&rdquo;
          launches a separate portal.azure.com browser window.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Summary stats — drives at-a-glance vault health. */}
        {entries.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <StatChip
              icon={Users}
              label="Total"
              value={stats.total}
              tone="primary"
            />
            <StatChip
              icon={ShieldCheck}
              label="Ready"
              value={stats.ready}
              tone="success"
            />
            <StatChip
              icon={ShieldAlert}
              label="Must change"
              value={stats.mustChange}
              tone="warning"
            />
            <StatChip
              icon={KeyRound}
              label="Reset"
              value={stats.reset}
              tone="info"
            />
            <StatChip
              icon={Clock}
              label="Last 30d"
              value={stats.recent}
              tone="muted"
            />
          </div>
        )}

        {/* Search + status filter + reveal-all + export */}
        {entries.length > 0 && (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-card/40 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[180px]">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  type="text"
                  value={searchText}
                  onChange={(ev) => setSearchText(ev.target.value)}
                  placeholder="Search UPN, display name, or tenant…"
                  aria-label="Search saved credentials"
                  className="h-8 pl-8 text-xs"
                />
                {searchText && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2"
                    onClick={() => setSearchText("")}
                    aria-label="Clear search"
                    title="Clear search"
                  >
                    <X />
                  </Button>
                )}
              </div>
              <label
                className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-2xs"
                title="When on, every password is shown in plaintext. Persisted in sessionStorage."
              >
                <Switch
                  checked={showAllPasswords}
                  onCheckedChange={(v) => setShowAllPasswords(Boolean(v))}
                  aria-label="Reveal all passwords"
                />
                <span className="font-medium text-muted-foreground">
                  Reveal all
                </span>
              </label>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => exportVault("csv")}
                  disabled={loading || bulkRunning || filteredEntries.length === 0}
                  aria-label="Export filtered vault entries as CSV"
                  title={`Export ${filteredEntries.length} visible row${filteredEntries.length === 1 ? "" : "s"} to CSV — contains plaintext passwords`}
                >
                  <Download />
                  CSV
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => exportVault("json")}
                  disabled={loading || bulkRunning || filteredEntries.length === 0}
                  aria-label="Export filtered vault entries as JSON"
                  title={`Export ${filteredEntries.length} visible row${filteredEntries.length === 1 ? "" : "s"} to JSON — contains plaintext passwords`}
                >
                  <FileJson />
                  JSON
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void reload()}
                  disabled={loading || bulkRunning}
                  aria-label="Reload vault entries"
                  title="Reload vault from localStorage"
                >
                  {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  Refresh
                </Button>
              </div>
            </div>
            {/* Status filter chips */}
            <div
              role="radiogroup"
              aria-label="Filter by status"
              className="flex flex-wrap items-center gap-1"
            >
              <Filter className="h-3 w-3 text-muted-foreground" aria-hidden />
              {(
                [
                  { k: "all", label: "All", count: entries.length },
                  {
                    k: "must-change",
                    label: "Must change",
                    count: stats.mustChange,
                  },
                  { k: "ready", label: "Ready", count: stats.ready },
                  { k: "created", label: "Created", count: stats.created },
                  { k: "reset", label: "Reset", count: stats.reset },
                ] as const
              ).map((chip) => {
                const active = statusFilter === chip.k;
                return (
                  <button
                    key={chip.k}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setStatusFilter(chip.k)}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-2xs transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-primary/50 bg-primary/15 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:bg-muted/50",
                    )}
                  >
                    {chip.label}
                    <span className="ml-1 opacity-70">({chip.count})</span>
                  </button>
                );
              })}
            </div>
            {/* Status line */}
            <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
              <span>
                Showing{" "}
                <strong className="text-foreground">
                  {filteredEntries.length}
                </strong>{" "}
                of{" "}
                <strong className="text-foreground">{entries.length}</strong>{" "}
                saved credential
                {entries.length === 1 ? "" : "s"}
              </span>
              {(statusFilter !== "all" || searchText) && (
                <button
                  type="button"
                  onClick={() => {
                    setStatusFilter("all");
                    setSearchText("");
                  }}
                  className="underline underline-offset-2 hover:no-underline"
                >
                  Clear filters
                </button>
              )}
              <span className="ml-auto inline-flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" aria-hidden />
                AES-GCM encrypted at rest (per-account key)
              </span>
            </div>
          </div>
        )}

        {entries.length === 0 && !loading && (
          <div className="flex items-center justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void reload()}
              disabled={loading || bulkRunning}
              aria-label="Reload vault entries"
            >
              {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh
            </Button>
          </div>
        )}

        {/*
          Bulk toolbar — Select all + thread count + Sign in all selected.
          Each "thread" is a concurrent Chromium window opening at once.
          The thread cap of 10 keeps us well under AAD's per-IP auth
          throttle (~20 concurrent flows trips a 429 in our experience).
        */}
        {entries.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-2.5">
            <label
              className="flex cursor-pointer items-center gap-1.5 text-xs font-medium"
              title={
                filteredEntries.length === entries.length
                  ? "Toggle every row"
                  : `Toggle the ${filteredEntries.length} visible row${filteredEntries.length === 1 ? "" : "s"}`
              }
            >
              <Checkbox
                checked={
                  filteredEntries.length > 0 &&
                  filteredEntries.every((e) => selectedKeys.has(rowKey(e)))
                }
                onCheckedChange={() => toggleSelectAll()}
                disabled={bulkRunning || filteredEntries.length === 0}
                aria-label={
                  filteredEntries.length === entries.length
                    ? "Select all credentials"
                    : "Select all visible credentials"
                }
              />
              {filteredEntries.length === entries.length
                ? "Select all"
                : `Select all visible (${filteredEntries.length})`}
            </label>
            <span className="text-2xs text-muted-foreground">
              ({selectedKeys.size} selected)
            </span>
            {selectedKeys.size > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelectedKeys(new Set())}
                disabled={bulkRunning}
                aria-label="Clear selection"
                title="Clear selection"
                className="h-6 px-2 text-2xs"
              >
                <X />
                Clear
              </Button>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                Threads
                <Input
                  type="number"
                  min={1}
                  max={10}
                  step={1}
                  value={threads}
                  onChange={(ev) => {
                    const v = Number(ev.target.value);
                    if (Number.isFinite(v)) {
                      setThreads(Math.max(1, Math.min(10, Math.floor(v))));
                    }
                  }}
                  disabled={bulkRunning}
                  className="h-7 w-14 text-2xs font-mono"
                  aria-label="Concurrent sign-in threads"
                />
              </label>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => void runBulkAutoSignIn()}
                disabled={
                  bulkRunning ||
                  selectedKeys.size === 0 ||
                  busyKeys.size > 0
                }
                aria-label={`Auto sign-in to ${selectedKeys.size} selected accounts`}
                title={
                  selectedKeys.size === 0
                    ? "Pick rows first"
                    : `Open ${selectedKeys.size} Chromium windows, ${threads} at a time`
                }
              >
                {bulkRunning ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <LogIn />
                )}
                {bulkRunning
                  ? `Signing in… ${bulkLaunched}/${bulkTotal}`
                  : `Auto sign-in selected (${selectedKeys.size})`}
              </Button>
            </div>
          </div>
        )}

        {entries.length === 0 && !loading && (
          <EmptyState
            icon={Users}
            title="No users created yet"
            description="Create a user from the Create User tab and it will appear here automatically."
          />
        )}

        {entries.length > 0 && filteredEntries.length === 0 && !loading && (
          <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border bg-card/40 px-4 py-6 text-center">
            <Search className="h-5 w-5 text-muted-foreground" aria-hidden />
            <div className="text-xs font-medium text-foreground">
              No credentials match the current filters
            </div>
            <div className="text-2xs text-muted-foreground">
              Adjust the search box or the status chips, or{" "}
              <button
                type="button"
                onClick={() => {
                  setStatusFilter("all");
                  setSearchText("");
                }}
                className="underline underline-offset-2 hover:no-underline"
              >
                clear all filters
              </button>
              .
            </div>
          </div>
        )}

        {filteredEntries.map((e) => {
          const key = rowKey(e);
          const busy = busyKeys.has(key);
          const selected = selectedKeys.has(key);
          const revealed = revealedKeys.has(key) || showAllPasswords;
          return (
            <div
              key={key}
              className={cn(
                "flex flex-col gap-2 rounded-md border bg-card/60 p-3 transition-colors duration-150",
                selected
                  ? "border-primary/50 bg-primary/5"
                  : "border-border",
                busy && "ring-1 ring-primary/30",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Checkbox
                  checked={selected}
                  onCheckedChange={() => toggleSelectRow(key)}
                  disabled={bulkRunning}
                  aria-label={`Select ${e.upn} for bulk sign-in`}
                />
                <BadgeCheck className="h-4 w-4 text-success" aria-hidden />
                <code className="font-mono text-sm font-medium">{e.upn}</code>
                <CopyChip
                  value={e.upn}
                  label="UPN"
                  onCopied={() =>
                    store.addNotification({
                      type: "info",
                      message: `Copied ${e.upn}.`,
                    })
                  }
                  onCopyFailed={() =>
                    store.addNotification({
                      type: "error",
                      message: "Clipboard blocked by the browser.",
                    })
                  }
                />
                {e.source === "create" && (
                  <Badge variant="info" className="text-2xs">
                    created
                  </Badge>
                )}
                {e.source === "reset" && (
                  <Badge variant="secondary" className="text-2xs">
                    reset
                  </Badge>
                )}
                {e.mustChangePassword && (
                  <Badge variant="warning" className="text-2xs">
                    must change
                  </Badge>
                )}
                <span
                  className="ml-auto text-2xs text-muted-foreground tabular-nums"
                  title={
                    e.createdAt ? new Date(e.createdAt).toISOString() : undefined
                  }
                >
                  {e.createdAt
                    ? formatRelative(e.createdAt)
                    : "unknown date"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
                <span>
                  tenant{" "}
                  <code className="font-mono">{truncateMiddle(e.tenantId)}</code>
                </span>
                <CopyChip
                  value={e.tenantId}
                  label="tenant ID"
                  onCopied={() =>
                    store.addNotification({
                      type: "info",
                      message: "Tenant ID copied.",
                    })
                  }
                  onCopyFailed={() =>
                    store.addNotification({
                      type: "error",
                      message: "Clipboard blocked by the browser.",
                    })
                  }
                />
                {e.displayName && (
                  <span>· {e.displayName}</span>
                )}
                {e.lastUsedAt && (
                  <span title={new Date(e.lastUsedAt).toISOString()}>
                    · last used {formatRelative(e.lastUsedAt)}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <code className="rounded bg-background px-2 py-1 font-mono text-2xs">
                  {revealed ? e.password : "••••••••••••"}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => togglePassword(key)}
                  aria-label={revealed ? "Hide password" : "Show password"}
                  title={revealed ? "Hide password" : "Show password"}
                >
                  {revealed ? <EyeOff /> : <Eye />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void copyPassword(e)}
                  aria-label="Copy password"
                  title="Copy password"
                >
                  <Copy />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {/*
                  PRIMARY: Full-auto WebUI sign-in via Playwright. Opens a
                  Chromium window, fills email + password, walks the
                  change-password form if required (with a freshly-
                  generated password that lands back in the vault).
                  Resulting browser is signed into this WebUI.
                */}
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={busy || bulkRunning}
                  onClick={() => void runAutoSignIn(e)}
                  aria-label={`Auto sign-in to WebUI as ${e.upn}`}
                  title="Playwright fills email + password (and walks the must-change-password form when needed). New Chromium window is signed into this WebUI as the user."
                >
                  {busy ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <LogIn />
                  )}
                  {e.mustChangePassword
                    ? "Auto sign-in (resets password)"
                    : "Auto sign-in"}
                </Button>
                {/*
                  SECONDARY: MSAL popup in this tab — manual password
                  entry, but signs THIS WebUI tab in (no separate
                  Chromium). Useful when Playwright isn't available or
                  the operator wants the new account to become the
                  active session in their current browser.
                */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || bulkRunning}
                  onClick={() => void runInteractive(e)}
                  aria-label={`MSAL popup sign-in as ${e.upn}`}
                  title="MSAL popup in this tab — manual password entry"
                >
                  <LogIn />
                  Manual (MSAL)
                </Button>
                {/*
                  TERTIARY: Open a portal.azure.com session in a separate
                  Chromium window. Independent of WebUI; may fail with
                  AADSTS50011 in tenants restricting portal access.
                */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || bulkRunning}
                  onClick={() => void runPlaywright(e)}
                  aria-label={`Open portal.azure.com session for ${e.upn}`}
                  title="POST /api/portal/auto-login (target=portal) — opens portal.azure.com in a separate Chromium window"
                >
                  <ExternalLink />
                  Portal
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void copyEmail(e)}
                  aria-label="Copy email"
                  title="Copy email to clipboard"
                >
                  <Copy />
                  Copy email
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeEntry(e)}
                  className="ml-auto text-destructive hover:text-destructive"
                  aria-label={`Remove vault entry for ${e.upn}`}
                  title="Remove from vault"
                >
                  <Trash2 />
                  Remove
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
    <ConfirmationDialog
      hidden={!pendingRemoval}
      danger
      title="Remove vault entry"
      message={
        pendingRemoval ? (
          <span>
            Remove vault entry for <strong>{pendingRemoval.upn}</strong>?
            You will not be able to re-launch the sign-in window from this
            browser without recreating the credential.
          </span>
        ) : (
          ""
        )
      }
      confirmText="Remove"
      loading={removalSubmitting}
      onConfirm={confirmRemoveEntry}
      onCancel={() => {
        if (!removalSubmitting) setPendingRemoval(null);
      }}
    />
    </>
  );
};

interface BrowseUsersProps {
  tenantUsers: Record<string, GraphUser[]>;
  azureAccounts: Array<{
    homeAccountId: string;
    username: string;
    name: string;
    tenantId: string;
    activeTenantId?: string;
  }>;
  privilegedAccounts: PrivilegedAccount[];
  onSwitchToCreateTab: (homeAccountId: string) => void;
  onNavigate?: (k: PageKey) => void;
}

const BrowseUsers: React.FC<BrowseUsersProps> = ({
  tenantUsers,
  privilegedAccounts,
  onSwitchToCreateTab,
  onNavigate,
}) => {
  const store = useMultiRegionStore();
  const rows: BrowseRow[] = React.useMemo(() => {
    const out: BrowseRow[] = [];
    for (const [tenantId, users] of Object.entries(tenantUsers ?? {})) {
      if (!Array.isArray(users)) continue;
      for (const u of users) {
        out.push({
          ...u,
          tenantId,
          createdDateTime:
            (u as unknown as { createdDateTime?: string }).createdDateTime ??
            null,
        });
      }
    }
    return out;
  }, [tenantUsers]);

  const tenantIds = React.useMemo(() => {
    return Array.from(new Set(rows.map((r) => r.tenantId))).sort();
  }, [rows]);

  const [tenantFilter, setTenantFilter] = React.useState<string[]>([]);
  const [statusFilter, setStatusFilter] = React.useState<string[]>([]);

  const stats = React.useMemo(() => {
    const total = rows.length;
    const enabled = rows.filter((r) => r.accountEnabled).length;
    const disabled = total - enabled;
    const tenants = tenantIds.length;
    return { total, enabled, disabled, tenants };
  }, [rows, tenantIds]);

  const findAccountForTenant = React.useCallback(
    (tenantId: string): PrivilegedAccount | null => {
      return (
        privilegedAccounts.find((p) => p.tenantId === tenantId) ??
        privilegedAccounts[0] ??
        null
      );
    },
    [privilegedAccounts],
  );

  const notifyCopied = React.useCallback(
    (value: string) => {
      store.addNotification({
        type: "info",
        message: `Copied ${truncateMiddle(value)}`,
      });
    },
    [store],
  );
  const notifyCopyFailed = React.useCallback(() => {
    store.addNotification({
      type: "error",
      message: "Clipboard blocked by the browser.",
    });
  }, [store]);

  const columns: EnhancedColumn<BrowseRow>[] = React.useMemo(
    () => [
      {
        key: "displayName",
        name: "Display Name",
        minWidth: 180,
        getValue: (u) => u.displayName ?? "",
        onRender: (u) => (
          <span className="truncate text-xs text-foreground">
            {u.displayName || "(unnamed)"}
          </span>
        ),
      },
      {
        key: "userPrincipalName",
        name: "User Principal Name",
        minWidth: 260,
        getValue: (u) => u.userPrincipalName ?? "",
        onRender: (u) => {
          const upn = u.userPrincipalName ?? "";
          const at = upn.indexOf("@");
          const label = at < 0 ? upn : null;
          return (
            <span className="flex items-center gap-1 truncate text-xs">
              {label !== null ? (
                <span className="text-muted-foreground">{label}</span>
              ) : (
                <>
                  <span className="text-foreground">{upn.slice(0, at + 1)}</span>
                  <span className="font-mono text-muted-foreground">
                    {upn.slice(at + 1)}
                  </span>
                </>
              )}
              {upn && (
                <CopyChip
                  value={upn}
                  label="UPN"
                  onCopied={notifyCopied}
                  onCopyFailed={notifyCopyFailed}
                />
              )}
            </span>
          );
        },
      },
      {
        key: "id",
        name: "Object ID",
        minWidth: 160,
        getValue: (u) => u.id ?? "",
        onRender: (u) => (
          <span className="flex items-center gap-1 text-2xs">
            <code className="font-mono text-muted-foreground">
              {truncateMiddle(u.id ?? "", 8, 4)}
            </code>
            {u.id && (
              <CopyChip
                value={u.id}
                label="object ID"
                onCopied={notifyCopied}
                onCopyFailed={notifyCopyFailed}
              />
            )}
          </span>
        ),
      },
      {
        key: "tenantId",
        name: "Tenant",
        minWidth: 160,
        getValue: (u) => u.tenantId,
        onRender: (u) => (
          <span className="flex items-center gap-1 text-2xs">
            <Badge variant="secondary" className="font-mono text-2xs">
              {truncateMiddle(u.tenantId, 8, 4)}
            </Badge>
            <CopyChip
              value={u.tenantId}
              label="tenant ID"
              onCopied={notifyCopied}
              onCopyFailed={notifyCopyFailed}
            />
          </span>
        ),
      },
      {
        key: "accountEnabled",
        name: "State",
        minWidth: 110,
        getValue: (u) => (u.accountEnabled ? "Enabled" : "Disabled"),
        onRender: (u) =>
          u.accountEnabled ? (
            <Badge variant="success" className="gap-1">
              <BadgeCheck className="h-3 w-3" />
              Enabled
            </Badge>
          ) : (
            <Badge variant="secondary">Disabled</Badge>
          ),
      },
      {
        key: "createdDateTime",
        name: "Created",
        minWidth: 110,
        getValue: (u) => u.createdDateTime ?? "",
        onRender: (u) => (
          <span
            className="text-2xs text-muted-foreground tabular-nums"
            title={u.createdDateTime ?? undefined}
          >
            {formatRelative(u.createdDateTime)}
          </span>
        ),
      },
      {
        key: "actions",
        name: "Action",
        minWidth: 130,
        sortable: false,
        onRender: (u) => {
          const target = findAccountForTenant(u.tenantId);
          const disabled = !target;
          return (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                if (target) onSwitchToCreateTab(target.homeAccountId);
              }}
              disabled={disabled}
              aria-label={`Use tenant ${u.tenantId}`}
              title={
                disabled
                  ? "No privileged account is logged in for this tenant."
                  : `Switch to tenant ${truncateMiddle(u.tenantId)}`
              }
            >
              <ArrowLeftRight />
              Use Tenant
            </Button>
          );
        },
      },
    ],
    [findAccountForTenant, onSwitchToCreateTab, notifyCopied, notifyCopyFailed],
  );

  // Apply the local "State" filter on top of the EnhancedTable's
  // tenant-column filter. EnhancedTable doesn't natively support a
  // boolean filter via FilterConfig, so we pre-filter the rows array.
  const visibleRows = React.useMemo(() => {
    if (statusFilter.length === 0) return rows;
    return rows.filter((r) => {
      const k = r.accountEnabled ? "enabled" : "disabled";
      return statusFilter.includes(k);
    });
  }, [rows, statusFilter]);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="No users fetched yet."
        description="Open the Tenant Users page and load users for one or more tenants to populate this browser."
        action={
          onNavigate
            ? {
                label: "Open Tenant Users",
                onClick: () => onNavigate("tenant-users"),
              }
            : undefined
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Stats strip — quick read of the loaded dataset. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatChip
          icon={Users}
          label="Total"
          value={stats.total}
          tone="primary"
        />
        <StatChip
          icon={BadgeCheck}
          label="Enabled"
          value={stats.enabled}
          tone="success"
        />
        <StatChip
          icon={ShieldAlert}
          label="Disabled"
          value={stats.disabled}
          tone="muted"
        />
        <StatChip
          icon={Building2}
          label="Tenants"
          value={stats.tenants}
          tone="info"
        />
      </div>

      <Card>
        <CardContent className="pt-4">
          <EnhancedTable<BrowseRow>
            items={visibleRows}
            columns={columns}
            getRowId={(u) => `${u.tenantId}::${u.id}`}
            searchPlaceholder="Search users (UPN, display name, object ID, tenant)…"
            filters={[
              {
                columnKey: "tenantId",
                options: tenantIds.map((t) => ({
                  key: t,
                  text: truncateMiddle(t),
                })),
                selectedKeys: tenantFilter,
                onChange: setTenantFilter,
              },
              {
                columnKey: "accountEnabled",
                options: [
                  { key: "enabled", text: "Enabled" },
                  { key: "disabled", text: "Disabled" },
                ],
                selectedKeys: statusFilter,
                onChange: setStatusFilter,
              },
            ]}
            pageSize={50}
          />
        </CardContent>
      </Card>
    </div>
  );
};

export const UserCreatorPage: React.FC<UserCreatorPageProps> = (props) => (
  <ErrorBoundary>
    <UserCreatorPageInner {...props} />
  </ErrorBoundary>
);
