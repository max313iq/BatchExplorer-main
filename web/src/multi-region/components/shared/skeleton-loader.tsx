import * as React from "react";

export type SkeletonVariant =
    | "table"
    | "card"
    | "stat-bar"
    | "list"
    | "form"
    | "text";

export interface SkeletonLoaderProps {
    variant: SkeletonVariant;
    rows?: number;
    columns?: number;
    cards?: number;
    animate?: boolean;
}

let _pulseStyleInjected = false;

function injectPulseStyle(): void {
    if (_pulseStyleInjected) return;
    _pulseStyleInjected = true;
    const style = document.createElement("style");
    style.textContent = `
        @keyframes skeleton-pulse {
            0% { opacity: 1; }
            50% { opacity: 0.4; }
            100% { opacity: 1; }
        }
    `;
    document.head.appendChild(style);
}

const boxStyle = (
    width: string,
    height: number,
    animate: boolean
): React.CSSProperties => ({
    width,
    height,
    borderRadius: 4,
    backgroundColor: "var(--bg-tertiary, #252525)",
    animation: animate ? "skeleton-pulse 1.5s ease-in-out infinite" : "none",
});

const circleStyle = (size: number, animate: boolean): React.CSSProperties => ({
    width: size,
    height: size,
    borderRadius: "50%",
    backgroundColor: "var(--bg-tertiary, #252525)",
    animation: animate ? "skeleton-pulse 1.5s ease-in-out infinite" : "none",
    flexShrink: 0,
});

function TableSkeleton({
    rows,
    columns,
    animate,
}: {
    rows: number;
    columns: number;
    animate: boolean;
}): React.ReactElement {
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {/* Header */}
            <div style={{ display: "flex", gap: 12 }}>
                {Array.from({ length: columns }, (_, c) => (
                    <div key={`h-${c}`} style={boxStyle("100%", 16, animate)} />
                ))}
            </div>
            <div style={boxStyle("100%", 1, false)} />
            {/* Rows */}
            {Array.from({ length: rows }, (_, r) => (
                <div key={`r-${r}`} style={{ display: "flex", gap: 12 }}>
                    {Array.from({ length: columns }, (_, c) => (
                        <div
                            key={`r-${r}-c-${c}`}
                            style={{
                                ...boxStyle("100%", 14, animate),
                                animationDelay: `${(r * columns + c) * 0.05}s`,
                            }}
                        />
                    ))}
                </div>
            ))}
        </div>
    );
}

function CardSkeleton({
    cards,
    animate,
}: {
    cards: number;
    animate: boolean;
}): React.ReactElement {
    return (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {Array.from({ length: cards }, (_, i) => (
                <div
                    key={i}
                    style={{
                        width: 240,
                        borderRadius: 8,
                        padding: 16,
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                        border: "1px solid var(--border-subtle, #2b2b2b)",
                    }}
                >
                    <div style={boxStyle("60%", 16, animate)} />
                    <div style={boxStyle("100%", 12, animate)} />
                    <div style={boxStyle("80%", 12, animate)} />
                </div>
            ))}
        </div>
    );
}

function StatBarSkeleton({
    animate,
}: {
    animate: boolean;
}): React.ReactElement {
    return (
        <div style={{ display: "flex", gap: 16 }}>
            {Array.from({ length: 4 }, (_, i) => (
                <div
                    key={i}
                    style={{
                        flex: 1,
                        borderRadius: 8,
                        padding: 16,
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        border: "1px solid var(--border-subtle, #2b2b2b)",
                    }}
                >
                    <div style={boxStyle("50%", 12, animate)} />
                    <div style={boxStyle("70%", 24, animate)} />
                </div>
            ))}
        </div>
    );
}

function ListSkeleton({
    rows,
    animate,
}: {
    rows: number;
    animate: boolean;
}): React.ReactElement {
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {Array.from({ length: rows }, (_, i) => (
                <div
                    key={i}
                    style={{
                        display: "flex",
                        gap: 12,
                        alignItems: "center",
                    }}
                >
                    <div style={circleStyle(32, animate)} />
                    <div
                        style={{
                            flex: 1,
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                        }}
                    >
                        <div style={boxStyle("40%", 14, animate)} />
                        <div style={boxStyle("70%", 12, animate)} />
                    </div>
                </div>
            ))}
        </div>
    );
}

function FormSkeleton({
    rows,
    animate,
}: {
    rows: number;
    animate: boolean;
}): React.ReactElement {
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {Array.from({ length: rows }, (_, i) => (
                <div
                    key={i}
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                    }}
                >
                    <div style={boxStyle("20%", 12, animate)} />
                    <div style={boxStyle("100%", 32, animate)} />
                </div>
            ))}
        </div>
    );
}

function TextSkeleton({
    rows,
    animate,
}: {
    rows: number;
    animate: boolean;
}): React.ReactElement {
    const widths = ["100%", "95%", "85%", "90%", "60%"];
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Array.from({ length: rows }, (_, i) => (
                <div
                    key={i}
                    style={boxStyle(widths[i % widths.length], 14, animate)}
                />
            ))}
        </div>
    );
}

export const SkeletonLoader: React.FC<SkeletonLoaderProps> = ({
    variant,
    rows = 5,
    columns = 4,
    cards = 3,
    animate = true,
}) => {
    React.useEffect(injectPulseStyle, []);

    const content = React.useMemo(() => {
        switch (variant) {
            case "table":
                return (
                    <TableSkeleton
                        rows={rows}
                        columns={columns}
                        animate={animate}
                    />
                );
            case "card":
                return <CardSkeleton cards={cards} animate={animate} />;
            case "stat-bar":
                return <StatBarSkeleton animate={animate} />;
            case "list":
                return <ListSkeleton rows={rows} animate={animate} />;
            case "form":
                return <FormSkeleton rows={rows} animate={animate} />;
            case "text":
                return <TextSkeleton rows={rows} animate={animate} />;
        }
    }, [variant, rows, columns, cards, animate]);

    return (
        <div role="progressbar" aria-label="Loading content">
            {content}
        </div>
    );
};
