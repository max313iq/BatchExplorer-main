/**
 * Typed design-token names. Use these instead of hardcoded hex colors so
 * theme overrides (dark/light, density) propagate through the whole app.
 *
 * The values here match the CSS variables in `./tailwind.css`. They are
 * resolved at runtime via `getComputedStyle(document.documentElement)`
 * when a TS consumer needs the actual color (e.g. Monaco theme sync,
 * canvas elements, dynamic style generators).
 */
export type ColorTokenName = "background" | "foreground" | "card" | "card-foreground" | "popover" | "popover-foreground" | "primary" | "primary-foreground" | "secondary" | "secondary-foreground" | "muted" | "muted-foreground" | "accent" | "accent-foreground" | "destructive" | "destructive-foreground" | "border" | "input" | "ring" | "success" | "success-foreground" | "warning" | "warning-foreground" | "info" | "info-foreground" | "error" | "error-foreground" | "surface-base" | "surface-raised" | "surface-overlay" | "surface-sunken";
export type StatusToneName = "success" | "warning" | "error" | "info" | "muted";
/** Resolve a token to its current `hsl(...)` string. SSR-safe (returns "" outside browser). */
export declare function resolveToken(name: ColorTokenName, alpha?: number): string;
/** Tailwind class fragments for a status tone. Composed at call site. */
export declare const STATUS_TONE_CLASSES: Record<StatusToneName, {
    bg: string;
    text: string;
    border: string;
    ring: string;
}>;
/** Spacing rhythm — 8px grid */
export declare const SPACING: {
    readonly xxs: "0.125rem";
    readonly xs: "0.25rem";
    readonly sm: "0.5rem";
    readonly md: "0.75rem";
    readonly lg: "1rem";
    readonly xl: "1.5rem";
    readonly xxl: "2rem";
};
/** Motion tokens — chosen once, used everywhere */
export declare const MOTION: {
    readonly durationFast: 120;
    readonly durationBase: 180;
    readonly durationSlow: 280;
    readonly easeStandard: "cubic-bezier(0.16, 1, 0.3, 1)";
    readonly easeEnter: "cubic-bezier(0, 0, 0.2, 1)";
    readonly easeExit: "cubic-bezier(0.4, 0, 1, 1)";
};
/**
 * Elevation tokens — paired with the `shadow-elev-{n}` Tailwind classes.
 * Use these names in TS code that needs to reference an elevation level
 * (e.g., conditional shadow on hover).
 */
export declare const ELEVATION: {
    readonly flat: "shadow-none";
    readonly raised: "shadow-elev-1";
    readonly card: "shadow-elev-2";
    readonly popover: "shadow-elev-3";
    readonly modal: "shadow-elev-4";
};
export type ElevationName = keyof typeof ELEVATION;
/**
 * Density tokens — read by the DataTable component via CSS variables defined
 * in `tailwind.css`. The `density-compact` and `density-comfortable` classes
 * on `<html>` switch between these.
 */
export declare const DENSITY_CLASSES: readonly ["density-compact", "density-comfortable"];
export type DensityClass = (typeof DENSITY_CLASSES)[number];
/**
 * Resolve a CSS variable backing a density-aware spacing token. Useful when a
 * canvas / Monaco / inline-style consumer needs the px value at runtime.
 */
export declare function resolveDensityVar(name: "row-height" | "row-padding-y" | "row-padding-x" | "header-padding-y" | "header-font-size" | "table-font-size" | "gutter-y" | "cell-line-height"): string;
/**
 * Tone names — the canonical five from the Design Contract §2.3. Code that
 * accepts a tone prop should narrow to this union.
 */
export declare const TONES: readonly ["primary", "info", "success", "warning", "destructive"];
export type Tone = (typeof TONES)[number];
/**
 * Tailwind class fragments per tone. Mirrors STATUS_TONE_CLASSES but keyed
 * by the canonical contract names. Prefer this object in new code.
 */
export declare const TONE_CLASSES: Record<Tone, {
    text: string;
    bg: string;
    bgSubtle: string;
    border: string;
    borderTop: string;
    ring: string;
}>;
//# sourceMappingURL=tokens.d.ts.map