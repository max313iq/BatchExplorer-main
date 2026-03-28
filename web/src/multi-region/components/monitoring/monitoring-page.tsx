import * as React from "react";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import { Toggle } from "@fluentui/react/lib/Toggle";
import { Icon } from "@fluentui/react/lib/Icon";
import { useMultiRegionState } from "../../store/store-context";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { AgentName, AgentStatus } from "../../store/store-types";

const AGENT_NAMES: AgentName[] = [
    "orchestrator",
    "provisioner",
    "quota",
    "monitor",
    "filter",
    "pool",
    "node",
];

const statusBadgeStyles: Record<
    AgentStatus,
    { background: string; color: string }
> = {
    idle: { background: "#555", color: "#999" },
    running: { background: "#0a2a4a", color: "#0078d4" },
    completed: { background: "#0a3a0a", color: "#107c10" },
    error: { background: "#3a0a0a", color: "#d13438" },
};

const activityStatusColors: Record<string, string> = {
    pending: "#888",
    running: "#0078d4",
    completed: "#107c10",
    failed: "#d13438",
    cancelled: "#999",
};

const sectionStyle: React.CSSProperties = {
    background: "#252525",
    borderRadius: 8,
    padding: 16,
};

export const MonitoringPage: React.FC<{ orchestrator: OrchestratorAgent }> = ({
    orchestrator,
}) => {
    const state = useMultiRegionState();
    const [autoRefresh, setAutoRefresh] = React.useState(false);

    // Auto-refresh every 30s
    React.useEffect(() => {
        if (!autoRefresh) return;
        const interval = setInterval(() => {
            // Force a re-render by reading state (state is reactive via context)
        }, 30000);
        return () => clearInterval(interval);
    }, [autoRefresh]);

    const recentActivities = React.useMemo(
        () => (state.activities ?? []).slice(-20).reverse(),
        [state.activities]
    );

    const recentLogs = React.useMemo(
        () => (state.agentLogs ?? []).slice(-50).reverse(),
        [state.agentLogs]
    );

    return (
        <div style={{ padding: "16px 0" }}>
            <Stack
                horizontal
                verticalAlign="center"
                tokens={{ childrenGap: 12 }}
                styles={{ root: { marginBottom: 16 } }}
            >
                <Icon
                    iconName="Health"
                    styles={{ root: { fontSize: 20, color: "#0078d4" } }}
                />
                <Text
                    variant="xLarge"
                    styles={{ root: { fontWeight: 600, color: "#eee" } }}
                >
                    Monitoring
                </Text>
                <div style={{ marginLeft: "auto" }}>
                    <Toggle
                        label="Auto-refresh (30s)"
                        inlineLabel
                        checked={autoRefresh}
                        onChange={(_e, checked) =>
                            setAutoRefresh(checked ?? false)
                        }
                        styles={{
                            root: { marginBottom: 0 },
                            label: { color: "#999", fontSize: 11 },
                        }}
                    />
                </div>
            </Stack>

            {/* Agent Status Panel */}
            <div style={{ ...sectionStyle, marginBottom: 16 }}>
                <Text
                    variant="mediumPlus"
                    styles={{
                        root: {
                            fontWeight: 600,
                            color: "#eee",
                            marginBottom: 12,
                            display: "block",
                        },
                    }}
                >
                    Agent Status
                </Text>
                <Stack horizontal wrap tokens={{ childrenGap: 12 }}>
                    {AGENT_NAMES.map((name) => {
                        const status: AgentStatus =
                            state.agentStatuses[name] ?? "idle";
                        const style = statusBadgeStyles[status];
                        return (
                            <div
                                key={name}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    background: style.background,
                                    borderRadius: 6,
                                    padding: "6px 14px",
                                }}
                            >
                                <div
                                    style={{
                                        width: 8,
                                        height: 8,
                                        borderRadius: "50%",
                                        background: style.color,
                                        boxShadow:
                                            status === "running"
                                                ? `0 0 6px ${style.color}`
                                                : "none",
                                    }}
                                />
                                <Text
                                    variant="small"
                                    styles={{
                                        root: {
                                            color: style.color,
                                            fontWeight: 600,
                                            textTransform: "capitalize",
                                        },
                                    }}
                                >
                                    {name}
                                </Text>
                                <Text
                                    variant="tiny"
                                    styles={{
                                        root: {
                                            color: style.color,
                                            opacity: 0.7,
                                            fontSize: 10,
                                        },
                                    }}
                                >
                                    {status}
                                </Text>
                            </div>
                        );
                    })}
                </Stack>
            </div>

            {/* Request Governance Stats */}
            <div style={{ ...sectionStyle, marginBottom: 16 }}>
                <Text
                    variant="mediumPlus"
                    styles={{
                        root: {
                            fontWeight: 600,
                            color: "#eee",
                            marginBottom: 12,
                            display: "block",
                        },
                    }}
                >
                    Request Governance Stats
                </Text>
                <Text variant="small" styles={{ root: { color: "#666" } }}>
                    Governance stats are not yet available.
                    RequestGovernance.getStats() is not implemented.
                </Text>
            </div>

            {/* Recent Activity */}
            <div style={{ ...sectionStyle, marginBottom: 16 }}>
                <Text
                    variant="mediumPlus"
                    styles={{
                        root: {
                            fontWeight: 600,
                            color: "#eee",
                            marginBottom: 12,
                            display: "block",
                        },
                    }}
                >
                    Recent Activity
                </Text>
                {recentActivities.length === 0 ? (
                    <Text variant="small" styles={{ root: { color: "#666" } }}>
                        No activity recorded yet.
                    </Text>
                ) : (
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                            maxHeight: 300,
                            overflowY: "auto",
                        }}
                    >
                        {recentActivities.map((activity) => (
                            <div
                                key={activity.id}
                                style={{
                                    display: "flex",
                                    gap: 10,
                                    alignItems: "center",
                                    fontSize: 12,
                                    padding: "4px 0",
                                    borderBottom: "1px solid #2a2a2a",
                                }}
                            >
                                <span
                                    style={{
                                        color: "#555",
                                        minWidth: 70,
                                        fontSize: 10,
                                        fontFamily: "monospace",
                                    }}
                                >
                                    {new Date(
                                        activity.startedAt
                                    ).toLocaleTimeString()}
                                </span>
                                <span style={{ color: "#ccc", minWidth: 120 }}>
                                    {activity.action}
                                </span>
                                <span
                                    style={{
                                        color: "#888",
                                        flex: 1,
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    {activity.target}
                                </span>
                                <span
                                    style={{
                                        padding: "1px 8px",
                                        borderRadius: 8,
                                        fontSize: 10,
                                        fontWeight: 600,
                                        color:
                                            activityStatusColors[
                                                activity.status
                                            ] ?? "#888",
                                        background: "#1e1e1e",
                                    }}
                                >
                                    {activity.status}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Agent Logs */}
            <div style={sectionStyle}>
                <Text
                    variant="mediumPlus"
                    styles={{
                        root: {
                            fontWeight: 600,
                            color: "#eee",
                            marginBottom: 12,
                            display: "block",
                        },
                    }}
                >
                    Agent Logs
                </Text>
                {recentLogs.length === 0 ? (
                    <Text variant="small" styles={{ root: { color: "#666" } }}>
                        No logs yet.
                    </Text>
                ) : (
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 2,
                            maxHeight: 400,
                            overflowY: "auto",
                        }}
                    >
                        {recentLogs.map((log, i) => {
                            const levelColor =
                                log.level === "error"
                                    ? "#d13438"
                                    : log.level === "warn"
                                      ? "#e3a400"
                                      : "#0078d4";
                            const levelBg =
                                log.level === "error"
                                    ? "#3a0a0a"
                                    : log.level === "warn"
                                      ? "#3a2a0a"
                                      : "#0a1a2a";
                            return (
                                <div
                                    key={i}
                                    style={{
                                        display: "flex",
                                        gap: 8,
                                        alignItems: "baseline",
                                        fontSize: 12,
                                        padding: "3px 0",
                                    }}
                                >
                                    <span
                                        style={{
                                            color: "#555",
                                            minWidth: 70,
                                            fontSize: 10,
                                            fontFamily: "monospace",
                                        }}
                                    >
                                        {new Date(
                                            log.timestamp
                                        ).toLocaleTimeString()}
                                    </span>
                                    <span
                                        style={{
                                            padding: "0 6px",
                                            borderRadius: 4,
                                            fontSize: 10,
                                            fontWeight: 600,
                                            background: levelBg,
                                            color: levelColor,
                                            textTransform: "uppercase",
                                        }}
                                    >
                                        {log.level}
                                    </span>
                                    <span style={{ color: "#888" }}>
                                        [{log.agent}]
                                    </span>
                                    <span
                                        style={{
                                            color:
                                                log.level === "error"
                                                    ? "#e06060"
                                                    : "#ccc",
                                            flex: 1,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                        }}
                                    >
                                        {log.message}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};
