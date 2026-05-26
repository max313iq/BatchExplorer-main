/**
 * Resource Manager — bulk move Azure Batch accounts between
 * resource groups / subscriptions via ARM's moveResources API.
 *
 * Flow:
 *   1. Pick the signed-in account that does the ARM calls.
 *   2. Pick the source subscription → list Batch accounts in it
 *      (already implemented via listBatchAccounts).
 *   3. Multi-select with checkboxes (bulk mode is the default).
 *   4. Pick a destination subscription. Each selected account gets its
 *      own freshly-created destination RG, name-templated per row.
 *   5. Validate (pre-flight via ARM validateMoveResources, no side
 *      effects).
 *   6. Move (long-running; the service layer polls Azure-AsyncOperation
 *      under the hood — including the fall-back of polling the resource
 *      URL itself when ARM returns 202 without a Location header — and
 *      surfaces success/failure inline per row).
 *
 * Notes / Azure caveats surfaced in the UI:
 *   - Source RG is implicit per Batch account (the path's resourceGroups
 *     segment). moveResources requires a single source RG per call, so we
 *     issue one call per account (each gets its own destination RG to
 *     avoid name collisions with sibling accounts).
 *   - ARM limits each call to 800 resources; we never exceed that here.
 *   - Cross-subscription moves require both subs in the same tenant
 *     and the destination subscription must allow Microsoft.Batch.
 *   - Run-id correlation: every validate/move kick-off generates an
 *     incrementing `runId`. Async setState callbacks check the run-id
 *     to avoid clobbering newer runs (race-condition fix for the case
 *     where an operator cancels then immediately re-clicks).
 */
import * as React from "react";
export declare const ResourceManagerPage: React.FC;
//# sourceMappingURL=resource-manager-page.d.ts.map