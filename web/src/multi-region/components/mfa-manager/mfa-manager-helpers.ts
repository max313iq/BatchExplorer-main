/**
 * Pure helpers for the MFA Manager page — error messaging, method → icon
 * mapping, and the small option/label tables. Kept separate from the page so
 * they stay trivially testable and the page file focuses on orchestration.
 */
import {
  Fingerprint,
  KeyRound,
  Lock,
  Mail,
  MessageSquare,
  Smartphone,
  ShieldCheck,
  ShieldQuestion,
  Timer,
  type LucideIcon,
} from "lucide-react";

import { AzureRequestError } from "../../services/types";
import type {
  PhoneAuthType,
  PreferredMfaMethod,
} from "../../services/graph-service";

/**
 * Turn a failure from a `/authentication/*` call into an operator-actionable
 * message. The 401/403 case is the common one: reading or writing a principal's
 * registered authentication methods needs BOTH a Graph permission and (for the
 * `/users/{id}` target) an Entra directory role — an Azure RBAC role
 * (Owner/Contributor) is NOT sufficient. `label` is the human target ("your
 * signed-in account", a UPN, …) so the message reads naturally in both the
 * self and target-user modes.
 */
export function describeAuthMethodsError(err: unknown, label: string): string {
  const status = err instanceof AzureRequestError ? err.status : undefined;
  const raw = err instanceof Error ? err.message : String(err);
  if (status === 403 || status === 401) {
    return (
      `Not authorized to manage authentication methods for ${label}. ` +
      `This needs the Graph permission UserAuthenticationMethod.Read.All ` +
      `(or .ReadWrite.All to register/reset) AND an Entra directory role that ` +
      `can manage auth methods — Authentication Administrator or Privileged ` +
      `Authentication Administrator (the latter is required for admin-role ` +
      `targets). Azure subscription roles (Owner/Contributor) do not grant ` +
      `this. Ask a Global Administrator to assign the role and consent the ` +
      `permission, then retry. (${raw})`
    );
  }
  if (status === 404) {
    return `${label} was not found in this tenant (it may have been deleted). (${raw})`;
  }
  return raw;
}

/** Map a Graph `@odata.type` to a representative icon for the method list. */
export function methodIcon(odataType: string): LucideIcon {
  switch (odataType) {
    case "#microsoft.graph.phoneAuthenticationMethod":
      return Smartphone;
    case "#microsoft.graph.emailAuthenticationMethod":
      return Mail;
    case "#microsoft.graph.microsoftAuthenticatorAuthenticationMethod":
    case "#microsoft.graph.passwordlessMicrosoftAuthenticatorAuthenticationMethod":
      return ShieldCheck;
    case "#microsoft.graph.fido2AuthenticationMethod":
    case "#microsoft.graph.windowsHelloForBusinessAuthenticationMethod":
    case "#microsoft.graph.platformCredentialAuthenticationMethod":
      return Fingerprint;
    case "#microsoft.graph.softwareOathAuthenticationMethod":
    case "#microsoft.graph.hardwareOathAuthenticationMethod":
      return KeyRound;
    case "#microsoft.graph.temporaryAccessPassAuthenticationMethod":
      return Timer;
    case "#microsoft.graph.passwordAuthenticationMethod":
      return Lock;
    case "#microsoft.graph.smsAuthenticationMethod":
      return MessageSquare;
    default:
      return ShieldQuestion;
  }
}

/** Phone slots Graph accepts, with human labels for the type picker. */
export const PHONE_TYPE_OPTIONS: ReadonlyArray<{
  value: PhoneAuthType;
  label: string;
}> = [
  { value: "mobile", label: "Mobile (SMS + voice)" },
  { value: "alternateMobile", label: "Alternate mobile" },
  { value: "office", label: "Office (voice only)" },
];

/** Friendly labels for the user-preferred second-factor method. */
export const PREFERRED_METHOD_LABELS: Record<PreferredMfaMethod, string> = {
  push: "Authenticator push",
  oath: "Authenticator / OATH code",
  voiceMobile: "Voice call (mobile)",
  voiceAlternateMobile: "Voice call (alternate mobile)",
  voiceOffice: "Voice call (office)",
  sms: "Text message (SMS)",
};

/** Badge tone for a Temporary Access Pass usability reason. */
export function tapUsabilityTone(
  reason: string | undefined,
  isUsable: boolean,
): "success" | "warning" | "destructive" {
  if (isUsable) return "success";
  if (reason === "NotYetValid") return "warning";
  return "destructive";
}
