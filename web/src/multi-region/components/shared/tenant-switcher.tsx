/**
 * Global tenant + account switcher pinned to the app header.
 *
 * Why this exists: even though the operator can switch tenants on the
 * `/azure-accounts` page (drawer + inline row dropdown), that flow
 * requires *navigating away* from the page they're working on. After
 * the switch they have to navigate back — meanwhile any page-scoped
 * state is wiped. This pin always-visible switcher means the operator
 * can pivot tenants from anywhere in the app and the current page
 * just re-fetches itself via the `TENANT_CHANGED_EVENT` listeners.
 *
 * Behaviour:
 *   - Pill shows the CURRENT active account + active tenant friendly
 *     label.
 *   - Click opens a Radix Popover with a cmdk Command palette.
 *   - Searchable across every account's username AND every accessible
 *     tenant (displayName / defaultDomain / tenantId).
 *   - Each account is rendered as a CommandGroup; tenants are nested
 *     CommandItems. Current tenant shows a check icon + "active" tag.
 *   - Clicking a tenant runs the canonical `performTenantSwitch`
 *     flow — same audit shape, same notification, same sub-refresh as
 *     the Azure Accounts page.
 *   - In-flight switches show a loading spinner on the row + disable
 *     re-click. Concurrent rapid switches use a monotonic seq so the
 *     latest one wins.
 *   - Footer: "Add another account" + "Open Azure Accounts page".
 *   - Hotkey: Mod+Shift+T opens the popover.
 *   - Empty state: when no account is signed in, the pill becomes a
 *     "Sign in" button (delegated to `onAddAccount`).
 *
 * Token + state propagation: the switch helper writes MSAL's per-
 * account active tenant pointer AND the store's `activeTenantId` AND
 * fires `TENANT_CHANGED_EVENT`. Pages using `useArmToken` re-mint
 * automatically (the hook listens for the event). Pages with extra
 * tenant-scoped local state should add their own `useTenantChange`
 * listener — this component doesn't reach into their state.
 */
import * as React from "react";
import {
  AlertTriangle,
  Building2,
  Check,
  ChevronsUpDown,
  Loader2,
  LogIn,
  Plus,
  Settings,
  Star,
  UserCog,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { KbdChord } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

import {
  findTenantLabel,
  performTenantSwitch,
  resolveActiveTenantId,
} from "../../auth/perform-tenant-switch";
import { listAccessibleTenants } from "../../auth/msal-auth";
import { modKeyLabel, useShortcut } from "../../hooks/use-shortcut";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
import type { AzureLoginAccount } from "../../store/store-types";

/**
 * Truncate a GUID to the first 8 chars for compact display.
 * Avoids importing the page-local helpers; intentionally inlined.
 */
function shortGuid(id: string | undefined | null): string {
  if (!id) return "";
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

interface TenantSwitcherProps {
  /**
   * Wired up to the "Sign in" / "Add another account" footer item.
   * When unset, the footer item is hidden.
   */
  onAddAccount?: () => void;
  /**
   * Wired up to the "Manage accounts" footer item. Typically pushes
   * `/azure-accounts` via the hash router.
   */
  onOpenManage?: () => void;
}

export const TenantSwitcher: React.FC<TenantSwitcherProps> = ({
  onAddAccount,
  onOpenManage,
}) => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const accounts = state.azureAccounts ?? [];

  const [open, setOpen] = React.useState(false);
  // Map<accountId, tenantId-in-flight>. Used to disable rows + show
  // per-row spinner. Cleared by the switch helper's finally.
  const [switchingMap, setSwitchingMap] = React.useState<
    Record<string, string>
  >({});
  // Per-account abort + seq so rapid clicks on different rows don't
  // race each other. The seq is the canonical "is this still the
  // latest" check; AbortController kills the in-flight sub list.
  const seqByAccountRef = React.useRef<Record<string, number>>({});
  const abortByAccountRef = React.useRef<
    Record<string, AbortController | undefined>
  >({});

  // Tenant-list fetch-on-open. The Azure Accounts page pre-loads
  // tenants per account at first load (after the recent fix), so this
  // is normally a no-op. But if the operator opened the app fresh
  // OR an account was added after that load OR a refresh failed, we
  // back-fill here so the switcher always has tenants to show.
  const [tenantsFetching, setTenantsFetching] = React.useState<
    Set<string>
  >(new Set());
  const fetchedRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    if (!open || accounts.length === 0) return;
    const needsTenants = accounts.filter(
      (a) =>
        (!a.tenants || a.tenants.length === 0) &&
        !fetchedRef.current.has(a.homeAccountId),
    );
    if (needsTenants.length === 0) return;
    setTenantsFetching((prev) => {
      const next = new Set(prev);
      for (const a of needsTenants) next.add(a.homeAccountId);
      return next;
    });
    void Promise.allSettled(
      needsTenants.map(async (a) => {
        try {
          const list = await listAccessibleTenants(a.homeAccountId);
          store.updateAzureAccount(a.homeAccountId, { tenants: list });
          fetchedRef.current.add(a.homeAccountId);
        } catch {
          /* swallow — operator can retry by closing & reopening. */
        } finally {
          setTenantsFetching((prev) => {
            const next = new Set(prev);
            next.delete(a.homeAccountId);
            return next;
          });
        }
      }),
    );
  }, [open, accounts, store]);

  // Mod+Shift+T opens the popover from anywhere in the app.
  useShortcut("Mod+Shift+t", (e) => {
    e.preventDefault();
    setOpen((prev) => !prev);
  });

  // Primary account drives the pill label. We pick the most-recently-
  // added account as a heuristic — same convention as the rest of the
  // app, where the "primary" account is the one whose token most
  // pages use by default.
  const primaryAccount: AzureLoginAccount | null = accounts[0] ?? null;
  const primaryActiveTenantId = primaryAccount
    ? resolveActiveTenantId(primaryAccount)
    : undefined;
  const primaryTenantLabel = primaryAccount
    ? findTenantLabel(
        primaryAccount.tenants,
        primaryActiveTenantId,
        primaryActiveTenantId ?? "(no tenant)",
      )
    : "";

  /**
   * Run the canonical switch flow. Wraps `performTenantSwitch` with
   * per-account seq + AbortController bookkeeping so concurrent
   * rapid clicks across different rows don't step on each other,
   * AND a slow stale switch can't overwrite a faster newer one.
   */
  const onPickTenant = React.useCallback(
    async (account: AzureLoginAccount, tenantId: string) => {
      const homeAccountId = account.homeAccountId;
      if (switchingMap[homeAccountId]) return; // already switching this row
      const currentActive = resolveActiveTenantId(account);
      if (currentActive === tenantId) {
        setOpen(false); // no-op switch — just close
        return;
      }

      const seq = (seqByAccountRef.current[homeAccountId] ?? 0) + 1;
      seqByAccountRef.current[homeAccountId] = seq;
      // Abort any previous switch for this same account.
      abortByAccountRef.current[homeAccountId]?.abort();
      const controller = new AbortController();
      abortByAccountRef.current[homeAccountId] = controller;

      setSwitchingMap((prev) => ({ ...prev, [homeAccountId]: tenantId }));
      try {
        await performTenantSwitch(account, tenantId, store, {
          source: "header-switcher",
          signal: controller.signal,
          isStale: () =>
            (seqByAccountRef.current[homeAccountId] ?? 0) !== seq,
          onSuccess: () => {
            // Close the popover once the new tenant's subs have
            // loaded — gives the operator immediate visual feedback
            // that the switch landed.
            setOpen(false);
          },
        });
      } finally {
        // Only clear the spinner if we're still the latest switch.
        // Otherwise the newer switch is in flight and owns the row.
        if ((seqByAccountRef.current[homeAccountId] ?? 0) === seq) {
          setSwitchingMap((prev) => {
            const { [homeAccountId]: _drop, ...rest } = prev;
            return rest;
          });
          if (abortByAccountRef.current[homeAccountId] === controller) {
            delete abortByAccountRef.current[homeAccountId];
          }
        }
      }
    },
    [store, switchingMap],
  );

  // ─── Render: not-signed-in state ──────────────────────────────────
  if (accounts.length === 0) {
    if (!onAddAccount) return null;
    return (
      <Button
        variant="default"
        size="sm"
        onClick={onAddAccount}
        className="gap-1.5"
        aria-label="Sign in with Azure"
      >
        <LogIn className="h-3.5 w-3.5" />
        Sign in
      </Button>
    );
  }

  // ─── Render: signed-in state — pill + popover ─────────────────────
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "h-8 max-w-[18rem] gap-1.5 border-border bg-card/60 px-2.5 text-xs",
                "hover:border-primary/40 hover:bg-card",
                open && "border-primary/60 bg-card",
              )}
              aria-label="Switch active tenant"
              aria-haspopup="listbox"
              aria-expanded={open}
            >
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-primary/15 text-primary"
                aria-hidden="true"
              >
                <Building2 className="h-3 w-3" />
              </span>
              <span className="flex min-w-0 flex-col items-start leading-tight">
                <span className="truncate text-2xs uppercase tracking-wider text-muted-foreground">
                  {primaryAccount?.username ?? "—"}
                </span>
                <span className="truncate text-xs font-medium text-foreground">
                  {primaryTenantLabel || "(pick tenant)"}
                </span>
              </span>
              <ChevronsUpDown
                className="ml-1 h-3 w-3 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span className="inline-flex items-center gap-1.5">
            Switch active tenant
            <KbdChord keys={`${modKeyLabel()}+Shift+T`} />
          </span>
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[26rem] p-0"
        // Trap focus inside the popover when open. cmdk handles the
        // arrow-key/enter wiring; Radix Popover handles Escape +
        // outside-click + focus return.
      >
        <Command
          // cmdk uses substring match across every CommandItem's
          // `value` prop. We build `value` to include both the
          // account username AND the tenant identifiers so a single
          // search hits either.
          label="Switch tenant"
        >
          <CommandInput
            placeholder="Search by tenant name, domain, or account…"
            autoFocus
          />
          <CommandList className="max-h-[60vh]">
            <CommandEmpty>No matching tenants.</CommandEmpty>
            {accounts.map((acct) => {
              const accountTenants = acct.tenants ?? [];
              const activeTenantId = resolveActiveTenantId(acct);
              const isLoading = tenantsFetching.has(acct.homeAccountId);
              const inFlightTenantId = switchingMap[acct.homeAccountId];
              return (
                <CommandGroup
                  key={acct.homeAccountId}
                  heading={acct.username || acct.name || acct.homeAccountId}
                >
                  {accountTenants.length === 0 && !isLoading && (
                    <CommandItem
                      value={`${acct.homeAccountId}-no-tenants`}
                      disabled
                      className="text-2xs italic text-muted-foreground"
                    >
                      <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                      No tenants loaded for this account — visit Azure
                      Accounts to refresh.
                    </CommandItem>
                  )}
                  {isLoading && (
                    <CommandItem
                      value={`${acct.homeAccountId}-loading`}
                      disabled
                      className="text-2xs italic text-muted-foreground"
                    >
                      <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                      Loading tenants…
                    </CommandItem>
                  )}
                  {accountTenants.map((t) => {
                    const isActive = t.tenantId === activeTenantId;
                    const isInFlight = inFlightTenantId === t.tenantId;
                    const isHome = t.tenantId === acct.tenantId;
                    const friendly =
                      t.displayName ??
                      t.defaultDomain ??
                      shortGuid(t.tenantId);
                    // Include searchable tokens in `value` so cmdk
                    // can match. The visible label comes from JSX.
                    const searchValue = [
                      acct.username ?? "",
                      acct.name ?? "",
                      t.displayName ?? "",
                      t.defaultDomain ?? "",
                      t.tenantId ?? "",
                    ]
                      .filter(Boolean)
                      .join(" ")
                      .toLowerCase();
                    return (
                      <CommandItem
                        key={`${acct.homeAccountId}-${t.tenantId}`}
                        value={`${acct.homeAccountId}:${t.tenantId}:${searchValue}`}
                        disabled={!!inFlightTenantId}
                        onSelect={() => {
                          void onPickTenant(acct, t.tenantId);
                        }}
                        className={cn(
                          "group/row gap-2",
                          isActive && "bg-primary/5",
                        )}
                      >
                        <span
                          className="flex h-5 w-5 shrink-0 items-center justify-center"
                          aria-hidden="true"
                        >
                          {isInFlight ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none" />
                          ) : isActive ? (
                            <Check className="h-3.5 w-3.5 text-primary" />
                          ) : (
                            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 group-hover/row:bg-muted-foreground/70" />
                          )}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium text-foreground">
                              {friendly}
                            </span>
                            {isHome && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                    aria-label="Home tenant"
                                    className="flex h-3.5 w-3.5 items-center justify-center text-muted-foreground"
                                  >
                                    <Star className="h-3 w-3" />
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="right">
                                  Home tenant of this account
                                </TooltipContent>
                              </Tooltip>
                            )}
                            {isActive && (
                              <span className="rounded-full bg-primary/15 px-1.5 text-2xs font-medium text-primary">
                                active
                              </span>
                            )}
                            {isInFlight && (
                              <span className="rounded-full bg-warning/15 px-1.5 text-2xs font-medium text-warning-foreground">
                                switching…
                              </span>
                            )}
                          </span>
                          <span className="truncate font-mono text-2xs text-muted-foreground">
                            {t.defaultDomain ?? shortGuid(t.tenantId)}
                          </span>
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            })}
            <CommandSeparator />
            <CommandGroup heading="Actions">
              {onAddAccount && (
                <CommandItem
                  value="action-add-account"
                  onSelect={() => {
                    setOpen(false);
                    onAddAccount();
                  }}
                >
                  <Plus className="h-3.5 w-3.5 text-primary" />
                  <span className="text-sm">Add another Azure account</span>
                </CommandItem>
              )}
              {onOpenManage && (
                <CommandItem
                  value="action-open-manage"
                  onSelect={() => {
                    setOpen(false);
                    onOpenManage();
                  }}
                >
                  <UserCog className="h-3.5 w-3.5 text-primary" />
                  <span className="text-sm">Open Azure Accounts page</span>
                </CommandItem>
              )}
              <CommandItem
                value="action-keyboard-hint"
                disabled
                className="text-2xs italic text-muted-foreground"
              >
                <Settings className="h-3.5 w-3.5" />
                <span className="flex-1">Open this anywhere with</span>
                <KbdChord keys={`${modKeyLabel()}+Shift+T`} />
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
