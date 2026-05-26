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
import { AzureLoginAccount, AzureLoginSubscription, ManagedAccount, Subscription } from "../store/store-types";
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
export declare function findAzureSubscription(subscriptionId: string, azureAccounts: ReadonlyArray<AzureLoginAccount>): AzureLoginSubscription | undefined;
/** Validate the subscription input. */
export declare function checkSubscription(input: PreflightInputs): PreflightResult;
/** Validate the regions selection. */
export declare function checkRegions(input: PreflightInputs): PreflightResult;
/** Detect regions where an account has already been created in this session. */
export declare function checkDuplicateRegions(input: PreflightInputs): PreflightResult;
/** Check that an MSAL/AAD account is connected (RBAC proxy). */
export declare function checkRbac(input: PreflightInputs): PreflightResult;
/** Run all pre-flight checks and return them in display order. */
export declare function runPreflight(input: PreflightInputs): PreflightResult[];
/** True iff every blocking check is OK or warn (no errors). */
export declare function preflightCanSubmit(checks: PreflightResult[]): boolean;
//# sourceMappingURL=account-provisioning-preflight.d.ts.map