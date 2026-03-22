import * as React from "react";
import { useMultiRegionState } from "../../store/store-context";
import { AgentLogEntry } from "../../store/store-types";

const LOG_COLORS: Record<string, string> = {
    info: "#323130",
    warn: "#8a6d00",
    error: "#a80000",
};

export const AgentLogPanel: React.FC = () => {
    const state = useMultiRegionState();
    const [expanded, setExpanded] = React.useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (containerRef.current && expanded) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
    }, [state.agentLogs.length, expanded]);

    const recentLogs = state.agentLogs.slice(-100);

    return (
        <div
            style={{
                borderTop: "1px solid #edebe9",
                backgroundColor: "#faf9f8",
            }}
        >
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 16px",
                    cursor: "pointer",
                    userSelect: "none",
                }}
                onClick={() => setExpanded(!expanded)}
            >
                <span style={{ fontWeight: 600, fontSize: "13px" }}>
                    Agent Logs ({state.agentLogs.length})
                </span>
                <span style={{ fontSize: "12px" }}>
                    {expanded ? "Collapse" : "Expand"}
                </span>
            </div>
            {expanded && (
                <div
                    ref={containerRef}
                    style={{
                        maxHeight: "200px",
                        overflowY: "auto",
                        padding: "0 16px 8px",
                        fontFamily: "Consolas, monospace",
                        fontSize: "12px",
                    }}
                >
                    {recentLogs.map((log: AgentLogEntry, idx: number) => (
                        <div
                            key={idx}
                            style={{
                                color: LOG_COLORS[log.level] ?? "#323130",
                                padding: "1px 0",
                            }}
                        >
                            <span style={{ opacity: 0.6 }}>
                                {new Date(log.timestamp).toLocaleTimeString()}
                            </span>{" "}
                            <span
                                style={{
                                    fontWeight: 600,
                                    textTransform: "uppercase",
                                    width: "50px",
                                    display: "inline-block",
                                }}
                            >
                                [{log.agent}]
                            </span>{" "}
                            {log.message}
                        </div>
                    ))}
                    {recentLogs.length === 0 && (
                        <div style={{ opacity: 0.5, padding: "8px 0" }}>
                            No logs yet
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
