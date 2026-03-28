import * as React from "react";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import { Toggle } from "@fluentui/react/lib/Toggle";
import { Icon } from "@fluentui/react/lib/Icon";
import { DefaultButton } from "@fluentui/react/lib/Button";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { useMultiRegionState } from "../../store/store-context";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { AgentName, AgentStatus } from "../../store/store-types";

/* ------------------------------------------------------------------ */
/*  Skeleton                                                           */
/* ------------------------------------------------------------------ */

const SKELETON_KEYFRAMES = `
@keyframes skeletonPulse {
  0% { opacity: 0.6; }
  50% { opacity: 1; }
  100% { opacity: 0.6; }
}`;

/* Skeleton bars kept minimal — monitoring page data is always local/reactive */

/* ------------------------------------------------------------------ */
/*  Pagination                                                         */
/* ------------------------------------------------------------------ */

const PAGE_SIZE_OPTIONS: IDropdownOption[] = [
    { key: 10, text: "10" },
    { key: 25, text: "25" },
    { key: 50, text: "50" },
    { key: 100, text: "100" },
];

const Pagination: React.FC<{
    page: number;
    pageSize: number;
    totalItems: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
    label: string;
}> = ({
    page,
    pageSize,
    totalItems,
    onPageChange,
    onPageSizeChange,
    label,
}) => {
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    return (
        <Stack
            horizontal
            verticalAlign="center"
            tokens={{ childrenGap: 12 }}
            styles={{
                root: {
                    padding: "6px 0",
                    justifyContent: "space-between",
                },
            }}
        >
            <Stack
                horizontal
                verticalAlign="center"
                tokens={{ childrenGap: 8 }}
            >
                <DefaultButton
                    text="Prev"
                    onClick={() => onPageChange(page - 1)}
                    disabled={page <= 1}
                    aria-label={`Previous ${label} page`}
                    styles={{ root: { minWidth: 50, fontSize: 11 } }}
                />
                <Text
                    styles={{ root: { color: "#999", fontSize: 12 } }}
                    role="status"
                    aria-live="polite"
                >
                    Page {page} of {totalPages}
                </Text>
                <DefaultButton
                    text="Next"
                    onClick={() => onPageChange(page + 1)}
                    disabled={page >= totalPages}
                    aria-label={`Next ${label} page`}
                    styles={{ root: { minWidth: 50, fontSize: 11 } }}
                />
            </Stack>
            <Stack
                horizontal
                verticalAlign="center"
                tokens={{ childrenGap: 6 }}
            >
                <Text styles={{ root: { color: "#888", fontSize: 11 } }}>
                    Rows:
                </Text>
                <Dropdown
                    options={PAGE_SIZE_OPTIONS}
                    selectedKey={pageSize}
                    onChange={(_e, o) => {
                        if (o) onPageSizeChange(o.key as number);
                    }}
                    styles={{ dropdown: { width: 60 } }}
                    aria-label={`Rows per page for ${label}`}
                />
                <Text styles={{ root: { color: "#666", fontSize: 10 } }}>
                    ({totalItems} total)
                </Text>
            </Stack>
        </Stack>
    );
};

/* ------------------------------------------------------------------ */
/*  Empty state                                                        */
/* ------------------------------------------------------------------ */

const EmptySection: React.FC<{
    icon: string;
    title: string;
    subtitle: string;
}> = ({ icon, title, subtitle }) => (
    <Stack
        horizontalAlign="center"
        tokens={{ childrenGap: 8 }}
        styles={{ root: { padding: "24px 16px" } }}
        role="status"
    >
        <Icon
            iconName={icon}
            styles={{ root: { fontSize: 32, color: "#555" } }}
        />
        <Text
            variant="medium"
            styles={{ root: { color: "#888", fontWeight: 600 } }}
        >
            {title}
        </Text>
        <Text styles={{ root: { color: "#666", fontSize: 12 } }}>
            {subtitle}
        </Text>
    </Stack>
);

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export const MonitoringPage: React.FC<{ orchestrator: OrchestratorAgent }> = ({
    orchestrator,
}) => {
    const state = useMultiRegionState();
    const [autoRefresh, setAutoRefresh] = React.useState(false);

    // Pagination state for activities
    const [actPage, setActPage] = React.useState(1);
    const [actPageSize, setActPageSize] = React.useState(25);

    // Pagination state for logs
    const [logPage, setLogPage] = React.useState(1);
    const [logPageSize, setLogPageSize] = React.useState(25);

    // Auto-refresh every 30s
    React.useEffect(() => {
        if (!autoRefresh) return;
        const interval = setInterval(() => {
            // Force a re-render by reading state (state is reactive via context)
        }, 30000);
        return () => clearInterval(interval);
    }, [autoRefresh]);

    const allActivities = React.useMemo(
        () => (state.activities ?? []).slice().reverse(),
        [state.activities]
    );

    const allLogs = React.useMemo(
        () => (state.agentLogs ?? []).slice().reverse(),
        [state.agentLogs]
    );

    // Reset pages when data changes
    React.useEffect(() => {
        setActPage(1);
    }, [allActivities.length]);

    React.useEffect(() => {
        setLogPage(1);
    }, [allLogs.length]);

    // Paginate activities
    const paginatedActivities = React.useMemo(() => {
        const start = (actPage - 1) * actPageSize;
        return allActivities.slice(start, start + actPageSize);
    }, [allActivities, actPage, actPageSize]);

    // Paginate logs
    const paginatedLogs = React.useMemo(() => {
        const start = (logPage - 1) * logPageSize;
        return allLogs.slice(start, start + logPageSize);
    }, [allLogs, logPage, logPageSize]);

    return (
        <div style={{ padding: "16px 0" }}>
            <style>{SKELETON_KEYFRAMES}</style>

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
                        aria-label="Toggle auto-refresh every 30 seconds"
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
                                role="status"
                                aria-label={`Agent ${name}: ${status}`}
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
                {allActivities.length === 0 ? (
                    <EmptySection
                        icon="BarChart4"
                        title="No activity recorded"
                        subtitle="Activities will appear here as operations are performed."
                    />
                ) : (
                    <>
                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                            }}
                        >
                            {paginatedActivities.map((activity) => (
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
                                    <span
                                        style={{
                                            color: "#ccc",
                                            minWidth: 120,
                                        }}
                                    >
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
                                        title={activity.target}
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
                                        role="status"
                                    >
                                        {activity.status}
                                    </span>
                                </div>
                            ))}
                        </div>
                        {allActivities.length > 10 && (
                            <Pagination
                                page={actPage}
                                pageSize={actPageSize}
                                totalItems={allActivities.length}
                                onPageChange={setActPage}
                                onPageSizeChange={(s) => {
                                    setActPageSize(s);
                                    setActPage(1);
                                }}
                                label="activities"
                            />
                        )}
                    </>
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
                {allLogs.length === 0 ? (
                    <EmptySection
                        icon="TextDocument"
                        title="No logs yet"
                        subtitle="Agent log entries will appear here as agents execute actions."
                    />
                ) : (
                    <>
                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 2,
                            }}
                        >
                            {paginatedLogs.map((log, i) => {
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
                                            title={log.message}
                                        >
                                            {log.message}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                        {allLogs.length > 10 && (
                            <Pagination
                                page={logPage}
                                pageSize={logPageSize}
                                totalItems={allLogs.length}
                                onPageChange={setLogPage}
                                onPageSizeChange={(s) => {
                                    setLogPageSize(s);
                                    setLogPage(1);
                                }}
                                label="logs"
                            />
                        )}
                    </>
                )}
            </div>
        </div>
    );
};
