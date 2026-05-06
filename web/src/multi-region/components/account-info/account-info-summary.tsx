import * as React from "react";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import { Icon } from "@fluentui/react/lib/Icon";
import { AccountInfoSummary } from "./account-info-helpers";

interface SummaryStatItemProps {
    icon: string;
    label: string;
    value: number | string;
    color: string;
    suffix?: string;
    ariaLabel?: string;
}

const SummaryStatItem: React.FC<SummaryStatItemProps> = React.memo(
    ({ icon, label, value, color, suffix, ariaLabel }) => (
        <Stack
            horizontal
            verticalAlign="center"
            tokens={{ childrenGap: 8 }}
            aria-label={ariaLabel ?? `${label}: ${value}${suffix ?? ""}`}
        >
            <Icon
                iconName={icon}
                aria-hidden="true"
                styles={{ root: { color, fontSize: 16 } }}
            />
            <div>
                <Text
                    variant="tiny"
                    styles={{
                        root: {
                            color: "var(--text-muted, #888)",
                            display: "block",
                            fontSize: 11,
                        },
                    }}
                >
                    {label}
                </Text>
                <Text
                    variant="large"
                    styles={{ root: { fontWeight: 700, color } }}
                >
                    {value ?? 0}
                    {suffix ?? ""}
                </Text>
            </div>
        </Stack>
    )
);
SummaryStatItem.displayName = "SummaryStatItem";

interface AccountInfoSummaryBarProps {
    summary: AccountInfoSummary;
}

export const AccountInfoSummaryBar: React.FC<AccountInfoSummaryBarProps> =
    React.memo(({ summary }) => {
        return (
            <Stack
                horizontal
                wrap
                tokens={{ childrenGap: 24 }}
                styles={{
                    root: {
                        padding: "12px 16px",
                        background: "var(--bg-secondary, #1e1e1e)",
                        borderRadius: 6,
                        marginBottom: 16,
                        border: "1px solid var(--border-subtle, #2b2b2b)",
                    },
                }}
                role="status"
                aria-live="polite"
                aria-label="Account info summary statistics"
            >
                <SummaryStatItem
                    icon="AccountManagement"
                    label="Total Accounts"
                    value={summary.totalAccounts}
                    color="var(--accent, #0078d4)"
                />
                <SummaryStatItem
                    icon="Server"
                    label="Total Dedicated Quota"
                    value={summary.totalDedicatedQuota}
                    color="#00b7c3"
                />
                <SummaryStatItem
                    icon="Server"
                    label="LP Used / Total"
                    value={summary.totalLpUsed}
                    suffix={` / ${summary.totalLpQuota}`}
                    color="#8764b8"
                />
                <SummaryStatItem
                    icon="StatusCircleCheckmark"
                    label="LP Free"
                    value={summary.totalLpFree}
                    color="var(--success, #107c10)"
                />
                <SummaryStatItem
                    icon="BuildQueue"
                    label="Total Pools"
                    value={summary.totalPools}
                    color="var(--warning, #e3a400)"
                />
                <SummaryStatItem
                    icon="BarChart4"
                    label="Avg LP Utilization"
                    value={summary.avgLpUtilization}
                    suffix="%"
                    color={
                        summary.avgLpUtilization > 80
                            ? "var(--danger, #d13438)"
                            : summary.avgLpUtilization >= 50
                              ? "var(--warning, #e3a400)"
                              : "var(--success, #107c10)"
                    }
                />
            </Stack>
        );
    });
AccountInfoSummaryBar.displayName = "AccountInfoSummaryBar";
