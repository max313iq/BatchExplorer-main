/**
 * Multi-region SDK service layer.
 *
 * Re-exports all service functions and types so consumers can import from
 * a single entry point:
 *
 *   import { listSubscriptions, listPools, AzureRequestError } from "../services";
 */

// Types
export type {
    AzureError,
    ArmSubscription,
    ArmBatchAccount,
    ArmResourceGroup,
    VmFamilyCoreQuota,
    BatchPool,
    BatchNode,
    NodeAction,
} from "./types";
export { AzureRequestError } from "./types";

// ARM management plane
export {
    listSubscriptions,
    listBatchAccounts,
    getBatchAccount,
    createResourceGroup,
    createBatchAccount,
} from "./arm-service";

// Batch data plane
export {
    listPools,
    createPool,
    patchPool,
    deletePool,
    listNodes,
    performNodeAction,
    removeNodes,
} from "./batch-service";

// Support ticket adapter (pre-existing)
export { SupportTicketAdapter } from "./support-ticket-adapter";
export type {
    SubmitQuotaTicketParams,
    SupportTicketResponse,
    SupportPlan,
} from "./support-ticket-adapter";
