/**
 * EA Subscription page — provisions Azure subscriptions under an
 * Enterprise Agreement (or MCA) billing scope, one per recipient.
 * Uses a Popover + Command picker for fuzzy multi-recipient selection,
 * zod-validated form, EmptyState for the unauthenticated path, and
 * ConfirmationDialog for the irreversible create step.
 *
 * Sibling files (extracted from this page to keep its surface scannable
 * and improve re-render isolation):
 *
 *   - `./accept-ownership-panel.tsx` — destination-tenant companion for
 *     the cross-tenant flow (operator pastes a subscriptionId and accepts
 *     ownership inline).
 *   - `./copyable-id.tsx`            — shared "copy to clipboard" pill.
 *   - `./ea-helpers.ts`              — pure utilities (parseBulkRecipients,
 *     suggestRemediation, categorizeError, azurePortalLinkForSubscription,
 *     formatElapsedSec, UUID/ALIAS regex, randomSuffix, generateBatchId).
 *   - `./pre-flight-panel.tsx`       — corpus-grounded signature panel
 *     (cross-tenant fan-out, mixed-recipient anomaly, self-replication,
 *     manual-paste-heavy) + pre-create audit-event simulation.
 *     Cite: `_ea_subscription_cross_tenant.md` §1, §9.
 *   - `./reconciliation-tile.tsx`    — post-batch steady-state bucket
 *     (steady / alias-only / pending-acceptance / failed / stale).
 *     Cite: `_bypass_modify_delete.md`.
 *   - `./recipient-templates.tsx`    — persisted recipient lists for
 *     repeated batches; localStorage via `usePersistedState`.
 *   - `./corpus-signatures.ts`       — pure detection helpers consumed by
 *     `pre-flight-panel.tsx`.
 *
 * Hotkeys: `Ctrl/Cmd + Enter` opens the create-subscription confirmation
 * when the form is ready; `Escape` cancels the confirm dialog (but never
 * aborts an in-flight batch).
 *
 * Screen readers get an off-screen `aria-live="polite"` announcer near the
 * top of the rendered tree that emits short batch-milestone strings
 * ("Provisioning subscriptions: 3 of 10 complete", "Batch complete.")
 * in addition to the visible Provisioning Summary card.
 */
import * as React from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  AlertCircle,
  AlertTriangle,
  BadgeCheck,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  ChevronsUpDown,
  ClipboardPaste,
  Download,
  ExternalLink,
  FileSignature,
  Filter,
  Hourglass,
  IdCard,
  Info,
  Link2,
  Loader2,
  PartyPopper,
  PlusCircle,
  Receipt,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  Users,
  Wallet,
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
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, downloadCsv, downloadJson } from "@/lib/utils";

import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import {
  decodeJwtClaimsUnsafe,
  getActiveTenant,
  getArmTokenForAccount,
} from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { auditLog } from "../../services/audit-log";
import {
  buildAcceptOwnershipPortalUrl,
  type CallerBillingRoleDiagnostic,
  createEaSubscription,
  diagnoseCallerBillingRole,
  listBillingProfiles,
  listEaBillingAccounts,
  listEnrollmentAccounts,
  listInvoiceSections,
  probeEaCapability,
} from "../../services/arm-service";
import {
  CreateSubscriptionRequest,
  EaBillingAccount,
  EaBillingProfile,
  EaEnrollmentAccount,
  EaInvoiceSection,
  GraphUser,
  TenantInfo,
} from "../../services/types";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";

import { useArmToken } from "../../auth/use-arm-token";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { PageHeader } from "../shared/page-header";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

import { AcceptOwnershipPanel } from "./accept-ownership-panel";
import { CopyableId } from "./copyable-id";
import {
  ALIAS_REGEX,
  azurePortalLinkForSubscription,
  categorizeError,
  formatElapsedSec,
  generateBatchId,
  isValidAlias,
  isValidUuid,
  parseBulkRecipients,
  randomSuffix,
  suggestRemediation,
  truncateMiddle,
  UUID_REGEX,
} from "./ea-helpers";
import { PreFlightPanel } from "./pre-flight-panel";
import { ReconciliationTile } from "./reconciliation-tile";
import { RecipientTemplates } from "./recipient-templates";

const ACTIVE_KEY_STORAGE = "ea-subscription:active-account";
const RECIPIENTS_STORAGE = "ea-subscription:recipients";
const SELF_ASSIGN_STORAGE = "ea-subscription:self-assign";

interface EaAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
  localAccountId?: string;
  billingAccountCount: number;
}

type RecipientSource = "web-account" | "tenant-user" | "manual";

interface Recipient {
  key: string;
  source: RecipientSource;
  tenantId: string;
  ownerObjectId: string;
  displayLabel: string;
  upn?: string;
  tenantLabel?: string;
  enabled?: boolean;
}

type PerRecipientStatus =
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

interface PersistedRecipient {
  key: string;
  source: RecipientSource;
  tenantId: string;
  ownerObjectId: string;
}

function recipientKey(
  source: RecipientSource,
  r: Pick<Recipient, "tenantId" | "ownerObjectId">,
): string {
  return `${source}:${r.tenantId}:${r.ownerObjectId}`;
}

function dedupeKey(r: Pick<Recipient, "tenantId" | "ownerObjectId">): string {
  // Hardened: malformed/partial recipients (e.g. a row hydrated from
  // sessionStorage with a missing tenantId or ownerObjectId) used to
  // throw "Cannot read properties of undefined (reading 'toLowerCase')"
  // here during render. Fall back to empty strings so the dedupe key
  // is still stable for the missing-field case.
  return `${(r.tenantId ?? "").toLowerCase()}:${(r.ownerObjectId ?? "").toLowerCase()}`;
}

function deriveAlias(recipient: Recipient): string {
  const seedRaw =
    recipient.upn?.split("@")[0] ??
    recipient.displayLabel ??
    recipient.ownerObjectId;
  const seed =
    seedRaw
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "sub";
  return `sub-${seed}-${randomSuffix(5)}`;
}

function deriveDisplayName(recipient: Recipient): string {
  const base = `Sub for ${recipient.displayLabel || recipient.upn || recipient.ownerObjectId}`;
  return base.length > 64 ? `${base.slice(0, 61)}...` : base;
}

interface ScopeCardProps {
  selected: boolean;
  onSelect: () => void;
  title: string;
  subtitle?: string;
  meta?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
}

/**
 * Visual replacement for a `<Select>` when the user is choosing one of a
 * small set of billing-hierarchy entities. Cards make the picked node
 * obvious and let us surface secondary metadata (cost center, owner,
 * agreement type) without a dropdown overlay.
 */
const ScopeCard: React.FC<ScopeCardProps> = ({
  selected,
  onSelect,
  title,
  subtitle,
  meta,
  badge,
  disabled,
}) => (
  <button
    type="button"
    onClick={onSelect}
    disabled={disabled}
    aria-pressed={selected}
    className={cn(
      "group flex w-full items-start gap-3 rounded-lg border bg-card px-3 py-2.5 text-left",
      "transition-all duration-200 ease-out",
      "hover:border-primary/60 hover:bg-accent/5 hover:shadow-elev-1",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:shadow-none",
      selected
        ? "border-primary bg-primary/5 shadow-elev-1 ring-1 ring-primary/30"
        : "border-border",
    )}
  >
    <span
      aria-hidden
      className={cn(
        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-150",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background group-hover:border-primary/60",
      )}
    >
      {selected && <Check className="h-3 w-3" aria-hidden />}
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">
          {title}
        </span>
        {badge}
      </span>
      {subtitle && (
        <span className="truncate font-mono text-2xs text-muted-foreground">
          {subtitle}
        </span>
      )}
      {meta && (
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
          {meta}
        </span>
      )}
    </span>
  </button>
);

const recipientSchema = z.object({
  key: z.string(),
  source: z.union([
    z.literal("web-account"),
    z.literal("tenant-user"),
    z.literal("manual"),
  ]),
  tenantId: z.string().regex(UUID_REGEX, "Tenant ID must be a GUID."),
  ownerObjectId: z.string().regex(UUID_REGEX, "Owner ID must be a GUID."),
  displayLabel: z.string().min(1),
  upn: z.string().optional(),
  tenantLabel: z.string().optional(),
  enabled: z.boolean().optional(),
});

const formSchema = z
  .object({
    aliasName: z
      .string()
      .min(3, "Alias must be at least 3 characters.")
      .max(63, "Alias must be at most 63 characters.")
      .regex(
        ALIAS_REGEX,
        "Alias must use lowercase letters, digits, or hyphens.",
      ),
    displayName: z
      .string()
      .min(1, "Display name is required.")
      .max(64, "Display name must be at most 64 characters."),
    billingScope: z.string().min(1, "Billing scope is required."),
    selfAssign: z.boolean(),
    recipients: z.array(recipientSchema),
  })
  .refine(
    (v) => v.selfAssign || v.recipients.length > 0,
    {
      message: "Pick at least one recipient.",
      path: ["recipients"],
    },
  );

type FormValues = z.infer<typeof formSchema>;

export interface EaSubscriptionPageProps {
  orchestrator?: OrchestratorAgent;
  onNavigate?: (key: string) => void;
}

const EaSubscriptionPageInner: React.FC<EaSubscriptionPageProps> = ({
  onNavigate,
}) => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();

  const azureAccounts = state.azureAccounts ?? [];

  const [eaCapabilityMap, setEaCapabilityMap] = React.useState<
    Record<string, { hasEa: boolean; billingAccountCount: number }>
  >({});
  const [discoveringEa, setDiscoveringEa] = React.useState(true);

  const accountKey = React.useMemo(
    () =>
      azureAccounts
        .map((a) => `${a.homeAccountId}|${resolveActiveTenantId(a) ?? ""}`)
        .sort()
        .join(","),
    [azureAccounts],
  );

  // EA-capability probe — runs every signed-in account through the billing
  // API so we can render only the EA-capable ones. Uses `useAbortableEffect`
  // so an in-flight probe is dropped if `accountKey` changes mid-flight
  // (e.g. a parallel sign-in completes) — the signal short-circuits the
  // setState calls below. `probeEaCapability` itself does not accept a
  // signal yet, so we still let any pending HTTPs finish but discard the
  // result if the effect was torn down.
  useAbortableEffect(
    async (signal) => {
      setDiscoveringEa(true);
      const next: Record<
        string,
        { hasEa: boolean; billingAccountCount: number }
      > = {};
      await Promise.allSettled(
        azureAccounts.map(async (a) => {
          if (signal.aborted || !a.homeAccountId) return;
          const tenantId = getActiveTenant(a.homeAccountId) ?? a.tenantId;
          if (!tenantId) {
            next[a.homeAccountId] = { hasEa: false, billingAccountCount: 0 };
            return;
          }
          try {
            const token = await getArmTokenForAccount(
              a.homeAccountId,
              tenantId,
            );
            if (signal.aborted) return;
            const cap = await probeEaCapability(token);
            if (signal.aborted) return;
            next[a.homeAccountId] = {
              hasEa: cap.hasEa,
              billingAccountCount: cap.billingAccountCount,
            };
          } catch {
            if (signal.aborted) return;
            next[a.homeAccountId] = { hasEa: false, billingAccountCount: 0 };
          }
        }),
      );
      if (signal.aborted) return;
      setEaCapabilityMap(next);
      setDiscoveringEa(false);
    },
    [accountKey, azureAccounts],
  );

  const eaAccounts: EaAccount[] = React.useMemo(() => {
    return azureAccounts
      .filter((a) => eaCapabilityMap[a.homeAccountId]?.hasEa)
      .map((a) => ({
        homeAccountId: a.homeAccountId,
        tenantId: getActiveTenant(a.homeAccountId) ?? a.tenantId,
        username: a.username,
        name: a.name || a.username,
        localAccountId: a.localAccountId,
        billingAccountCount:
          eaCapabilityMap[a.homeAccountId]?.billingAccountCount ?? 0,
      }))
      .filter((a) => a.tenantId);
  }, [azureAccounts, eaCapabilityMap]);

  const [activeKey, setActiveKey] = React.useState<string>(() => {
    try {
      return sessionStorage.getItem(ACTIVE_KEY_STORAGE) ?? "";
    } catch {
      return "";
    }
  });

  React.useEffect(() => {
    if (eaAccounts.length === 0) return;
    const exists = eaAccounts.some((a) => a.homeAccountId === activeKey);
    if (!exists) {
      const next = eaAccounts[0]!.homeAccountId;
      setActiveKey(next);
      try {
        sessionStorage.setItem(ACTIVE_KEY_STORAGE, next);
      } catch {
        /* sessionStorage may be unavailable in some sandboxed contexts */
      }
    }
  }, [eaAccounts, activeKey]);

  const handleSelectAccount = React.useCallback((key: string) => {
    setActiveKey(key);
    try {
      sessionStorage.setItem(ACTIVE_KEY_STORAGE, key);
    } catch {
      /* sessionStorage may be unavailable in some sandboxed contexts */
    }
    // Audit the active-account switch so the timeline shows which EA
    // identity was in scope when subsequent billing / submission events
    // landed. Previously this was silent — making post-mortem of a wrong-
    // account submission much harder.
    auditLog.record({
      actor: key,
      action: "ea_subscription_select_account",
      target: key,
      status: "success",
      details: { homeAccountId: key },
    });
  }, []);

  const activeAccount: EaAccount | null = React.useMemo(
    () => eaAccounts.find((a) => a.homeAccountId === activeKey) ?? null,
    [eaAccounts, activeKey],
  );

  // Centralized ARM-token tracker for the active EA-capable account.
  // Runs in parallel with the existing per-call `getArmTokenForAccount`
  // logic (which we intentionally leave intact — the recipient batcher
  // re-mints tokens per-tenant and against caller-billing-role
  // diagnostics, both of which need bespoke control flow). This hook
  // exists purely so the operator can see a live expiry badge on a page
  // that often sits open while they curate a recipient list and review
  // diagnostics, and force a refresh before submitting a multi-recipient
  // batch that may run past the auto-refresh window.
  const armTokenTracker = useArmToken(
    activeAccount?.homeAccountId,
    activeAccount?.tenantId,
  );

  const [billingAccounts, setBillingAccounts] = React.useState<
    EaBillingAccount[]
  >([]);
  const [billingProfiles, setBillingProfiles] = React.useState<
    EaBillingProfile[]
  >([]);
  const [invoiceSections, setInvoiceSections] = React.useState<
    EaInvoiceSection[]
  >([]);
  const [enrollmentAccounts, setEnrollmentAccounts] = React.useState<
    EaEnrollmentAccount[]
  >([]);

  const [selectedBillingAccount, setSelectedBillingAccount] =
    React.useState<string>("");
  const [selectedBillingProfile, setSelectedBillingProfile] =
    React.useState<string>("");
  const [selectedInvoiceSection, setSelectedInvoiceSection] =
    React.useState<string>("");
  const [selectedEnrollmentAccount, setSelectedEnrollmentAccount] =
    React.useState<string>("");

  const [loadingBa, setLoadingBa] = React.useState(false);
  const [loadingBp, setLoadingBp] = React.useState(false);
  const [loadingIs, setLoadingIs] = React.useState(false);
  const [loadingEnrollmentAccounts, setLoadingEnrollmentAccounts] =
    React.useState(false);

  const [errBa, setErrBa] = React.useState<string | null>(null);
  const [errBp, setErrBp] = React.useState<string | null>(null);
  const [errIs, setErrIs] = React.useState<string | null>(null);
  const [enrollmentAccountsError, setEnrollmentAccountsError] = React.useState<
    string | null
  >(null);

  const selectedBillingAccountObj = React.useMemo(
    () => billingAccounts.find((b) => b.name === selectedBillingAccount),
    [billingAccounts, selectedBillingAccount],
  );

  const isEa =
    selectedBillingAccountObj?.agreementType === "EnterpriseAgreement";

  // Tracks the latest in-flight load so a slow earlier request (e.g. the
  // user switched accounts before the previous fetch resolved) can't clobber
  // a newer response — classic last-fetch-wins race fix.
  const billingLoadSeqRef = React.useRef(0);

  const loadBillingAccounts = React.useCallback(async () => {
    if (!activeAccount) return;
    const seq = ++billingLoadSeqRef.current;
    setLoadingBa(true);
    setErrBa(null);
    try {
      const token = await getArmTokenForAccount(
        activeAccount.homeAccountId,
        activeAccount.tenantId,
      );
      const list = await listEaBillingAccounts(token);
      if (seq !== billingLoadSeqRef.current) return;
      setBillingAccounts(list);
      if (list.length === 1) {
        setSelectedBillingAccount(list[0]!.name);
      } else {
        setSelectedBillingAccount("");
      }
    } catch (e: unknown) {
      if (seq !== billingLoadSeqRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setErrBa(msg);
      setBillingAccounts([]);
    } finally {
      if (seq === billingLoadSeqRef.current) {
        setLoadingBa(false);
      }
    }
  }, [activeAccount]);

  React.useEffect(() => {
    if (activeAccount) {
      // Invalidate any in-flight load from the previous account so its
      // response is silently dropped instead of overwriting our reset state.
      billingLoadSeqRef.current += 1;
      setBillingAccounts([]);
      setBillingProfiles([]);
      setInvoiceSections([]);
      setEnrollmentAccounts([]);
      setSelectedBillingAccount("");
      setSelectedBillingProfile("");
      setSelectedInvoiceSection("");
      setSelectedEnrollmentAccount("");
      loadBillingAccounts();
    }
  }, [activeAccount, loadBillingAccounts]);

  // Independent seq counters for each downstream loader — switching the
  // selected billing account mid-fetch must not let an older response set
  // billing profiles / enrollment accounts that belong to the previous BA.
  const profileLoadSeqRef = React.useRef(0);
  const enrollmentLoadSeqRef = React.useRef(0);
  const invoiceLoadSeqRef = React.useRef(0);

  const loadBillingProfiles = React.useCallback(async () => {
    if (!activeAccount || !selectedBillingAccount) return;
    const seq = ++profileLoadSeqRef.current;
    setLoadingBp(true);
    setErrBp(null);
    try {
      const token = await getArmTokenForAccount(
        activeAccount.homeAccountId,
        activeAccount.tenantId,
      );
      const list = await listBillingProfiles(selectedBillingAccount, token);
      if (seq !== profileLoadSeqRef.current) return;
      setBillingProfiles(list);
      if (list.length === 1) {
        setSelectedBillingProfile(list[0]!.name);
      } else {
        setSelectedBillingProfile("");
      }
    } catch (e: unknown) {
      if (seq !== profileLoadSeqRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setErrBp(msg);
      setBillingProfiles([]);
    } finally {
      if (seq === profileLoadSeqRef.current) {
        setLoadingBp(false);
      }
    }
  }, [activeAccount, selectedBillingAccount]);

  const loadEnrollmentAccounts = React.useCallback(async () => {
    if (!activeAccount || !selectedBillingAccount) return;
    const seq = ++enrollmentLoadSeqRef.current;
    setLoadingEnrollmentAccounts(true);
    setEnrollmentAccountsError(null);
    try {
      const token = await getArmTokenForAccount(
        activeAccount.homeAccountId,
        activeAccount.tenantId,
      );
      const list = await listEnrollmentAccounts(selectedBillingAccount, token);
      if (seq !== enrollmentLoadSeqRef.current) return;
      setEnrollmentAccounts(list);
      if (list.length === 1) {
        setSelectedEnrollmentAccount(list[0]!.name);
      } else {
        setSelectedEnrollmentAccount("");
      }
    } catch (e: unknown) {
      if (seq !== enrollmentLoadSeqRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setEnrollmentAccountsError(msg);
      setEnrollmentAccounts([]);
    } finally {
      if (seq === enrollmentLoadSeqRef.current) {
        setLoadingEnrollmentAccounts(false);
      }
    }
  }, [activeAccount, selectedBillingAccount]);

  React.useEffect(() => {
    // Invalidate any in-flight profile / enrollment fetches before resetting.
    profileLoadSeqRef.current += 1;
    enrollmentLoadSeqRef.current += 1;
    invoiceLoadSeqRef.current += 1;
    setBillingProfiles([]);
    setInvoiceSections([]);
    setEnrollmentAccounts([]);
    setSelectedBillingProfile("");
    setSelectedInvoiceSection("");
    setSelectedEnrollmentAccount("");
    if (!selectedBillingAccount) return;
    if (isEa) {
      loadEnrollmentAccounts();
    } else {
      loadBillingProfiles();
    }
  }, [
    selectedBillingAccount,
    isEa,
    loadBillingProfiles,
    loadEnrollmentAccounts,
  ]);

  const loadInvoiceSections = React.useCallback(async () => {
    if (!activeAccount || !selectedBillingAccount || !selectedBillingProfile)
      return;
    const seq = ++invoiceLoadSeqRef.current;
    setLoadingIs(true);
    setErrIs(null);
    try {
      const token = await getArmTokenForAccount(
        activeAccount.homeAccountId,
        activeAccount.tenantId,
      );
      const list = await listInvoiceSections(
        selectedBillingAccount,
        selectedBillingProfile,
        token,
      );
      if (seq !== invoiceLoadSeqRef.current) return;
      setInvoiceSections(list);
      if (list.length === 1) {
        setSelectedInvoiceSection(list[0]!.name);
      } else {
        setSelectedInvoiceSection("");
      }
    } catch (e: unknown) {
      if (seq !== invoiceLoadSeqRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setErrIs(msg);
      setInvoiceSections([]);
    } finally {
      if (seq === invoiceLoadSeqRef.current) {
        setLoadingIs(false);
      }
    }
  }, [activeAccount, selectedBillingAccount, selectedBillingProfile]);

  React.useEffect(() => {
    invoiceLoadSeqRef.current += 1;
    setInvoiceSections([]);
    setSelectedInvoiceSection("");
    if (!isEa && selectedBillingAccount && selectedBillingProfile) {
      loadInvoiceSections();
    }
  }, [
    isEa,
    selectedBillingAccount,
    selectedBillingProfile,
    loadInvoiceSections,
  ]);

  const knownTenants = React.useMemo<TenantInfo[]>(() => {
    const map = new Map<string, TenantInfo>();
    for (const a of azureAccounts) {
      for (const t of a.tenants ?? []) {
        if (!map.has(t.tenantId)) map.set(t.tenantId, t);
      }
    }
    return Array.from(map.values());
  }, [azureAccounts]);

  const tenantLabelFor = React.useCallback(
    (tenantId: string): string => {
      const t = knownTenants.find((x) => x.tenantId === tenantId);
      return (
        t?.displayName ?? t?.defaultDomain ?? truncateMiddle(tenantId, 8, 4)
      );
    },
    [knownTenants],
  );

  const webAccountRecipients = React.useMemo<Recipient[]>(() => {
    const out: Recipient[] = [];
    for (const a of azureAccounts) {
      const ownerObjectId = a.localAccountId;
      if (!ownerObjectId) continue;
      const tenantId = resolveActiveTenantId(a);
      if (!tenantId || !isValidUuid(tenantId) || !isValidUuid(ownerObjectId))
        continue;
      out.push({
        key: recipientKey("web-account", { tenantId, ownerObjectId }),
        source: "web-account",
        tenantId,
        ownerObjectId,
        displayLabel: a.name || a.username,
        upn: a.username,
        tenantLabel: tenantLabelFor(tenantId),
        enabled: true,
      });
    }
    return out;
  }, [azureAccounts, tenantLabelFor]);

  const tenantUserGroups = React.useMemo<
    Array<{ tenantId: string; tenantLabel: string; users: GraphUser[] }>
  >(() => {
    const buckets = state.tenantUsers ?? {};
    return Object.keys(buckets)
      .filter((tid) => isValidUuid(tid))
      .map((tenantId) => ({
        tenantId,
        tenantLabel: tenantLabelFor(tenantId),
        users: buckets[tenantId] ?? [],
      }))
      .filter((g) => g.users.length > 0);
  }, [state.tenantUsers, tenantLabelFor]);

  const tenantUserRecipients = React.useMemo<Recipient[]>(() => {
    const out: Recipient[] = [];
    for (const g of tenantUserGroups) {
      for (const u of g.users) {
        if (!isValidUuid(u.id)) continue;
        out.push({
          key: recipientKey("tenant-user", {
            tenantId: g.tenantId,
            ownerObjectId: u.id,
          }),
          source: "tenant-user",
          tenantId: g.tenantId,
          ownerObjectId: u.id,
          displayLabel: u.displayName || u.userPrincipalName || u.id,
          upn: u.userPrincipalName,
          tenantLabel: g.tenantLabel,
          enabled: u.accountEnabled !== false,
        });
      }
    }
    return out;
  }, [tenantUserGroups]);

  const recipientCatalog = React.useMemo<Map<string, Recipient>>(() => {
    const map = new Map<string, Recipient>();
    for (const r of webAccountRecipients) map.set(r.key, r);
    for (const r of tenantUserRecipients) {
      if (!map.has(r.key)) map.set(r.key, r);
    }
    return map;
  }, [webAccountRecipients, tenantUserRecipients]);

  const initialSelfAssign = React.useMemo<boolean>(() => {
    try {
      return sessionStorage.getItem(SELF_ASSIGN_STORAGE) === "1";
    } catch {
      return false;
    }
  }, []);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onChange",
    defaultValues: {
      aliasName: "",
      displayName: "",
      billingScope: "",
      selfAssign: initialSelfAssign,
      recipients: [],
    },
  });

  const selfAssign = form.watch("selfAssign");
  const selectedRecipients = form.watch("recipients");
  const aliasNameField = form.watch("aliasName");
  const displayNameField = form.watch("displayName");

  React.useEffect(() => {
    try {
      sessionStorage.setItem(SELF_ASSIGN_STORAGE, selfAssign ? "1" : "0");
    } catch {
      /* sessionStorage may be unavailable in some sandboxed contexts */
    }
  }, [selfAssign]);

  const [recipientsHydrated, setRecipientsHydrated] = React.useState(false);

  React.useEffect(() => {
    if (recipientsHydrated) return;
    if (azureAccounts.length === 0 && tenantUserRecipients.length === 0) return;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(RECIPIENTS_STORAGE);
    } catch {
      raw = null;
    }
    if (!raw) {
      setRecipientsHydrated(true);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as PersistedRecipient[];
      const next: Recipient[] = [];
      const seen = new Set<string>();
      for (const p of parsed) {
        if (!p || !p.tenantId || !p.ownerObjectId) continue;
        const dk = dedupeKey(p);
        if (seen.has(dk)) continue;
        if (p.source === "manual") {
          if (!isValidUuid(p.tenantId) || !isValidUuid(p.ownerObjectId))
            continue;
          next.push({
            key: `manual:${p.tenantId}:${p.ownerObjectId}`,
            source: "manual",
            tenantId: p.tenantId,
            ownerObjectId: p.ownerObjectId,
            displayLabel: `Manual (${truncateMiddle(p.ownerObjectId, 8, 4)})`,
            tenantLabel: tenantLabelFor(p.tenantId),
          });
          seen.add(dk);
        } else {
          const found = recipientCatalog.get(p.key);
          if (found) {
            next.push(found);
            seen.add(dk);
          }
        }
      }
      form.setValue("recipients", next, { shouldValidate: true });
    } catch {
      /* malformed cache - ignore and start fresh */
    }
    setRecipientsHydrated(true);
  }, [
    recipientsHydrated,
    azureAccounts.length,
    tenantUserRecipients.length,
    recipientCatalog,
    tenantLabelFor,
    form,
  ]);

  React.useEffect(() => {
    if (!recipientsHydrated) return;
    try {
      const persistable: PersistedRecipient[] = selectedRecipients.map((r) => ({
        key: r.key,
        source: r.source,
        tenantId: r.tenantId,
        ownerObjectId: r.ownerObjectId,
      }));
      sessionStorage.setItem(RECIPIENTS_STORAGE, JSON.stringify(persistable));
    } catch {
      /* sessionStorage may be unavailable in some sandboxed contexts */
    }
  }, [selectedRecipients, recipientsHydrated]);

  const selectedDedupeKeys = React.useMemo(() => {
    const set = new Set<string>();
    for (const r of selectedRecipients) set.add(dedupeKey(r));
    return set;
  }, [selectedRecipients]);

  const isSelected = React.useCallback(
    (r: Recipient) => selectedDedupeKeys.has(dedupeKey(r)),
    [selectedDedupeKeys],
  );

  const toggleRecipient = React.useCallback(
    (r: Recipient, on: boolean) => {
      const prev = form.getValues("recipients");
      const dk = dedupeKey(r);
      let next: Recipient[];
      if (on) {
        if (prev.some((x) => dedupeKey(x) === dk)) return;
        next = [...prev, r];
      } else {
        next = prev.filter((x) => dedupeKey(x) !== dk);
      }
      form.setValue("recipients", next, { shouldValidate: true });
    },
    [form],
  );

  const removeRecipient = React.useCallback(
    (key: string) => {
      const prev = form.getValues("recipients");
      const removed = prev.find((r) => r.key === key);
      form.setValue(
        "recipients",
        prev.filter((r) => r.key !== key),
        { shouldValidate: true },
      );
      if (removed) {
        auditLog.record({
          actor: activeAccount?.username ?? "anonymous",
          action: "ea_subscription_remove_recipient",
          target: removed.ownerObjectId,
          status: "success",
          details: {
            tenantId: removed.tenantId,
            source: removed.source,
            displayLabel: removed.displayLabel,
          },
        });
      }
    },
    [form, activeAccount],
  );

  const [pickerOpen, setPickerOpen] = React.useState(false);

  const [showManualPaste, setShowManualPaste] = React.useState(false);
  const [manualTenantId, setManualTenantId] = React.useState("");
  const [manualOwnerId, setManualOwnerId] = React.useState("");
  const manualTenantValid = isValidUuid(manualTenantId);
  const manualOwnerValid = isValidUuid(manualOwnerId);

  const handleAddManual = React.useCallback(() => {
    if (!manualTenantValid || !manualOwnerValid) return;
    const tenantId = manualTenantId.trim();
    const ownerObjectId = manualOwnerId.trim();
    const r: Recipient = {
      key: `manual:${tenantId}:${ownerObjectId}`,
      source: "manual",
      tenantId,
      ownerObjectId,
      displayLabel: `Manual (${truncateMiddle(ownerObjectId, 8, 4)})`,
      tenantLabel: tenantLabelFor(tenantId),
    };
    toggleRecipient(r, true);
    setManualTenantId("");
    setManualOwnerId("");
    auditLog.record({
      actor: activeAccount?.username ?? "anonymous",
      action: "ea_subscription_add_manual_recipient",
      target: ownerObjectId,
      status: "success",
      details: { tenantId, source: "manual" },
    });
  }, [
    manualTenantValid,
    manualOwnerValid,
    manualTenantId,
    manualOwnerId,
    tenantLabelFor,
    toggleRecipient,
    activeAccount,
  ]);

  // Bulk paste — accepts CSV / whitespace-separated `(tenantId, ownerObjectId)`
  // pairs (one per line) and adds them all to the recipient list in one shot.
  // Indispensable for batches of 20+ recipients where adding one at a time
  // through the manual paste form is unbearable.
  const [bulkPasteOpen, setBulkPasteOpen] = React.useState(false);
  const [bulkPasteText, setBulkPasteText] = React.useState("");
  const bulkParseResult = React.useMemo(
    () => parseBulkRecipients(bulkPasteText, 500),
    [bulkPasteText],
  );

  const handleBulkAdd = React.useCallback(() => {
    if (bulkParseResult.pairs.length === 0) return;
    const prev = form.getValues("recipients");
    const seen = new Set(prev.map((p) => dedupeKey(p)));
    const added: Recipient[] = [];
    for (const pair of bulkParseResult.pairs) {
      const dk = dedupeKey(pair);
      if (seen.has(dk)) continue;
      seen.add(dk);
      // Prefer an existing catalog entry (web account / tenant user) so the
      // operator sees the friendly display name they typed in. Otherwise
      // fall back to a manual recipient.
      const wkey = recipientKey("web-account", pair);
      const tkey = recipientKey("tenant-user", pair);
      const fromCatalog =
        recipientCatalog.get(wkey) ?? recipientCatalog.get(tkey);
      if (fromCatalog) {
        added.push(fromCatalog);
      } else {
        added.push({
          key: `manual:${pair.tenantId}:${pair.ownerObjectId}`,
          source: "manual",
          tenantId: pair.tenantId,
          ownerObjectId: pair.ownerObjectId,
          displayLabel: `Manual (${truncateMiddle(pair.ownerObjectId, 8, 4)})`,
          tenantLabel: tenantLabelFor(pair.tenantId),
        });
      }
    }
    if (added.length > 0) {
      form.setValue("recipients", [...prev, ...added], {
        shouldValidate: true,
      });
    }
    setBulkPasteText("");
    store.addNotification({
      type: added.length > 0 ? "success" : "info",
      message:
        added.length === 0
          ? "Bulk paste added no new recipients — all were duplicates or invalid."
          : `Bulk paste added ${added.length} recipient${added.length === 1 ? "" : "s"}` +
            (bulkParseResult.errors.length > 0
              ? ` (${bulkParseResult.errors.length} invalid row${bulkParseResult.errors.length === 1 ? "" : "s"} skipped).`
              : "."),
    });
    auditLog.record({
      actor: activeAccount?.username ?? "anonymous",
      action: "ea_subscription_bulk_paste_recipients",
      target: `${added.length} added`,
      status: "success",
      details: {
        validRows: bulkParseResult.pairs.length,
        addedCount: added.length,
        duplicateCount: bulkParseResult.pairs.length - added.length,
        invalidCount: bulkParseResult.errors.length,
        truncated: bulkParseResult.truncated,
      },
    });
  }, [
    bulkParseResult,
    form,
    recipientCatalog,
    tenantLabelFor,
    store,
    activeAccount,
  ]);

  // "Select all in tenant" — power-user shortcut on the Command picker.
  // For tenants with hundreds of users this saves the operator from
  // shift-clicking every row.
  const handleSelectAllInTenant = React.useCallback(
    (tenantId: string, users: Recipient[]) => {
      const prev = form.getValues("recipients");
      const seen = new Set(prev.map((p) => dedupeKey(p)));
      const added: Recipient[] = [];
      for (const r of users) {
        if (r.enabled === false) continue;
        const dk = dedupeKey(r);
        if (seen.has(dk)) continue;
        seen.add(dk);
        added.push(r);
      }
      if (added.length > 0) {
        form.setValue("recipients", [...prev, ...added], {
          shouldValidate: true,
        });
        store.addNotification({
          type: "success",
          message: `Added ${added.length} recipient${added.length === 1 ? "" : "s"} from this tenant.`,
        });
      }
      auditLog.record({
        actor: activeAccount?.username ?? "anonymous",
        action: "ea_subscription_select_all_in_tenant",
        target: tenantId,
        status: "success",
        details: { addedCount: added.length, tenantId },
      });
    },
    [form, store, activeAccount],
  );

  const handleClearRecipients = React.useCallback(() => {
    const prevCount = form.getValues("recipients").length;
    if (prevCount === 0) return;
    form.setValue("recipients", [], { shouldValidate: true });
    store.addNotification({
      type: "info",
      message: `Cleared ${prevCount} recipient${prevCount === 1 ? "" : "s"}.`,
    });
    auditLog.record({
      actor: activeAccount?.username ?? "anonymous",
      action: "ea_subscription_clear_recipients",
      target: `${prevCount} cleared`,
      status: "success",
      details: { previousCount: prevCount },
    });
  }, [form, store, activeAccount]);

  const selectedBillingProfileObj = React.useMemo(
    () => billingProfiles.find((p) => p.name === selectedBillingProfile),
    [billingProfiles, selectedBillingProfile],
  );

  const selectedInvoiceSectionObj = React.useMemo(
    () => invoiceSections.find((s) => s.name === selectedInvoiceSection),
    [invoiceSections, selectedInvoiceSection],
  );

  const selectedEnrollmentAccountObj = React.useMemo(
    () => enrollmentAccounts.find((e) => e.name === selectedEnrollmentAccount),
    [enrollmentAccounts, selectedEnrollmentAccount],
  );

  const billingScope = React.useMemo(() => {
    if (!selectedBillingAccount) return "";
    if (isEa) {
      return selectedEnrollmentAccountObj?.id ?? "";
    }
    return selectedInvoiceSectionObj?.id ?? "";
  }, [
    isEa,
    selectedBillingAccount,
    selectedEnrollmentAccountObj,
    selectedInvoiceSectionObj,
  ]);

  // Hoisted up from the JSX so it can be referenced by performSubmit (audit
  // events log the human-readable scope leaf, not just the ARM id).
  const confirmLeafName = isEa
    ? selectedEnrollmentAccountObj?.displayName
    : selectedInvoiceSectionObj?.displayName;

  // Keep zod-validated `billingScope` in sync with the cascade selection.
  React.useEffect(() => {
    form.setValue("billingScope", billingScope, { shouldValidate: true });
  }, [billingScope, form]);

  const leafSelectionReady = isEa
    ? Boolean(selectedEnrollmentAccount)
    : Boolean(selectedBillingProfile && selectedInvoiceSection);

  const selfAssignRecipient = React.useMemo<Recipient | null>(() => {
    if (!selfAssign || !activeAccount) return null;
    if (
      !activeAccount.localAccountId ||
      !isValidUuid(activeAccount.localAccountId) ||
      !isValidUuid(activeAccount.tenantId)
    ) {
      return null;
    }
    return {
      key: recipientKey("web-account", {
        tenantId: activeAccount.tenantId,
        ownerObjectId: activeAccount.localAccountId,
      }),
      source: "web-account",
      tenantId: activeAccount.tenantId,
      ownerObjectId: activeAccount.localAccountId,
      displayLabel: activeAccount.name || activeAccount.username,
      upn: activeAccount.username,
      tenantLabel: tenantLabelFor(activeAccount.tenantId),
      enabled: true,
    };
  }, [selfAssign, activeAccount, tenantLabelFor]);

  const effectiveRecipients = React.useMemo<Recipient[]>(() => {
    if (selfAssign) return selfAssignRecipient ? [selfAssignRecipient] : [];
    return selectedRecipients;
  }, [selfAssign, selfAssignRecipient, selectedRecipients]);

  // Pre-computed per-batch stats for the KPI tile row above the
  // Provisioning Summary. Memoized off `effectiveRecipients` so the four
  // tiles don't re-derive on every keystroke in the alias / display-name
  // inputs.
  const recipientStats = React.useMemo(() => {
    const callerTid = activeAccount?.tenantId.toLowerCase() ?? "";
    let crossTenant = 0;
    let disabled = 0;
    const tenantSet = new Set<string>();
    for (const r of effectiveRecipients) {
      tenantSet.add(r.tenantId);
      if (callerTid && r.tenantId.toLowerCase() !== callerTid) crossTenant += 1;
      if (r.enabled === false) disabled += 1;
    }
    return {
      total: effectiveRecipients.length,
      crossTenant,
      disabled,
      tenantSpan: tenantSet.size,
    };
  }, [effectiveRecipients, activeAccount]);

  // Auto-derive a default alias + display name from the first recipient
  // so the zod-required fields populate even when the user does not type
  // anything. Users may still override.
  const aliasTouched = form.formState.dirtyFields.aliasName;
  const displayTouched = form.formState.dirtyFields.displayName;
  React.useEffect(() => {
    const first = effectiveRecipients[0];
    if (!first) return;
    if (!aliasTouched) {
      let alias = deriveAlias(first);
      if (!isValidAlias(alias)) {
        alias = `sub-${randomSuffix(5)}-${Date.now().toString(36).slice(-4)}`;
      }
      form.setValue("aliasName", alias, { shouldValidate: true });
    }
    if (!displayTouched) {
      form.setValue("displayName", deriveDisplayName(first), {
        shouldValidate: true,
      });
    }
  }, [effectiveRecipients, aliasTouched, displayTouched, form]);

  const validRecipientsForSubmit =
    selfAssign && selfAssignRecipient
      ? true
      : !selfAssign && selectedRecipients.length > 0;

  const formReady =
    Boolean(activeAccount) &&
    leafSelectionReady &&
    Boolean(billingScope) &&
    validRecipientsForSubmit &&
    form.formState.isValid;

  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  // Wall-clock elapsed time during a submit, in seconds. Set to a monotonic
  // start timestamp on submit, ticks every 1s while submitting, and freezes
  // at the final value when the batch completes — surfaced to the user
  // because the alias polling loop can take 30-90 seconds and we want them
  // to see *something* moving instead of a static spinner.
  const [submitStartedAt, setSubmitStartedAt] = React.useState<number | null>(
    null,
  );
  const [submitElapsedSec, setSubmitElapsedSec] = React.useState(0);
  React.useEffect(() => {
    if (!submitting || submitStartedAt === null) return;
    const id = window.setInterval(() => {
      setSubmitElapsedSec(
        Math.max(0, Math.round((Date.now() - submitStartedAt) / 1000)),
      );
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [submitting, submitStartedAt]);
  const [statusMap, setStatusMap] = React.useState<
    Record<string, PerRecipientStatus>
  >({});
  const [batchErrors, setBatchErrors] = React.useState<
    Array<{ key: string; label: string; error: string }>
  >([]);
  // Decoded JWT claims of the ARM token used for the most recent submit.
  // Populated when the token is acquired; rendered in the failure card so
  // the user can verify tenant/oid/aud match what their EA role expects.
  const [tokenDiagnostic, setTokenDiagnostic] = React.useState<{
    tid: string;
    oid: string;
    upn: string;
    aud: string;
    issuedAt: string;
  } | null>(null);
  // Result of probing the billingRoleAssignments API at the active scope
  // for the caller's principalId. Auto-populated when a 401 is detected in
  // batchErrors so the user can see exactly which roles (if any) they
  // actually hold at the enrollment account scope.
  const [roleDiagnostic, setRoleDiagnostic] =
    React.useState<CallerBillingRoleDiagnostic | null>(null);
  const [roleDiagnosticLoading, setRoleDiagnosticLoading] =
    React.useState<boolean>(false);
  const [roleDiagnosticError, setRoleDiagnosticError] = React.useState<
    string | null
  >(null);
  // The most recent successful ARM token + billingScope, kept so the role
  // diagnostic can re-run without prompting another sign-in.
  const lastSubmitContextRef = React.useRef<{
    token: string;
    billingScope: string;
    principalId: string;
  } | null>(null);

  // Detect whether any failure in the current batch is a 401 / authorization
  // error — used as the trigger to auto-run the billing-role diagnostic.
  const hasAuthFailure = React.useMemo(
    () =>
      batchErrors.some((b) =>
        /401|not authorized|authoriz|billingpermission/i.test(b.error),
      ),
    [batchErrors],
  );

  // Detect MSAL session-death failures — the user's cached refresh
  // token is dead (expired, revoked, MFA stale, password changed) and
  // ONLY an interactive popup can recover. Silent retry / Retry failed
  // is useless against these; we surface a dedicated "Sign in again"
  // button that calls armTokenTracker.reauth() to pop the MSAL prompt.
  const hasStaleSession = React.useMemo(
    () =>
      batchErrors.some((b) =>
        /interaction_required|invalid_grant|Cached session is no longer valid|AADSTS50173|AADSTS50058|AADSTS50076|AADSTS50079|AADSTS65001/i.test(
          b.error,
        ),
      ),
    [batchErrors],
  );

  // Auto-fire the role diagnostic the first time a 401 appears. We have
  // the token + billingScope + caller oid stashed in lastSubmitContextRef;
  // calling listBillingRoleAssignments at the enrollmentAccount scope tells
  // us the ground truth about whether the principal is granted the
  // sufficient EA roles, vs. the 401 telling us only "no" without saying
  // why.
  React.useEffect(() => {
    if (!hasAuthFailure) return;
    if (roleDiagnostic !== null) return;
    if (roleDiagnosticLoading) return;
    const ctx = lastSubmitContextRef.current;
    if (!ctx) return;
    let cancelled = false;
    setRoleDiagnosticLoading(true);
    setRoleDiagnosticError(null);
    (async () => {
      try {
        const result = await diagnoseCallerBillingRole(
          ctx.billingScope,
          ctx.principalId,
          ctx.token,
        );
        if (!cancelled) setRoleDiagnostic(result);
      } catch (e: unknown) {
        if (!cancelled) {
          setRoleDiagnosticError(
            e instanceof Error ? e.message : String(e),
          );
        }
      } finally {
        if (!cancelled) setRoleDiagnosticLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasAuthFailure, roleDiagnostic, roleDiagnosticLoading]);

  const completedCount = React.useMemo(
    () =>
      Object.values(statusMap).filter(
        (s) => s.state === "success" || s.state === "failure",
      ).length,
    [statusMap],
  );
  const totalInFlight = React.useMemo(
    () => Object.keys(statusMap).length,
    [statusMap],
  );

  // Live wall-clock tick at 1 Hz used by every `running` row in the per-
  // recipient strip to recompute its "Xs elapsed" label. Without this
  // single shared tick the rows freeze at the time of the last
  // setStatusMap call.
  const [, tickNow] = React.useState(0);
  React.useEffect(() => {
    if (!submitting) return;
    const id = window.setInterval(() => tickNow((t) => t + 1), 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [submitting]);

  // Race-safety: every submit gets a monotonic batchId. Stale per-
  // recipient setStatusMap callbacks fired after the user kicked off a
  // newer batch must not clobber the new statusMap. Same idea as the
  // billingLoadSeqRef pattern earlier in the file.
  const batchIdRef = React.useRef(0);

  // Adjustable concurrency. 1 = strictly serial (lowest pressure on EA
  // billing API), 5 = parallel up to 5 (faster but more likely to trip
  // throttles on large enrollments).
  //
  // Persisted via `usePersistedState` (localStorage) so a power-user who
  // always runs 5 doesn't have to re-select after every reload. The
  // versioned envelope makes future migrations (e.g. add a "10" option)
  // safe — older payloads fall back to the default.
  const [concurrencyChoice, setConcurrencyChoice] = usePersistedState<
    "1" | "3" | "5"
  >("ea-subscription:concurrency", "3", {
    version: 1,
    migrate: (raw) =>
      raw === "1" || raw === "3" || raw === "5" ? raw : undefined,
  });

  // Track which recipient keys should be re-run on the next submit. When
  // empty, performSubmit runs against every effective recipient. When
  // populated (Retry failed flow), only those keys are scheduled — and
  // their previous failure status is preserved as "pending" so the
  // success rows from the prior batch remain visible above.
  const [retryOnlyKeys, setRetryOnlyKeys] = React.useState<Set<string> | null>(
    null,
  );

  const performSubmit = React.useCallback(async () => {
    if (!activeAccount || !formReady) return;
    const myBatchId = ++batchIdRef.current;
    const batchKey = generateBatchId();
    setSubmitting(true);
    setSubmitStartedAt(Date.now());
    setSubmitElapsedSec(0);
    setBatchErrors([]);
    setTokenDiagnostic(null);
    setRoleDiagnostic(null);
    setRoleDiagnosticError(null);
    lastSubmitContextRef.current = null;

    // Either run every selected recipient, or only the ones the operator
    // queued via "Retry failed". In retry mode we preserve the prior
    // statusMap and just reset the targeted rows to `pending`.
    const isRetry = retryOnlyKeys !== null && retryOnlyKeys.size > 0;
    const recipients = isRetry
      ? effectiveRecipients.filter((r) => retryOnlyKeys!.has(r.key))
      : effectiveRecipients;

    // Defensive: if the operator removed every failed recipient between
    // clicking Retry failed and confirming the dialog, just bail out
    // cleanly instead of submitting an empty batch.
    if (recipients.length === 0) {
      setSubmitting(false);
      setConfirmOpen(false);
      setRetryOnlyKeys(null);
      store.addNotification({
        type: "info",
        message:
          "Retry skipped — no failed recipients remain in the current selection.",
      });
      return;
    }

    if (isRetry) {
      setStatusMap((prev) => {
        const next = { ...prev };
        for (const r of recipients) next[r.key] = { state: "pending" };
        return next;
      });
    } else {
      const initial: Record<string, PerRecipientStatus> = {};
      for (const r of recipients) initial[r.key] = { state: "pending" };
      setStatusMap(initial);
    }

    const actor =
      activeAccount.username ||
      activeAccount.name ||
      activeAccount.homeAccountId;

    // Batch-level audit — surfaces "this operator started a batch of N
    // recipients against this enrollment account at this time" even
    // if every per-recipient call subsequently fails. Makes the audit
    // log a complete activity timeline without needing to reconstruct
    // batch context from individual per-recipient records.
    auditLog.record({
      actor,
      action: "create_ea_subscription_batch_start",
      target: confirmLeafName ?? billingScope,
      status: "success",
      details: {
        batchKey,
        recipientCount: recipients.length,
        billingAccount: selectedBillingAccount,
        billingProfile: isEa ? undefined : selectedBillingProfile,
        invoiceSection: isEa ? undefined : selectedInvoiceSection,
        enrollmentAccount: isEa ? selectedEnrollmentAccount : undefined,
        billingScope,
        concurrency: parseInt(concurrencyChoice, 10),
        retryOnly: isRetry,
      },
    });

    // Force a fresh ARM token. The Subscription Alias / EA Subscription
    // Creator role check fails on a token minted BEFORE the role was
    // granted — even with the role correctly assigned now — until a
    // round-trip to Entra ID produces a token whose claims see the new
    // assignment. forceRefresh: true bypasses MSAL's silent cache.
    let token: string;
    try {
      token = await getArmTokenForAccount(
        activeAccount.homeAccountId,
        activeAccount.tenantId,
        { forceRefresh: true },
      );
    } catch (e: unknown) {
      // Stale acquire — a newer batch superseded us. Drop silently.
      if (myBatchId !== batchIdRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      const now = Date.now();
      setStatusMap((prev) => {
        const next = { ...prev };
        const errs: Array<{ key: string; label: string; error: string }> = [];
        for (const r of recipients) {
          next[r.key] = {
            state: "failure",
            error: msg,
            startedAt: now,
            completedAt: now,
          };
          errs.push({ key: r.key, label: r.displayLabel, error: msg });
        }
        setBatchErrors(errs);
        return next;
      });
      auditLog.record({
        actor,
        action: "create_ea_subscription_batch_end",
        target: confirmLeafName ?? billingScope,
        status: "failure",
        error: `Token acquisition failed: ${msg}`,
        details: {
          batchKey,
          recipientCount: recipients.length,
          successCount: 0,
          failureCount: recipients.length,
        },
      });
      setSubmitting(false);
      setConfirmOpen(false);
      setRetryOnlyKeys(null);
      return;
    }

    // Decode the token's claims (no signature verification — diagnostic
    // display only). The tid / oid / aud surface in the failure card so
    // the user can confirm the token is from the expected tenant + identity
    // and was issued for ARM. Set once per submit attempt; consumed by the
    // batchErrors UI when a 401 is observed.
    const tokenClaims = decodeJwtClaimsUnsafe(token);
    const callerOid = tokenClaims ? String(tokenClaims.oid ?? "") : "";
    setTokenDiagnostic(
      tokenClaims
        ? {
            tid: String(tokenClaims.tid ?? ""),
            oid: callerOid,
            upn: String(
              tokenClaims.upn ??
                tokenClaims.preferred_username ??
                tokenClaims.unique_name ??
                "",
            ),
            aud: String(tokenClaims.aud ?? ""),
            issuedAt:
              typeof tokenClaims.iat === "number"
                ? new Date((tokenClaims.iat as number) * 1000).toISOString()
                : "",
          }
        : null,
    );
    // Stash the (token, billingScope, principalId) tuple so the role
    // diagnostic can run when a 401 lands without re-prompting the user
    // for a fresh token.
    if (callerOid && billingScope) {
      lastSubmitContextRef.current = {
        token,
        billingScope,
        principalId: callerOid,
      };
    }

    const concurrency = parseInt(concurrencyChoice, 10) || 3;
    const queue = [...recipients];
    const localErrors: Array<{ key: string; label: string; error: string }> =
      [];
    const successfulKeys: string[] = [];

    // Race-aware setStatusMap: silently no-op if a newer batch has
    // superseded this one. The recipient `key` may have been recycled
    // by the new batch with a different intended state.
    const safeSet = (
      key: string,
      mut: (prev: PerRecipientStatus | undefined) => PerRecipientStatus,
    ): void => {
      if (myBatchId !== batchIdRef.current) return;
      setStatusMap((prev) => ({ ...prev, [key]: mut(prev[key]) }));
    };

    const runOne = async (r: Recipient) => {
      const startedAt = Date.now();
      safeSet(r.key, () => ({ state: "running", startedAt }));
      // For multi-recipient batches we always re-derive a unique alias per
      // recipient to keep aliases stable+predictable. For a single
      // recipient we honour the user-edited alias from the form.
      let alias =
        recipients.length === 1 && form.getValues("aliasName")
          ? form.getValues("aliasName")
          : deriveAlias(r);
      if (!isValidAlias(alias)) {
        alias = `sub-${randomSuffix(5)}-${Date.now().toString(36).slice(-4)}`;
      }
      const displayName =
        recipients.length === 1 && form.getValues("displayName")
          ? form.getValues("displayName")
          : deriveDisplayName(r);
      const req: CreateSubscriptionRequest = {
        aliasName: alias,
        displayName,
        billingScope,
        workload: "Production",
        subscriptionTenantId: r.tenantId,
        subscriptionOwnerId: r.ownerObjectId,
        // Idempotency: the alias name itself is the natural idempotency
        // key for the Subscription Alias API (a second PUT with the
        // same alias against the same scope is a no-op when the first
        // succeeded). We additionally tag the new subscription with
        // the batch key + recipient key so this provisioning event is
        // discoverable via Azure Activity Log and our local audit log.
        // Tags persist on the subscription resource indefinitely.
        tags: {
          "ea-batch-key": batchKey,
          "ea-recipient-key": r.key.slice(0, 64),
          "provisioned-by": "azurebatchmanager",
        },
      };
      try {
        const result = await createEaSubscription(req, token);
        const completedAt = Date.now();
        if (myBatchId !== batchIdRef.current) {
          // Stale — the operator kicked a newer batch; don't record.
          return;
        }
        safeSet(r.key, () => ({
          state: "success",
          subscriptionId: result.subscriptionId,
          aliasName: result.aliasName,
          startedAt,
          completedAt,
        }));
        successfulKeys.push(r.key);
        auditLog.record({
          actor,
          action: "create_ea_subscription",
          target: r.displayLabel,
          status: "success",
          details: {
            batchKey,
            aliasName: result.aliasName,
            subscriptionId: result.subscriptionId,
            billingScope,
            workload: "Production",
            billingAccount: selectedBillingAccount,
            billingProfile: isEa ? undefined : selectedBillingProfile,
            invoiceSection: isEa ? undefined : selectedInvoiceSection,
            enrollmentAccount: isEa ? selectedEnrollmentAccount : undefined,
            subscriptionTenantId: r.tenantId,
            subscriptionOwnerId: r.ownerObjectId,
            recipientLabel: r.displayLabel,
            recipientSource: r.source,
            elapsedMs: completedAt - startedAt,
          },
        });
        store.addNotification({
          type: "success",
          message: result.subscriptionId
            ? `Subscription provisioned for ${r.displayLabel} (id: ${result.subscriptionId})`
            : `Subscription alias '${result.aliasName}' provisioned for ${r.displayLabel}.`,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const completedAt = Date.now();
        if (myBatchId !== batchIdRef.current) return;
        safeSet(r.key, () => ({
          state: "failure",
          error: msg,
          startedAt,
          completedAt,
        }));
        localErrors.push({ key: r.key, label: r.displayLabel, error: msg });
        auditLog.record({
          actor,
          action: "create_ea_subscription",
          target: r.displayLabel,
          status: "failure",
          error: msg,
          details: {
            batchKey,
            aliasName: alias,
            billingScope,
            workload: "Production",
            billingAccount: selectedBillingAccount,
            billingProfile: isEa ? undefined : selectedBillingProfile,
            invoiceSection: isEa ? undefined : selectedInvoiceSection,
            enrollmentAccount: isEa ? selectedEnrollmentAccount : undefined,
            subscriptionTenantId: r.tenantId,
            subscriptionOwnerId: r.ownerObjectId,
            recipientLabel: r.displayLabel,
            recipientSource: r.source,
            elapsedMs: completedAt - startedAt,
            errorCategory: categorizeError(msg).label,
          },
        });
      }
    };

    const workers: Promise<void>[] = [];
    const next = async () => {
      while (queue.length > 0) {
        // Cooperative cancellation — if a newer batch is in flight, drain
        // the queue without making any more API calls. Already-running
        // calls finish (Azure's contract is irreversible once PUT lands).
        if (myBatchId !== batchIdRef.current) {
          queue.length = 0;
          break;
        }
        const r = queue.shift();
        if (!r) break;
        await runOne(r);
      }
    };
    for (let i = 0; i < Math.min(concurrency, recipients.length); i += 1) {
      workers.push(next());
    }
    await Promise.allSettled(workers);

    // Stale — the operator kicked a newer batch; abort any cleanup.
    if (myBatchId !== batchIdRef.current) return;

    if (localErrors.length > 0) {
      setBatchErrors(localErrors);
      store.addNotification({
        type: "error",
        message: `Failed to provision ${localErrors.length} of ${recipients.length} subscription(s). See details on page.`,
      });
    }

    if (successfulKeys.length > 0 && !selfAssign) {
      const remaining = form
        .getValues("recipients")
        .filter((r) => !successfulKeys.includes(r.key));
      form.setValue("recipients", remaining, { shouldValidate: true });
    }

    auditLog.record({
      actor,
      action: "create_ea_subscription_batch_end",
      target: confirmLeafName ?? billingScope,
      status: localErrors.length === 0 ? "success" : "failure",
      details: {
        batchKey,
        recipientCount: recipients.length,
        successCount: successfulKeys.length,
        failureCount: localErrors.length,
        elapsedMs: Date.now() - (submitStartedAt ?? Date.now()),
      },
    });

    setSubmitting(false);
    setConfirmOpen(false);
    setRetryOnlyKeys(null);
  }, [
    activeAccount,
    formReady,
    effectiveRecipients,
    billingScope,
    confirmLeafName,
    isEa,
    selectedBillingAccount,
    selectedBillingProfile,
    selectedInvoiceSection,
    selectedEnrollmentAccount,
    selfAssign,
    store,
    form,
    concurrencyChoice,
    retryOnlyKeys,
    submitStartedAt,
  ]);

  // Failure summary stats for the post-batch summary chip strip. Computed
  // off the live statusMap (not batchErrors) so the numbers stay accurate
  // mid-batch as rows transition pending → running → success/failure.
  const failureCount = React.useMemo(
    () =>
      Object.values(statusMap).filter((s) => s.state === "failure").length,
    [statusMap],
  );
  const runningCount = React.useMemo(
    () =>
      Object.values(statusMap).filter((s) => s.state === "running").length,
    [statusMap],
  );
  const pendingCount = React.useMemo(
    () => Object.values(statusMap).filter((s) => s.state === "pending").length,
    [statusMap],
  );

  // Median / max per-recipient elapsed time across the most recent batch.
  // Surfaced in the summary so the operator gets a feel for whether the
  // batch was throttle-bound, capacity-bound, or smooth.
  const elapsedStats = React.useMemo(() => {
    const samples: number[] = [];
    for (const s of Object.values(statusMap)) {
      if (s.state === "success" || s.state === "failure") {
        samples.push((s.completedAt - s.startedAt) / 1000);
      }
    }
    if (samples.length === 0)
      return { median: 0, max: 0, count: 0, avg: 0 };
    samples.sort((a, b) => a - b);
    const median =
      samples.length % 2 === 0
        ? (samples[samples.length / 2 - 1]! + samples[samples.length / 2]!) /
          2
        : samples[Math.floor(samples.length / 2)]!;
    const max = samples[samples.length - 1]!;
    const avg = samples.reduce((acc, v) => acc + v, 0) / samples.length;
    return { median, max, count: samples.length, avg };
  }, [statusMap]);

  // Failure rows the user is allowed to retry (subset of effectiveRecipients
  // with state === "failure" in the live statusMap). Keys are sourced from
  // effectiveRecipients so we never offer to retry a recipient the user
  // already removed.
  const failedKeys = React.useMemo<string[]>(() => {
    const out: string[] = [];
    for (const r of effectiveRecipients) {
      const s = statusMap[r.key];
      if (s?.state === "failure") out.push(r.key);
    }
    return out;
  }, [effectiveRecipients, statusMap]);

  const handleRetryFailed = React.useCallback(() => {
    if (failedKeys.length === 0 || submitting) return;
    setRetryOnlyKeys(new Set(failedKeys));
    setConfirmOpen(true);
  }, [failedKeys, submitting]);

  // Export the current batch (success + failure rows) to CSV / JSON. The
  // CSV is intentionally Excel-friendly: every row is flat, all GUIDs are
  // strings (so they don't lose precision), and error text is single-cell.
  const handleExportResults = React.useCallback(
    (format: "csv" | "json") => {
      const rows = effectiveRecipients
        .map((r) => {
          const s = statusMap[r.key];
          if (!s) return null;
          if (s.state === "pending" || s.state === "running") return null;
          const elapsedSec =
            s.state === "success" || s.state === "failure"
              ? (s.completedAt - s.startedAt) / 1000
              : 0;
          return {
            recipient: r.displayLabel,
            upn: r.upn ?? "",
            tenantId: r.tenantId,
            tenantLabel: r.tenantLabel ?? "",
            ownerObjectId: r.ownerObjectId,
            source: r.source,
            state: s.state,
            subscriptionId:
              s.state === "success" ? (s.subscriptionId ?? "") : "",
            aliasName: s.state === "success" ? s.aliasName : "",
            error: s.state === "failure" ? s.error : "",
            errorCategory:
              s.state === "failure" ? categorizeError(s.error).label : "",
            elapsedSeconds: Math.round(elapsedSec * 10) / 10,
            startedAtIso: new Date(s.startedAt).toISOString(),
            completedAtIso: new Date(s.completedAt).toISOString(),
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const baseFilename = `ea-subscription-batch-${stamp}`;

      if (format === "csv") {
        const headers = [
          "recipient",
          "upn",
          "tenantId",
          "tenantLabel",
          "ownerObjectId",
          "source",
          "state",
          "subscriptionId",
          "aliasName",
          "error",
          "errorCategory",
          "elapsedSeconds",
          "startedAtIso",
          "completedAtIso",
        ];
        const csvRows = rows.map((r) => [
          r.recipient,
          r.upn,
          r.tenantId,
          r.tenantLabel,
          r.ownerObjectId,
          r.source,
          r.state,
          r.subscriptionId,
          r.aliasName,
          r.error,
          r.errorCategory,
          r.elapsedSeconds,
          r.startedAtIso,
          r.completedAtIso,
        ]);
        downloadCsv(`${baseFilename}.csv`, headers, csvRows);
      } else {
        downloadJson(`${baseFilename}.json`, {
          exportedAt: new Date().toISOString(),
          billingScope,
          billingAccount: selectedBillingAccount,
          billingAccountDisplay:
            selectedBillingAccountObj?.displayName ?? null,
          enrollmentAccount: isEa ? selectedEnrollmentAccount : null,
          enrollmentAccountDisplay: isEa
            ? (selectedEnrollmentAccountObj?.displayName ?? null)
            : null,
          billingProfile: isEa ? null : selectedBillingProfile,
          invoiceSection: isEa ? null : selectedInvoiceSection,
          agreementType: isEa ? "EnterpriseAgreement" : "MicrosoftCustomerAgreement",
          totalRecipients: rows.length,
          successCount: rows.filter((r) => r.state === "success").length,
          failureCount: rows.filter((r) => r.state === "failure").length,
          results: rows,
        });
      }
      store.addNotification({
        type: "success",
        message: `Exported ${rows.length} result row${rows.length === 1 ? "" : "s"} as ${format.toUpperCase()}.`,
      });
      auditLog.record({
        actor: activeAccount?.username ?? "anonymous",
        action: "ea_subscription_export_results",
        target: `${rows.length} rows`,
        status: "success",
        details: { format, rowCount: rows.length, billingScope },
      });
    },
    [
      effectiveRecipients,
      statusMap,
      billingScope,
      selectedBillingAccount,
      selectedBillingAccountObj,
      selectedEnrollmentAccount,
      selectedEnrollmentAccountObj,
      selectedBillingProfile,
      selectedInvoiceSection,
      isEa,
      store,
      activeAccount,
    ],
  );

  // Recipient picker filters — operator-facing facet controls so a 500-
  // user tenant list is navigable. The Command primitive already handles
  // fuzzy match on the search box; these chips narrow the candidate set
  // BEFORE the fuzzy search runs.
  const [pickerSourceFilter, setPickerSourceFilter] = React.useState<
    "all" | "web-account" | "tenant-user"
  >("all");
  const [pickerTenantFilter, setPickerTenantFilter] =
    React.useState<string>("__all__");
  const [pickerEnabledOnly, setPickerEnabledOnly] = React.useState(true);

  // Distinct tenant facets across both web-account + tenant-user recipient
  // sources, sorted alphabetically by displayed label.
  const pickerTenantFacets = React.useMemo<
    Array<{ id: string; label: string; count: number }>
  >(() => {
    const counts = new Map<string, { label: string; count: number }>();
    const visit = (r: Recipient) => {
      if (pickerSourceFilter !== "all" && r.source !== pickerSourceFilter)
        return;
      const cur = counts.get(r.tenantId);
      if (cur) {
        cur.count += 1;
      } else {
        counts.set(r.tenantId, {
          label: r.tenantLabel ?? truncateMiddle(r.tenantId, 8, 4),
          count: 1,
        });
      }
    };
    for (const r of webAccountRecipients) visit(r);
    for (const r of tenantUserRecipients) visit(r);
    const out: Array<{ id: string; label: string; count: number }> = [];
    for (const [id, v] of counts) {
      out.push({ id, label: v.label, count: v.count });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }, [
    webAccountRecipients,
    tenantUserRecipients,
    pickerSourceFilter,
  ]);

  // Apply the chip filters; returns the recipient subset the picker should
  // render. Falsy filter values pass everything through.
  const applyPickerFilters = React.useCallback(
    (rs: Recipient[]) =>
      rs.filter((r) => {
        if (pickerSourceFilter !== "all" && r.source !== pickerSourceFilter)
          return false;
        if (
          pickerTenantFilter !== "__all__" &&
          r.tenantId !== pickerTenantFilter
        )
          return false;
        if (pickerEnabledOnly && r.enabled === false) return false;
        return true;
      }),
    [pickerSourceFilter, pickerTenantFilter, pickerEnabledOnly],
  );

  // React to global tenant switches fired from azure-accounts-page or the
  // shared header TenantSwitcher: if the operator switched to an account
  // that's EA-capable on this page, mirror the selection here so the form
  // and recipient picker stay aligned with the rest of the app.
  useTenantChange(undefined, (detail) => {
    const candidate = detail.homeAccountId;
    if (!eaAccounts.some((a) => a.homeAccountId === candidate)) return;
    if (activeKey === candidate) return;
    handleSelectAccount(candidate);
  });

  // Hotkey: Ctrl+Enter (Cmd+Enter on macOS) opens the create-subscription
  // confirmation when the form is ready. Skips when the confirm dialog
  // is already open or a batch is running so it can't double-fire.
  useShortcut(
    "Mod+Enter",
    () => {
      if (submitting || confirmOpen) return;
      if (!formReady) return;
      setConfirmOpen(true);
    },
    { enabled: true, allowInInputs: true, preventDefault: true },
  );

  // Hotkey: Escape cancels the confirm dialog (but never aborts an in-
  // flight batch — Azure has already committed the in-flight PUTs). When
  // a retry is queued, also clears the retry-only key set.
  useShortcut(
    "Escape",
    () => {
      if (submitting) return;
      if (confirmOpen) {
        setConfirmOpen(false);
        setRetryOnlyKeys(null);
      }
    },
    { enabled: confirmOpen, allowInInputs: true, preventDefault: false },
  );

  if (discoveringEa && eaAccounts.length === 0) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <PageHeader
          title="Create EA Subscription"
          description="Provision a new Azure subscription under your Enterprise Agreement enrollment."
        />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Loader2
                className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none"
                aria-hidden
              />
              Probing EA billing capability
            </CardTitle>
            <CardDescription>
              Checking each signed-in account for Enterprise Agreement access
              via the billing API. This usually takes a few seconds.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SkeletonLoader variant="form" rows={3} />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (eaAccounts.length === 0) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <PageHeader
          title="Create EA Subscription"
          description="Provision a new Azure subscription under your Enterprise Agreement enrollment."
        />
        <Card className="border-warning/40 bg-warning/5 transition-colors duration-200 ease-out">
          <CardHeader className="flex flex-row items-start gap-3 space-y-0">
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning"
            >
              <ShieldAlert className="h-4 w-4" aria-hidden />
            </span>
            <div className="flex flex-col gap-1">
              <CardTitle className="text-sm">
                No EA-capable account detected
              </CardTitle>
              <CardDescription>
                None of your signed-in accounts have an Enterprise Agreement or
                MCA billing role we can use to provision subscriptions.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Sign in with an account that holds one of these roles:
            </p>
            <ul className="ml-2 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">
                  Enterprise Administrator
                </span>{" "}
                — full EA portal control
              </li>
              <li>
                <span className="font-medium text-foreground">
                  Department Administrator
                </span>{" "}
                — provisions inside one department
              </li>
              <li>
                <span className="font-medium text-foreground">
                  EA Account Owner
                </span>{" "}
                — provisions inside one enrollment account
              </li>
              <li>
                <span className="font-medium text-foreground">
                  EA Subscription Creator
                </span>{" "}
                — RBAC role on the enrollment account
              </li>
            </ul>
            {onNavigate && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={() => onNavigate("azure-accounts")}
                  aria-label="Sign in with an EA-billing-owner account"
                >
                  <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
                  Sign in with EA-billing-owner account
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const confirmRecipientsPreview = effectiveRecipients.slice(0, 10);
  const confirmRecipientsExtra = Math.max(
    0,
    effectiveRecipients.length - confirmRecipientsPreview.length,
  );

  const totalRecipients = effectiveRecipients.length;

  // Build the full recipient catalog for the Command picker. Each entry
  // gets an opaque `value` string (used by cmdk for fuzzy matching) that
  // mixes display text + UPN + tenant + GUIDs so users can search by any.
  const renderRecipientItem = (r: Recipient) => {
    const disabled = r.enabled === false;
    const checked = isSelected(r);
    const cmdValue = [
      r.displayLabel,
      r.upn ?? "",
      r.tenantLabel ?? "",
      r.tenantId,
      r.ownerObjectId,
    ].join(" ");
    return (
      <CommandItem
        key={r.key}
        value={cmdValue}
        disabled={disabled}
        onSelect={() => toggleRecipient(r, !checked)}
        className={cn(disabled && "opacity-70")}
      >
        <span
          aria-hidden
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
            checked
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background",
          )}
        >
          {checked && <Check className="h-3 w-3" aria-hidden />}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm">{r.displayLabel}</span>
          <span className="truncate text-2xs text-muted-foreground">
            {r.upn ? (
              r.upn
            ) : (
              <code className="font-mono">
                {truncateMiddle(r.ownerObjectId, 8, 4)}
              </code>
            )}
            {r.tenantLabel ? ` -- ${r.tenantLabel}` : ""}
          </span>
        </span>
        {disabled && (
          <Badge variant="secondary" className="ml-auto">
            disabled
          </Badge>
        )}
      </CommandItem>
    );
  };

  // Successful results that should be celebrated in the result panel —
  // computed up here so the JSX below can spotlight them above the
  // failure list.
  const successResults = effectiveRecipients
    .map((r) => {
      const s = statusMap[r.key];
      if (s && s.state === "success") {
        return { recipient: r, status: s };
      }
      return null;
    })
    .filter(
      (
        x,
      ): x is {
        recipient: Recipient;
        status: Extract<PerRecipientStatus, { state: "success" }>;
      } => Boolean(x),
    );

  // Screen-reader-only live announcement of batch progress. Distinct from
  // the visible polite-live region inside the Provisioning Summary so
  // milestones (start / each-completed / done) reach assistive tech
  // without re-announcing the entire summary card on every re-render.
  const srStatusMessage = React.useMemo(() => {
    if (submitting) {
      if (totalInFlight === 0) return "Batch starting.";
      return `Provisioning subscriptions: ${completedCount} of ${totalInFlight} complete.`;
    }
    if (totalInFlight > 0 && completedCount === totalInFlight) {
      const failCount = totalInFlight - successResults.length;
      if (failCount === 0) {
        return `Batch complete. All ${totalInFlight} subscriptions provisioned successfully.`;
      }
      return `Batch complete with ${failCount} failure${failCount === 1 ? "" : "s"} of ${totalInFlight}.`;
    }
    return "";
  }, [submitting, totalInFlight, completedCount, successResults.length]);

  return (
    <div className="flex flex-col gap-4 py-4">
      {/* Off-screen ARIA-live announcer for batch progress. The visible
          status card is also polite-live; this region exists so screen
          readers get a short, structured milestone string instead of the
          entire summary card on each re-render. `sr-only` keeps it
          invisible. */}
      <div
        aria-live="polite"
        aria-atomic="true"
        role="status"
        className="sr-only"
      >
        {srStatusMessage}
      </div>
      <PageHeader
        title="Create EA Subscription"
        description="Provision a new Azure subscription under your Enterprise Agreement enrollment."
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
        <Select value={activeKey} onValueChange={handleSelectAccount}>
          <SelectTrigger
            className="h-8 w-72 text-xs"
            aria-label="Select EA-capable account"
          >
            <SelectValue placeholder="Select EA-capable account" />
          </SelectTrigger>
          <SelectContent>
            {eaAccounts.map((a) => (
              <SelectItem key={a.homeAccountId} value={a.homeAccountId}>
                <span className="flex items-center gap-2 truncate">
                  <BadgeCheck
                    className="h-3.5 w-3.5 shrink-0 text-success"
                    aria-hidden
                  />
                  <span className="truncate">{a.name || a.username}</span>
                  <span className="text-muted-foreground">
                    ({a.billingAccountCount} EA)
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PageHeader>

      {/* Plain-English explainer. The page is the only entry point for
          irreversible billing-scope work, so we spell out the flow
          before any inputs. */}
      <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-xs text-foreground transition-colors duration-200 ease-out">
        <span
          aria-hidden
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary"
        >
          <Info className="h-3 w-3" aria-hidden />
        </span>
        <div className="flex flex-col gap-1">
          <p>
            <span className="font-medium">EA Sub Creation</span> provisions a
            brand-new Azure subscription under your Enterprise Agreement (or
            MCA) billing scope, one per recipient. You pick the billing path,
            choose who owns each new subscription, and confirm. We call the
            Subscription Alias API and poll until the new GUID is live.
          </p>
          <p className="text-muted-foreground">
            <span className="font-medium text-warning-foreground">
              Submission is irreversible
            </span>{" "}
            — once a subscription is provisioned, only an EA admin can cancel
            or transfer it from the EA portal.
          </p>
        </div>
      </div>

      {/*
        Pending acceptance — incoming-side companion to the cross-tenant
        creation flow above. When THIS WebUI is run in the destination
        tenant by the invited owner, paste the subscriptionId here to
        check status and accept ownership inline. Token is acquired from
        the active EA account (which must be in the destination tenant
        per Microsoft's documented requirement: the accept-ownership
        endpoint requires a destination-tenant token).
      */}
      {activeAccount && (
        <AcceptOwnershipPanel account={activeAccount} store={store} />
      )}

      {activeAccount ? (
        <div className="flex flex-col gap-4">
          {/* Billing-scope hierarchy crumb — appears once any leaf in the
              cascade is picked, so users can tell at a glance what path
              they're about to provision under. */}
          {(selectedBillingAccountObj ||
            selectedBillingProfileObj ||
            selectedInvoiceSectionObj ||
            selectedEnrollmentAccountObj) && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface-sunken px-3 py-1.5 text-2xs text-muted-foreground transition-colors duration-200 ease-out">
              <span className="font-medium uppercase tracking-wider">
                Scope:
              </span>
              {selectedBillingAccountObj && (
                <span className="flex items-center gap-1">
                  <Building2 className="h-3 w-3" aria-hidden />
                  <span className="text-foreground">
                    {selectedBillingAccountObj.displayName}
                  </span>
                </span>
              )}
              {isEa && selectedEnrollmentAccountObj && (
                <>
                  <ChevronRight className="h-3 w-3" aria-hidden />
                  <span className="flex items-center gap-1">
                    <IdCard className="h-3 w-3" aria-hidden />
                    <span className="text-foreground">
                      {selectedEnrollmentAccountObj.displayName}
                    </span>
                  </span>
                </>
              )}
              {!isEa && selectedBillingProfileObj && (
                <>
                  <ChevronRight className="h-3 w-3" aria-hidden />
                  <span className="flex items-center gap-1">
                    <Wallet className="h-3 w-3" aria-hidden />
                    <span className="text-foreground">
                      {selectedBillingProfileObj.displayName}
                    </span>
                  </span>
                </>
              )}
              {!isEa && selectedInvoiceSectionObj && (
                <>
                  <ChevronRight className="h-3 w-3" aria-hidden />
                  <span className="flex items-center gap-1">
                    <Receipt className="h-3 w-3" aria-hidden />
                    <span className="text-foreground">
                      {selectedInvoiceSectionObj.displayName}
                    </span>
                  </span>
                </>
              )}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Building2 className="h-4 w-4 text-primary" aria-hidden />
                Billing Account
              </CardTitle>
              <CardDescription>
                The top-level Enterprise Agreement (or MCA) enrollment.
                Subscriptions live under one of these.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {loadingBa ? (
                <SkeletonLoader variant="list" rows={2} />
              ) : errBa ? (
                <ErrorState
                  size="compact"
                  message="Failed to load billing accounts."
                  detail={errBa}
                  onRetry={loadBillingAccounts}
                />
              ) : billingAccounts.length === 0 ? (
                <EmptyState
                  icon={Building2}
                  title="No EA billing accounts visible"
                  description="The signed-in account has no Enterprise Agreement or MCA enrollment we can read. Make sure you're using an EA admin / Account Owner identity."
                />
              ) : (
                <div
                  role="radiogroup"
                  aria-label="Billing account"
                  className="flex flex-col gap-1.5"
                >
                  {billingAccounts.map((ba) => (
                    <ScopeCard
                      key={ba.name}
                      selected={selectedBillingAccount === ba.name}
                      onSelect={() => setSelectedBillingAccount(ba.name)}
                      title={ba.displayName}
                      subtitle={ba.name}
                      badge={
                        ba.agreementType ? (
                          <Badge
                            variant="secondary"
                            className="text-2xs font-normal"
                          >
                            {ba.agreementType === "EnterpriseAgreement"
                              ? "EA"
                              : ba.agreementType === "MicrosoftCustomerAgreement"
                                ? "MCA"
                                : ba.agreementType}
                          </Badge>
                        ) : undefined
                      }
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {selectedBillingAccount &&
            (isEa ? (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <IdCard className="h-4 w-4 text-primary" aria-hidden />
                    Enrollment Account
                  </CardTitle>
                  <CardDescription>
                    The enrollment account that owns the new subscription.
                    Costs are charged here.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {loadingEnrollmentAccounts ? (
                    <SkeletonLoader variant="list" rows={2} />
                  ) : enrollmentAccountsError ? (
                    <ErrorState
                      size="compact"
                      message="Failed to load enrollment accounts."
                      detail={enrollmentAccountsError}
                      onRetry={loadEnrollmentAccounts}
                    />
                  ) : enrollmentAccounts.length === 0 ? (
                    <EmptyState
                      icon={IdCard}
                      title="No enrollment accounts here"
                      description="This EA enrollment does not expose any enrollment accounts to your principal. Pick a different billing account."
                    />
                  ) : (
                    <div
                      role="radiogroup"
                      aria-label="Enrollment account"
                      className="flex flex-col gap-1.5"
                    >
                      {enrollmentAccounts.map((ea) => (
                        <ScopeCard
                          key={ea.name}
                          selected={selectedEnrollmentAccount === ea.name}
                          onSelect={() =>
                            setSelectedEnrollmentAccount(ea.name)
                          }
                          title={ea.displayName}
                          subtitle={ea.name}
                          meta={
                            ea.accountOwner || ea.costCenter ? (
                              <>
                                {ea.accountOwner && (
                                  <span>
                                    <span className="font-medium">Owner:</span>{" "}
                                    <span className="text-foreground">
                                      {ea.accountOwner}
                                    </span>
                                  </span>
                                )}
                                {ea.costCenter && (
                                  <span>
                                    <span className="font-medium">
                                      Cost Center:
                                    </span>{" "}
                                    <span className="text-foreground">
                                      {ea.costCenter}
                                    </span>
                                  </span>
                                )}
                              </>
                            ) : undefined
                          }
                        />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Wallet className="h-4 w-4 text-primary" aria-hidden />
                      Billing Profile
                    </CardTitle>
                    <CardDescription>
                      Cost-tracking profile within the MCA enrollment.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    {loadingBp ? (
                      <SkeletonLoader variant="list" rows={2} />
                    ) : errBp ? (
                      <ErrorState
                        size="compact"
                        message="Failed to load billing profiles."
                        detail={errBp}
                        onRetry={loadBillingProfiles}
                      />
                    ) : billingProfiles.length === 0 ? (
                      <EmptyState
                        icon={Wallet}
                        title="No billing profiles here"
                        description="This billing account has no profiles your principal can see. Pick a different billing account."
                      />
                    ) : (
                      <div
                        role="radiogroup"
                        aria-label="Billing profile"
                        className="flex flex-col gap-1.5"
                      >
                        {billingProfiles.map((bp) => (
                          <ScopeCard
                            key={bp.name}
                            selected={selectedBillingProfile === bp.name}
                            onSelect={() =>
                              setSelectedBillingProfile(bp.name)
                            }
                            title={bp.displayName}
                            subtitle={bp.name}
                          />
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {selectedBillingProfile && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <Receipt className="h-4 w-4 text-primary" aria-hidden />
                        Invoice Section
                      </CardTitle>
                      <CardDescription>
                        Where charges for this subscription will be invoiced.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2">
                      {loadingIs ? (
                        <SkeletonLoader variant="list" rows={2} />
                      ) : errIs ? (
                        <ErrorState
                          size="compact"
                          message="Failed to load invoice sections."
                          detail={errIs}
                          onRetry={loadInvoiceSections}
                        />
                      ) : invoiceSections.length === 0 ? (
                        <EmptyState
                          icon={Receipt}
                          title="No invoice sections here"
                          description="This billing profile has no invoice sections to provision under."
                        />
                      ) : (
                        <div
                          role="radiogroup"
                          aria-label="Invoice section"
                          className="flex flex-col gap-1.5"
                        >
                          {invoiceSections.map((is) => (
                            <ScopeCard
                              key={is.name}
                              selected={selectedInvoiceSection === is.name}
                              onSelect={() =>
                                setSelectedInvoiceSection(is.name)
                              }
                              title={is.displayName}
                              subtitle={is.name}
                            />
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}
              </>
            ))}

          {leafSelectionReady && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Users className="h-4 w-4 text-primary" aria-hidden />
                  Recipients
                </CardTitle>
                <CardDescription>
                  Pick one or more identities. Each selected recipient becomes
                  its own subscription, provisioned in parallel.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Controller
                  control={form.control}
                  name="selfAssign"
                  render={({ field }) => (
                    <div className="flex items-start gap-3">
                      <Switch
                        id="ea-self-assign"
                        checked={field.value}
                        onCheckedChange={(v) => field.onChange(Boolean(v))}
                        aria-label="Assign to me (the EA billing account)"
                      />
                      <div className="flex flex-col gap-0.5">
                        <Label
                          htmlFor="ea-self-assign"
                          className="cursor-pointer text-sm"
                        >
                          Assign to me (the EA billing account)
                        </Label>
                        <p className="text-2xs text-muted-foreground">
                          When ON, hides the picker and provisions exactly one
                          subscription owned by the signed-in EA principal in
                          their home tenant. Default is OFF (multi-recipient).
                        </p>
                      </div>
                    </div>
                  )}
                />

                {!selfAssign && (
                  <Controller
                    control={form.control}
                    name="recipients"
                    render={({ fieldState }) => (
                      <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <Label htmlFor="ea-recipient-picker">
                              Subscription Owners
                            </Label>
                            {selectedRecipients.length > 0 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={handleClearRecipients}
                                aria-label="Clear all recipients"
                                className="gap-1 text-2xs text-muted-foreground"
                              >
                                <Trash2 className="h-3 w-3" aria-hidden />
                                Clear all
                              </Button>
                            )}
                          </div>
                          <Popover
                            open={pickerOpen}
                            onOpenChange={setPickerOpen}
                          >
                            <PopoverTrigger asChild>
                              <Button
                                id="ea-recipient-picker"
                                type="button"
                                variant="outline"
                                role="combobox"
                                className="justify-between transition-colors duration-200 ease-out hover:border-primary/60"
                                aria-haspopup="listbox"
                                aria-expanded={pickerOpen}
                                aria-label="Open recipient picker"
                              >
                                <span className="flex items-center gap-2">
                                  <Users
                                    className="h-3.5 w-3.5"
                                    aria-hidden
                                  />
                                  {selectedRecipients.length === 0
                                    ? "Choose recipients"
                                    : `${selectedRecipients.length} selected`}
                                </span>
                                <ChevronsUpDown
                                  className="h-3.5 w-3.5 opacity-60"
                                  aria-hidden
                                />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent
                              align="start"
                              sideOffset={4}
                              className="w-[32rem] p-0"
                            >
                              {/* Facet chips — narrow the candidate set
                                  BEFORE cmdk fuzzy-search runs. Lets a
                                  500-user tenant list stay scannable. */}
                              <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                                    <Filter
                                      className="h-3 w-3"
                                      aria-hidden
                                    />
                                    Filters
                                  </span>
                                  <Label
                                    htmlFor="ea-picker-enabled-only"
                                    className="flex cursor-pointer items-center gap-1.5 text-2xs"
                                  >
                                    <Switch
                                      id="ea-picker-enabled-only"
                                      checked={pickerEnabledOnly}
                                      onCheckedChange={(v) =>
                                        setPickerEnabledOnly(Boolean(v))
                                      }
                                      aria-label="Show only enabled accounts"
                                    />
                                    Enabled only
                                  </Label>
                                </div>
                                <div className="flex flex-wrap items-center gap-1">
                                  {(
                                    [
                                      { v: "all", l: "All sources" },
                                      { v: "web-account", l: "Signed-in" },
                                      { v: "tenant-user", l: "Tenant users" },
                                    ] as const
                                  ).map((opt) => (
                                    <button
                                      key={opt.v}
                                      type="button"
                                      onClick={() =>
                                        setPickerSourceFilter(opt.v)
                                      }
                                      className={cn(
                                        "rounded-full px-2 py-0.5 text-2xs transition-colors duration-150",
                                        pickerSourceFilter === opt.v
                                          ? "bg-primary text-primary-foreground"
                                          : "bg-muted text-muted-foreground hover:bg-muted/80",
                                      )}
                                      aria-pressed={
                                        pickerSourceFilter === opt.v
                                      }
                                    >
                                      {opt.l}
                                    </button>
                                  ))}
                                </div>
                                {pickerTenantFacets.length > 1 && (
                                  <div className="flex flex-wrap items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setPickerTenantFilter("__all__")
                                      }
                                      className={cn(
                                        "rounded-full px-2 py-0.5 text-2xs transition-colors duration-150",
                                        pickerTenantFilter === "__all__"
                                          ? "bg-primary text-primary-foreground"
                                          : "bg-muted text-muted-foreground hover:bg-muted/80",
                                      )}
                                      aria-pressed={
                                        pickerTenantFilter === "__all__"
                                      }
                                    >
                                      All tenants
                                    </button>
                                    {pickerTenantFacets.map((t) => (
                                      <button
                                        key={t.id}
                                        type="button"
                                        onClick={() =>
                                          setPickerTenantFilter(t.id)
                                        }
                                        className={cn(
                                          "rounded-full px-2 py-0.5 text-2xs transition-colors duration-150",
                                          pickerTenantFilter === t.id
                                            ? "bg-primary text-primary-foreground"
                                            : "bg-muted text-muted-foreground hover:bg-muted/80",
                                        )}
                                        aria-pressed={
                                          pickerTenantFilter === t.id
                                        }
                                        title={`${t.label} (${t.count})`}
                                      >
                                        {t.label}{" "}
                                        <span className="opacity-70">
                                          ({t.count})
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <Command label="Select subscription owners">
                                <CommandInput placeholder="Search by name, UPN, tenant, or GUID..." />
                                <CommandList className="max-h-80">
                                  <CommandEmpty>
                                    No recipients match your filters /
                                    search. Loosen the chips above, or use
                                    the Paste / Bulk paste panels below to
                                    add (tenant, object) pairs manually.
                                  </CommandEmpty>
                                  {applyPickerFilters(webAccountRecipients)
                                    .length > 0 && (
                                    <CommandGroup heading="Signed-in accounts">
                                      {applyPickerFilters(
                                        webAccountRecipients,
                                      ).map((r) => renderRecipientItem(r))}
                                    </CommandGroup>
                                  )}
                                  {tenantUserGroups.map((g, idx) => {
                                    const groupRecipients = applyPickerFilters(
                                      g.users
                                        .map((u) =>
                                          tenantUserRecipients.find(
                                            (r) =>
                                              r.tenantId === g.tenantId &&
                                              r.ownerObjectId === u.id,
                                          ),
                                        )
                                        .filter((r): r is Recipient =>
                                          Boolean(r),
                                        ),
                                    );
                                    if (groupRecipients.length === 0)
                                      return null;
                                    return (
                                      <React.Fragment key={g.tenantId}>
                                        {(idx > 0 ||
                                          applyPickerFilters(
                                            webAccountRecipients,
                                          ).length > 0) && (
                                          <CommandSeparator />
                                        )}
                                        <CommandGroup
                                          heading={
                                            <div className="flex items-center justify-between gap-2">
                                              <span>
                                                Tenant -- {g.tenantLabel}
                                              </span>
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleSelectAllInTenant(
                                                    g.tenantId,
                                                    groupRecipients,
                                                  );
                                                }}
                                                className="rounded px-1.5 py-0.5 text-2xs font-normal text-primary hover:bg-primary/10"
                                                aria-label={`Select all ${groupRecipients.length} from ${g.tenantLabel}`}
                                              >
                                                + Add all (
                                                {groupRecipients.length})
                                              </button>
                                            </div>
                                          }
                                        >
                                          {groupRecipients.map((r) =>
                                            renderRecipientItem(r),
                                          )}
                                        </CommandGroup>
                                      </React.Fragment>
                                    );
                                  })}
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                          {fieldState.error && (
                            <p
                              className="text-2xs text-destructive"
                              role="alert"
                            >
                              {fieldState.error.message}
                            </p>
                          )}
                        </div>

                        <div className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-surface-sunken px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <Label
                              htmlFor="ea-paste-toggle"
                              className="cursor-pointer text-xs"
                            >
                              Paste recipient (tenant + object IDs)
                            </Label>
                            <Switch
                              id="ea-paste-toggle"
                              checked={showManualPaste}
                              onCheckedChange={(v) =>
                                setShowManualPaste(Boolean(v))
                              }
                              aria-label="Show paste-recipient inputs"
                            />
                          </div>
                          {showManualPaste && (
                            <div className="flex flex-col gap-2">
                              <div className="flex flex-col gap-1.5">
                                <Label
                                  htmlFor="ea-manual-tenant"
                                  className="text-2xs"
                                >
                                  Tenant ID (GUID)
                                </Label>
                                <Input
                                  id="ea-manual-tenant"
                                  type="text"
                                  value={manualTenantId}
                                  onChange={(e) =>
                                    setManualTenantId(e.target.value)
                                  }
                                  placeholder="00000000-0000-0000-0000-000000000000"
                                  aria-label="Manual tenant ID"
                                  aria-invalid={
                                    manualTenantId && !manualTenantValid
                                      ? true
                                      : undefined
                                  }
                                  autoComplete="off"
                                  spellCheck={false}
                                  className="font-mono text-xs"
                                />
                              </div>
                              <div className="flex flex-col gap-1.5">
                                <Label
                                  htmlFor="ea-manual-owner"
                                  className="text-2xs"
                                >
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="cursor-help underline decoration-dotted underline-offset-2">
                                        Subscription Owner Object ID (GUID)
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      AAD object ID of the user/SPN in the
                                      destination tenant who becomes the
                                      owner.
                                    </TooltipContent>
                                  </Tooltip>
                                </Label>
                                <Input
                                  id="ea-manual-owner"
                                  type="text"
                                  value={manualOwnerId}
                                  onChange={(e) =>
                                    setManualOwnerId(e.target.value)
                                  }
                                  placeholder="00000000-0000-0000-0000-000000000000"
                                  aria-label="Manual subscription owner object ID"
                                  aria-invalid={
                                    manualOwnerId && !manualOwnerValid
                                      ? true
                                      : undefined
                                  }
                                  autoComplete="off"
                                  spellCheck={false}
                                  className="font-mono text-xs"
                                />
                              </div>
                              <div className="flex justify-end">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={handleAddManual}
                                  disabled={
                                    !manualTenantValid || !manualOwnerValid
                                  }
                                  aria-label="Add manual recipient"
                                >
                                  Add
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Bulk paste panel — accepts CSV/whitespace
                            separated `tenantId, ownerObjectId` pairs (one
                            per line) and adds them all in one shot.
                            Indispensable for batches of 20+ recipients. */}
                        <div className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-surface-sunken px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <Label
                              htmlFor="ea-bulk-paste-toggle"
                              className="cursor-pointer text-xs"
                            >
                              <span className="flex items-center gap-1.5">
                                <ClipboardPaste
                                  className="h-3.5 w-3.5"
                                  aria-hidden
                                />
                                Bulk paste recipients (CSV)
                              </span>
                            </Label>
                            <Switch
                              id="ea-bulk-paste-toggle"
                              checked={bulkPasteOpen}
                              onCheckedChange={(v) =>
                                setBulkPasteOpen(Boolean(v))
                              }
                              aria-label="Show bulk-paste textarea"
                            />
                          </div>
                          {bulkPasteOpen && (
                            <div className="flex flex-col gap-2">
                              <p className="text-2xs text-muted-foreground">
                                Paste one{" "}
                                <code className="font-mono">
                                  tenantId, ownerObjectId
                                </code>{" "}
                                pair per line. Commas, tabs, or whitespace
                                separators are accepted. Lines beginning
                                with{" "}
                                <code className="font-mono">#</code> or{" "}
                                <code className="font-mono">//</code> are
                                treated as comments. Duplicates are
                                silently skipped on add.
                              </p>
                              <textarea
                                id="ea-bulk-paste"
                                value={bulkPasteText}
                                onChange={(e) =>
                                  setBulkPasteText(e.target.value)
                                }
                                rows={6}
                                spellCheck={false}
                                autoComplete="off"
                                placeholder={
                                  "# tenantId, ownerObjectId — one per line\n" +
                                  "11111111-1111-1111-1111-111111111111, 22222222-2222-2222-2222-222222222222\n" +
                                  "33333333-3333-3333-3333-333333333333\t44444444-4444-4444-4444-444444444444"
                                }
                                aria-label="Bulk paste recipient pairs"
                                className={cn(
                                  "w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-2xs leading-relaxed text-foreground placeholder:text-muted-foreground/60",
                                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                                )}
                              />
                              <div className="flex flex-wrap items-center justify-between gap-2 text-2xs">
                                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                                  <span>
                                    <span
                                      className={cn(
                                        "font-semibold",
                                        bulkParseResult.pairs.length > 0
                                          ? "text-success"
                                          : "text-foreground",
                                      )}
                                    >
                                      {bulkParseResult.pairs.length}
                                    </span>{" "}
                                    valid
                                  </span>
                                  {bulkParseResult.errors.length > 0 && (
                                    <span>
                                      <span className="font-semibold text-destructive">
                                        {bulkParseResult.errors.length}
                                      </span>{" "}
                                      invalid
                                    </span>
                                  )}
                                  {bulkParseResult.truncated && (
                                    <span className="text-warning">
                                      ⚠ Truncated at 500 rows
                                    </span>
                                  )}
                                </span>
                                <div className="flex items-center gap-1.5">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="xs"
                                    onClick={() => setBulkPasteText("")}
                                    disabled={!bulkPasteText}
                                    aria-label="Clear bulk paste textarea"
                                  >
                                    Clear
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={handleBulkAdd}
                                    disabled={
                                      bulkParseResult.pairs.length === 0
                                    }
                                    aria-label="Add all parsed recipients"
                                    className="gap-1"
                                  >
                                    <PlusCircle
                                      className="h-3 w-3"
                                      aria-hidden
                                    />
                                    Add{" "}
                                    {bulkParseResult.pairs.length || ""}{" "}
                                    valid
                                  </Button>
                                </div>
                              </div>
                              {bulkParseResult.errors.length > 0 && (
                                <div className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-2xs">
                                  <p className="mb-1 font-semibold text-destructive/90">
                                    {bulkParseResult.errors.length} row
                                    {bulkParseResult.errors.length === 1
                                      ? ""
                                      : "s"}{" "}
                                    will be skipped
                                  </p>
                                  <ul className="ml-4 max-h-32 list-disc space-y-0.5 overflow-y-auto pr-2 font-mono text-2xs text-muted-foreground">
                                    {bulkParseResult.errors
                                      .slice(0, 10)
                                      .map((e) => (
                                        <li key={e.line}>
                                          <span className="text-foreground">
                                            L{e.line}:
                                          </span>{" "}
                                          {e.reason}
                                        </li>
                                      ))}
                                    {bulkParseResult.errors.length > 10 && (
                                      <li className="text-muted-foreground">
                                        ...and{" "}
                                        {bulkParseResult.errors.length - 10}{" "}
                                        more
                                      </li>
                                    )}
                                  </ul>
                                </div>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Persisted recipient templates — operator can save
                            and reload common recipient lists (e.g. "Customer
                            A monthly provisioning") without re-clicking the
                            picker. Pure local persistence; no Azure round-
                            trip. */}
                        <RecipientTemplates
                          currentPairs={selectedRecipients.map((r) => ({
                            tenantId: r.tenantId,
                            ownerObjectId: r.ownerObjectId,
                          }))}
                          onLoad={(pairs, templateName) => {
                            const prev = form.getValues("recipients");
                            const seen = new Set(prev.map((p) => dedupeKey(p)));
                            const added: Recipient[] = [];
                            for (const pair of pairs) {
                              const dk = dedupeKey(pair);
                              if (seen.has(dk)) continue;
                              seen.add(dk);
                              const wkey = recipientKey("web-account", pair);
                              const tkey = recipientKey("tenant-user", pair);
                              const fromCatalog =
                                recipientCatalog.get(wkey) ??
                                recipientCatalog.get(tkey);
                              if (fromCatalog) {
                                added.push(fromCatalog);
                              } else {
                                added.push({
                                  key: `manual:${pair.tenantId}:${pair.ownerObjectId}`,
                                  source: "manual",
                                  tenantId: pair.tenantId,
                                  ownerObjectId: pair.ownerObjectId,
                                  displayLabel: `Manual (${truncateMiddle(pair.ownerObjectId, 8, 4)})`,
                                  tenantLabel: tenantLabelFor(pair.tenantId),
                                });
                              }
                            }
                            if (added.length > 0) {
                              form.setValue(
                                "recipients",
                                [...prev, ...added],
                                { shouldValidate: true },
                              );
                            }
                            store.addNotification({
                              type: added.length > 0 ? "success" : "info",
                              message:
                                added.length === 0
                                  ? `Template '${templateName}' added no new recipients (all duplicates).`
                                  : `Loaded '${templateName}' — added ${added.length} recipient${added.length === 1 ? "" : "s"}.`,
                            });
                            auditLog.record({
                              actor:
                                activeAccount?.username ?? "anonymous",
                              action: "ea_subscription_load_template",
                              target: templateName,
                              status: "success",
                              details: {
                                templateName,
                                templatePairCount: pairs.length,
                                addedCount: added.length,
                                duplicateCount: pairs.length - added.length,
                              },
                            });
                          }}
                          disabled={submitting}
                        />

                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                              Selected Recipients
                            </p>
                            {selectedRecipients.length > 0 && (
                              <Badge
                                variant="secondary"
                                className="text-2xs font-normal"
                              >
                                {selectedRecipients.length}
                              </Badge>
                            )}
                          </div>
                          {selectedRecipients.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              Pick one or more recipients above. Each becomes
                              its own subscription.
                            </p>
                          ) : (
                            <div
                              className="flex flex-wrap gap-1.5"
                              role="list"
                              aria-label="Selected recipients"
                            >
                              {selectedRecipients.map((r) => {
                                const isCrossTenant =
                                  activeAccount &&
                                  r.tenantId.toLowerCase() !==
                                    activeAccount.tenantId.toLowerCase();
                                return (
                                  <Badge
                                    key={r.key}
                                    variant="secondary"
                                    className="flex items-center gap-1.5 pr-1"
                                    role="listitem"
                                    title={`${r.displayLabel}\nTenant: ${r.tenantLabel ?? r.tenantId}\nObject ID: ${r.ownerObjectId}`}
                                  >
                                    {isCrossTenant && (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span
                                            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-warning/20 text-warning"
                                            aria-label="Cross-tenant — needs acceptance"
                                          >
                                            <Hourglass
                                              className="h-2.5 w-2.5"
                                              aria-hidden
                                            />
                                          </span>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          Cross-tenant subscription —
                                          recipient must accept ownership
                                          in their tenant within 7 days.
                                        </TooltipContent>
                                      </Tooltip>
                                    )}
                                    <span className="flex flex-col leading-tight">
                                      <span className="text-xs">
                                        {r.displayLabel}
                                      </span>
                                      <span className="text-2xs text-muted-foreground">
                                        {r.tenantLabel}
                                        {r.source === "manual" && (
                                          <span className="ml-1 italic">
                                            (manual)
                                          </span>
                                        )}
                                        {r.enabled === false && (
                                          <span className="ml-1 text-destructive">
                                            (disabled)
                                          </span>
                                        )}
                                      </span>
                                    </span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-sm"
                                      className="h-4 w-4"
                                      onClick={() => removeRecipient(r.key)}
                                      aria-label={`Remove ${r.displayLabel}`}
                                    >
                                      <X className="h-3 w-3" aria-hidden />
                                    </Button>
                                  </Badge>
                                );
                              })}
                            </div>
                          )}
                          {selectedRecipients.length > 0 && (
                            <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-muted-foreground">
                              <p>
                                {selectedRecipients.length} recipient
                                {selectedRecipients.length === 1 ? "" : "s"}{" "}
                                selected · {selectedRecipients.length}{" "}
                                subscription
                                {selectedRecipients.length === 1
                                  ? ""
                                  : "s"}{" "}
                                will be created
                                {selectedRecipients.length > 1
                                  ? `, ${concurrencyChoice} at a time`
                                  : ""}
                                .
                              </p>
                              {(() => {
                                // Tenant-distribution chip — surfaces
                                // when a batch contains a mix of tenants.
                                const tenantMap = new Map<
                                  string,
                                  { label: string; count: number }
                                >();
                                for (const r of selectedRecipients) {
                                  const cur = tenantMap.get(r.tenantId);
                                  if (cur) cur.count += 1;
                                  else
                                    tenantMap.set(r.tenantId, {
                                      label:
                                        r.tenantLabel ??
                                        truncateMiddle(r.tenantId, 8, 4),
                                      count: 1,
                                    });
                                }
                                if (tenantMap.size <= 1) return null;
                                return (
                                  <span className="text-2xs">
                                    Spans {tenantMap.size} tenants
                                  </span>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  />
                )}

                {selfAssign && (
                  <div className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs">
                    {selfAssignRecipient ? (
                      <p>
                        Will assign to{" "}
                        <span className="font-medium text-foreground">
                          {selfAssignRecipient.displayLabel}
                        </span>{" "}
                        in{" "}
                        <span className="font-medium text-foreground">
                          {selfAssignRecipient.tenantLabel}
                        </span>
                        .
                      </p>
                    ) : (
                      <p className="text-destructive">
                        The active EA account has no resolvable AAD object ID
                        for self-assignment. Sign in again or pick recipients
                        manually.
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {leafSelectionReady && totalRecipients === 1 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <FileSignature
                    className="h-4 w-4 text-primary"
                    aria-hidden
                  />
                  Subscription Identity
                </CardTitle>
                <CardDescription>
                  Auto-derived from the recipient. Override if needed.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="ea-alias">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help underline decoration-dotted underline-offset-2">
                            Alias name
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          Azure resource name for the subscription
                          alias. 3–63 chars, lowercase + digits +
                          hyphens. Acts as the natural idempotency key
                          on the Subscription Alias API — a duplicate
                          PUT with the same alias is a no-op. We
                          auto-derive a unique alias per recipient when
                          the batch has &gt; 1 recipient.
                        </TooltipContent>
                      </Tooltip>
                    </Label>
                    {effectiveRecipients[0] && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          const first = effectiveRecipients[0];
                          if (!first) return;
                          let alias = deriveAlias(first);
                          if (!isValidAlias(alias)) {
                            alias = `sub-${randomSuffix(5)}-${Date.now()
                              .toString(36)
                              .slice(-4)}`;
                          }
                          form.setValue("aliasName", alias, {
                            shouldValidate: true,
                            shouldDirty: false,
                          });
                        }}
                        aria-label="Regenerate alias from recipient"
                        className="gap-1 text-2xs text-muted-foreground"
                      >
                        <RefreshCw
                          className="h-3 w-3"
                          aria-hidden
                        />
                        Regenerate
                      </Button>
                    )}
                  </div>
                  <Controller
                    control={form.control}
                    name="aliasName"
                    render={({ field, fieldState }) => (
                      <>
                        <Input
                          id="ea-alias"
                          {...field}
                          aria-invalid={
                            fieldState.error ? true : undefined
                          }
                          aria-describedby="ea-alias-error"
                          autoComplete="off"
                          spellCheck={false}
                          className="font-mono text-xs"
                        />
                        {fieldState.error && (
                          <p
                            id="ea-alias-error"
                            className="text-2xs text-destructive"
                            role="alert"
                          >
                            {fieldState.error.message}
                          </p>
                        )}
                      </>
                    )}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ea-display-name">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-help underline decoration-dotted underline-offset-2">
                          Display name
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        Human-friendly name shown in portal and the
                        Subscriptions blade. 1–64 chars, free text. The
                        recipient can rename when accepting ownership.
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <Controller
                    control={form.control}
                    name="displayName"
                    render={({ field, fieldState }) => (
                      <>
                        <Input
                          id="ea-display-name"
                          {...field}
                          aria-invalid={
                            fieldState.error ? true : undefined
                          }
                          aria-describedby="ea-display-name-error"
                          autoComplete="off"
                        />
                        {fieldState.error && (
                          <p
                            id="ea-display-name-error"
                            className="text-2xs text-destructive"
                            role="alert"
                          >
                            {fieldState.error.message}
                          </p>
                        )}
                      </>
                    )}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/*
            Pre-flight signature panel — corpus-grounded detections that
            surface unusual batch shapes (cross-tenant fan-out, mixed
            recipient classes, self-replication, manual-paste-heavy) and
            simulate the audit events that will fire on submit. Read-only;
            never blocks the operator. See `_ea_subscription_cross_tenant.md`
            §1, §9 for the documented attack shape.
          */}
          {leafSelectionReady && activeAccount && (
            <PreFlightPanel
              callerTenantId={activeAccount.tenantId}
              callerTenantLabel={tenantLabelFor(activeAccount.tenantId)}
              callerUpn={activeAccount.username}
              recipients={effectiveRecipients}
            />
          )}

          {/*
            KPI tile strip — at-a-glance recipient breakdown right above the
            Provisioning Summary so the operator can sanity-check the batch
            shape (total, cross-tenant share, disabled rows, tenant span)
            before committing irreversible billing operations.
          */}
          {leafSelectionReady && recipientStats.total > 0 && (
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Recipient batch summary"
            >
              <SummaryStatItem
                label="Total"
                value={recipientStats.total}
                hint={
                  recipientStats.total === 1
                    ? "subscription"
                    : "subscriptions"
                }
                tone="info"
                compact
              />
              <SummaryStatItem
                label="Cross-tenant"
                value={recipientStats.crossTenant}
                hint={
                  recipientStats.crossTenant > 0
                    ? "needs accept"
                    : "same tenant"
                }
                tone={recipientStats.crossTenant > 0 ? "warning" : "muted"}
                compact
              />
              <SummaryStatItem
                label="Disabled"
                value={recipientStats.disabled}
                hint={
                  recipientStats.disabled > 0 ? "may 400" : "all enabled"
                }
                tone={recipientStats.disabled > 0 ? "destructive" : "muted"}
                compact
              />
              <SummaryStatItem
                label="Tenants"
                value={recipientStats.tenantSpan}
                hint={
                  recipientStats.tenantSpan > 1
                    ? "multi-tenant"
                    : "single"
                }
                tone={recipientStats.tenantSpan > 1 ? "warning" : "muted"}
                compact
              />
              {totalInFlight > 0 && (
                <>
                  <SummaryStatItem
                    label="Succeeded"
                    value={successResults.length}
                    hint={
                      submitting
                        ? "in batch"
                        : completedCount === totalInFlight
                          ? "complete"
                          : "running"
                    }
                    tone="success"
                    compact
                  />
                  <SummaryStatItem
                    label="Failed"
                    value={failureCount}
                    hint={failureCount > 0 ? "see below" : "none"}
                    tone={failureCount > 0 ? "destructive" : "muted"}
                    compact
                  />
                </>
              )}
            </div>
          )}

          {leafSelectionReady && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <FileSignature className="h-4 w-4 text-primary" aria-hidden />
                  Provisioning Summary
                </CardTitle>
                <CardDescription>
                  {totalRecipients <= 1
                    ? "Review the destination scope before submitting."
                    : "Names and aliases are auto-generated per recipient. Workload is fixed to Production."}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="rounded-md border border-border bg-surface-sunken px-3 py-2">
                  <p className="mb-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                    Billing scope
                  </p>
                  <div className="flex items-start gap-1.5">
                    <p className="flex-1 break-all font-mono text-2xs text-foreground">
                      {billingScope ||
                        (isEa
                          ? "(select an enrollment account)"
                          : "(select an invoice section)")}
                    </p>
                    {billingScope && (
                      <CopyableId value={billingScope} label="billing scope" />
                    )}
                  </div>
                  {isEa && selectedEnrollmentAccountObj && (
                    <p className="mt-1 flex items-center gap-1 text-2xs text-muted-foreground">
                      <ChevronRight className="h-3 w-3" aria-hidden />
                      Charges land in
                      <span className="font-medium text-foreground">
                        {selectedEnrollmentAccountObj.displayName}
                      </span>
                    </p>
                  )}
                  {!isEa && selectedInvoiceSectionObj && (
                    <p className="mt-1 flex items-center gap-1 text-2xs text-muted-foreground">
                      <ChevronRight className="h-3 w-3" aria-hidden />
                      Charges land in
                      <span className="font-medium text-foreground">
                        {selectedInvoiceSectionObj.displayName}
                      </span>
                      {selectedBillingProfileObj && (
                        <span className="text-foreground/70">
                          ({selectedBillingProfileObj.displayName})
                        </span>
                      )}
                    </p>
                  )}
                </div>

                {totalRecipients > 1 && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <Label
                        htmlFor="ea-concurrency"
                        className="text-2xs uppercase tracking-wider text-muted-foreground"
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help underline decoration-dotted underline-offset-2">
                              Parallel calls
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            How many subscription-creation requests run
                            simultaneously. 1 = strictly serial (gentlest
                            on the EA billing API). 5 = fastest, but more
                            likely to trip 429 throttles on large
                            enrollments. Default 3 balances speed and
                            reliability.
                          </TooltipContent>
                        </Tooltip>
                      </Label>
                      <Select
                        value={concurrencyChoice}
                        onValueChange={(v) =>
                          setConcurrencyChoice(v as "1" | "3" | "5")
                        }
                        disabled={submitting}
                      >
                        <SelectTrigger
                          id="ea-concurrency"
                          className="h-7 w-20 text-xs"
                          aria-label="Concurrency for batch submit"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1">1 (serial)</SelectItem>
                          <SelectItem value="3">3 (default)</SelectItem>
                          <SelectItem value="5">5 (fastest)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-3 text-2xs text-muted-foreground">
                      <span>
                        Est. wall-clock:{" "}
                        <span className="font-medium text-foreground">
                          {formatElapsedSec(
                            Math.ceil(
                              (totalRecipients /
                                parseInt(concurrencyChoice, 10)) *
                                60,
                            ),
                          )}{" "}
                          – {" "}
                          {formatElapsedSec(
                            Math.ceil(
                              (totalRecipients /
                                parseInt(concurrencyChoice, 10)) *
                                90,
                            ),
                          )}
                        </span>
                      </span>
                    </div>
                  </div>
                )}

                {/* Post-batch summary stat strip. Rendered whenever a
                    batch has completed (some / all rows in success or
                    failure). Lets the operator scan the outcome at a
                    glance and gives them an Export menu + Retry-failed
                    shortcut without scrolling to the bottom of the page. */}
                {totalInFlight > 0 && !submitting && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5">
                    <div className="flex flex-wrap items-center gap-4 text-xs">
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2
                          className="h-3.5 w-3.5 text-success"
                          aria-hidden
                        />
                        <span className="font-semibold tabular-nums text-success">
                          {successResults.length}
                        </span>
                        <span className="text-muted-foreground">
                          succeeded
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <AlertCircle
                          className="h-3.5 w-3.5 text-destructive"
                          aria-hidden
                        />
                        <span className="font-semibold tabular-nums text-destructive">
                          {failureCount}
                        </span>
                        <span className="text-muted-foreground">failed</span>
                      </div>
                      {pendingCount + runningCount > 0 && (
                        <div className="flex items-center gap-1.5">
                          <Loader2
                            className="h-3.5 w-3.5 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="font-semibold tabular-nums">
                            {pendingCount + runningCount}
                          </span>
                          <span className="text-muted-foreground">
                            pending
                          </span>
                        </div>
                      )}
                      {elapsedStats.count > 0 && (
                        <div className="text-2xs text-muted-foreground">
                          median{" "}
                          <span className="font-medium tabular-nums text-foreground">
                            {formatElapsedSec(elapsedStats.median)}
                          </span>{" "}
                          · max{" "}
                          <span className="font-medium tabular-nums text-foreground">
                            {formatElapsedSec(elapsedStats.max)}
                          </span>
                          {submitElapsedSec > 0 && (
                            <>
                              {" "}
                              · total{" "}
                              <span className="font-medium tabular-nums text-foreground">
                                {formatElapsedSec(submitElapsedSec)}
                              </span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {failedKeys.length > 0 && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleRetryFailed}
                          disabled={submitting}
                          aria-label={`Retry ${failedKeys.length} failed`}
                          className="gap-1"
                        >
                          <RotateCcw className="h-3 w-3" aria-hidden />
                          Retry failed ({failedKeys.length})
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleExportResults("csv")}
                        aria-label="Export batch results as CSV"
                        className="gap-1"
                      >
                        <Download className="h-3 w-3" aria-hidden />
                        CSV
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleExportResults("json")}
                        aria-label="Export batch results as JSON"
                        className="gap-1"
                      >
                        <Download className="h-3 w-3" aria-hidden />
                        JSON
                      </Button>
                    </div>
                  </div>
                )}

                {/*
                  Steady-state reconciliation tile — appears once any batch
                  outcome lands. Buckets rows into steady / alias-only /
                  pending-acceptance / failed / stale so the operator knows
                  what still needs follow-up. Per `_bypass_modify_delete.md`:
                  state-changing ops need explicit follow-up — the caller's
                  view of "success" does not equal the destination tenant's
                  view of "fully owned" for cross-tenant subs.
                */}
                {activeAccount && totalInFlight > 0 && (
                  <ReconciliationTile
                    callerTenantId={activeAccount.tenantId}
                    recipients={effectiveRecipients}
                    statusMap={statusMap}
                    submitting={submitting}
                  />
                )}

                {batchErrors.length > 0 && (
                  <Alert
                    variant="destructive"
                    role="alert"
                    aria-live="assertive"
                    aria-atomic="false"
                  >
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      <p className="mb-1 font-medium">
                        {batchErrors.length} of {totalInFlight} subscription
                        {totalInFlight === 1 ? "" : "s"} failed.
                      </p>
                      {hasStaleSession && (
                        <div className="mb-2 flex flex-wrap items-center gap-2 rounded border border-warning/40 bg-warning/10 px-2.5 py-2 text-2xs">
                          <ShieldAlert
                            className="h-4 w-4 shrink-0 text-warning"
                            aria-hidden
                          />
                          <span className="flex-1 text-warning-foreground">
                            Your sign-in session for{" "}
                            <strong>{activeAccount?.username}</strong> is no
                            longer valid (MSAL refresh token expired,
                            revoked, or wiped). Click the button to re-auth
                            interactively, then Retry failed.
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="default"
                            disabled={armTokenTracker.loading}
                            onClick={() =>
                              void armTokenTracker.reauth({
                                loginHint: activeAccount?.username,
                              })
                            }
                          >
                            {armTokenTracker.loading ? (
                              <Loader2
                                className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                                aria-hidden
                              />
                            ) : (
                              <BadgeCheck
                                className="h-3.5 w-3.5"
                                aria-hidden
                              />
                            )}
                            Sign in again
                          </Button>
                        </div>
                      )}
                      <ul className="list-none space-y-2 text-2xs">
                        {batchErrors.map((b) => {
                          const tip = suggestRemediation(b.error);
                          const cat = categorizeError(b.error);
                          return (
                            <li key={b.key}>
                              <p className="flex items-start gap-2">
                                <Badge
                                  variant="secondary"
                                  className={cn(
                                    "shrink-0 text-2xs font-normal uppercase tracking-wider",
                                    cat.tone === "auth" &&
                                      "border-warning/40 bg-warning/10 text-warning",
                                    cat.tone === "data" &&
                                      "border-destructive/40 bg-destructive/10 text-destructive",
                                    cat.tone === "quota" &&
                                      "border-warning/40 bg-warning/10 text-warning",
                                    cat.tone === "transient" &&
                                      "border-primary/40 bg-primary/10 text-primary",
                                    cat.tone === "input" &&
                                      "border-info/40 bg-info/10 text-info",
                                  )}
                                >
                                  {cat.label}
                                </Badge>
                                <span className="flex-1">
                                  <span className="font-medium">
                                    {b.label}:
                                  </span>{" "}
                                  {b.error}
                                </span>
                              </p>
                              {tip && (
                                <p className="mt-0.5 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-2xs text-destructive/90">
                                  <span className="font-semibold">
                                    How to fix:{" "}
                                  </span>
                                  {tip}
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ul>

                      {tokenDiagnostic &&
                        batchErrors.some(
                          (b) =>
                            /401|not authorized|authoriz|billingpermission/i.test(
                              b.error,
                            ),
                        ) && (
                          <div className="mt-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-2xs">
                            <p className="mb-1 font-semibold text-destructive/90">
                              Token diagnostic (verify the token actually
                              carries the role)
                            </p>
                            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 font-mono">
                              {tokenDiagnostic.upn && (
                                <>
                                  <dt className="text-muted-foreground">
                                    upn
                                  </dt>
                                  <dd className="break-all">
                                    {tokenDiagnostic.upn}
                                  </dd>
                                </>
                              )}
                              <dt className="text-muted-foreground">tid</dt>
                              <dd className="break-all">
                                {tokenDiagnostic.tid || "—"}
                              </dd>
                              <dt className="text-muted-foreground">oid</dt>
                              <dd className="break-all">
                                {tokenDiagnostic.oid || "—"}
                              </dd>
                              <dt className="text-muted-foreground">aud</dt>
                              <dd className="break-all">
                                {tokenDiagnostic.aud || "—"}
                              </dd>
                              {tokenDiagnostic.issuedAt && (
                                <>
                                  <dt className="text-muted-foreground">
                                    iat
                                  </dt>
                                  <dd className="break-all">
                                    {tokenDiagnostic.issuedAt}
                                  </dd>
                                </>
                              )}
                            </dl>
                            <p className="mt-1.5 text-muted-foreground">
                              Verify in the EA Portal that the principal with
                              this <code>oid</code> in tenant{" "}
                              <code>{tokenDiagnostic.tid}</code> is granted
                              <em> EA Subscription Creator</em> on the selected
                              enrollment account. If the role was added in the
                              last few minutes, retry — propagation can take up
                              to 5 minutes after a fresh token is issued. If
                              <code> aud</code> is not{" "}
                              <code>https://management.azure.com</code>,
                              sign out and sign in again.
                            </p>
                          </div>
                        )}

                      {hasAuthFailure && (
                        <div className="mt-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-2xs">
                          <p className="mb-1 font-semibold text-destructive/90">
                            EA role assignments at this scope (live)
                          </p>
                          {roleDiagnosticLoading && (
                            <p className="text-muted-foreground">
                              Querying billingRoleAssignments…
                            </p>
                          )}
                          {roleDiagnosticError && (
                            <p className="text-muted-foreground">
                              Could not read role assignments at this scope
                              (billingRoleAssignments returned:{" "}
                              {roleDiagnosticError}). This usually means
                              your principal has zero billing-scope roles
                              here, or the EA Portal hasn&apos;t propagated
                              your role yet.
                            </p>
                          )}
                          {roleDiagnostic && (
                            <>
                              {roleDiagnostic.assignments.length === 0 ? (
                                <p className="text-muted-foreground">
                                  Your principal has{" "}
                                  <strong>no role assignments</strong> on
                                  this enrollment-account scope. The
                                  &quot;EA Account Owner&quot; flag in EA
                                  Portal does <strong>not</strong> by itself
                                  create the Azure RBAC role assignment that
                                  the Subscription Alias API checks. An
                                  Enterprise Administrator must explicitly
                                  add you as an Account Owner of THIS
                                  enrollment account (not just the
                                  enrollment), OR grant you the{" "}
                                  <em>EA Subscription Creator</em> role at
                                  this scope.
                                </p>
                              ) : (
                                <>
                                  <p className="text-muted-foreground">
                                    Roles found for principal{" "}
                                    <code>
                                      {roleDiagnostic.assignments[0]?.principalId}
                                    </code>{" "}
                                    at this scope:
                                  </p>
                                  <ul className="mt-1 list-disc pl-4">
                                    {roleDiagnostic.assignments.map((a) => (
                                      <li key={a.id}>
                                        <strong>
                                          {a.roleDefinitionName}
                                        </strong>
                                        {a.createdOn && (
                                          <span className="ml-1 text-muted-foreground">
                                            (granted{" "}
                                            {new Date(
                                              a.createdOn,
                                            ).toLocaleString()}
                                            )
                                          </span>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                  <p className="mt-1 text-muted-foreground">
                                    {roleDiagnostic.canCreateSubscriptions
                                      ? "These roles SHOULD allow subscription creation. The 401 then is most likely propagation lag — wait 1–5 min and retry."
                                      : "None of these roles allow subscription creation. Ask an Enterprise Administrator to grant you EA Subscription Creator at this scope."}
                                  </p>
                                </>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                {(submitting || totalInFlight > 0) &&
                  effectiveRecipients.length > 0 && (
                    <div
                      className={cn(
                        "flex flex-col gap-2.5 rounded-lg border bg-card px-3.5 py-3",
                        "transition-colors duration-200 ease-out",
                        submitting
                          ? "border-primary/40 bg-primary/5"
                          : "border-border",
                      )}
                      aria-live="polite"
                      aria-atomic="false"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="flex items-center gap-2 font-medium">
                          {submitting ? (
                            <Loader2
                              className="h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none"
                              aria-hidden
                            />
                          ) : completedCount === totalInFlight &&
                            batchErrors.length === 0 ? (
                            <CheckCircle2
                              className="h-3.5 w-3.5 text-success"
                              aria-hidden
                            />
                          ) : (
                            <AlertCircle
                              className="h-3.5 w-3.5 text-warning"
                              aria-hidden
                            />
                          )}
                          {submitting
                            ? "Calling Subscription Alias API"
                            : "Provisioning complete"}
                        </span>
                        <span className="flex items-center gap-3 text-2xs text-muted-foreground">
                          <span>
                            {completedCount}/{totalInFlight} done
                          </span>
                          {submitElapsedSec > 0 && (
                            <span className="tabular-nums">
                              {submitElapsedSec}s elapsed
                            </span>
                          )}
                        </span>
                      </div>
                      <Progress
                        value={
                          totalInFlight === 0
                            ? 0
                            : Math.round((completedCount / totalInFlight) * 100)
                        }
                        aria-label="Subscription provisioning progress"
                      />
                      {submitting && (
                        <p className="text-2xs text-muted-foreground">
                          Each subscription is an async ARM operation:{" "}
                          <span className="font-medium text-foreground">
                            PUT alias
                          </span>
                          {" → "}
                          <span className="font-medium text-foreground">
                            poll every 5s
                          </span>
                          {" → "}
                          <span className="font-medium text-foreground">
                            subscription GUID returned
                          </span>
                          . Typical wait: 30–90 seconds per recipient. Don&apos;t
                          close the tab.
                        </p>
                      )}
                      <ul className="flex flex-col gap-1 text-2xs">
                        {effectiveRecipients.map((r) => {
                          const s = statusMap[r.key];
                          const elapsedSec =
                            s?.state === "running"
                              ? (Date.now() - s.startedAt) / 1000
                              : s?.state === "success" ||
                                  s?.state === "failure"
                                ? (s.completedAt - s.startedAt) / 1000
                                : 0;
                          return (
                            <li
                              key={r.key}
                              className={cn(
                                "flex items-center gap-2 rounded px-1.5 py-1 transition-colors duration-150",
                                s?.state === "running" && "bg-primary/10",
                                s?.state === "success" && "bg-success/10",
                                s?.state === "failure" && "bg-destructive/10",
                              )}
                            >
                              {!s || s.state === "pending" ? (
                                <Loader2
                                  className="h-3 w-3 text-muted-foreground"
                                  aria-hidden
                                />
                              ) : s.state === "running" ? (
                                <Loader2
                                  className="h-3 w-3 animate-spin text-primary motion-reduce:animate-none"
                                  aria-hidden
                                />
                              ) : s.state === "success" ? (
                                <CheckCircle2
                                  className="h-3 w-3 text-success"
                                  aria-hidden
                                />
                              ) : (
                                <AlertCircle
                                  className="h-3 w-3 text-destructive"
                                  aria-hidden
                                />
                              )}
                              <span className="truncate font-medium">
                                {r.displayLabel}
                              </span>
                              <span className="text-muted-foreground">·</span>
                              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                {s?.state === "success" && s.subscriptionId ? (
                                  <>
                                    id{" "}
                                    <code className="font-mono">
                                      {truncateMiddle(s.subscriptionId, 8, 4)}
                                    </code>
                                  </>
                                ) : s?.state === "success" ? (
                                  <>
                                    alias{" "}
                                    <code className="font-mono">
                                      {s.aliasName}
                                    </code>{" "}
                                    (id pending)
                                  </>
                                ) : s?.state === "failure" ? (
                                  s.error
                                ) : s?.state === "running" ? (
                                  "creating subscription alias..."
                                ) : (
                                  "queued"
                                )}
                              </span>
                              {elapsedSec > 0 && (
                                <span className="shrink-0 tabular-nums text-muted-foreground">
                                  {formatElapsedSec(elapsedSec)}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                {successResults.length > 0 && (
                  <div
                    className={cn(
                      "flex flex-col gap-2 rounded-lg border border-success/40 bg-success/5 px-3.5 py-3",
                      "transition-colors duration-200 ease-out",
                    )}
                    role="region"
                    aria-label="Successfully provisioned subscriptions"
                  >
                    <div className="flex items-center gap-2 text-sm font-medium text-success-foreground">
                      <PartyPopper
                        className="h-4 w-4 text-success"
                        aria-hidden
                      />
                      <span>
                        {successResults.length === 1
                          ? "Subscription provisioned"
                          : `${successResults.length} subscriptions provisioned`}
                      </span>
                      <Sparkles
                        className="h-3.5 w-3.5 text-success/70"
                        aria-hidden
                      />
                    </div>
                    <p className="text-2xs text-muted-foreground">
                      The new subscription
                      {successResults.length === 1 ? " is" : "s are"} live in
                      Azure. Click an ID to copy, or open it in the portal.
                    </p>
                    <ul className="flex flex-col gap-1.5">
                      {successResults.map(({ recipient, status }) => {
                        // Cross-tenant: the recipient's tenantId differs from
                        // the API caller's home tenant. The new owner has 7
                        // days to accept ownership in the destination tenant.
                        // Surface a "Copy approver URL" button so the
                        // operator can paste the link into chat / email
                        // independent of the auto-email Microsoft sends.
                        const approverUrl = status.subscriptionId
                          ? buildAcceptOwnershipPortalUrl(
                              recipient.tenantId,
                              status.subscriptionId,
                            )
                          : null;
                        return (
                          <li
                            key={recipient.key}
                            className="flex flex-col gap-1.5 rounded-md border border-success/30 bg-card px-2.5 py-1.5"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <CheckCircle2
                                className="h-3.5 w-3.5 shrink-0 text-success"
                                aria-hidden
                              />
                              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                                <span className="truncate text-xs font-medium text-foreground">
                                  {recipient.displayLabel}
                                </span>
                                {recipient.tenantLabel && (
                                  <span className="truncate text-2xs text-muted-foreground">
                                    {recipient.tenantLabel}
                                    {recipient.upn ? ` · ${recipient.upn}` : ""}
                                  </span>
                                )}
                              </span>
                              {status.subscriptionId ? (
                                <>
                                  <CopyableId
                                    value={status.subscriptionId}
                                    label="subscription id"
                                  />
                                  <a
                                    href={azurePortalLinkForSubscription(
                                      status.subscriptionId,
                                    )}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={cn(
                                      "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-2xs font-medium text-foreground",
                                      "transition-all duration-200 ease-out hover:border-primary hover:bg-accent/5 hover:text-primary",
                                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                                    )}
                                    aria-label={`Open ${status.subscriptionId} in Azure Portal`}
                                  >
                                    <ExternalLink
                                      className="h-3 w-3"
                                      aria-hidden
                                    />
                                    Open in Azure Portal
                                  </a>
                                </>
                              ) : (
                                <span className="text-2xs text-muted-foreground">
                                  alias{" "}
                                  <span className="font-mono text-foreground">
                                    {status.aliasName}
                                  </span>{" "}
                                  created — subscription id pending
                                </span>
                              )}
                            </div>
                            {/*
                              Approver banner — only renders for cross-tenant
                              subscriptions where the new owner needs to accept
                              ownership in the destination tenant. The 7-day
                              expiry is per Azure's documented invitation
                              window.
                            */}
                            {approverUrl && (
                              <div
                                className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/5 px-2 py-1.5"
                                role="note"
                                aria-label="Pending owner acceptance"
                              >
                                <Hourglass
                                  className="h-3.5 w-3.5 shrink-0 text-warning"
                                  aria-hidden
                                />
                                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                                  <span className="text-2xs font-medium text-foreground">
                                    Awaiting owner acceptance · expires in
                                    7 days
                                  </span>
                                  <span className="truncate text-2xs text-muted-foreground">
                                    Paste this URL to the new owner so they
                                    can accept ownership in their tenant:
                                  </span>
                                </span>
                                <code
                                  className="max-w-full truncate rounded bg-background px-2 py-1 font-mono text-2xs text-foreground"
                                  title={approverUrl}
                                >
                                  {approverUrl}
                                </code>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="xs"
                                  onClick={async () => {
                                    try {
                                      await navigator.clipboard.writeText(
                                        approverUrl,
                                      );
                                      store.addNotification({
                                        type: "success",
                                        message: `Approver URL copied for ${recipient.displayLabel}.`,
                                      });
                                    } catch {
                                      store.addNotification({
                                        type: "error",
                                        message:
                                          "Clipboard blocked — select the URL manually.",
                                      });
                                    }
                                  }}
                                  aria-label={`Copy approver URL for ${recipient.displayLabel}`}
                                  className="gap-1"
                                >
                                  <Link2 className="h-3 w-3" aria-hidden />
                                  Copy URL
                                </Button>
                                <a
                                  href={approverUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={cn(
                                    "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-2xs font-medium text-foreground",
                                    "transition-all duration-200 ease-out hover:border-warning hover:bg-warning/5 hover:text-warning",
                                  )}
                                  aria-label="Open the approver URL in a new tab"
                                  title="Opens the destination-tenant Subscriptions blade"
                                >
                                  <ExternalLink
                                    className="h-3 w-3"
                                    aria-hidden
                                  />
                                  Open
                                </a>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-end gap-2">
                  {!formReady && !submitting && (
                    <p className="text-2xs text-muted-foreground">
                      Pick a billing scope and at least one recipient to enable
                      submit.
                    </p>
                  )}
                  {formReady && !submitting && (
                    <p className="text-2xs text-muted-foreground">
                      Hotkey:{" "}
                      <kbd className="rounded border border-border bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                        Ctrl
                      </kbd>{" "}
                      <span aria-hidden>+</span>{" "}
                      <kbd className="rounded border border-border bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                        Enter
                      </kbd>{" "}
                      to open confirm
                    </p>
                  )}
                  <Button
                    type="button"
                    variant="default"
                    size="lg"
                    onClick={() => setConfirmOpen(true)}
                    disabled={!formReady || submitting}
                    aria-label="Create EA subscriptions (Ctrl+Enter)"
                    title="Create EA subscriptions — Ctrl+Enter"
                    className="transition-all duration-200 ease-out hover:shadow-elev-2"
                  >
                    <PlusCircle className="h-4 w-4" aria-hidden />
                    {totalRecipients <= 1
                      ? "Create Subscription"
                      : `Create ${totalRecipients} Subscriptions`}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      ) : null}

      {(() => {
        // Recompute confirm panel content based on retry mode. In retry
        // mode, the dialog targets only the previously-failed recipients;
        // in normal mode it targets the full effective recipient list.
        const isRetryMode =
          retryOnlyKeys !== null && retryOnlyKeys.size > 0;
        const confirmRecipients = isRetryMode
          ? effectiveRecipients.filter((r) => retryOnlyKeys!.has(r.key))
          : effectiveRecipients;
        const confirmCount = confirmRecipients.length;
        const previewList = confirmRecipients.slice(0, 10);
        const previewExtra = Math.max(0, confirmCount - previewList.length);
        const crossTenantCount = activeAccount
          ? confirmRecipients.filter(
              (r) =>
                r.tenantId.toLowerCase() !==
                activeAccount.tenantId.toLowerCase(),
            ).length
          : 0;
        const tenantSet = new Set(confirmRecipients.map((r) => r.tenantId));
        return (
          <ConfirmationDialog
            hidden={!confirmOpen}
            danger
            title={
              isRetryMode
                ? `Retry ${confirmCount} failed subscription${confirmCount === 1 ? "" : "s"}`
                : confirmCount <= 1
                  ? "Create EA subscription"
                  : `Create ${confirmCount} EA subscriptions`
            }
            message={
              <div className="flex flex-col gap-3">
                {/* Bold irreversibility callout — distinct color so the
                    user cannot miss that this commits real billing. */}
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground">
                  <AlertTriangle
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
                    aria-hidden
                  />
                  <p>
                    <strong className="font-semibold text-destructive">
                      This action is irreversible.
                    </strong>{" "}
                    Subscriptions are created in Azure under your{" "}
                    <strong className="font-semibold text-foreground">
                      Enterprise Agreement billing scope
                    </strong>{" "}
                    and{" "}
                    <strong className="font-semibold text-foreground">
                      cannot be cancelled from this UI
                    </strong>
                    . Only an EA admin can transfer or cancel them later.
                  </p>
                </div>

                {isRetryMode && (
                  <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning-foreground">
                    <RotateCcw
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
                      aria-hidden
                    />
                    <p>
                      <strong className="font-semibold">Retry mode.</strong>{" "}
                      Only the {confirmCount} recipient
                      {confirmCount === 1 ? "" : "s"} that failed in the
                      previous batch will be re-submitted. Successful
                      results from the previous batch remain visible
                      below.
                    </p>
                  </div>
                )}

                {crossTenantCount > 0 && (
                  <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs">
                    <Hourglass
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
                      aria-hidden
                    />
                    <p>
                      <strong className="font-semibold">
                        {crossTenantCount} cross-tenant subscription
                        {crossTenantCount === 1 ? "" : "s"}
                      </strong>{" "}
                      will be created. Each owner has{" "}
                      <strong>7 days</strong> to accept ownership in their
                      destination tenant — paste the approver URL we
                      generate below to chat / email them, or they can
                      use the &quot;Accept incoming subscription&quot;
                      panel at the top of this page.
                    </p>
                  </div>
                )}

                <p>
                  {confirmLeafName
                    ? confirmCount <= 1
                      ? `Create one subscription under '${confirmLeafName}' for the recipient below?`
                      : `Create ${confirmCount} subscriptions under '${confirmLeafName}', one per recipient below?`
                    : "Create subscriptions?"}
                </p>
                {activeAccount && (
                  <p className="text-xs">
                    EA billing account:{" "}
                    <span className="font-medium text-foreground">
                      {activeAccount.name || activeAccount.username}
                    </span>
                  </p>
                )}
                <p className="break-all rounded border border-border bg-surface-sunken px-2 py-1 font-mono text-2xs">
                  {billingScope}
                </p>
                {confirmCount > 1 && (
                  <p className="text-2xs text-muted-foreground">
                    Parallelism:{" "}
                    <span className="font-medium text-foreground">
                      {concurrencyChoice} at a time
                    </span>
                    {tenantSet.size > 1 ? (
                      <>
                        {" · "}spans{" "}
                        <span className="font-medium text-foreground">
                          {tenantSet.size} tenants
                        </span>
                      </>
                    ) : null}
                  </p>
                )}
                {confirmCount === 1 && (
                  <p className="text-xs">
                    Alias:{" "}
                    <span className="font-mono text-2xs text-foreground">
                      {aliasNameField}
                    </span>
                    {" — "}
                    <span className="text-foreground">
                      {displayNameField}
                    </span>
                  </p>
                )}
                {previewList.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-4 text-xs">
                    {previewList.map((r) => (
                      <li key={r.key}>
                        <span className="font-medium text-foreground">
                          {r.displayLabel}
                        </span>
                        {r.upn ? <span> · {r.upn}</span> : null} ·{" "}
                        <span>{r.tenantLabel}</span>
                        {r.enabled === false && (
                          <span className="text-muted-foreground">
                            {" "}
                            (disabled)
                          </span>
                        )}
                      </li>
                    ))}
                    {previewExtra > 0 && (
                      <li className="text-muted-foreground">
                        ...and {previewExtra} more
                      </li>
                    )}
                  </ul>
                )}
              </div>
            }
            confirmText={
              isRetryMode
                ? `Yes, retry ${confirmCount}`
                : confirmCount <= 1
                  ? "Yes, create subscription"
                  : `Yes, create ${confirmCount} subscriptions`
            }
            cancelText="Cancel"
            loading={submitting}
            onConfirm={performSubmit}
            onCancel={() => {
              if (!submitting) {
                setConfirmOpen(false);
                setRetryOnlyKeys(null);
              }
            }}
          />
        );
      })()}
    </div>
  );
};


export const EaSubscriptionPage: React.FC<EaSubscriptionPageProps> = (
  props,
) => (
  <ErrorBoundary>
    <EaSubscriptionPageInner {...props} />
  </ErrorBoundary>
);
