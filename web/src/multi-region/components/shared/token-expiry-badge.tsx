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

export const TokenExpiryBadge: React.FC<TokenExpiryBadgeProps> = ({
  secondsUntilExpiry,
  loading = false,
  onRefresh,
  className,
  alwaysShow = false,
  needsReauth = false,
  onReauth,
}) => {
  // Re-auth path takes precedence — show the destructive button
  // EVEN IF expiry data is still loading, since the only path back
  // to a usable token is interactive auth.
  if (needsReauth) {
    if (onReauth) {
      return (
        <button
          type="button"
          onClick={() => void onReauth()}
          className={cn(
            "cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
          aria-label="Re-authenticate this account — MSAL session expired"
        >
          <Badge
            variant="destructive"
            className="flex items-center gap-1 text-2xs"
          >
            <KeyRound className="h-3 w-3" aria-hidden />
            Re-auth required
          </Badge>
        </button>
      );
    }
    return (
      <Badge
        variant="destructive"
        className={cn("flex items-center gap-1 text-2xs", className)}
        aria-label="Re-authentication required — open Azure Accounts to re-sign-in this account"
        title="MSAL session expired. Open Azure Accounts and re-sign-in this account."
      >
        <KeyRound className="h-3 w-3" aria-hidden />
        Re-auth required
      </Badge>
    );
  }
  // Render nothing if we don't have an expiry yet AND we're not loading.
  if (secondsUntilExpiry === null && !loading) return null;
  // Default behaviour: stay quiet until < 10 min.
  if (
    !alwaysShow &&
    !loading &&
    secondsUntilExpiry !== null &&
    secondsUntilExpiry > 10 * 60
  ) {
    return null;
  }

  if (loading) {
    return (
      <Badge
        variant="outline"
        className={cn("flex items-center gap-1 text-2xs", className)}
        aria-label="Refreshing ARM token"
      >
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
        Refreshing token…
      </Badge>
    );
  }

  const s = secondsUntilExpiry ?? 0;
  const variant: "outline" | "warning" | "destructive" =
    s < 60 ? "destructive" : s < 5 * 60 ? "warning" : "outline";
  const label = formatExpiry(s);

  const Inner = (
    <Badge
      variant={variant}
      className={cn("flex items-center gap-1 text-2xs", className)}
      aria-label={`ARM token expires in ${label}${onRefresh ? "; click to refresh" : ""}`}
    >
      {variant === "destructive" ? (
        <ShieldAlert className="h-3 w-3" aria-hidden />
      ) : (
        <RotateCw className="h-3 w-3" aria-hidden />
      )}
      Token expires in {label}
    </Badge>
  );

  if (!onRefresh) return Inner;

  return (
    <button
      type="button"
      onClick={() => void onRefresh()}
      className="cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Refresh ARM token (currently expires in ${label})`}
    >
      {Inner}
    </button>
  );
};

function formatExpiry(seconds: number): string {
  if (seconds <= 0) return "now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 60 * 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
