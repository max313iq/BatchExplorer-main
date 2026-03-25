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
    /** Number of shimmer lines to render. Defaults to 3. */
    lines?: number;
    /** CSS width of the skeleton container. Defaults to "100%". */
    width?: string;
    /** Height of each shimmer line in pixels. Defaults to 14. */
    lineHeight?: number;
}

export const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({
    lines = 3,
    width = "100%",
    lineHeight = 14,
}) => {
    React.useEffect(injectShimmerStyle, []);

    return (
        <div
            style={{ display: "flex", flexDirection: "column", gap: 10, width }}
            role="progressbar"
            aria-label="Loading content"
        >
            {Array.from({ length: lines }, (_, i) => (
                <div
                    key={i}
                    style={{
                        height: lineHeight,
                        borderRadius: 4,
                        width: i === lines - 1 ? "60%" : "100%",
                        background:
                            "linear-gradient(90deg, #2a2a2a 25%, #333 50%, #2a2a2a 75%)",
                        backgroundSize: `800px ${lineHeight}px`,
                        animation: "mr-shimmer 1.5s infinite linear",
                    }}
                />
            ))}
        </div>
    );
};
