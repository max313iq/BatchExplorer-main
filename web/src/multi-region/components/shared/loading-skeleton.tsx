import * as React from "react";

let _styleInjected = false;

function injectShimmerStyle() {
    if (_styleInjected) return;
    _styleInjected = true;
    const style = document.createElement("style");
    style.textContent = `
        @keyframes mr-shimmer {
            0% { background-position: -400px 0; }
            100% { background-position: 400px 0; }
        }
    `;
    document.head.appendChild(style);
}

export interface LoadingSkeletonProps {
    lines?: number;
    width?: string;
}

export const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({
    lines = 3,
    width = "100%",
}) => {
    React.useEffect(injectShimmerStyle, []);

    return (
        <div
            style={{ display: "flex", flexDirection: "column", gap: 10, width }}
        >
            {Array.from({ length: lines }, (_, i) => (
                <div
                    key={i}
                    style={{
                        height: 14,
                        borderRadius: 4,
                        width: i === lines - 1 ? "60%" : "100%",
                        background:
                            "linear-gradient(90deg, #2a2a2a 25%, #333 50%, #2a2a2a 75%)",
                        backgroundSize: "800px 14px",
                        animation: "mr-shimmer 1.5s infinite linear",
                    }}
                />
            ))}
        </div>
    );
};
