/**
 * Compact summary bar shown above the Account Info table — surfaces total
 * accounts, quota, LP usage, pools, and average utilization at a glance.
 * Does NOT compute the summary; consumes the pre-aggregated `AccountInfoSummary`.
 */
import * as React from "react";
import { BarChart4, Boxes, CircleCheckBig, Server, Users, } from "lucide-react";
import { cn, formatNumber } from "@/lib/utils";
import { TONE_CLASSES } from "@/styles/tokens";
const SummaryStatItem = React.memo(({ icon: Icon, tone, label, value, suffix, ariaLabel }) => {
    const toneText = TONE_CLASSES[tone].text;
    const displayValue = typeof value === "number" ? formatNumber(value) : (value !== null && value !== void 0 ? value : "0");
    return (React.createElement("div", { className: "flex items-center gap-2", "aria-label": ariaLabel !== null && ariaLabel !== void 0 ? ariaLabel : `${label}: ${displayValue}${suffix !== null && suffix !== void 0 ? suffix : ""}` },
        React.createElement(Icon, { className: cn("h-4 w-4", toneText), "aria-hidden": true }),
        React.createElement("div", null,
            React.createElement("span", { className: "block text-2xs text-muted-foreground" }, label),
            React.createElement("span", { className: cn("block text-lg font-bold leading-tight tabular-nums", toneText) },
                displayValue, suffix !== null && suffix !== void 0 ? suffix : ""))));
});
SummaryStatItem.displayName = "SummaryStatItem";
export const AccountInfoSummaryBar = React.memo(({ summary }) => {
    const utilizationTone = summary.avgLpUtilization > 80
        ? "destructive"
        : summary.avgLpUtilization >= 50
            ? "warning"
            : "success";
    return (React.createElement("div", { className: "flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-border bg-card px-4 py-3 shadow-elev-1", role: "region", "aria-label": "Account quota summary", "aria-live": "polite" },
        React.createElement(SummaryStatItem, { icon: Users, tone: "primary", label: "Total Accounts", value: summary.totalAccounts }),
        React.createElement(SummaryStatItem, { icon: Server, tone: "info", label: "Total Dedicated Quota", value: summary.totalDedicatedQuota }),
        React.createElement(SummaryStatItem, { icon: Server, tone: "info", label: "LP Used / Total", value: summary.totalLpUsed, suffix: ` / ${formatNumber(summary.totalLpQuota)}` }),
        React.createElement(SummaryStatItem, { icon: CircleCheckBig, tone: "success", label: "LP Free", value: summary.totalLpFree }),
        React.createElement(SummaryStatItem, { icon: Boxes, tone: "warning", label: "Total Pools", value: summary.totalPools }),
        React.createElement(SummaryStatItem, { icon: BarChart4, tone: utilizationTone, label: "Avg LP Utilization", value: summary.avgLpUtilization, suffix: "%" })));
});
AccountInfoSummaryBar.displayName = "AccountInfoSummaryBar";
//# sourceMappingURL=account-info-summary.js.map