/**
 * Top-of-shell auth/health banner: surfaces health-check progress, login
 * prompts on failure, and the signed-in MSAL user identity with sign-out.
 */
import * as React from "react";
import { CloudCog } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export interface AuthBannerProps {
  healthCheck: { healthy: boolean; error: string | null } | null;
  onRetry: () => void;
  onLogin?: () => void;
  onLogout?: () => void;
  authMode?: "msal" | "cli";
  userName?: string;
}

export const AuthBanner: React.FC<AuthBannerProps> = ({
  healthCheck,
  onRetry,
  onLogin,
  onLogout,
  authMode,
  userName,
}) => {
  if (healthCheck === null) {
    return (
      <Alert
        variant="info"
        className="rounded-none border-x-0"
        aria-live="polite"
      >
        <AlertDescription>Running health check...</AlertDescription>
      </Alert>
    );
  }

  if (!healthCheck.healthy) {
    return (
      <Alert
        variant="warning"
        className="rounded-none border-x-0"
        aria-live="polite"
      >
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1">
            <b>Health check failed.</b> {healthCheck.error}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {onLogin && (
              <Button
                size="sm"
                onClick={onLogin}
                className="gap-1.5"
                aria-label="Sign in with Azure"
              >
                <CloudCog aria-hidden="true" />
                Sign in with Azure
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={onRetry}
              aria-label="Retry health check"
            >
              Retry
            </Button>
          </span>
        </AlertDescription>
      </Alert>
    );
  }

  if (authMode === "msal" && userName) {
    return (
      <Alert
        variant="success"
        className="rounded-none border-x-0"
        aria-live="polite"
      >
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1">
            Signed in as <b>{userName}</b> via Entra ID
          </span>
          {onLogout && (
            <Button
              size="xs"
              variant="outline"
              onClick={onLogout}
              className="shrink-0"
              aria-label="Sign out"
            >
              Sign out
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  return null;
};
