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
export interface TokenExpiryBadgeProps {
    /** Seconds until expiry. `null` while loading; hides the badge. */
    secondsUntilExpiry: number | null;
    /** True while a (re-)acquire is in flight. */
    loading?: boolean;
    /**
     * Optional force-refresh callback. When provided, the badge renders
     * as a button that triggers it on click.
     */
    onRefresh?: () => void | Promise<void>;
    /** Custom className for layout integration. */
    className?: string;
    /**
     * If true, render even when expiry is far away (debug / always-on).
     * Default false — quiet until < 10 min.
     */
    alwaysShow?: boolean;
    /**
     * True when the underlying ArmTokenState reports that an interactive
     * re-auth is REQUIRED to recover (interaction_required /
     * invalid_grant / "Cached session is no longer valid"). When true,
     * the badge SWAPS its expiry display for a destructive "Re-auth"
     * button — silent retries are useless against these errors.
     *
     * Pass `armTokenTracker.needsReauth` from the `useArmToken` hook.
     */
    needsReauth?: boolean;
    /**
     * Triggered when the operator clicks the Re-auth button. Pass
     * `armTokenTracker.reauth` from the `useArmToken` hook — it pops
     * the MSAL `loginAccount` dialog with `prompt: "login"` and then
     * auto-retries the silent acquire.
     *
     * When `needsReauth` is true and `onReauth` is NOT supplied, the
     * button shows a disabled "Re-auth required" pill so the operator
     * still understands the failure mode even on legacy callers.
     */
    onReauth?: () => void | Promise<unknown>;
}
export declare const TokenExpiryBadge: React.FC<TokenExpiryBadgeProps>;
//# sourceMappingURL=token-expiry-badge.d.ts.map