import * as React from "react";

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
    pending: { bg: "#fff4ce", text: "#8a6d00" },
    creating: { bg: "#deecf9", text: "#004578" },
    created: { bg: "#dff6dd", text: "#107c10" },
    submitted: { bg: "#deecf9", text: "#004578" },
    approved: { bg: "#dff6dd", text: "#107c10" },
    denied: { bg: "#fde7e9", text: "#a80000" },
    failed: { bg: "#fde7e9", text: "#a80000" },
    idle: { bg: "#f3f2f1", text: "#605e5c" },
    running: { bg: "#deecf9", text: "#004578" },
    completed: { bg: "#dff6dd", text: "#107c10" },
    error: { bg: "#fde7e9", text: "#a80000" },
    // Node states
    rebooting: { bg: "#fff4ce", text: "#8a6d00" },
    reimaging: { bg: "#fff4ce", text: "#8a6d00" },
    starting: { bg: "#deecf9", text: "#004578" },
    waitingforstarttask: { bg: "#fff4ce", text: "#8a6d00" },
    starttaskfailed: { bg: "#fde7e9", text: "#a80000" },
    unusable: { bg: "#fde7e9", text: "#a80000" },
    offline: { bg: "#f3f2f1", text: "#605e5c" },
    preempted: { bg: "#fff4ce", text: "#8a6d00" },
    leavingpool: { bg: "#fff4ce", text: "#8a6d00" },
    unknown: { bg: "#f3f2f1", text: "#605e5c" },
};

interface StatusBadgeProps {
    status: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
    const colors = STATUS_COLORS[status] ?? {
        bg: "#f3f2f1",
        text: "#323130",
    };

    return (
        <span
            style={{
                display: "inline-block",
                padding: "2px 8px",
                borderRadius: "2px",
                fontSize: "12px",
                fontWeight: 600,
                backgroundColor: colors.bg,
                color: colors.text,
                textTransform: "capitalize",
            }}
        >
            {status}
        </span>
    );
};
