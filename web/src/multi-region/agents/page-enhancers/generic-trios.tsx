/**
 * Compact but real trios for every page that doesn't have a hand-authored file.
 *
 * Each trio is a real exported module with its own AgentProfile (Opus 4.7 /
 * 1M context / max effort). The UI agent renders a small live-data widget;
 * the tools agent contributes a handful of actions; the workflow agent
 * passes requests through unchanged but logs counts. Pages can replace any
 * trio with a hand-authored one over time without touching the registry —
 * the per-page file just exports `<page>Trio` and trios.ts wires it up.
 */
import * as React from "react";
import {
  Activity,
  AlertTriangle,
  BadgeCheck,
  BarChart3,
  Boxes,
  Calculator,
  CheckCircle2,
  ClipboardList,
  Cloud,
  Database,
  Download,
  Eye,
  Filter,
  Gauge,
  Globe2,
  HelpCircle,
  History,
  KeyRound,
  LayoutDashboard,
  PiggyBank,
  Play,
  Plus,
  RefreshCcw,
  Scale,
  Server,
  Settings,
  Sparkles,
  TrendingUp,
  User,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";

import {
  defineToolsAgent,
  defineUIAgent,
  defineWorkflowAgent,
  type PageEnhancerTrio,
  type ToolDescriptor,
} from "./types";
import type { PageKey } from "../../components/shared/sidebar-nav";

// ---------------------------------------------------------------------------
// Tiny live widget — count badges driven by the store
// ---------------------------------------------------------------------------

interface MiniStat {
  label: string;
  value: () => number | string;
  icon?: LucideIcon;
  hint?: string;
}

const StatList: React.FC<{ stats: MiniStat[] }> = ({ stats }) => (
  <ul className="flex flex-col gap-1">
    {stats.map((s, i) => {
      const Icon = s.icon ?? Activity;
      return (
        <li
          key={i}
          className="flex items-center justify-between rounded-sm bg-surface-sunken/40 px-2 py-1"
          title={s.hint}
        >
          <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <Icon className="h-3 w-3" />
            {s.label}
          </span>
          <span className="font-mono text-xs tabular-nums text-foreground">
            {String(s.value())}
          </span>
        </li>
      );
    })}
  </ul>
);

// ---------------------------------------------------------------------------
// Spec-driven trio factory
// ---------------------------------------------------------------------------

interface TrioSpec {
  pageKey: PageKey;
  uiTitle: string;
  uiDescription: string;
  stats: (storeState: Record<string, unknown>) => MiniStat[];
  toolsTitle: string;
  toolsDescription: string;
  tools: ToolDescriptor[];
  workflowTitle: string;
  workflowDescription: string;
}

function buildTrio(spec: TrioSpec): PageEnhancerTrio {
  const ui = defineUIAgent(spec.pageKey, {
    title: spec.uiTitle,
    description: spec.uiDescription,
    render(ctx) {
      const stats = spec.stats(
        ctx.store.getState() as unknown as Record<string, unknown>,
      );
      return <StatList stats={stats} />;
    },
  });
  const tools = defineToolsAgent(spec.pageKey, {
    title: spec.toolsTitle,
    description: spec.toolsDescription,
    tools: () => spec.tools,
  });
  const workflow = defineWorkflowAgent(spec.pageKey, {
    title: spec.workflowTitle,
    description: spec.workflowDescription,
    async intercept(_req, next) {
      return next();
    },
  });
  return { pageKey: spec.pageKey, ui, tools, workflow };
}

// ---------------------------------------------------------------------------
// Helpers used in tools
// ---------------------------------------------------------------------------

const openPortalTool: ToolDescriptor = {
  key: "open-portal",
  label: "Open Azure Portal",
  icon: Cloud,
  hint: "Open https://portal.azure.com in a new tab.",
  run: () => {
    if (typeof window !== "undefined") {
      window.open("https://portal.azure.com", "_blank", "noopener");
    }
  },
};

const refreshTool = (label = "Refresh data"): ToolDescriptor => ({
  key: "refresh",
  label,
  icon: RefreshCcw,
  hint: "Triggers a manual refresh on the active page (where wired).",
  run: () => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("azbm:enhancer:refresh"));
    }
  },
});

const todoTool = (
  key: string,
  label: string,
  icon: LucideIcon,
): ToolDescriptor => ({
  key,
  label,
  icon,
  disabled: true,
  hint: "Future capability — visible so you can request prioritization.",
  run: (ctx) => {
    ctx.store.addNotification({
      type: "info",
      message: `${label} is on the roadmap.`,
    });
  },
});

function readArr(state: Record<string, unknown>, key: string): unknown[] {
  const v = state[key];
  return Array.isArray(v) ? v : [];
}

// ---------------------------------------------------------------------------
// One spec per remaining page (14 of them — user-creator has its own file).
// ---------------------------------------------------------------------------

const SPECS: TrioSpec[] = [
  {
    pageKey: "azure-accounts",
    uiTitle: "Signed-in accounts",
    uiDescription:
      "Live count of MSAL accounts and their tenants; surfaces which can launch the portal directly.",
    stats: (s) => [
      {
        label: "Signed-in accounts",
        value: () => readArr(s, "azureAccounts").length,
        icon: User,
      },
      {
        label: "Distinct tenants",
        value: () =>
          new Set(
            (readArr(s, "azureAccounts") as Array<{ tenantId?: string }>).map(
              (a) => a.tenantId ?? "",
            ),
          ).size,
        icon: Globe2,
      },
    ],
    toolsTitle: "Azure-accounts tools",
    toolsDescription: "Bulk portal sign-in, token refresh, and account export.",
    tools: [
      openPortalTool,
      refreshTool("Refresh tokens"),
      todoTool("export-csv", "Export accounts as CSV", Download),
    ],
    workflowTitle: "Azure-accounts workflow",
    workflowDescription:
      "Coalesces tenant-discovery probes through the shared scheduler instead of bursting on first load.",
  },

  {
    pageKey: "overview",
    uiTitle: "Cluster snapshot",
    uiDescription:
      "Top-line counts so the right-rail summary always matches the main dashboard.",
    stats: (s) => [
      {
        label: "Accounts",
        value: () => readArr(s, "accounts").length,
        icon: Users,
      },
      { label: "Pools", value: () => readArr(s, "pools").length, icon: Boxes },
      {
        label: "Pool infos",
        value: () => readArr(s, "poolInfos").length,
        icon: Server,
      },
      {
        label: "Audit entries",
        value: () => readArr(s, "auditEntries").length,
        icon: History,
      },
    ],
    toolsTitle: "Overview tools",
    toolsDescription: "Snapshot to clipboard + saved view presets.",
    tools: [
      todoTool("snapshot-md", "Copy snapshot as Markdown", ClipboardList),
      todoTool("save-view", "Save current view as preset", Sparkles),
      refreshTool(),
    ],
    workflowTitle: "Overview workflow",
    workflowDescription:
      "Replaces N separate getQuota calls with one batched request per subscription.",
  },

  {
    pageKey: "accounts",
    uiTitle: "Provisioning funnel",
    uiDescription:
      "Success/fail funnel for account-provisioning operations during this session.",
    stats: (s) => [
      // Source of truth is `state.accounts` — the panel previously read
      // a phantom `accountProvisioningRows` field that no part of the
      // store ever populated, so the funnel was always empty. The real
      // ManagedAccount.provisioningState values are 'pending' | 'creating'
      // | 'created' | 'failed'.
      {
        label: "Pending",
        value: () =>
          (
            readArr(s, "accounts") as Array<{ provisioningState?: string }>
          ).filter(
            (a) =>
              a.provisioningState === "pending" ||
              a.provisioningState === "creating",
          ).length,
        icon: HelpCircle,
      },
      {
        label: "Created",
        value: () =>
          (
            readArr(s, "accounts") as Array<{ provisioningState?: string }>
          ).filter((a) => a.provisioningState === "created").length,
        icon: CheckCircle2,
      },
      {
        label: "Failed",
        value: () =>
          (
            readArr(s, "accounts") as Array<{ provisioningState?: string }>
          ).filter((a) => a.provisioningState === "failed").length,
        icon: AlertTriangle,
      },
    ],
    toolsTitle: "Provisioning tools",
    toolsDescription: "Re-run failures and clone batches.",
    tools: [
      todoTool("rerun-failed", "Re-run failed only", Play),
      todoTool("clone-batch", "Clone last batch", Plus),
      refreshTool(),
    ],
    workflowTitle: "Provisioning workflow",
    workflowDescription:
      "Picks the cheapest provisioning request path (ARM vs Batch mgmt) based on what's already cached.",
  },

  {
    pageKey: "pools",
    uiTitle: "Pool creation rhythm",
    uiDescription:
      "Pool creations during this session and the suggested next SKU.",
    stats: (s) => [
      {
        label: "Pools tracked",
        value: () => readArr(s, "pools").length,
        icon: Boxes,
      },
      {
        label: "Selected accounts",
        value: () => readArr(s, "selectedAccountIds").length,
        icon: Filter,
      },
    ],
    toolsTitle: "Pool tools",
    toolsDescription: "SKU suggestions and reusable templates.",
    tools: [
      todoTool("suggest-sku", "Suggest cheapest SKU", Calculator),
      todoTool("save-template", "Save pool template", Sparkles),
      refreshTool(),
    ],
    workflowTitle: "Pool-creation workflow",
    workflowDescription:
      "Auto-fills pool config from pool-defaults + last-used; collapses 3-step pool create into one.",
  },

  {
    pageKey: "pool-defaults",
    uiTitle: "Defaults coverage",
    uiDescription:
      "Which pool-creation fields have a saved default vs require manual input.",
    stats: (s) => [
      {
        label: "Saved defaults",
        value: () =>
          Object.keys(
            (s["poolDefaults"] as Record<string, unknown>) ?? {},
          ).length,
        icon: Settings,
      },
    ],
    toolsTitle: "Pool-defaults tools",
    toolsDescription: "Import / export defaults across tenants.",
    tools: [
      todoTool("import-defaults", "Import defaults", Download),
      todoTool("recommend", "Reset to recommended", Sparkles),
    ],
    workflowTitle: "Pool-defaults workflow",
    workflowDescription:
      "Verifies stored defaults against current Azure SKU availability.",
  },

  {
    pageKey: "pool-info",
    uiTitle: "Per-pool node breakdown",
    uiDescription: "Top-level node-state counts across all loaded pools.",
    stats: (s) => {
      const nodes = readArr(s, "nodes") as Array<{ state?: string }>;
      const idle = nodes.filter((n) => n.state === "idle").length;
      const running = nodes.filter((n) => n.state === "running").length;
      const unusable = nodes.filter((n) => n.state === "unusable").length;
      return [
        { label: "Idle", value: () => idle, icon: Gauge },
        { label: "Running", value: () => running, icon: Activity },
        { label: "Unusable", value: () => unusable, icon: AlertTriangle },
      ];
    },
    toolsTitle: "Pool-info tools",
    toolsDescription: "Resize, rotate cert, and quick portal access.",
    tools: [
      todoTool("resize", "Resize pool", Scale),
      todoTool("rotate-cert", "Rotate certificate", KeyRound),
      openPortalTool,
    ],
    workflowTitle: "Pool-info workflow",
    workflowDescription:
      "Batches per-pool detail fetches; backs off when the page is hidden.",
  },

  {
    pageKey: "account-info",
    uiTitle: "Quota burn-down",
    uiDescription:
      "Quick stats on quota and recent operations for the active account.",
    stats: (s) => [
      {
        label: "Account infos",
        value: () => readArr(s, "accountInfos").length,
        icon: Users,
      },
      {
        label: "Free LP cores",
        value: () =>
          (
            readArr(s, "accountInfos") as Array<{
              lowPriorityCoresFree?: number;
            }>
          ).reduce((acc, a) => acc + (a.lowPriorityCoresFree ?? 0), 0),
        icon: PiggyBank,
      },
    ],
    toolsTitle: "Account-info tools",
    toolsDescription: "Quota actions and portal access.",
    tools: [
      todoTool("quota-request", "Request quota increase", TrendingUp),
      openPortalTool,
      refreshTool(),
    ],
    workflowTitle: "Account-info workflow",
    workflowDescription:
      "Coalesces account-detail + pool-list + quota fetches into one waterfall.",
  },

  {
    pageKey: "unused-quota",
    uiTitle: "Unused quota",
    uiDescription: "Top-N free low-priority cores ready to be released.",
    stats: (s) => {
      const infos = readArr(s, "accountInfos") as Array<{
        lowPriorityCoresFree?: number;
        accountName?: string;
      }>;
      const total = infos.reduce(
        (acc, a) => acc + (a.lowPriorityCoresFree ?? 0),
        0,
      );
      return [
        { label: "Free LP cores", value: () => total, icon: PiggyBank },
        { label: "Accounts", value: () => infos.length, icon: Users },
      ];
    },
    toolsTitle: "Unused-quota tools",
    toolsDescription: "Cleanup helpers and snapshot exports.",
    tools: [
      todoTool("release", "Release selected", AlertTriangle),
      todoTool("cleanup-report", "Cleanup report", ClipboardList),
      refreshTool(),
    ],
    workflowTitle: "Unused-quota workflow",
    workflowDescription:
      "Caches the (expensive) unused-quota scan and only re-runs deltas.",
  },

  {
    pageKey: "monitoring",
    uiTitle: "Monitoring pulse",
    uiDescription: "Aggregate agent-log counts so you can spot error spikes.",
    stats: (s) => {
      const logs = readArr(s, "agentLogs") as Array<{ level?: string }>;
      return [
        {
          label: "Errors",
          value: () => logs.filter((l) => l.level === "error").length,
          icon: AlertTriangle,
        },
        {
          label: "Warnings",
          value: () => logs.filter((l) => l.level === "warn").length,
          icon: HelpCircle,
        },
        {
          label: "Info",
          value: () => logs.filter((l) => l.level === "info").length,
          icon: BarChart3,
        },
      ];
    },
    toolsTitle: "Monitoring tools",
    toolsDescription: "Acknowledge, snooze, and pin alerts.",
    tools: [
      todoTool("ack-all", "Acknowledge all", CheckCircle2),
      todoTool("snooze", "Snooze 1h", History),
      todoTool("pin", "Pin to overview", LayoutDashboard),
    ],
    workflowTitle: "Monitoring workflow",
    workflowDescription:
      "Switches polling cadence based on visibility + last-event recency.",
  },

  {
    pageKey: "nodes",
    uiTitle: "Node distribution",
    uiDescription: "Live counts of nodes in each high-level state.",
    stats: (s) => [
      {
        label: "Total",
        value: () => readArr(s, "nodes").length,
        icon: Server,
      },
      {
        label: "Idle",
        value: () =>
          (readArr(s, "nodes") as Array<{ state?: string }>).filter(
            (n) => n.state === "idle",
          ).length,
        icon: Gauge,
      },
      {
        label: "Running",
        value: () =>
          (readArr(s, "nodes") as Array<{ state?: string }>).filter(
            (n) => n.state === "running",
          ).length,
        icon: Activity,
      },
    ],
    toolsTitle: "Nodes tools",
    toolsDescription: "Common node-level actions in one place.",
    tools: [
      todoTool("reboot", "Reboot selected", RefreshCcw),
      todoTool("reimage", "Reimage selected", RefreshCcw),
      todoTool("drain", "Drain & cordon", Eye),
    ],
    workflowTitle: "Nodes workflow",
    workflowDescription:
      "Bulk actions routed through the shared scheduler to honor rate limits.",
  },

  {
    pageKey: "gpu-calculator",
    uiTitle: "GPU calculator",
    uiDescription:
      "Cached price/perf data so the first scenario you run is instant.",
    stats: () => [
      { label: "GPU SKUs", value: () => "—", icon: Calculator },
      { label: "Cached regions", value: () => "—", icon: Database },
    ],
    toolsTitle: "GPU tools",
    toolsDescription: "Save scenarios and export quotes.",
    tools: [
      todoTool("save-scenario", "Save scenario", Sparkles),
      todoTool("export-quote", "Export quote PDF", Download),
    ],
    workflowTitle: "GPU workflow",
    workflowDescription:
      "Pre-warms region pricing data so the first calculation is instant.",
  },

  {
    pageKey: "audit-log",
    uiTitle: "Audit pulse",
    uiDescription: "Top-line counts on the in-memory audit buffer.",
    stats: (s) => {
      const entries = readArr(s, "auditEntries") as Array<{
        action?: string;
        status?: string;
      }>;
      return [
        { label: "Total", value: () => entries.length, icon: History },
        {
          label: "Successes",
          value: () => entries.filter((e) => e.status === "success").length,
          icon: CheckCircle2,
        },
        {
          label: "Failures",
          value: () => entries.filter((e) => e.status === "failure").length,
          icon: AlertTriangle,
        },
      ];
    },
    toolsTitle: "Audit-log tools",
    toolsDescription: "Export and filter helpers.",
    tools: [
      todoTool("export", "Export audit log", Download),
      todoTool("mine", "Filter to my actions", Filter),
      todoTool("siem", "Send to SIEM", Sparkles),
    ],
    workflowTitle: "Audit-log workflow",
    workflowDescription:
      "Read-only — agent suggests retention policies based on volume.",
  },

  {
    pageKey: "tenant-users",
    uiTitle: "Tenant users",
    uiDescription:
      "Per-tenant counts and a quick handle on the password-reset queue.",
    stats: (s) => {
      const all = Object.values(
        (s["tenantUsers"] as Record<string, Array<{
          accountEnabled?: boolean;
        }>>) ?? {},
      ).flat();
      return [
        { label: "Total", value: () => all.length, icon: Users },
        {
          label: "Enabled",
          value: () => all.filter((u) => u.accountEnabled).length,
          icon: CheckCircle2,
        },
        {
          label: "Disabled",
          value: () => all.filter((u) => !u.accountEnabled).length,
          icon: AlertTriangle,
        },
      ];
    },
    toolsTitle: "Tenant-users tools",
    toolsDescription: "Bulk reset + portal access.",
    tools: [
      todoTool("bulk-reset", "Bulk reset password", KeyRound),
      todoTool("disable", "Disable selected", AlertTriangle),
      openPortalTool,
    ],
    workflowTitle: "Tenant-users workflow",
    workflowDescription:
      "Routes bulk reset/disable through the scheduler so you stay under Graph rate limits.",
  },

  {
    pageKey: "ea-subscription",
    uiTitle: "EA subscription",
    uiDescription:
      "Surface EA capability and show how many subscriptions have been provisioned this session.",
    stats: (s) => [
      {
        label: "Recent subscriptions",
        value: () =>
          readArr(s, "auditEntries").filter(
            (e) =>
              (e as { action?: string }).action === "create_subscription",
          ).length,
        icon: BadgeCheck,
      },
    ],
    toolsTitle: "EA tools",
    toolsDescription: "Bulk-provision and tagging.",
    tools: [
      todoTool("bulk-provision", "Provision N from preset", UserPlus),
      todoTool("tag-cost-center", "Tag w/ cost-center", Sparkles),
    ],
    workflowTitle: "EA-subscription workflow",
    workflowDescription:
      "Forces a token refresh once after role-assignment grant, then proceeds.",
  },
];

export const GENERIC_TRIOS: PageEnhancerTrio[] = SPECS.map(buildTrio);
