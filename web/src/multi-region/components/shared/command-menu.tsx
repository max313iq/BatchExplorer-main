/**
 * Command palette (Cmd-K) per Design Contract §N. Wired to the canonical
 * routes from §4.1 plus app-level actions (refresh all, save session, export
 * session, toggle theme). Pages can register their own commands via
 * `useCommands()` hook (see PageCommandsContext below).
 */
import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  ActivityIcon,
  BadgeCheck,
  Boxes,
  Calculator,
  Copy as CopyIcon,
  Cpu,
  Download,
  Gauge,
  Grid3x3,
  History,
  KeyboardIcon,
  KeyRound,
  Layers,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  Moon,
  PiggyBank,
  RefreshCw,
  Save,
  Server,
  ServerCog,
  Settings,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Sun,
  User,
  UserPlus,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useShortcut, modKeyLabel } from "../../hooks/use-shortcut";
import {
  useRegisteredCommands,
  type RegisteredCommand,
} from "../../hooks/use-command-palette";

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export interface AppCommand {
  /** Stable id for de-dup across page registrations. */
  id: string;
  /** Group heading (e.g. "Navigate", "Actions"). */
  group: string;
  /** User-facing label. */
  label: string;
  /** Optional searchable keywords. */
  keywords?: string[];
  /** Optional inline icon. */
  icon?: LucideIcon;
  /** Optional shortcut display (right-aligned). Display only, not a binding. */
  shortcut?: string;
  /** Action invoked on select. Called after the dialog closes. */
  run: () => void;
}

interface PageCommandsState {
  commands: AppCommand[];
  register: (commands: AppCommand[]) => () => void;
}

const PageCommandsContext = React.createContext<PageCommandsState | null>(null);

/**
 * Provider — sits inside the dashboard shell so page-level command
 * contributions can flow up to the palette. Pages call `useCommands` to
 * register their own commands; registrations are removed on unmount.
 */
export const PageCommandsProvider: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const [commands, setCommands] = React.useState<AppCommand[]>([]);

  const register = React.useCallback((toRegister: AppCommand[]) => {
    setCommands((prev) => {
      const ids = new Set(toRegister.map((c) => c.id));
      const filtered = prev.filter((c) => !ids.has(c.id));
      return [...filtered, ...toRegister];
    });
    return () => {
      const ids = new Set(toRegister.map((c) => c.id));
      setCommands((prev) => prev.filter((c) => !ids.has(c.id)));
    };
  }, []);

  const value = React.useMemo(
    () => ({ commands, register }),
    [commands, register],
  );

  return (
    <PageCommandsContext.Provider value={value}>
      {children}
    </PageCommandsContext.Provider>
  );
};

/**
 * Page hook for contributing commands. Call once per page render with the
 * fresh array; the provider de-dupes by `id`.
 */
export function useCommands(commands: AppCommand[]): void {
  const ctx = React.useContext(PageCommandsContext);
  React.useEffect(() => {
    if (!ctx) return;
    return ctx.register(commands);
    // The commands array is intentionally not in deps — pages should pass a
    // stable array (memoize with useMemo) and call this once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// ---------------------------------------------------------------------------
// Default navigation + action commands
// ---------------------------------------------------------------------------

interface DefaultCommandHandlers {
  onRefreshAll?: () => void;
  onSaveSession?: () => void;
  onExportSession?: () => void;
  onToggleTheme?: () => void;
  onToggleDensity?: () => void;
  onShowKeyboardHelp?: () => void;
  onSignOut?: () => void;
  onClearSignInCache?: () => void;
}

function buildDefaultCommands(
  navigate: ReturnType<typeof useNavigate>,
  handlers: DefaultCommandHandlers,
): AppCommand[] {
  const nav = (path: string): (() => void) => () => navigate(path);
  const mod = modKeyLabel();
  // Commands grouped by the same four sidebar groups so users can scan the
  // palette by task area. Each PageKey in the sidebar has a corresponding
  // entry here so every page is reachable via Cmd-K, not just the Alt+1..9
  // top nine.
  const cmds: AppCommand[] = [
    // ── Identity & Users ─────────────────────────────────────────────────
    {
      id: "nav.azure-accounts",
      group: "Identity & Users",
      label: "Azure Accounts",
      icon: User,
      keywords: ["accounts", "tenant", "msal", "identity"],
      shortcut: "Alt+1",
      run: nav("/azure-accounts"),
    },
    {
      id: "nav.token-importer",
      group: "Identity & Users",
      label: "Import Token",
      icon: KeyRound,
      keywords: ["token", "bearer", "paste"],
      run: nav("/token-importer"),
    },
    {
      id: "nav.tenant-users",
      group: "Identity & Users",
      label: "Tenant Users",
      icon: Users,
      keywords: ["password", "reset", "directory"],
      run: nav("/tenant-users"),
    },
    {
      id: "nav.mfa-manager",
      group: "Identity & Users",
      label: "MFA Manager",
      icon: ShieldCheck,
      keywords: [
        "mfa",
        "2fa",
        "authentication",
        "methods",
        "reset",
        "totp",
        "oath",
        "temporary access pass",
        "tap",
        "phone",
      ],
      run: nav("/mfa-manager"),
    },
    {
      id: "nav.user-creator",
      group: "Identity & Users",
      label: "Create User",
      icon: UserPlus,
      keywords: ["AD", "new", "member"],
      run: nav("/user-creator"),
    },
    {
      id: "nav.invite-user",
      group: "Identity & Users",
      label: "Invite User",
      icon: Mail,
      keywords: ["guest", "B2B", "invitation"],
      run: nav("/invite-user"),
    },

    // ── Batch & Compute ──────────────────────────────────────────────────
    {
      id: "nav.overview",
      group: "Batch & Compute",
      label: "Overview",
      icon: LayoutDashboard,
      keywords: ["dashboard", "summary"],
      shortcut: "Alt+2",
      run: nav("/overview"),
    },
    {
      id: "nav.accounts",
      group: "Batch & Compute",
      label: "Accounts",
      icon: ServerCog,
      keywords: ["batch accounts", "provisioning"],
      shortcut: "Alt+3",
      run: nav("/accounts"),
    },
    {
      id: "nav.pools",
      group: "Batch & Compute",
      label: "Pools",
      icon: Boxes,
      keywords: ["pool creation"],
      shortcut: "Alt+4",
      run: nav("/pools"),
    },
    {
      id: "nav.pool-defaults",
      group: "Batch & Compute",
      label: "Pool Settings",
      icon: Settings,
      keywords: ["defaults", "template"],
      shortcut: "Alt+5",
      run: nav("/pool-defaults"),
    },
    {
      id: "nav.pool-info",
      group: "Batch & Compute",
      label: "Pool Info",
      icon: Grid3x3,
      keywords: ["pool details"],
      shortcut: "Alt+6",
      run: nav("/pool-info"),
    },
    {
      id: "nav.account-info",
      group: "Batch & Compute",
      label: "Account Info",
      icon: Users,
      keywords: ["quota", "details"],
      shortcut: "Alt+7",
      run: nav("/account-info"),
    },
    {
      id: "nav.nodes",
      group: "Batch & Compute",
      label: "Nodes",
      icon: Server,
      keywords: ["compute", "vm"],
      run: nav("/nodes"),
    },
    {
      id: "nav.unused-quota",
      group: "Batch & Compute",
      label: "Unused Quota",
      icon: PiggyBank,
      keywords: ["free cores", "lp", "low-priority"],
      shortcut: "Alt+8",
      run: nav("/unused-quota"),
    },

    // ── Subscriptions & Billing ──────────────────────────────────────────
    {
      id: "nav.sub-manager",
      group: "Subscriptions & Billing",
      label: "Sub Manager",
      icon: ServerCog,
      keywords: ["subscription", "manage"],
      run: nav("/sub-manager"),
    },
    {
      id: "nav.sub-mover",
      group: "Subscriptions & Billing",
      label: "Sub Mover",
      icon: BadgeCheck,
      keywords: ["subscription", "move", "transfer"],
      run: nav("/sub-mover"),
    },
    {
      id: "nav.resource-manager",
      group: "Subscriptions & Billing",
      label: "Resource Manager",
      icon: Boxes,
      keywords: ["resource group", "arm"],
      run: nav("/resource-manager"),
    },
    {
      id: "nav.ea-billing-manager",
      group: "Subscriptions & Billing",
      label: "EA Billing Manager",
      icon: Wallet,
      keywords: ["enrollment", "billing", "ea"],
      run: nav("/ea-billing-manager"),
    },
    {
      id: "nav.department-admin",
      group: "Subscriptions & Billing",
      label: "Department Admin",
      icon: Layers,
      keywords: ["ea", "department", "billing"],
      run: nav("/department-admin"),
    },
    {
      id: "nav.ea-subscription",
      group: "Subscriptions & Billing",
      label: "Create EA Subscription",
      icon: BadgeCheck,
      keywords: ["billing", "enrollment", "ea"],
      run: nav("/ea-subscription"),
    },
    {
      id: "nav.ea-creator-pregrant",
      group: "Subscriptions & Billing",
      label: "Pre-grant EA Subscription Creator",
      icon: ShieldCheck,
      keywords: ["ea", "role", "grant", "pregrant", "subscription", "creator"],
      run: nav("/ea-creator-pregrant"),
    },
    {
      id: "nav.ea-sub-quick",
      group: "Subscriptions & Billing",
      label: "Create EA Sub (quick)",
      icon: Sparkles,
      keywords: ["ea", "quick", "fast"],
      run: nav("/ea-sub-quick"),
    },
    {
      id: "nav.legacy-ea-sub",
      group: "Subscriptions & Billing",
      label: "Create EA Sub (legacy)",
      icon: BadgeCheck,
      keywords: ["ea", "legacy"],
      run: nav("/legacy-ea-sub"),
    },

    // ── Diagnostics & Tools ──────────────────────────────────────────────
    {
      id: "nav.monitoring",
      group: "Diagnostics & Tools",
      label: "Monitoring",
      icon: ActivityIcon,
      keywords: ["health", "metrics", "logs"],
      shortcut: "Alt+9",
      run: nav("/monitoring"),
    },
    {
      id: "nav.gpu-calculator",
      group: "Diagnostics & Tools",
      label: "GPU Calculator",
      icon: Calculator,
      keywords: ["cost", "vm size", "gpu"],
      run: nav("/gpu-calculator"),
    },
    {
      id: "nav.vm-catalog",
      group: "Diagnostics & Tools",
      label: "VM Catalog",
      icon: Cpu,
      keywords: ["sku", "vm size", "catalog"],
      run: nav("/vm-catalog"),
    },
    {
      id: "nav.audit-log",
      group: "Diagnostics & Tools",
      label: "Audit Log",
      icon: History,
      keywords: ["history", "audit"],
      run: nav("/audit-log"),
    },
    {
      id: "nav.tasks",
      group: "Diagnostics & Tools",
      label: "Task Manager",
      icon: ListChecks,
      keywords: ["tasks", "jobs", "background"],
      run: nav("/tasks"),
    },
    {
      id: "nav.throttle",
      group: "Diagnostics & Tools",
      label: "Throttle Status",
      icon: Gauge,
      keywords: ["rate limit", "circuit", "429"],
      run: nav("/throttle"),
    },
  ];

  // Actions
  if (handlers.onRefreshAll) {
    cmds.push({
      id: "action.refresh-all",
      group: "Actions",
      label: "Refresh all data",
      icon: RefreshCw,
      run: handlers.onRefreshAll,
    });
  }
  if (handlers.onSaveSession) {
    cmds.push({
      id: "action.save-session",
      group: "Actions",
      label: "Save session",
      icon: Save,
      shortcut: `${mod}+S`,
      run: handlers.onSaveSession,
    });
  }
  if (handlers.onExportSession) {
    cmds.push({
      id: "action.export-session",
      group: "Actions",
      label: "Export session as JSON",
      icon: Download,
      shortcut: `${mod}+E`,
      run: handlers.onExportSession,
    });
  }
  if (handlers.onToggleTheme) {
    cmds.push({
      id: "action.toggle-theme",
      group: "View",
      label: "Toggle dark / light mode",
      icon: Moon,
      shortcut: `${mod}+D`,
      run: handlers.onToggleTheme,
    });
  }
  if (handlers.onToggleDensity) {
    cmds.push({
      id: "action.toggle-density",
      group: "View",
      label: "Toggle row density",
      icon: Sun,
      shortcut: `${mod}+Shift+D`,
      run: handlers.onToggleDensity,
    });
  }
  if (handlers.onShowKeyboardHelp) {
    cmds.push({
      id: "action.show-keyboard-help",
      group: "Help",
      label: "Show keyboard shortcuts",
      icon: KeyboardIcon,
      shortcut: "?",
      run: handlers.onShowKeyboardHelp,
    });
  }

  // Utility commands. Copy-URL + Reload work in any environment (no
  // handler needed). Sign-out + Clear-cache are gated on handlers so a
  // demo / preview surface can omit them.
  cmds.push({
    id: "action.copy-current-url",
    group: "Actions",
    label: "Copy current page URL",
    icon: CopyIcon,
    keywords: ["link", "share", "permalink"],
    run: () => {
      if (typeof window === "undefined") return;
      const href = window.location.href;
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText !== undefined
      ) {
        void navigator.clipboard.writeText(href).catch(() => {});
      }
    },
  });
  cmds.push({
    id: "action.reload-page",
    group: "Actions",
    label: "Reload page",
    icon: RefreshCw,
    keywords: ["refresh", "hard"],
    run: () => {
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    },
  });
  if (handlers.onSignOut) {
    cmds.push({
      id: "action.sign-out",
      group: "Actions",
      label: "Sign out",
      icon: LogOut,
      keywords: ["msal", "logout"],
      run: handlers.onSignOut,
    });
  }
  if (handlers.onClearSignInCache) {
    cmds.push({
      id: "action.clear-sign-in-cache",
      group: "Actions",
      label: "Clear sign-in cache and reload",
      icon: ShieldX,
      keywords: ["msal", "purge", "reset", "auth"],
      run: handlers.onClearSignInCache,
    });
  }

  return cmds;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface CommandMenuProps extends DefaultCommandHandlers {
  /** Open-state, controlled. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const CommandMenu: React.FC<CommandMenuProps> = ({
  open,
  onOpenChange,
  ...handlers
}) => {
  const navigate = useNavigate();
  const ctx = React.useContext(PageCommandsContext);
  // Cross-cutting commands registered via `registerCommand()` from the
  // hooks/use-command-palette registry. This is the "any module anywhere
  // can contribute" channel (e.g. auth pod adds "Sign out", task pod adds
  // "Cancel all running"). The PageCommandsContext channel above is
  // page-scoped — registrations there auto-unregister on page unmount.
  const registered = useRegisteredCommands();

  const allCommands = React.useMemo(() => {
    const defaults = buildDefaultCommands(navigate, handlers);
    // Convert RegisteredCommand → AppCommand. The two shapes diverge on a
    // few fields (`section` vs `group`, `description` vs not) — flatten
    // here so the palette renders both uniformly.
    const fromRegistry: AppCommand[] = registered.map(
      (cmd: RegisteredCommand): AppCommand => ({
        id: cmd.id,
        group: cmd.section ?? "Commands",
        label: cmd.label,
        keywords: cmd.keywords,
        shortcut: cmd.shortcut,
        run: cmd.run,
      }),
    );
    return [...defaults, ...(ctx?.commands ?? []), ...fromRegistry];
  }, [navigate, handlers, ctx?.commands, registered]);

  // Group commands for rendering
  const grouped = React.useMemo(() => {
    const map = new Map<string, AppCommand[]>();
    for (const cmd of allCommands) {
      const list = map.get(cmd.group) ?? [];
      list.push(cmd);
      map.set(cmd.group, list);
    }
    return Array.from(map.entries());
  }, [allCommands]);

  const handleSelect = React.useCallback(
    (cmd: AppCommand) => {
      onOpenChange(false);
      // Defer the run to the next tick so the dialog closes cleanly.
      setTimeout(cmd.run, 0);
    },
    [onOpenChange],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} label="Command palette">
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No matching command.</CommandEmpty>
        {grouped.map(([group, cmds], i) => (
          <React.Fragment key={group}>
            {i > 0 && <CommandSeparator />}
            <CommandGroup heading={group}>
              {cmds.map((cmd) => {
                const Icon = cmd.icon;
                return (
                  <CommandItem
                    key={cmd.id}
                    value={`${cmd.label} ${cmd.keywords?.join(" ") ?? ""}`}
                    onSelect={() => handleSelect(cmd)}
                  >
                    {Icon && (
                      <Icon className="text-muted-foreground" aria-hidden="true" />
                    )}
                    <span>{cmd.label}</span>
                    {cmd.shortcut && (
                      <CommandShortcut>{cmd.shortcut}</CommandShortcut>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </React.Fragment>
        ))}
      </CommandList>
    </CommandDialog>
  );
};

/**
 * Convenience: bind Cmd-K and own the open-state. Drop into the dashboard
 * shell once.
 */
export const ConnectedCommandMenu: React.FC<DefaultCommandHandlers> = (
  handlers,
) => {
  const [open, setOpen] = React.useState(false);
  useShortcut("Mod+K", () => setOpen((p) => !p));
  return <CommandMenu open={open} onOpenChange={setOpen} {...handlers} />;
};
