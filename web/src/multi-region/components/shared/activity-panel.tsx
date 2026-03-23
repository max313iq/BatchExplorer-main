import * as React from "react";
import { IconButton, DefaultButton } from "@fluentui/react/lib/Button";
import { Spinner, SpinnerSize } from "@fluentui/react/lib/Spinner";
import { Icon } from "@fluentui/react/lib/Icon";
import { ProgressIndicator } from "@fluentui/react/lib/ProgressIndicator";
import {
    useMultiRegionState,
    useMultiRegionStore,
} from "../../store/store-context";
import { Activity, ActivityStatus } from "../../store/store-types";

type FilterTab = "all" | "running" | "completed" | "failed";

const COMPACT_HEIGHT = 140;
const FULL_HEIGHT = 320;

function formatDuration(startedAt: string, completedAt?: string): string {
    const start = new Date(startedAt).getTime();
    const end = completedAt ? new Date(completedAt).getTime() : Date.now();
    const diffMs = end - start;
    if (diffMs < 1000) return `${diffMs}ms`;
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSecs = seconds % 60;
    return `${minutes}m ${remainingSecs}s`;
}

function getStatusIcon(status: ActivityStatus): React.ReactElement {
    switch (status) {
        case "running":
            return <Spinner size={SpinnerSize.xSmall} />;
        case "completed":
            return (
                <Icon
                    iconName="CheckMark"
                    styles={{ root: { color: "#4ec959", fontSize: 12 } }}
                />
            );
        case "failed":
            return (
                <Icon
                    iconName="ErrorBadge"
                    styles={{ root: { color: "#f44747", fontSize: 12 } }}
                />
            );
        case "cancelled":
            return (
                <Icon
                    iconName="Cancel"
                    styles={{ root: { color: "#999", fontSize: 12 } }}
                />
            );
        case "pending":
        default:
            return (
                <Icon
                    iconName="Clock"
                    styles={{ root: { color: "#e8b730", fontSize: 12 } }}
                />
            );
    }
}

function filterActivities(activities: Activity[], tab: FilterTab): Activity[] {
    switch (tab) {
        case "running":
            return activities.filter(
                (a) => a.status === "running" || a.status === "pending"
            );
        case "completed":
            return activities.filter((a) => a.status === "completed");
        case "failed":
            return activities.filter(
                (a) => a.status === "failed" || a.status === "cancelled"
            );
        case "all":
        default:
            return activities;
    }
}

const FILTER_TABS: { key: FilterTab; label: string }[] = [
    { key: "all", label: "All" },
    { key: "running", label: "Running" },
    { key: "completed", label: "Completed" },
    { key: "failed", label: "Failed" },
];

const ActivityRow: React.FC<{ activity: Activity }> = ({ activity }) => {
    const [, setTick] = React.useState(0);

    // Update duration display every second for running activities
    React.useEffect(() => {
        if (activity.status !== "running") return;
        const interval = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(interval);
    }, [activity.status]);

    return (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
                borderBottom: "1px solid #2a2a2a",
            }}
        >
            <div style={{ width: 20, flexShrink: 0, textAlign: "center" }}>
                {getStatusIcon(activity.status)}
            </div>
            <div
                style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                }}
            >
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                    }}
                >
                    <span
                        style={{
                            color: "#ddd",
                            fontSize: 12,
                            fontWeight: 600,
                        }}
                    >
                        {activity.action}
                    </span>
                    <span
                        style={{
                            color: "#888",
                            fontSize: 11,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                    >
                        {activity.target}
                    </span>
                </div>
                {activity.progress !== undefined &&
                    activity.status === "running" && (
                        <ProgressIndicator
                            percentComplete={activity.progress / 100}
                            barHeight={3}
                            styles={{
                                root: { padding: 0 },
                                itemProgress: { padding: 0 },
                                progressBar: {
                                    backgroundColor: "#0078d4",
                                },
                                progressTrack: {
                                    backgroundColor: "#333",
                                },
                            }}
                        />
                    )}
                {activity.error && (
                    <span
                        style={{
                            color: "#f44747",
                            fontSize: 11,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                        title={activity.error}
                    >
                        {activity.error}
                    </span>
                )}
            </div>
            <span
                style={{
                    color: "#777",
                    fontSize: 11,
                    flexShrink: 0,
                    fontFamily: "Consolas, monospace",
                }}
            >
                {formatDuration(activity.startedAt, activity.completedAt)}
            </span>
        </div>
    );
};

export const ActivityPanel: React.FC = () => {
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const [expanded, setExpanded] = React.useState(false);
    const [activeTab, setActiveTab] = React.useState<FilterTab>("all");
    const [panelSize, setPanelSize] = React.useState<"compact" | "full">(
        "compact"
    );
    const containerRef = React.useRef<HTMLDivElement>(null);

    const activities = state.activities;
    const runningCount = activities.filter(
        (a) => a.status === "running"
    ).length;
    const completedCount = activities.filter(
        (a) =>
            a.status === "completed" ||
            a.status === "failed" ||
            a.status === "cancelled"
    ).length;

    const filtered = React.useMemo(
        () => filterActivities(activities, activeTab),
        [activities, activeTab]
    );

    // Auto-scroll to bottom when new activities appear
    React.useEffect(() => {
        if (containerRef.current && expanded) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
    }, [filtered.length, expanded]);

    const handleClearCompleted = React.useCallback(() => {
        store.clearCompletedActivities();
    }, [store]);

    const toggleSize = React.useCallback(() => {
        setPanelSize((prev) => (prev === "compact" ? "full" : "compact"));
    }, []);

    const maxHeight = panelSize === "compact" ? COMPACT_HEIGHT : FULL_HEIGHT;

    return (
        <div
            style={{
                borderTop: "1px solid #333",
                backgroundColor: "#1e1e1e",
            }}
        >
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "6px 16px",
                    cursor: "pointer",
                    userSelect: "none",
                    backgroundColor: "#252525",
                }}
                onClick={() => setExpanded(!expanded)}
            >
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                    }}
                >
                    <span
                        style={{
                            fontWeight: 600,
                            fontSize: "13px",
                            color: "#ccc",
                        }}
                    >
                        Activities ({activities.length})
                    </span>
                    {runningCount > 0 && (
                        <span
                            style={{
                                fontSize: 11,
                                color: "#0078d4",
                                display: "flex",
                                alignItems: "center",
                                gap: 4,
                            }}
                        >
                            <Spinner size={SpinnerSize.xSmall} />
                            {runningCount} running
                        </span>
                    )}
                </div>
                <span style={{ fontSize: "12px", color: "#999" }}>
                    {expanded ? "Collapse" : "Expand"}
                </span>
            </div>
            {expanded && (
                <div style={{ backgroundColor: "#1e1e1e" }}>
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            padding: "4px 16px",
                            borderBottom: "1px solid #333",
                        }}
                    >
                        {FILTER_TABS.map((tab) => (
                            <DefaultButton
                                key={tab.key}
                                text={tab.label}
                                checked={activeTab === tab.key}
                                onClick={() => setActiveTab(tab.key)}
                                styles={{
                                    root: {
                                        height: 26,
                                        minWidth: 0,
                                        padding: "0 10px",
                                        border: "none",
                                        backgroundColor:
                                            activeTab === tab.key
                                                ? "#333"
                                                : "transparent",
                                    },
                                    rootHovered: {
                                        backgroundColor: "#333",
                                    },
                                    label: {
                                        fontSize: 11,
                                        color:
                                            activeTab === tab.key
                                                ? "#fff"
                                                : "#999",
                                        fontWeight:
                                            activeTab === tab.key ? 600 : 400,
                                    },
                                }}
                            />
                        ))}
                        <div style={{ flex: 1 }} />
                        {completedCount > 0 && (
                            <DefaultButton
                                text="Clear completed"
                                onClick={handleClearCompleted}
                                styles={{
                                    root: {
                                        height: 26,
                                        minWidth: 0,
                                        padding: "0 10px",
                                        border: "1px solid #444",
                                        backgroundColor: "transparent",
                                    },
                                    rootHovered: {
                                        backgroundColor: "#333",
                                    },
                                    label: {
                                        fontSize: 11,
                                        color: "#999",
                                    },
                                }}
                            />
                        )}
                        <IconButton
                            iconProps={{
                                iconName:
                                    panelSize === "compact"
                                        ? "DoubleChevronUp"
                                        : "DoubleChevronDown",
                            }}
                            title={
                                panelSize === "compact"
                                    ? "Expand to full size"
                                    : "Shrink to compact"
                            }
                            ariaLabel="Toggle panel size"
                            onClick={toggleSize}
                            styles={{
                                root: {
                                    color: "#999",
                                    height: 28,
                                    width: 28,
                                },
                                rootHovered: { color: "#ccc" },
                            }}
                        />
                    </div>
                    <div
                        ref={containerRef}
                        style={{
                            maxHeight: `${maxHeight}px`,
                            overflowY: "auto",
                            padding: "4px 16px 8px",
                        }}
                    >
                        {filtered.map((activity) => (
                            <ActivityRow
                                key={activity.id}
                                activity={activity}
                            />
                        ))}
                        {filtered.length === 0 && (
                            <div
                                style={{
                                    opacity: 0.5,
                                    padding: "8px 0",
                                    color: "#999",
                                    fontSize: 12,
                                }}
                            >
                                No activities
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
