/**
 * Inline badge that surfaces the freshness of an ARM access token.
 *
 * Pages that hold a long-lived token (Pool Info auto-refresh, Nodes
 * polling, EA Sub Quick form sitting open) need a visible cue when
 * the token is about to expire so the operator knows why a submit
 * might 401 — and can force a refresh before it does. The hook
 * `useArmToken` already auto-refreshes 60 s before expiry, but the
 * operator may want to refresh sooner (e.g. they're about to start a
 * 10-minute pool resize and don't want the token to flip mid-run).
 *
 * Visual states:
 *   - Hidden when the token has > 10 min left (no clutter)
 *   - "Token expires in 9m" outline badge at 10 → 5 min
 *   - "Token expires in 2m" warning badge at 5 → 1 min
 *   - "Token expires in 30s" destructive badge at < 1 min
 *   - "Refreshing…" spinner while a refresh is in flight
 *
 * If `onRefresh` is provided, the badge becomes a clickable button.
 */
import * as React from "react";
import { KeyRound, Loader2, RotateCw, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
export const TokenExpiryBadge = ({ secondsUntilExpiry, loading = false, onRefresh, className, alwaysShow = false, needsReauth = false, onReauth, }) => {
    // Re-auth path takes precedence — show the destructive button
    // EVEN IF expiry data is still loading, since the only path back
    // to a usable token is interactive auth.
    if (needsReauth) {
        if (onReauth) {
            return (React.createElement("button", { type: "button", onClick: () => void onReauth(), className: cn("cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className), "aria-label": "Re-authenticate this account \u2014 MSAL session expired" },
                React.createElement(Badge, { variant: "destructive", className: "flex items-center gap-1 text-2xs" },
                    React.createElement(KeyRound, { className: "h-3 w-3", "aria-hidden": true }),
                    "Re-auth required")));
        }
        return (React.createElement(Badge, { variant: "destructive", className: cn("flex items-center gap-1 text-2xs", className), "aria-label": "Re-authentication required \u2014 open Azure Accounts to re-sign-in this account", title: "MSAL session expired. Open Azure Accounts and re-sign-in this account." },
            React.createElement(KeyRound, { className: "h-3 w-3", "aria-hidden": true }),
            "Re-auth required"));
    }
    // Render nothing if we don't have an expiry yet AND we're not loading.
    if (secondsUntilExpiry === null && !loading)
        return null;
    // Default behaviour: stay quiet until < 10 min.
    if (!alwaysShow &&
        !loading &&
        secondsUntilExpiry !== null &&
        secondsUntilExpiry > 10 * 60) {
        return null;
    }
    if (loading) {
        return (React.createElement(Badge, { variant: "outline", className: cn("flex items-center gap-1 text-2xs", className), "aria-label": "Refreshing ARM token" },
            React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none" }),
            "Refreshing token\u2026"));
    }
    const s = secondsUntilExpiry !== null && secondsUntilExpiry !== void 0 ? secondsUntilExpiry : 0;
    const variant = s < 60 ? "destructive" : s < 5 * 60 ? "warning" : "outline";
    const label = formatExpiry(s);
    const Inner = (React.createElement(Badge, { variant: variant, className: cn("flex items-center gap-1 text-2xs", className), "aria-label": `ARM token expires in ${label}${onRefresh ? "; click to refresh" : ""}` },
        variant === "destructive" ? (React.createElement(ShieldAlert, { className: "h-3 w-3", "aria-hidden": true })) : (React.createElement(RotateCw, { className: "h-3 w-3", "aria-hidden": true })),
        "Token expires in ",
        label));
    if (!onRefresh)
        return Inner;
    return (React.createElement("button", { type: "button", onClick: () => void onRefresh(), className: "cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": `Refresh ARM token (currently expires in ${label})` }, Inner));
};
function formatExpiry(seconds) {
    if (seconds <= 0)
        return "now";
    if (seconds < 60)
        return `${seconds}s`;
    if (seconds < 60 * 60) {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return s > 0 ? `${m}m ${s}s` : `${m}m`;
    }
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
//# sourceMappingURL=token-expiry-badge.js.map