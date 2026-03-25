import * as React from "react";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { IconButton } from "@fluentui/react/lib/Button";
import {
    useMultiRegionState,
    useMultiRegionStore,
} from "../../store/store-context";
import { AgentLogEntry } from "../../store/store-types";
import { DEFAULT_CONFIG } from "./constants";

type LogLevel = "all" | "info" | "warn" | "error";

const COMPACT_HEIGHT = 120;
const FULL_HEIGHT = 300;

const LOG_COLORS: Record<string, string> = {
    info: "#ccc",
    warn: "#e8b730",
    error: "#f44747",
};

const LEVEL_OPTIONS: IDropdownOption[] = [
    { key: "all", text: "All" },
    { key: "info", text: "Info" },
    { key: "warn", text: "Warn" },
    { key: "error", text: "Error" },
];

function formatLogLine(log: AgentLogEntry): string {
    const ts = new Date(log.timestamp).toLocaleTimeString();
    const level = log.level.toUpperCase().padEnd(5);
    return `${ts} [${log.agent}] ${level} ${log.message}`;
}

export const AgentLogPanel: React.FC = () => {
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const [expanded, setExpanded] = React.useState(false);
    const [levelFilter, setLevelFilter] = React.useState<LogLevel>("all");
    const [panelSize, setPanelSize] = React.useState<"compact" | "full">(
        "compact"
    );
    const containerRef = React.useRef<HTMLDivElement>(null);

    const filteredLogs = React.useMemo(() => {
        const recent = state.agentLogs.slice(-DEFAULT_CONFIG.logRetentionCount);
        if (levelFilter === "all") return recent;
        return recent.filter((log) => log.level === levelFilter);
    }, [state.agentLogs, levelFilter]);

    React.useEffect(() => {
        if (containerRef.current && expanded) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
    }, [filteredLogs.length, expanded]);

    const handleCopyLogs = React.useCallback(() => {
        const text = state.agentLogs.map(formatLogLine).join("\n");
        navigator.clipboard.writeText(text).catch(() => {
            // Silently ignore clipboard failures
        });
    }, [state.agentLogs]);

    const handleClearLogs = React.useCallback(() => {
        store.clearLogs();
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
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setExpanded(!expanded);
                    }
                }}
                aria-expanded={expanded}
                aria-label="Toggle agent logs panel"
            >
                <span
                    style={{
                        fontWeight: 600,
                        fontSize: "13px",
                        color: "#ccc",
                    }}
                >
                    Agent Logs ({state.agentLogs.length})
                </span>
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
                            gap: "8px",
                            padding: "4px 16px",
                            borderBottom: "1px solid #333",
                        }}
                    >
                        <Dropdown
                            selectedKey={levelFilter}
                            options={LEVEL_OPTIONS}
                            onChange={(_e, option) => {
                                if (option) {
                                    setLevelFilter(option.key as LogLevel);
                                }
                            }}
                            styles={{
                                root: { width: 100 },
                                title: {
                                    backgroundColor: "#252525",
                                    color: "#ccc",
                                    borderColor: "#444",
                                    fontSize: "12px",
                                    height: 28,
                                    lineHeight: "28px",
                                },
                                caretDown: { color: "#999" },
                                dropdownItem: {
                                    fontSize: "12px",
                                    minHeight: 28,
                                },
                            }}
                        />
                        <IconButton
                            iconProps={{ iconName: "Delete" }}
                            title="Clear Logs"
                            ariaLabel="Clear Logs"
                            onClick={handleClearLogs}
                            styles={{
                                root: {
                                    color: "#999",
                                    height: 28,
                                    width: 28,
                                },
                                rootHovered: { color: "#ccc" },
                            }}
                        />
                        <IconButton
                            iconProps={{ iconName: "Copy" }}
                            title="Copy Logs"
                            ariaLabel="Copy Logs"
                            onClick={handleCopyLogs}
                            styles={{
                                root: {
                                    color: "#999",
                                    height: 28,
                                    width: 28,
                                },
                                rootHovered: { color: "#ccc" },
                            }}
                        />
                        <div style={{ flex: 1 }} />
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
                            fontFamily: "Consolas, monospace",
                            fontSize: "12px",
                        }}
                    >
                        {filteredLogs.map((log: AgentLogEntry, idx: number) => (
                            <div
                                key={idx}
                                style={{
                                    color: LOG_COLORS[log.level] ?? "#ccc",
                                    padding: "1px 0",
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                }}
                            >
                                <span style={{ opacity: 0.6, color: "#999" }}>
                                    {new Date(
                                        log.timestamp
                                    ).toLocaleTimeString()}
                                </span>{" "}
                                <span
                                    style={{
                                        fontWeight: 600,
                                        color: "#999",
                                    }}
                                >
                                    [{log.agent}]
                                </span>{" "}
                                <span
                                    style={{
                                        fontWeight: 600,
                                        textTransform: "uppercase",
                                        color: LOG_COLORS[log.level] ?? "#ccc",
                                    }}
                                >
                                    {log.level}
                                </span>{" "}
                                {log.message}
                            </div>
                        ))}
                        {filteredLogs.length === 0 && (
                            <div
                                style={{
                                    opacity: 0.5,
                                    padding: "8px 0",
                                    color: "#999",
                                }}
                            >
                                No logs yet
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
