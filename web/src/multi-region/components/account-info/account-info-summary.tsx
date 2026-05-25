/**
 * Compact summary bar shown above the Account Info table — surfaces total
 * accounts, quota, LP usage, pools, and average utilization at a glance.
 * Does NOT compute the summary; consumes the pre-aggregated `AccountInfoSummary`.
 */
import * as React from "react";
import {
  BarChart4,
  Boxes,
  CircleCheckBig,
  Server,
  Users,
  type LucideIcon,
} from "lucide-react";

import { cn, formatNumber } from "@/lib/utils";
import { TONE_CLASSES, type Tone } from "@/styles/tokens";

import { AccountInfoSummary } from "./account-info-helpers";

interface SummaryStatItemProps {
  icon: LucideIcon;
  tone: Tone;
  label: string;
  value: number | string;
  suffix?: string;
  ariaLabel?: string;
}

const SummaryStatItem: React.FC<SummaryStatItemProps> = React.memo(
  ({ icon: Icon, tone, label, value, suffix, ariaLabel }) => {
    const toneText = TONE_CLASSES[tone].text;
    const displayValue =
      typeof value === "number" ? formatNumber(value) : (value ?? "0");
    return (
      <div
        className="flex items-center gap-2"
        aria-label={ariaLabel ?? `${label}: ${displayValue}${suffix ?? ""}`}
      >
        <Icon className={cn("h-4 w-4", toneText)} aria-hidden />
        <div>
          <span className="block text-2xs text-muted-foreground">{label}</span>
          <span
            className={cn(
              "block text-lg font-bold leading-tight tabular-nums",
              toneText,
            )}
          >
            {displayValue}
            {suffix ?? ""}
          </span>
        </div>
      </div>
    );
  },
);
SummaryStatItem.displayName = "SummaryStatItem";

interface AccountInfoSummaryBarProps {
  summary: AccountInfoSummary;
}

export const AccountInfoSummaryBar: React.FC<AccountInfoSummaryBarProps> =
  React.memo(({ summary }) => {
    const utilizationTone: Tone =
      summary.avgLpUtilization > 80
        ? "destructive"
        : summary.avgLpUtilization >= 50
          ? "warning"
          : "success";
    return (
      <div
        className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-border bg-card px-4 py-3 shadow-elev-1"
        role="region"
        aria-label="Account quota summary"
        aria-live="polite"
      >
        <SummaryStatItem
          icon={Users}
          tone="primary"
          label="Total Accounts"
          value={summary.totalAccounts}
        />
        <SummaryStatItem
          icon={Server}
          tone="info"
          label="Total Dedicated Quota"
          value={summary.totalDedicatedQuota}
        />
        <SummaryStatItem
          icon={Server}
          tone="info"
          label="LP Used / Total"
          value={summary.totalLpUsed}
          suffix={` / ${formatNumber(summary.totalLpQuota)}`}
        />
        <SummaryStatItem
          icon={CircleCheckBig}
          tone="success"
          label="LP Free"
          value={summary.totalLpFree}
        />
        <SummaryStatItem
          icon={Boxes}
          tone="warning"
          label="Total Pools"
          value={summary.totalPools}
        />
        <SummaryStatItem
          icon={BarChart4}
          tone={utilizationTone}
          label="Avg LP Utilization"
          value={summary.avgLpUtilization}
          suffix="%"
        />
      </div>
    );
  });
AccountInfoSummaryBar.displayName = "AccountInfoSummaryBar";
