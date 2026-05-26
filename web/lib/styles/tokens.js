/**
 * Typed design-token names. Use these instead of hardcoded hex colors so
 * theme overrides (dark/light, density) propagate through the whole app.
 *
 * The values here match the CSS variables in `./tailwind.css`. They are
 * resolved at runtime via `getComputedStyle(document.documentElement)`
 * when a TS consumer needs the actual color (e.g. Monaco theme sync,
 * canvas elements, dynamic style generators).
 */
/** Resolve a token to its current `hsl(...)` string. SSR-safe (returns "" outside browser). */
export function resolveToken(name, alpha = 1) {
    if (typeof document === "undefined")
        return "";
    const raw = getComputedStyle(document.documentElement)
        .getPropertyValue(`--${name}`)
        .trim();
    if (!raw)
        return "";
    return alpha === 1 ? `hsl(${raw})` : `hsl(${raw} / ${alpha})`;
}
/** Tailwind class fragments for a status tone. Composed at call site. */
export const STATUS_TONE_CLASSES = {
    success: {
        bg: "bg-success/15",
        text: "text-success",
        border: "border-success/40",
        ring: "ring-success/30",
    },
    warning: {
        bg: "bg-warning/15",
        text: "text-warning",
        border: "border-warning/40",
        ring: "ring-warning/30",
    },
    error: {
        bg: "bg-destructive/15",
        text: "text-destructive",
        border: "border-destructive/40",
        ring: "ring-destructive/30",
    },
    info: {
        bg: "bg-info/15",
        text: "text-info",
        border: "border-info/40",
        ring: "ring-info/30",
    },
    muted: {
        bg: "bg-muted",
        text: "text-muted-foreground",
        border: "border-border",
        ring: "ring-muted/30",
    },
};
/** Spacing rhythm — 8px grid */
export const SPACING = {
    xxs: "0.125rem",
    xs: "0.25rem",
    sm: "0.5rem",
    md: "0.75rem",
    lg: "1rem",
    xl: "1.5rem",
    xxl: "2rem", //    32px
};
/** Motion tokens — chosen once, used everywhere */
export const MOTION = {
    durationFast: 120,
    durationBase: 180,
    durationSlow: 280,
    easeStandard: "cubic-bezier(0.16, 1, 0.3, 1)",
    easeEnter: "cubic-bezier(0, 0, 0.2, 1)",
    easeExit: "cubic-bezier(0.4, 0, 1, 1)",
};
/**
 * Elevation tokens — paired with the `shadow-elev-{n}` Tailwind classes.
 * Use these names in TS code that needs to reference an elevation level
 * (e.g., conditional shadow on hover).
 */
export const ELEVATION = {
    flat: "shadow-none",
    raised: "shadow-elev-1",
    card: "shadow-elev-2",
    popover: "shadow-elev-3",
    modal: "shadow-elev-4",
};
/**
 * Density tokens — read by the DataTable component via CSS variables defined
 * in `tailwind.css`. The `density-compact` and `density-comfortable` classes
 * on `<html>` switch between these.
 */
export const DENSITY_CLASSES = ["density-compact", "density-comfortable"];
/**
 * Resolve a CSS variable backing a density-aware spacing token. Useful when a
 * canvas / Monaco / inline-style consumer needs the px value at runtime.
 */
export function resolveDensityVar(name) {
    if (typeof document === "undefined")
        return "";
    return getComputedStyle(document.documentElement)
        .getPropertyValue(`--${name}`)
        .trim();
}
/**
 * Tone names — the canonical five from the Design Contract §2.3. Code that
 * accepts a tone prop should narrow to this union.
 */
export const TONES = ["primary", "info", "success", "warning", "destructive"];
/**
 * Tailwind class fragments per tone. Mirrors STATUS_TONE_CLASSES but keyed
 * by the canonical contract names. Prefer this object in new code.
 */
export const TONE_CLASSES = {
    primary: {
        text: "text-primary",
        bg: "bg-primary",
        bgSubtle: "bg-primary/15",
        border: "border-primary",
        borderTop: "border-t-primary",
        ring: "ring-primary/30",
    },
    info: {
        text: "text-info",
        bg: "bg-info",
        bgSubtle: "bg-info/15",
        border: "border-info",
        borderTop: "border-t-info",
        ring: "ring-info/30",
    },
    success: {
        text: "text-success",
        bg: "bg-success",
        bgSubtle: "bg-success/15",
        border: "border-success",
        borderTop: "border-t-success",
        ring: "ring-success/30",
    },
    warning: {
        text: "text-warning",
        bg: "bg-warning",
        bgSubtle: "bg-warning/15",
        border: "border-warning",
        borderTop: "border-t-warning",
        ring: "ring-warning/30",
    },
    destructive: {
        text: "text-destructive",
        bg: "bg-destructive",
        bgSubtle: "bg-destructive/15",
        border: "border-destructive",
        borderTop: "border-t-destructive",
        ring: "ring-destructive/30",
    },
};
//# sourceMappingURL=tokens.js.map