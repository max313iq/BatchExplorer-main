import { __awaiter } from "tslib";
import { noopAuditLogger, } from "./agent-types";
import { createPool, listPools } from "../services/batch-service";
import { AzureRequestError } from "../services/types";
import { classifyAzureError } from "./error-classifier";
import { isBlacklisted, addToBlacklist, recordBlacklistHit, } from "../store/failure-blacklist";
import { uuidV4, random4 } from "./_shared/ids";
import { accountEndpoint } from "./_shared/endpoints";
import { abortableSleep, isAbortError } from "./_shared/abortable-sleep";
import { CancellationTracker } from "./_shared/cancellation";
function vmShortName(vmSize) {
    // "Standard_NC6s_v3" → "nc6s-v3"
    return vmSize
        .replace(/^Standard_/i, "")
        .toLowerCase()
        .replace(/_/g, "-");
}
/**
 * Tiny FNV-1a style hex digest. Used to derive a deterministic 8-char
 * suffix for `idempotencyKey`-driven pool names so a retried create
 * with the same key collides with the previous attempt. NOT
 * cryptographically secure — just collision-resistant enough for
 * client-side idempotency tokens.
 */
function shortHash8(input) {
    let h1 = 0x811c9dc5;
    let h2 = 0xdeadbeef;
    for (let i = 0; i < input.length; i++) {
        const c = input.charCodeAt(i);
        h1 = (h1 ^ c) >>> 0;
        h1 = Math.imul(h1, 0x01000193);
        h2 = (h2 ^ c) >>> 0;
        h2 = Math.imul(h2, 0x01000193);
    }
    const hi = (h1 >>> 0).toString(16).padStart(8, "0");
    const lo = (h2 >>> 0).toString(16).padStart(8, "0");
    return (hi + lo).slice(0, 8);
}
/** Map of VM size keys to vCPU counts used for quota math */
const VM_VCPUS = {
    Standard_ND40rs_v2: 40,
    Standard_ND96isr_H100_v5: 96,
    Standard_NC24s_v3: 24,
    Standard_NC12s_v3: 12,
    Standard_NC6s_v3: 6,
};
export class PoolAgent {
    constructor(_ctx, tokenProvider) {
        Object.defineProperty(this, "_ctx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: _ctx
        });
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "pool"
        });
        /**
         * Legacy `_cancelled` flag preserved so legacy `cancel()` callers
         * keep working — but the source of truth for cooperative
         * cancellation is now the `_cancellation` tracker. When the legacy
         * flag flips, every in-flight call's controller is aborted as well.
         */
        Object.defineProperty(this, "_cancelled", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "_cancellation", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new CancellationTracker()
        });
        Object.defineProperty(this, "_tokenProvider", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        // Accept an explicit TokenProvider; fall back to context method.
        this._tokenProvider = tokenProvider !== null && tokenProvider !== void 0 ? tokenProvider : _ctx.getBatchAccessToken.bind(_ctx);
    }
    cancel() {
        this._cancelled = true;
        this._cancellation.abortAll();
    }
    /** Shorthand for `(ctx.auditLogger ?? noopAuditLogger)`. */
    get _audit() {
        var _a;
        return (_a = this._ctx.auditLogger) !== null && _a !== void 0 ? _a : noopAuditLogger;
    }
    /**
     * Per-call cancel check. Returns true if EITHER the per-call signal
     * has aborted OR the legacy `_cancelled` flag has been flipped.
     * Use at iteration boundaries instead of `if (this._cancelled)`.
     */
    _isCancelled(signal) {
        if (this._cancelled)
            return true;
        if (signal === null || signal === void 0 ? void 0 : signal.aborted)
            return true;
        return false;
    }
    /**
     * Resolve a Batch data-plane token for the account being targeted.
     *
     * Why per-account: when a single pool-create dispatch spans accounts
     * across multiple subscriptions (potentially owned by different
     * signed-in AAD identities), the global `_tokenProvider()` only ever
     * returns the primary account's token — which fails authentication
     * against any Batch endpoint owned by a non-primary tenant.
     *
     * The lookup chain prefers the context-provided per-sub resolver
     * (multi-account browsers) and falls back to the global provider so
     * single-account setups and unit tests with a fixed token continue
     * to work unchanged.
     *
     * `subscriptionId` may be missing on legacy / synthetic accounts —
     * the fallback covers that case too.
     */
    _resolveToken(subscriptionId) {
        return __awaiter(this, void 0, void 0, function* () {
            const perSub = this._ctx.getBatchAccessTokenForSubscription;
            if (perSub && subscriptionId) {
                try {
                    return yield perSub(subscriptionId);
                }
                catch (_a) {
                    // Sub-scoped resolution failed (e.g., homeAccountId missing
                    // for a legacy sub) — fall back to the global provider rather
                    // than aborting the whole dispatch.
                }
            }
            return this._tokenProvider();
        });
    }
    execute(params) {
        var _a, _b, _c, _d;
        return __awaiter(this, void 0, void 0, function* () {
            const input = params;
            const { store, scheduler } = this._ctx;
            // Audit fix #8: do NOT reset `_cancelled` here. Resetting the
            // shared flag would silently squash a concurrent caller's cancel
            // request. The `CancellationTracker` registers a per-call
            // controller so each execute() has its own abort lifecycle.
            const callerSignal = params.signal;
            const { controller, signal } = this._cancellation.begin(callerSignal);
            try {
                const cfg = (_a = input.config) !== null && _a !== void 0 ? _a : {};
                const dryRun = Boolean(cfg.dryRun);
                const idempotencyKey = typeof cfg.idempotencyKey === "string" && cfg.idempotencyKey.length > 0
                    ? cfg.idempotencyKey
                    : undefined;
                store.setAgentStatus("pool", "running");
                store.addLog({
                    agent: "pool",
                    level: "info",
                    message: `${dryRun ? "[dry-run] " : ""}Starting pool creation on ${input.accountIds.length} accounts`,
                });
                let created = 0;
                let failed = 0;
                const failures = [];
                const basePoolId = (_b = input.poolConfig.id) !== null && _b !== void 0 ? _b : "pool";
                for (const accountId of input.accountIds) {
                    if (this._isCancelled(signal))
                        break;
                    const state = store.getState();
                    const account = state.accounts.find((a) => a.id === accountId);
                    if (!account) {
                        store.addLog({
                            agent: "pool",
                            level: "warn",
                            message: `Account ${accountId} not found, skipping`,
                        });
                        continue;
                    }
                    const internalId = uuidV4();
                    // SAFETY: Always force targetDedicatedNodes = 0.
                    // Never allow dedicated nodes regardless of what the caller passes.
                    const vmSizeForId = (_c = input.poolConfig.vmSize) !== null && _c !== void 0 ? _c : "";
                    const startTaskJson = (() => {
                        var _a;
                        try {
                            return JSON.stringify((_a = input.poolConfig.startTask) !== null && _a !== void 0 ? _a : null);
                        }
                        catch (_b) {
                            return "null";
                        }
                    })();
                    // Audit fix #19: derive a deterministic poolId when caller
                    // supplied an idempotency key. Otherwise keep the legacy
                    // explicit / fallback "pool" id.
                    const poolId = idempotencyKey
                        ? `${basePoolId}-${shortHash8(`${idempotencyKey}|${vmSizeForId}|${startTaskJson}`)}`
                        : basePoolId;
                    const poolConfig = Object.assign(Object.assign({}, input.poolConfig), { id: poolId, targetDedicatedNodes: 0 });
                    const pool = {
                        id: internalId,
                        accountId,
                        poolId,
                        provisioningState: "pending",
                        config: poolConfig,
                        createdAt: new Date().toISOString(),
                        error: null,
                    };
                    store.addPool(pool);
                    try {
                        store.updatePool(internalId, {
                            provisioningState: "creating",
                        });
                        yield scheduler.run(accountId, () => __awaiter(this, void 0, void 0, function* () {
                            if (this._isCancelled(signal)) {
                                throw new Error("cancelled");
                            }
                            const token = yield this._resolveToken(account.subscriptionId);
                            const endpoint = accountEndpoint(account.accountName, account.region);
                            if (dryRun) {
                                store.addLog({
                                    agent: "pool",
                                    level: "info",
                                    message: `[dry-run] would createPool ${poolId} on ${account.accountName} (${account.region}) — vmSize=${vmSizeForId}`,
                                });
                            }
                            else {
                                yield createPool(endpoint, poolConfig, token);
                            }
                        }));
                        // Throttle between pool creations (skip in dry-run for speed).
                        if (!dryRun) {
                            try {
                                yield abortableSleep(500, signal);
                            }
                            catch (_e) {
                                break;
                            }
                        }
                        store.updatePool(internalId, {
                            provisioningState: "created",
                        });
                        // Update store.poolInfos with newly created pool
                        if (!dryRun) {
                            this._addPoolInfoToStore(account, poolId, poolConfig);
                        }
                        store.addLog({
                            agent: "pool",
                            level: "info",
                            message: `${dryRun ? "[dry-run] would have created" : "Created"} pool "${poolId}" on ${account.accountName} (${account.region})`,
                        });
                        created++;
                        this._audit.record({
                            action: dryRun ? "pool_create_dryrun" : "pool_create",
                            target: `${account.accountName}/${poolId}`,
                            status: "success",
                            details: {
                                accountId,
                                poolId,
                                vmSize: vmSizeForId,
                                dryRun,
                            },
                        });
                    }
                    catch (error) {
                        const errorMsg = error instanceof AzureRequestError
                            ? error.message
                            : (_d = error === null || error === void 0 ? void 0 : error.message) !== null && _d !== void 0 ? _d : String(error);
                        const classified = classifyAzureError(error);
                        store.updatePool(internalId, {
                            provisioningState: "failed",
                            error: errorMsg,
                        });
                        store.addLog({
                            agent: "pool",
                            level: "error",
                            message: `Failed pool creation on ${account.accountName} [${classified.kind}]: ${errorMsg}`,
                        });
                        failures.push({
                            accountName: account.accountName,
                            region: account.region,
                            error: errorMsg,
                            kind: classified.kind,
                        });
                        failed++;
                        this._audit.record({
                            action: "pool_create",
                            target: `${account.accountName}/${poolId}`,
                            status: "failure",
                            error: errorMsg,
                            details: {
                                accountId,
                                poolId,
                                vmSize: vmSizeForId,
                                classification: classified.kind,
                                dryRun,
                            },
                        });
                    }
                }
                const status = failed === 0 ? "completed" : created === 0 ? "failed" : "partial";
                store.setAgentStatus("pool", status === "failed" ? "error" : "completed");
                return {
                    status,
                    summary: Object.assign({ total: input.accountIds.length, created,
                        failed,
                        failures }, (dryRun ? { dryRun: true } : {})),
                };
            }
            finally {
                this._cancellation.end(controller);
            }
        });
    }
    /**
     * Smart pool creation with VM size fallback.
     *
     * Per account, tries VM sizes in priority order. If a VM size fails with
     * a capacity/quota error, falls back to the next. Calculates maxNodes
     * from LP quota (floor(freeLpCores / vCPUs per VM)).
     *
     * If a pool is created but doesn't consume all available quota, a second
     * pool may be created with the next VM size for the remaining quota.
     *
     * SAFETY: ALWAYS sets targetDedicatedNodes = 0 and only uses LP quota.
     */
    executeWithFallback(params) {
        var _a, _b;
        return __awaiter(this, void 0, void 0, function* () {
            const { accountIds, vmSizes, poolConfig } = params;
            const { store, scheduler } = this._ctx;
            // Audit fix #8: per-call AbortController, not a shared flag.
            const { controller, signal } = this._cancellation.begin(params.signal);
            const dryRun = Boolean(params.dryRun);
            try {
                store.setAgentStatus("pool", "running");
                store.addLog({
                    agent: "pool",
                    level: "info",
                    message: `${dryRun ? "[dry-run] " : ""}Smart pool creation on ${accountIds.length} accounts with ${vmSizes.length} VM size(s)`,
                });
                // Pre-flight: if every input account has zero free LP quota,
                // abort without making any API calls. Audit fix #5: surface a
                // descriptive `failures[]` entry per skipped account so the
                // caller (orchestrator + UI) can render something more useful
                // than "Pool creation failed".
                const preState = store.getState();
                const accountsWithQuota = accountIds.filter((id) => {
                    var _a;
                    const info = preState.accountInfos.find((a) => a.id === id);
                    return ((_a = info === null || info === void 0 ? void 0 : info.lowPriorityCoresFree) !== null && _a !== void 0 ? _a : 0) > 0;
                });
                if (accountsWithQuota.length === 0) {
                    store.setAgentStatus("pool", "completed");
                    store.addLog({
                        agent: "pool",
                        level: "warn",
                        message: `No free LP quota on any of ${accountIds.length} input accounts. Smart-mode is stopping without making any pool calls — request a quota increase or pick different accounts.`,
                    });
                    const noQuotaFailures = accountIds.map((id) => {
                        var _a, _b, _c, _d, _e;
                        const info = preState.accountInfos.find((a) => a.id === id);
                        const acct = preState.accounts.find((a) => a.id === id);
                        const vmFamily = (_a = vmSizes[0]) !== null && _a !== void 0 ? _a : "?";
                        const requestedSlots = 1;
                        const availableSlots = (_b = info === null || info === void 0 ? void 0 : info.lowPriorityCoresFree) !== null && _b !== void 0 ? _b : 0;
                        return {
                            kind: "no_quota",
                            account: (_c = acct === null || acct === void 0 ? void 0 : acct.accountName) !== null && _c !== void 0 ? _c : id,
                            accountName: (_d = acct === null || acct === void 0 ? void 0 : acct.accountName) !== null && _d !== void 0 ? _d : id,
                            region: (_e = acct === null || acct === void 0 ? void 0 : acct.region) !== null && _e !== void 0 ? _e : "?",
                            vmFamily,
                            reason: `No free LP quota (${availableSlots} cores) for ${vmFamily}`,
                            requestedSlots,
                            availableSlots,
                            error: `No free LP quota (${availableSlots} cores) for ${vmFamily}`,
                        };
                    });
                    return {
                        status: "failed",
                        summary: Object.assign({ total: accountIds.length, created: 0, failed: noQuotaFailures.length, failures: noQuotaFailures }, (dryRun ? { dryRun: true } : {})),
                    };
                }
                let totalCreated = 0;
                let totalFailed = 0;
                let abortRun = false;
                const failures = [];
                // Extract startTask from the payload pool config
                const startTask = poolConfig.startTask;
                for (const accountId of accountIds) {
                    if (abortRun)
                        break;
                    if (this._isCancelled(signal))
                        break;
                    const currentState = store.getState();
                    const account = currentState.accounts.find((a) => a.id === accountId);
                    if (!account) {
                        store.addLog({
                            agent: "pool",
                            level: "warn",
                            message: `Account ${accountId} not found, skipping`,
                        });
                        continue;
                    }
                    // Get free LP quota from AccountInfo in the store
                    // ALWAYS use LP quota only, never dedicated
                    const accountInfo = currentState.accountInfos.find((a) => a.id === accountId);
                    let remainingQuota = 0;
                    if (accountInfo) {
                        remainingQuota = accountInfo.lowPriorityCoresFree;
                    }
                    if (remainingQuota <= 0) {
                        store.addLog({
                            agent: "pool",
                            level: "warn",
                            message: `No free LP quota on ${account.accountName}, skipping`,
                        });
                        // Audit fix #5: even mid-loop no-quota skips deserve a
                        // descriptive failure entry so the orchestrator can surface
                        // "no_quota" instead of "Pool creation failed".
                        failures.push({
                            accountName: account.accountName,
                            region: account.region,
                            error: `No free LP quota`,
                            kind: "no_quota",
                        });
                        totalFailed++;
                        continue;
                    }
                    let accountCreated = false;
                    let regionPermanentlyBlocked = false;
                    for (let vmIdx = 0; vmIdx < vmSizes.length; vmIdx++) {
                        if (this._isCancelled(signal))
                            break;
                        if (abortRun)
                            break;
                        if (regionPermanentlyBlocked)
                            break;
                        if (remainingQuota <= 0)
                            break;
                        const vmSize = vmSizes[vmIdx];
                        const vCPUs = (_a = VM_VCPUS[vmSize]) !== null && _a !== void 0 ? _a : 1;
                        // Permanent (vmSize, region) blacklist: skip combinations that
                        // previously hit a SkuNotAvailable / NotAvailableForSubscription /
                        // similar killer error. Blacklist persists across reloads.
                        const bl = isBlacklisted(vmSize, account.region);
                        if (bl.blocked) {
                            recordBlacklistHit(vmSize, account.region);
                            store.addLog({
                                agent: "pool",
                                level: "info",
                                message: `${account.accountName} (${account.region}): ${vmSize} blacklisted — ${bl.reason}. Skipping.`,
                            });
                            continue;
                        }
                        // Compute maxNodes using ONLY LP quota: floor(freeLpCores / vCPUs)
                        const maxNodes = Math.floor(remainingQuota / vCPUs);
                        if (maxNodes <= 0) {
                            store.addLog({
                                agent: "pool",
                                level: "info",
                                message: `${account.accountName}: not enough LP quota (${remainingQuota} cores) for ${vmSize} (${vCPUs} vCPUs), trying next`,
                            });
                            continue;
                        }
                        // Pool ID format: gpu-{vmSizeShort}-{random4}
                        const shortName = vmShortName(vmSize);
                        const currentPoolId = `gpu-${shortName}-${random4()}`;
                        // SAFETY: ALWAYS set targetDedicatedNodes = 0, only use LP nodes
                        // vmSize sent verbatim — Azure Batch / Compute SKU names are
                        // case-sensitive (canonical form: Standard_NC12s_v3). Previously
                        // we lowercased here and the API echoed back
                        // "STANDARD_NC12S_V3 is not supported" because the all-lowercase
                        // variant didn't match any registered SKU. Use the name as it
                        // was returned from listSupportedVirtualMachineSkus.
                        const currentConfig = Object.assign(Object.assign({}, poolConfig), { id: currentPoolId, vmSize, targetDedicatedNodes: 0, targetLowPriorityNodes: maxNodes });
                        // Ensure startTask from payload is included in every pool config
                        if (startTask) {
                            currentConfig.startTask = startTask;
                        }
                        const internalId = uuidV4();
                        const pool = {
                            id: internalId,
                            accountId,
                            poolId: currentPoolId,
                            provisioningState: "pending",
                            config: currentConfig,
                            createdAt: new Date().toISOString(),
                            error: null,
                        };
                        store.addPool(pool);
                        try {
                            store.updatePool(internalId, {
                                provisioningState: "creating",
                            });
                            yield scheduler.run(accountId, () => __awaiter(this, void 0, void 0, function* () {
                                if (this._isCancelled(signal)) {
                                    throw new Error("cancelled");
                                }
                                const token = yield this._resolveToken(account.subscriptionId);
                                const endpoint = accountEndpoint(account.accountName, account.region);
                                if (dryRun) {
                                    store.addLog({
                                        agent: "pool",
                                        level: "info",
                                        message: `[dry-run] would createPool ${currentPoolId} (${vmSize}, ${maxNodes} LP) on ${account.accountName}`,
                                    });
                                }
                                else {
                                    yield createPool(endpoint, currentConfig, token);
                                }
                            }));
                            store.updatePool(internalId, {
                                provisioningState: "created",
                            });
                            // Update store.poolInfos with newly created pool
                            if (!dryRun) {
                                this._addPoolInfoToStore(account, currentPoolId, currentConfig);
                            }
                            store.addLog({
                                agent: "pool",
                                level: "info",
                                message: `${dryRun ? "[dry-run] would have created" : "Created"} pool "${currentPoolId}" (${vmSize}, ${maxNodes} LP nodes) on ${account.accountName}`,
                            });
                            totalCreated++;
                            accountCreated = true;
                            this._audit.record({
                                action: dryRun ? "pool_create_dryrun" : "pool_create",
                                target: `${account.accountName}/${currentPoolId}`,
                                status: "success",
                                details: {
                                    accountId,
                                    vmSize,
                                    maxNodes,
                                    dryRun,
                                },
                            });
                            // Throttle between pool creations to avoid Azure fraud detection.
                            // Abortable so cancel doesn't have to wait the full second.
                            try {
                                yield abortableSleep(1000, signal);
                            }
                            catch (_c) {
                                break;
                            }
                            // Skip the resize-poll entirely in dry-run — there's nothing
                            // to poll for.
                            if (dryRun) {
                                if (remainingQuota > 0)
                                    continue;
                                break;
                            }
                            // Wait for pool to finish resizing to get ACTUAL node count
                            store.addLog({
                                agent: "pool",
                                level: "info",
                                message: `${account.accountName}: Waiting for pool "${currentPoolId}" to finish resizing...`,
                            });
                            const accountEndpointStr = accountEndpoint(account.accountName, account.region);
                            const resizeResult = yield this._waitForPoolSteady(accountEndpointStr, currentPoolId, yield this._resolveToken(account.subscriptionId), account.subscriptionId, undefined, signal);
                            const actualNodes = resizeResult.actualLpNodes;
                            const actualCoresUsed = actualNodes * vCPUs;
                            remainingQuota -= actualCoresUsed;
                            store.addLog({
                                agent: "pool",
                                level: "info",
                                message: `${account.accountName}: Pool "${currentPoolId}" (${vmSize}): ${actualNodes}/${maxNodes} nodes allocated (${actualCoresUsed} cores used, ${remainingQuota} cores remaining)`,
                            });
                            if (resizeResult.resizeErrors > 0) {
                                store.addLog({
                                    agent: "pool",
                                    level: "warn",
                                    message: `${account.accountName}: Pool "${currentPoolId}" had ${resizeResult.resizeErrors} resize error(s)`,
                                });
                            }
                            // ALWAYS continue to next VM if quota remains (waterfall fill)
                            if (remainingQuota > 0) {
                                store.addLog({
                                    agent: "pool",
                                    level: "info",
                                    message: `${account.accountName}: ${remainingQuota} LP cores remaining — trying next VM size`,
                                });
                                continue; // next VM in the loop
                            }
                            // No quota left — done with this account
                            break;
                        }
                        catch (error) {
                            const errorMsg = error instanceof AzureRequestError
                                ? error.message
                                : (_b = error === null || error === void 0 ? void 0 : error.message) !== null && _b !== void 0 ? _b : String(error);
                            store.updatePool(internalId, {
                                provisioningState: "failed",
                                error: errorMsg,
                            });
                            const classified = classifyAzureError(error);
                            // Permission / subscription-disabled — abort the whole run.
                            if (classified.shouldAbortRun) {
                                store.addLog({
                                    agent: "pool",
                                    level: "error",
                                    message: `${account.accountName}: ${classified.kind} — aborting run. ${classified.reason}`,
                                });
                                failures.push({
                                    accountName: account.accountName,
                                    region: account.region,
                                    error: classified.reason,
                                    kind: classified.kind,
                                });
                                totalFailed++;
                                abortRun = true;
                                break;
                            }
                            // Killer (vmSize, region) — blacklist permanently and try the
                            // next VM size in this region.
                            if (classified.kind === "killer-vm-region") {
                                const entry = addToBlacklist(vmSize, account.region, classified.reason);
                                store.addLog({
                                    agent: "pool",
                                    level: "warn",
                                    message: `${account.accountName}: ${vmSize} permanently blacklisted in ${account.region} (added ${entry.addedAt}). Reason: ${classified.reason}`,
                                });
                                try {
                                    yield abortableSleep(500, signal);
                                }
                                catch (_d) {
                                    break;
                                }
                                continue;
                            }
                            // Killer-region — every VM size will fail here. Mark the
                            // region blocked for this account and skip remaining VM
                            // iterations.
                            if (classified.kind === "killer-region") {
                                for (const vs of vmSizes) {
                                    addToBlacklist(vs, account.region, classified.reason);
                                }
                                store.addLog({
                                    agent: "pool",
                                    level: "warn",
                                    message: `${account.accountName}: region ${account.region} blocked — ${classified.reason}. Blacklisting all configured VM sizes here.`,
                                });
                                failures.push({
                                    accountName: account.accountName,
                                    region: account.region,
                                    error: classified.reason,
                                    kind: classified.kind,
                                });
                                totalFailed++;
                                regionPermanentlyBlocked = true;
                                break;
                            }
                            // Capacity / quota — transient or recoverable; try next VM.
                            if (classified.shouldFallbackVm) {
                                store.addLog({
                                    agent: "pool",
                                    level: "warn",
                                    message: `${account.accountName}: ${vmSize} ${classified.kind} (${classified.reason}). Trying next VM size.`,
                                });
                                try {
                                    yield abortableSleep(500, signal);
                                }
                                catch (_e) {
                                    break;
                                }
                                continue;
                            }
                            // Unknown — be conservative; surface and stop trying further
                            // VM sizes for this account.
                            store.addLog({
                                agent: "pool",
                                level: "error",
                                message: `${account.accountName}: ${classified.kind || "error"} — ${classified.reason}`,
                            });
                            failures.push({
                                accountName: account.accountName,
                                region: account.region,
                                error: classified.reason,
                                kind: classified.kind,
                            });
                            totalFailed++;
                            break;
                        }
                    }
                    // Audit fix #6: always emit an "exhausted" failure when the inner
                    // loop exited without creating a pool, regardless of whether
                    // failures[] already had entries for this account. Previously
                    // this was gated on `failures.length === 0` so concurrent
                    // mixed-account runs silently lost the diagnostic.
                    if (!accountCreated && !regionPermanentlyBlocked && !abortRun) {
                        const alreadyHasEntryForAccount = failures.some((f) => f.accountName === account.accountName);
                        if (!alreadyHasEntryForAccount) {
                            store.addLog({
                                agent: "pool",
                                level: "error",
                                message: `${account.accountName}: all VM sizes exhausted`,
                            });
                            failures.push({
                                accountName: account.accountName,
                                region: account.region,
                                error: "All VM sizes exhausted — capacity/quota insufficient or every size blacklisted",
                                kind: "exhausted",
                            });
                            totalFailed++;
                        }
                    }
                    // Throttle between accounts
                    try {
                        yield abortableSleep(500, signal);
                    }
                    catch (_f) {
                        break;
                    }
                }
                const status = totalFailed === 0
                    ? "completed"
                    : totalCreated === 0
                        ? "failed"
                        : "partial";
                store.setAgentStatus("pool", status === "failed" ? "error" : "completed");
                return {
                    status,
                    summary: Object.assign({ total: accountIds.length, created: totalCreated, failed: totalFailed, failures }, (dryRun ? { dryRun: true } : {})),
                };
            }
            finally {
                this._cancellation.end(controller);
            }
        });
    }
    _waitForPoolSteady(endpoint, poolId, _token, subscriptionId, timeoutMs = 600000, // 10 minutes
    signal) {
        var _a, _b, _c, _d;
        return __awaiter(this, void 0, void 0, function* () {
            const { store } = this._ctx;
            const pollIntervalMs = PoolAgent.POLL_INTERVAL_MS;
            const maxPolls = Math.ceil(timeoutMs / pollIntervalMs);
            for (let i = 0; i < maxPolls; i++) {
                if (this._isCancelled(signal))
                    break;
                try {
                    yield abortableSleep(pollIntervalMs, signal);
                }
                catch (err) {
                    if (isAbortError(err))
                        break;
                    throw err;
                }
                try {
                    // Need a fresh token for each poll since tokens can expire.
                    // Use the per-sub resolver so a multi-account dispatch keeps
                    // talking to the right tenant for every account it touches.
                    const freshToken = yield this._resolveToken(subscriptionId);
                    const pools = yield listPools(endpoint, freshToken);
                    const pool = pools.find((p) => { var _a; return ((_a = p.id) === null || _a === void 0 ? void 0 : _a.toLowerCase()) === poolId.toLowerCase(); });
                    if (!pool) {
                        store.addLog({
                            agent: "pool",
                            level: "warn",
                            message: `Pool ${poolId} not found during resize poll (poll ${i + 1}/${maxPolls})`,
                        });
                        continue;
                    }
                    const state = (_a = pool.allocationState) !== null && _a !== void 0 ? _a : "unknown";
                    const currentLp = (_b = pool.currentLowPriorityNodes) !== null && _b !== void 0 ? _b : 0;
                    const targetLp = (_c = pool.targetLowPriorityNodes) !== null && _c !== void 0 ? _c : 0;
                    const currentDedicated = (_d = pool.currentDedicatedNodes) !== null && _d !== void 0 ? _d : 0;
                    const errors = Array.isArray(pool.resizeErrors)
                        ? pool.resizeErrors.length
                        : 0;
                    store.addLog({
                        agent: "pool",
                        level: "info",
                        message: `Pool ${poolId}: ${state} — ${currentLp}/${targetLp} LP nodes (poll ${i + 1})`,
                    });
                    if (state === "steady" || state === "stopping") {
                        return {
                            actualLpNodes: currentLp,
                            targetLpNodes: targetLp,
                            actualDedicatedNodes: currentDedicated,
                            allocationState: state,
                            resizeErrors: errors,
                        };
                    }
                }
                catch (err) {
                    if (isAbortError(err))
                        break;
                    store.addLog({
                        agent: "pool",
                        level: "warn",
                        message: `Poll error for ${poolId}: ${err instanceof Error ? err.message : String(err)}`,
                    });
                }
            }
            // Timeout — return last known state
            store.addLog({
                agent: "pool",
                level: "warn",
                message: `Pool ${poolId}: resize timeout after ${timeoutMs / 1000}s, proceeding with partial data`,
            });
            return {
                actualLpNodes: 0,
                targetLpNodes: 0,
                actualDedicatedNodes: 0,
                allocationState: "timeout",
                resizeErrors: 0,
            };
        });
    }
    /**
     * Append a PoolInfo entry to store.poolInfos after successful creation.
     */
    _addPoolInfoToStore(account, poolId, config) {
        var _a, _b, _c, _d;
        const { store } = this._ctx;
        const state = store.getState();
        const newPoolInfo = {
            id: uuidV4(),
            accountId: account.id,
            accountName: account.accountName,
            region: account.region,
            poolId,
            vmSize: (_a = config.vmSize) !== null && _a !== void 0 ? _a : "",
            state: "active",
            allocationState: "resizing",
            targetDedicatedNodes: 0,
            currentDedicatedNodes: 0,
            targetLowPriorityNodes: (_b = config.targetLowPriorityNodes) !== null && _b !== void 0 ? _b : 0,
            currentLowPriorityNodes: 0,
            taskSlotsPerNode: (_c = config.taskSlotsPerNode) !== null && _c !== void 0 ? _c : 1,
            enableAutoScale: (_d = config.enableAutoScale) !== null && _d !== void 0 ? _d : false,
            autoScaleFormula: config.autoScaleFormula,
            creationTime: new Date().toISOString(),
            startTask: config.startTask,
        };
        store.setPoolInfos([...state.poolInfos, newPoolInfo]);
    }
}
/**
 * Poll until a pool's allocationState becomes "steady" or timeout.
 * Returns the actual node counts so we can calculate real quota usage.
 *
 * Honors `signal` for cooperative cancellation — the 15-second wait
 * between polls is abortable, so a mid-poll cancel exits in an
 * event-loop tick instead of waiting up to a full interval.
 *
 * `pollIntervalMs` defaults to 15s (production). Tests inject a much
 * smaller value to keep the smart-mode end-to-end pool-creation
 * tests under their 30s jest timeout.
 */
Object.defineProperty(PoolAgent, "POLL_INTERVAL_MS", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 15000
}); // overridable from tests
//# sourceMappingURL=pool-agent.js.map