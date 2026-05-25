/**
 * Pre-flight check helpers for account provisioning.
 *
 * These helpers compute lightweight, synchronous (UI-only) signals to surface
 * subscription state, RBAC hints and quota awareness BEFORE the user clicks
 * the irreversible "Create N Accounts" button. They never call ARM directly:
 * the deep "subscription enabled?" verification happens server-side inside
 * provisioner-agent before any resource group is created. This module is
 * about giving the operator visible confidence indicators in the wizard.
 */
import {
  AzureLoginAccount,
  AzureLoginSubscription,
  ManagedAccount,
  Subscription,
} from "../store/store-types";
import { isValidSubscriptionId } from "../components/shared/constants";

export type PreflightLevel = "ok" | "warn" | "error" | "unknown";

export interface PreflightResult {
  id: string;
  label: string;
  level: PreflightLevel;
  detail: string;
}

export interface PreflightInputs {
  subscriptionId: string;
  selectedRegions: string[];
  accounts: ReadonlyArray<ManagedAccount>;
  subscriptions: ReadonlyArray<Subscription>;
  azureAccounts: ReadonlyArray<AzureLoginAccount>;
  maxRegions: number;
}

/**
 * Find the first subscription matching `subscriptionId` across the logged-in
 * Azure accounts. Returns undefined if no AAD account is connected or the
 * subscription wasn't enumerated for it.
 */
export function findAzureSubscription(
  subscriptionId: string,
  azureAccounts: ReadonlyArray<AzureLoginAccount>,
): AzureLoginSubscription | undefined {
  for (const acct of azureAccounts) {
    const match = acct.subscriptions.find(
      (s) => s.subscriptionId === subscriptionId,
    );
    if (match) return match;
  }
  return undefined;
}

/** Validate the subscription input. */
export function checkSubscription(input: PreflightInputs): PreflightResult {
  const { subscriptionId, subscriptions, azureAccounts } = input;
  const trimmed = subscriptionId.trim();
  if (!trimmed) {
    return {
      id: "subscription",
      label: "Subscription selected",
      level: "error",
      detail: "Choose a subscription to continue.",
    };
  }
  if (!isValidSubscriptionId(trimmed)) {
    return {
      id: "subscription",
      label: "Subscription selected",
      level: "error",
      detail: "Subscription ID must be a valid UUID.",
    };
  }

  // Prefer enumerated AAD subscription metadata when available.
  const azSub = findAzureSubscription(trimmed, azureAccounts);
  if (azSub) {
    const state = (azSub.state ?? "").toLowerCase();
    if (state === "enabled" || state === "") {
      return {
        id: "subscription",
        label: "Subscription enabled",
        level: "ok",
        detail: `${azSub.displayName} is in "Enabled" state.`,
      };
    }
    return {
      id: "subscription",
      label: "Subscription enabled",
      level: "error",
      detail: `Subscription state is "${azSub.state}". Azure will refuse Batch account creation.`,
    };
  }

  // Fall back to plain Subscription[] (no state info available).
  const known = subscriptions.find((s) => s.subscriptionId === trimmed);
  if (known) {
    return {
      id: "subscription",
      label: "Subscription selected",
      level: "ok",
      detail: `${known.displayName}.`,
    };
  }

  return {
    id: "subscription",
    label: "Subscription selected",
    level: "warn",
    detail: "Subscription state will be verified at submit time.",
  };
}

/** Validate the regions selection. */
export function checkRegions(input: PreflightInputs): PreflightResult {
  const { selectedRegions, maxRegions } = input;
  if (selectedRegions.length === 0) {
    return {
      id: "regions",
      label: "Regions selected",
      level: "error",
      detail: "Select at least one region.",
    };
  }
  if (selectedRegions.length > maxRegions) {
    return {
      id: "regions",
      label: "Regions selected",
      level: "error",
      detail: `Maximum ${maxRegions} regions per request.`,
    };
  }
  if (selectedRegions.length >= 10) {
    return {
      id: "regions",
      label: "Regions selected",
      level: "warn",
      detail: `${selectedRegions.length} regions selected — provisioning will be rate-limited.`,
    };
  }
  return {
    id: "regions",
    label: "Regions selected",
    level: "ok",
    detail: `${selectedRegions.length} region${
      selectedRegions.length === 1 ? "" : "s"
    } chosen.`,
  };
}

/** Detect regions where an account has already been created in this session. */
export function checkDuplicateRegions(input: PreflightInputs): PreflightResult {
  const { selectedRegions, accounts, subscriptionId } = input;
  const trimmed = subscriptionId.trim();
  if (!trimmed || selectedRegions.length === 0) {
    return {
      id: "duplicates",
      label: "No duplicates",
      level: "unknown",
      detail: "Will be evaluated when subscription and regions are set.",
    };
  }
  const existing = new Set(
    accounts
      .filter(
        (a) =>
          a.subscriptionId === trimmed && a.provisioningState === "created",
      )
      .map((a) => a.region),
  );
  const overlapping = selectedRegions.filter((r) => existing.has(r));
  if (overlapping.length === 0) {
    return {
      id: "duplicates",
      label: "No duplicates",
      level: "ok",
      detail: "No existing accounts will be re-created.",
    };
  }
  return {
    id: "duplicates",
    label: "Existing accounts will be skipped",
    level: "warn",
    detail: `${overlapping.length} region${
      overlapping.length === 1 ? "" : "s"
    } already have an account: ${overlapping.join(", ")}.`,
  };
}

/** Check that an MSAL/AAD account is connected (RBAC proxy). */
export function checkRbac(input: PreflightInputs): PreflightResult {
  const { azureAccounts, subscriptionId } = input;
  if (azureAccounts.length === 0) {
    return {
      id: "rbac",
      label: "Azure identity",
      level: "warn",
      detail:
        "No Azure AD account connected — sign in to verify RBAC and quota.",
    };
  }
  const trimmed = subscriptionId.trim();
  if (trimmed) {
    const found = findAzureSubscription(trimmed, azureAccounts);
    if (!found) {
      return {
        id: "rbac",
        label: "Azure identity",
        level: "warn",
        detail:
          "Selected subscription is not visible to any signed-in account; you may lack RBAC.",
      };
    }
  }
  return {
    id: "rbac",
    label: "Azure identity",
    level: "ok",
    detail: `${azureAccounts.length} signed-in account${
      azureAccounts.length === 1 ? "" : "s"
    }.`,
  };
}

/** Run all pre-flight checks and return them in display order. */
export function runPreflight(input: PreflightInputs): PreflightResult[] {
  return [
    checkSubscription(input),
    checkRegions(input),
    checkRbac(input),
    checkDuplicateRegions(input),
  ];
}

/** True iff every blocking check is OK or warn (no errors). */
export function preflightCanSubmit(checks: PreflightResult[]): boolean {
  return checks.every((c) => c.level !== "error");
}
