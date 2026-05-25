/**
 * Pre-login tenant selector — input field + sign-in button used in
 * both the page header (compact) and the empty-state card (stacked).
 *
 * Extracted from `azure-accounts-page.tsx` to keep the parent file
 * focused on accounts orchestration. Behavior is byte-identical to the
 * in-file version it replaced.
 */
import * as React from "react";
import { LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { InfoTooltip } from "../shared/info-tooltip";

export interface PreLoginTenantSelectorProps {
  tenantInput: string;
  onTenantInputChange: (value: string) => void;
  onSignIn: () => void;
  signingIn: boolean;
  layout: "compact" | "stacked";
  signInLabel?: string;
}

export const PreLoginTenantSelector: React.FC<PreLoginTenantSelectorProps> = ({
  tenantInput,
  onTenantInputChange,
  onSignIn,
  signingIn,
  layout,
  signInLabel,
}) => {
  const inputId = React.useId();
  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        layout === "compact" && "min-w-[260px]",
      )}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Label
            htmlFor={inputId}
            className="text-2xs uppercase tracking-wider"
          >
            Tenant ID or domain (optional)
          </Label>
          <InfoTooltip
            content="Set this to sign in directly against a specific tenant. Leave blank to sign into your home tenant and discover others later via the per-account tenant switcher."
            ariaLabel="Tenant input help"
            size={12}
          />
        </div>
        <div
          className={cn(
            "flex gap-2",
            layout === "stacked" ? "flex-col sm:flex-row" : "flex-row",
          )}
        >
          <Input
            id={inputId}
            type="text"
            placeholder="contoso.onmicrosoft.com or GUID"
            value={tenantInput}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              onTenantInputChange(e.target.value)
            }
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === "Enter" && !signingIn) {
                e.preventDefault();
                onSignIn();
              }
            }}
            disabled={signingIn}
            aria-label="Tenant ID or domain"
            className="h-8 text-xs transition-colors duration-150"
            autoComplete="off"
            spellCheck={false}
          />
          {signingIn ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="default"
                    onClick={onSignIn}
                    loading={signingIn}
                    aria-label={signInLabel ?? "Sign in with Azure"}
                  >
                    {signInLabel ?? "Sign in with Azure"}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                Sign-in already in progress.
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button
              variant="default"
              onClick={onSignIn}
              loading={signingIn}
              aria-label={signInLabel ?? "Sign in with Azure"}
            >
              <LogIn className="h-3.5 w-3.5" />
              {signInLabel ?? "Sign in with Azure"}
            </Button>
          )}
        </div>
      </div>
      <p className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
        <span>Leave empty to use your home tenant.</span>
        <span className="text-muted-foreground/70">
          Press <Kbd>Enter</Kbd> in the field to sign in.
        </span>
      </p>
    </div>
  );
};
