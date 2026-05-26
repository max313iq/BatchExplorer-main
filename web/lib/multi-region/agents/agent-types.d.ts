/**
 * Agent contracts shared across the multi-region domain. Per Design
 * Contract §1.7, all long-running agent calls accept an optional AbortSignal
 * for cooperative cancellation.
 */
import { MultiRegionStore } from "../store/multi-region-store";
import { RequestScheduler } from "../scheduling/request-scheduler";
import type { RequestGuard } from "../scheduling/request-governance";
import { AgentName } from "../store/store-types";
/**
 * Minimal AuditLogger contract surfaced by AgentContext. Mirrors the
 * shape used by the auth subsystem's `audit-logger-types.ts` so a
 * single implementation (e.g. `services/audit-log.ts`) can satisfy
 * both consumers via dependency injection from the dashboard-shell.
 *
 * The default is a no-op (see `noopAuditLogger`) so agents can call
 * `(ctx.auditLogger ?? noopAuditLogger).record(...)` without
 * conditional checks at each call site.
 */
export interface AgentAuditRecord {
    /** Actor — usually a UPN, homeAccountId, or "system". */
    actor?: string;
    /** Short verb identifying the action — e.g. "pool_create". */
    action: string;
    /** Object of the action — pool id, account id, etc. */
    target?: string;
    /** "success" | "failure". */
    status: "success" | "failure";
    /** Free-text error description on failure. */
    error?: string;
    /** Action-specific structured detail (NEVER passwords or tokens). */
    details?: Record<string, unknown>;
}
export interface AgentAuditLogger {
    record(entry: AgentAuditRecord): void;
}
/**
 * Default no-op logger. Used when AgentContext does not provide an
 * `auditLogger` — keeps agent code free of `if (logger)` ladders.
 */
export declare const noopAuditLogger: AgentAuditLogger;
export interface AgentContext {
    store: MultiRegionStore;
    scheduler: RequestScheduler;
    armUrl: string;
    getAccessToken: (tenantId?: string) => Promise<string>;
    getBatchAccessToken: (tenantId?: string) => Promise<string>;
    /** Optional Microsoft Graph token provider (falls back to msal-auth). */
    getGraphAccessToken?: (tenantId?: string) => Promise<string>;
    /**
     * Per-subscription ARM token. Routes through MSAL's per-account API
     * when the store has the sub's owning homeAccountId (multi-signed-in
     * browsers); otherwise falls back to `getAccessToken(sub.tenantId)`
     * so callers that don't need multi-account routing keep working.
     *
     * Agents that target a specific subscription (provisioner,
     * orchestrator's create_batch_account, etc.) MUST prefer this over
     * the generic getAccessToken — otherwise an operator with two
     * signed-in accounts picking a sub from the non-primary account
     * will hit "subscription not found" or "no access" errors because
     * the primary's token doesn't see the chosen sub.
     */
    getAccessTokenForSubscription?: (subscriptionId: string) => Promise<string>;
    /**
     * Per-subscription Batch data-plane token. Same routing logic as
     * `getAccessTokenForSubscription` but issues a token with the
     * `https://batch.core.windows.net/.default` scope so it can be
     * presented to the Batch endpoint of an account owned by that sub.
     *
     * Required for pool / node / task operations that target accounts
     * spanning multiple subscriptions in the same dispatch — without
     * it the pool-agent's single global Batch token cannot create
     * pools on accounts owned by a non-primary signed-in AAD account.
     */
    getBatchAccessTokenForSubscription?: (subscriptionId: string) => Promise<string>;
    requestGuard?: RequestGuard;
    /**
     * Optional structured audit-event sink. Agents call
     * `ctx.auditLogger?.record(...)` for write-side operations (pool
     * create/delete, node action, account create, tenant switch, etc.).
     * The dashboard-shell wires the real `services/audit-log` instance
     * in at app boot; tests can pass `noopAuditLogger` or a jest mock.
     */
    auditLogger?: AgentAuditLogger;
}
export interface AgentResult {
    status: "completed" | "failed" | "partial";
    summary: Record<string, unknown>;
}
/**
 * Generic per-action execute params. Future-typed alternative to the
 * `Record<string, unknown>` payload shape — pages and the orchestrator can
 * thread an AbortSignal through to underlying service calls.
 */
export interface AgentExecuteParams<P = Record<string, unknown>> {
    action: string;
    payload: P;
    /** Cooperative cancellation. Honored by orchestrator and sub-agents. */
    signal?: AbortSignal;
    /** Optional correlation id surfaced in audit + agent log entries. */
    correlationId?: string;
}
export interface AgentMessage {
    action: string;
    payload: Record<string, unknown>;
    requestId: string;
    timestamp: string;
}
export interface AgentResponse {
    requestId: string;
    status: "completed" | "failed" | "partial";
    summary: Record<string, unknown>;
    timestamp: string;
}
export interface Agent {
    readonly name: AgentName;
    /**
     * Execute an agent action. Implementations should accept either the legacy
     * untyped params object or the new `AgentExecuteParams` shape — preserve
     * the original `params` signature so existing callers keep working.
     */
    execute(params: Record<string, unknown>): Promise<AgentResult>;
    cancel(): void;
}
export interface ProvisionerInput {
    subscriptionId: string;
    regions: string[];
    config?: {
        concurrency?: number;
        delayMs?: number;
        retryAttempts?: number;
        retryBackoffSeconds?: number[];
        jitterPct?: number;
        /**
         * When true, every write call (createResourceGroup,
         * createBatchAccount, etc.) is logged with a `[dry-run]` prefix
         * and skipped. The agent returns `status: "completed", dryRun:
         * true` per region without touching Azure.
         */
        dryRun?: boolean;
    };
}
/**
 * Canonical quota-type name used across the agents subsystem. Azure
 * surfaces the same concept as either "lowPriority" / "LowPriority" /
 * "Spot" / "Dedicated" depending on which API you're talking to;
 * agents standardize on these PascalCase names internally and
 * normalize at boundary I/O via `normalizeQuotaType()`.
 */
export type QuotaTypeName = "Dedicated" | "LowPriority" | "Spot";
/**
 * Normalize the many quota-type spellings seen across the codebase
 * ("lowPriority", "low-priority", "LowPriority", "low_priority",
 * "spot", "dedicated", ...) into the canonical PascalCase form.
 *
 * Returns `null` for unrecognised input so callers can decide whether
 * to default or surface an error — silently mapping to a wrong type
 * caused the pool-agent.ts:232 vs agent-types.ts:110 mismatch.
 */
export declare function normalizeQuotaType(raw: string | null | undefined): QuotaTypeName | null;
export interface QuotaInput {
    accountIds: string[];
    quotaType: QuotaTypeName;
    newLimit: number;
    contactConfig: {
        email: string;
        timezone: string;
        country: string;
        language: string;
    };
    /** Optional — auto-detected per subscription if omitted */
    supportPlanId?: string;
    config?: {
        concurrency?: number;
        delayMs?: number;
        retryAttempts?: number;
        retryBackoffSeconds?: number[];
        jitterPct?: number;
    };
}
export interface FilterInput {
    filters: {
        regions?: string[];
        subscriptionIds?: string[];
        provisioningState?: string;
        accountIds?: string[];
        hasPool?: boolean;
    };
    selectAll?: boolean;
}
export interface FilterOutput {
    matchCount: number;
    accounts: Array<{
        accountId: string;
        accountName: string;
        region: string;
        subscriptionId: string;
        hasPool: boolean;
    }>;
}
export interface PoolInput {
    accountIds: string[];
    poolConfig: Record<string, unknown>;
    config?: {
        concurrency?: number;
        delayMs?: number;
        retryAttempts?: number;
        retryBackoffSeconds?: number[];
        jitterPct?: number;
        /**
         * Optional idempotency key. When set, the agent derives a
         * deterministic pool name `${prefix}-${sha1(key+vmSize+startTaskHash).slice(0,8)}`
         * so a retried create with the same key collides with the
         * previous attempt — making the operation idempotent at the
         * Azure Batch layer. When unset, a random suffix is used (old
         * behavior).
         */
        idempotencyKey?: string;
        /**
         * Dry-run mode. When true, the agent computes the pool body and
         * logs a `[dry-run]` activity entry, but never calls
         * `createPool`. Useful for previewing what the agent would do
         * before unleashing it on a real subscription.
         */
        dryRun?: boolean;
    };
}
/**
 * Common orchestrator payload envelope. Pages dispatching actions
 * through `OrchestratorAgent.execute` may include `dryRun: true` so the
 * orchestrator forwards it to every sub-agent that supports it.
 */
export interface OrchestratorPayload {
    /** Apply dry-run semantics across the entire dispatch. */
    dryRun?: boolean;
    /** Free-form action-specific fields. */
    [key: string]: unknown;
}
//# sourceMappingURL=agent-types.d.ts.map