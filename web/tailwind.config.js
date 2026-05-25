/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: ["class"],
    content: [
        "./src/**/*.{ts,tsx}",
        "../packages/*/src/**/*.{ts,tsx}",
    ],
    safelist: [
        // Status badge color variants — these classes are composed dynamically
        // from a status string, so Tailwind's static analyzer can't see them.
        { pattern: /^(bg|text|border|ring)-(success|warning|error|info|muted|accent|primary|secondary|destructive)(-foreground)?$/ },
        // Density modes
        "density-compact",
        "density-comfortable",
        // Theme modes
        "dark",
        "light",
    ],
    theme: {
        container: {
            center: true,
            padding: "1rem",
            screens: { "2xl": "1400px" },
        },
        extend: {
            colors: {
                border: "hsl(var(--border) / <alpha-value>)",
                input: "hsl(var(--input) / <alpha-value>)",
                ring: "hsl(var(--ring) / <alpha-value>)",
                background: "hsl(var(--background) / <alpha-value>)",
                foreground: "hsl(var(--foreground) / <alpha-value>)",
                primary: {
                    DEFAULT: "hsl(var(--primary) / <alpha-value>)",
                    foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
                },
                secondary: {
                    DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
                    foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
                },
                destructive: {
                    DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
                    foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
                },
                muted: {
                    DEFAULT: "hsl(var(--muted) / <alpha-value>)",
                    foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
                },
                accent: {
                    DEFAULT: "hsl(var(--accent) / <alpha-value>)",
                    foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
                },
                popover: {
                    DEFAULT: "hsl(var(--popover) / <alpha-value>)",
                    foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
                },
                card: {
                    DEFAULT: "hsl(var(--card) / <alpha-value>)",
                    foreground: "hsl(var(--card-foreground) / <alpha-value>)",
                },
                // Domain-semantic
                success: {
                    DEFAULT: "hsl(var(--success) / <alpha-value>)",
                    foreground: "hsl(var(--success-foreground) / <alpha-value>)",
                },
                warning: {
                    DEFAULT: "hsl(var(--warning) / <alpha-value>)",
                    foreground: "hsl(var(--warning-foreground) / <alpha-value>)",
                },
                info: {
                    DEFAULT: "hsl(var(--info) / <alpha-value>)",
                    foreground: "hsl(var(--info-foreground) / <alpha-value>)",
                },
                error: {
                    DEFAULT: "hsl(var(--error) / <alpha-value>)",
                    foreground: "hsl(var(--error-foreground) / <alpha-value>)",
                },
                // Surface elevations matching the Batch dark theme
                surface: {
                    base: "hsl(var(--surface-base) / <alpha-value>)",
                    raised: "hsl(var(--surface-raised) / <alpha-value>)",
                    overlay: "hsl(var(--surface-overlay) / <alpha-value>)",
                    sunken: "hsl(var(--surface-sunken) / <alpha-value>)",
                },
            },
            borderRadius: {
                lg: "var(--radius)",
                md: "calc(var(--radius) - 2px)",
                sm: "calc(var(--radius) - 4px)",
            },
            fontFamily: {
                sans: [
                    "Segoe UI",
                    "system-ui",
                    "-apple-system",
                    "BlinkMacSystemFont",
                    "Helvetica Neue",
                    "Arial",
                    "sans-serif",
                ],
                mono: [
                    "Cascadia Code",
                    "JetBrains Mono",
                    "Consolas",
                    "Menlo",
                    "Monaco",
                    "monospace",
                ],
            },
            fontSize: {
                "3xs": ["0.625rem", { lineHeight: "0.875rem" }],   // 10px
                "2xs": ["0.6875rem", { lineHeight: "1rem" }],      // 11px
            },
            transitionDuration: {
                fast: "120ms",
                base: "180ms",
                slow: "280ms",
            },
            transitionTimingFunction: {
                standard: "cubic-bezier(0.16, 1, 0.3, 1)",
                enter: "cubic-bezier(0, 0, 0.2, 1)",
                exit: "cubic-bezier(0.4, 0, 1, 1)",
            },
            boxShadow: {
                // Elevation tokens — match the surface elevations
                "elev-1": "0 1px 2px 0 hsl(0 0% 0% / 0.06), 0 1px 3px 0 hsl(0 0% 0% / 0.08)",
                "elev-2": "0 4px 8px -2px hsl(0 0% 0% / 0.08), 0 2px 4px -2px hsl(0 0% 0% / 0.06)",
                "elev-3": "0 12px 24px -6px hsl(0 0% 0% / 0.16), 0 4px 8px -4px hsl(0 0% 0% / 0.10)",
                "elev-4": "0 24px 48px -12px hsl(0 0% 0% / 0.25)",
                "ring-primary": "0 0 0 2px hsl(var(--background)), 0 0 0 4px hsl(var(--ring) / 0.6)",
            },
            spacing: {
                // Density-aware row height; pages can use h-row when they
                // want rows that flex with the density toggle.
                row: "var(--row-height)",
            },
            keyframes: {
                "accordion-down": {
                    from: { height: "0" },
                    to: { height: "var(--radix-accordion-content-height)" },
                },
                "accordion-up": {
                    from: { height: "var(--radix-accordion-content-height)" },
                    to: { height: "0" },
                },
                "fade-in": {
                    from: { opacity: "0" },
                    to: { opacity: "1" },
                },
                "slide-in-bottom": {
                    from: { transform: "translateY(8px)", opacity: "0" },
                    to: { transform: "translateY(0)", opacity: "1" },
                },
                "slide-in-right": {
                    from: { transform: "translateX(16px)", opacity: "0" },
                    to: { transform: "translateX(0)", opacity: "1" },
                },
                "slide-in-left": {
                    from: { transform: "translateX(-16px)", opacity: "0" },
                    to: { transform: "translateX(0)", opacity: "1" },
                },
                "scale-in": {
                    from: { transform: "scale(0.96)", opacity: "0" },
                    to: { transform: "scale(1)", opacity: "1" },
                },
                shimmer: {
                    "0%": { backgroundPosition: "-200% 0" },
                    "100%": { backgroundPosition: "200% 0" },
                },
            },
            animation: {
                "accordion-down": "accordion-down 180ms cubic-bezier(0.16, 1, 0.3, 1)",
                "accordion-up": "accordion-up 180ms cubic-bezier(0.16, 1, 0.3, 1)",
                "fade-in": "fade-in 150ms cubic-bezier(0, 0, 0.2, 1)",
                "slide-in-bottom": "slide-in-bottom 200ms cubic-bezier(0.16, 1, 0.3, 1)",
                "slide-in-right": "slide-in-right 200ms cubic-bezier(0.16, 1, 0.3, 1)",
                "slide-in-left": "slide-in-left 200ms cubic-bezier(0.16, 1, 0.3, 1)",
                "scale-in": "scale-in 150ms cubic-bezier(0.16, 1, 0.3, 1)",
                shimmer: "shimmer 2s linear infinite",
            },
        },
    },
    plugins: [require("tailwindcss-animate")],
};
