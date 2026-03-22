import { HttpParams } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { UserConfigurationService } from "@batch-flask/core";
import { ArmBatchAccount, BatchAccount, PoolAllocationState } from "app/models";
import { PoolCreateDto } from "app/models/dtos";
import { AzureBatchHttpService, BatchListResponse } from "app/services/azure-batch/core";
import { BatchAccountService } from "app/services/batch-account";
import { BEUserConfiguration } from "common";
import { Observable, Subscriber } from "rxjs";
import { take } from "rxjs/operators";
import { RequestScheduler, RequestSchedulerOptions } from "./request-scheduler";
import { PerAccountSummary, WorkbenchAccountRef } from "./workbench-types";
import { WorkbenchDiscoveryService } from "./workbench-discovery.service";

interface PoolStatePayload {
    id: string;
    allocationState?: string;
    currentDedicatedNodes?: number;
    targetDedicatedNodes?: number;
    enableAutoScale?: boolean;
}

interface NodeStatePayload {
    id: string;
    state?: string;
}

interface BootstrapPollingResult {
    reached: boolean;
    attempts: number;
}

export interface BootstrapPoolTemplateIntent {
    vmSize: string;
    nodeAgentSKUId: string;
    imageReference: any;
    startTaskCommandLine?: string;
}

export interface MultiRegionBootstrapRequest {
    accountRefs?: WorkbenchAccountRef[];
    maxTargetPerAccount?: number;
    poolIdPattern?: string;
    poolTemplateIntent?: Partial<BootstrapPoolTemplateIntent>;
    provisioningTimeoutMinutes?: number;
    waitForIdleTimeoutMinutes?: number;
    pollIntervalSeconds?: number;
    maxPollAttempts?: number;
}

export interface MultiRegionBootstrapProgress {
    stage: "started" | "account-started" | "target-succeeded" | "account-completed" | "completed";
    totalAccounts: number;
    processedAccounts: number;
    currentAccount?: WorkbenchAccountRef;
    currentTarget?: number;
    summary?: PerAccountSummary;
    summaries?: PerAccountSummary[];
}

interface MultiRegionBootstrapResolvedOptions {
    scheduler: RequestScheduler;
    maxTargetPerAccount: number;
    provisioningTimeoutMinutes: number;
    waitForIdleTimeoutMinutes: number;
    pollIntervalSeconds: number;
    maxPollAttempts: number;
    poolIdPattern: string;
    poolTemplateIntent: Partial<BootstrapPoolTemplateIntent>;
}

const DEFAULT_POOL_ID_PATTERN = "bootstrap-{location}-{yyyyMMdd-HHmm}-{rand4}";
const DEFAULT_VM_SIZE = "Standard_D2s_v3";
const DEFAULT_POLL_INTERVAL_SECONDS = 10;
const DEFAULT_MAX_TARGET_PER_ACCOUNT = 20;
const DEFAULT_PROVISIONING_TIMEOUT_MINUTES = 20;
const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MINUTES = 10;
const DEFAULT_MAX_POLL_ATTEMPTS = 120;
const MAX_NODE_LIST_PAGES = 50;
const MAX_SUPPORTED_IMAGES_PAGES = 20;

export function buildBootstrapPoolCreateDto(
    poolId: string,
    vmSize: string,
    nodeAgentSKUId: string,
    imageRef: any,
): PoolCreateDto {
    return new PoolCreateDto({
        id: poolId,
        vmSize,
        targetDedicatedNodes: 0,
        enableAutoScale: false,
        virtualMachineConfiguration: {
            nodeAgentSKUId,
            imageReference: imageRef,
        },
        startTask: {
            commandLine: "/bin/bash -c \"echo bootstrap-ok\"",
            waitForSuccess: true,
        },
    } as any);
}

@Injectable({ providedIn: "root" })
export class MultiRegionBootstrapOrchestratorService {
    constructor(
        private settingsService: UserConfigurationService<BEUserConfiguration>,
        private discoveryService: WorkbenchDiscoveryService,
        private accountService: BatchAccountService,
        private batchHttp: AzureBatchHttpService,
    ) { }

    public run(request: MultiRegionBootstrapRequest = {}): Observable<MultiRegionBootstrapProgress> {
        return new Observable((subscriber) => {
            void this._run(request, subscriber);
        });
    }

    private async _run(request: MultiRegionBootstrapRequest, subscriber: Subscriber<MultiRegionBootstrapProgress>) {
        try {
            const config = await this.settingsService.config.pipe(take(1)).toPromise();
            if (!config || !config.features || !config.features.multiRegionPoolBootstrap) {
                throw new Error("Feature flag 'features.multiRegionPoolBootstrap' must be enabled.");
            }

            const options = this._resolveOptions(config, request);
            const accountRefs = await this._resolveAccountRefs(request);
            const summaries: PerAccountSummary[] = [];

            subscriber.next({
                stage: "started",
                totalAccounts: accountRefs.length,
                processedAccounts: 0,
            });

            for (let index = 0; index < accountRefs.length; index++) {
                const accountRef = accountRefs[index];

                subscriber.next({
                    stage: "account-started",
                    totalAccounts: accountRefs.length,
                    processedAccounts: index,
                    currentAccount: accountRef,
                });

                const summary = await this._runForAccount(accountRef, options, (target) => {
                    subscriber.next({
                        stage: "target-succeeded",
                        totalAccounts: accountRefs.length,
                        processedAccounts: index,
                        currentAccount: accountRef,
                        currentTarget: target,
                    });
                });
                summaries.push(summary);

                subscriber.next({
                    stage: "account-completed",
                    totalAccounts: accountRefs.length,
                    processedAccounts: index + 1,
                    currentAccount: accountRef,
                    summary,
                });
            }

            subscriber.next({
                stage: "completed",
                totalAccounts: accountRefs.length,
                processedAccounts: accountRefs.length,
                summaries,
            });
            subscriber.complete();
        } catch (error) {
            subscriber.error(error);
        }
    }

    private async _runForAccount(
        accountRef: WorkbenchAccountRef,
        options: MultiRegionBootstrapResolvedOptions,
        onTargetSucceeded: (target: number) => void,
    ): Promise<PerAccountSummary> {
        const summary: PerAccountSummary = {
            subscriptionId: accountRef.subscriptionId,
            accountId: accountRef.accountId,
            location: accountRef.location,
            lastSuccessfulTarget: 0,
            retries: 0,
            startedAt: new Date().toISOString(),
            errors: [],
        };

        try {
            const account = await this._resolveAccount(accountRef, options.scheduler);
            if (!(account instanceof ArmBatchAccount)) {
                summary.stopReason = "non-arm-account-skipped";
                return summary;
            }

            const poolId = this._buildPoolId(options.poolIdPattern, accountRef.location);
            summary.poolId = poolId;

            await this._ensurePoolAtZero(account, poolId, options, summary);
            if (summary.stopReason) {
                return summary;
            }

            for (let target = 1; target <= options.maxTargetPerAccount; target++) {
                const steadyBeforeResize = await this._pollPoolSteady(
                    account,
                    poolId,
                    options,
                    options.provisioningTimeoutMinutes,
                );
                if (!steadyBeforeResize.reached) {
                    summary.stopReason = "steady-timeout-before-resize";
                    this._appendError(summary, {
                        action: "wait-for-steady-before-resize",
                        attempts: steadyBeforeResize.attempts,
                        message: `Pool '${poolId}' did not reach steady allocation state before target ${target}.`,
                    });
                    break;
                }

                try {
                    await this._requestForAccountScheduled(
                        options.scheduler,
                        account,
                        "POST",
                        `/pools/${encodeURIComponent(poolId)}/resize`,
                        { body: { targetDedicatedNodes: target } },
                    );
                } catch (error) {
                    const failure = this._classifyResizeOrQuotaFailure(error);
                    summary.stopReason = failure.isQuotaOrResizeFailure ? "quota-or-resize-failure" : "resize-failure";
                    this._appendError(summary, {
                        action: "resize",
                        target,
                        message: failure.message,
                        status: failure.status,
                        code: failure.code,
                        error,
                    });
                    break;
                }

                const reachedIdle = await this._pollPoolTargetAndIdle(
                    account,
                    poolId,
                    target,
                    options,
                );
                if (!reachedIdle.reached) {
                    summary.stopReason = "wait-for-idle-timeout";
                    this._appendError(summary, {
                        action: "wait-for-target-idle",
                        target,
                        attempts: reachedIdle.attempts,
                        message: `Pool '${poolId}' did not reach target ${target} with all nodes idle.`,
                    });
                    break;
                }

                summary.lastSuccessfulTarget = target;
                onTargetSucceeded(target);
            }

            if (!summary.stopReason) {
                summary.stopReason = "completed";
            }
            return summary;
        } catch (error) {
            summary.stopReason = "fatal-error";
            this._appendError(summary, {
                action: "account-bootstrap",
                message: this._readErrorMessage(error),
                error,
            });
            return summary;
        } finally {
            summary.finishedAt = new Date().toISOString();
        }
    }

    private async _ensurePoolAtZero(
        account: ArmBatchAccount,
        poolId: string,
        options: MultiRegionBootstrapResolvedOptions,
        summary: PerAccountSummary,
    ): Promise<void> {
        let pool = await this._getPool(account, poolId, options.scheduler);
        if (!pool) {
            const templateIntent = await this._resolveTemplateIntent(account, options);
            const createDto = buildBootstrapPoolCreateDto(
                poolId,
                templateIntent.vmSize,
                templateIntent.nodeAgentSKUId,
                templateIntent.imageReference,
            );
            if (templateIntent.startTaskCommandLine) {
                createDto.startTask.commandLine = templateIntent.startTaskCommandLine;
            }
            try {
                await this._requestForAccountScheduled(
                    options.scheduler,
                    account,
                    "POST",
                    "/pools",
                    { body: createDto.toJS() },
                );
            } catch (error) {
                const failure = this._classifyResizeOrQuotaFailure(error);
                summary.stopReason = failure.isQuotaOrResizeFailure ? "quota-or-resize-failure" : "pool-create-failed";
                this._appendError(summary, {
                    action: "create-pool",
                    message: failure.message,
                    status: failure.status,
                    code: failure.code,
                    error,
                });
                return;
            }
            pool = await this._getPool(account, poolId, options.scheduler);
        }

        if (!pool) {
            summary.stopReason = "pool-create-failed";
            this._appendError(summary, {
                action: "ensure-pool",
                message: `Failed to create or resolve pool '${poolId}'.`,
            });
            return;
        }

        if (pool.enableAutoScale) {
            try {
                await this._requestForAccountScheduled(
                    options.scheduler,
                    account,
                    "POST",
                    `/pools/${encodeURIComponent(poolId)}/disableautoscale`,
                    { body: null },
                );
            } catch (error) {
                summary.stopReason = "disable-autoscale-failure";
                this._appendError(summary, {
                    action: "disable-autoscale",
                    message: this._readErrorMessage(error),
                    status: this._readStatus(error),
                    error,
                });
                return;
            }
        }

        const needsResizeToZero = this._toNumber(pool.currentDedicatedNodes) > 0 || this._toNumber(pool.targetDedicatedNodes) > 0;
        if (!needsResizeToZero) {
            return;
        }

        const steadyBeforeResize = await this._pollPoolSteady(
            account,
            poolId,
            options,
            options.provisioningTimeoutMinutes,
        );
        if (!steadyBeforeResize.reached) {
            summary.stopReason = "steady-timeout-before-zero";
            this._appendError(summary, {
                action: "wait-for-steady-before-zero",
                attempts: steadyBeforeResize.attempts,
                message: `Pool '${poolId}' did not reach steady allocation state before resizing to zero.`,
            });
            return;
        }

        try {
            await this._requestForAccountScheduled(
                options.scheduler,
                account,
                "POST",
                `/pools/${encodeURIComponent(poolId)}/resize`,
                { body: { targetDedicatedNodes: 0 } },
            );
        } catch (error) {
            const failure = this._classifyResizeOrQuotaFailure(error);
            summary.stopReason = failure.isQuotaOrResizeFailure ? "quota-or-resize-failure" : "resize-to-zero-failure";
            this._appendError(summary, {
                action: "resize-to-zero",
                message: failure.message,
                status: failure.status,
                code: failure.code,
                error,
            });
            return;
        }

        const reachedZero = await this._pollPoolTargetAndIdle(account, poolId, 0, options);
        if (!reachedZero.reached) {
            summary.stopReason = "wait-for-zero-idle-timeout";
            this._appendError(summary, {
                action: "wait-for-zero-idle",
                attempts: reachedZero.attempts,
                message: `Pool '${poolId}' did not settle at 0 nodes.`,
            });
        }
    }

    private async _pollPoolSteady(
        account: BatchAccount,
        poolId: string,
        options: MultiRegionBootstrapResolvedOptions,
        timeoutMinutes: number,
    ): Promise<BootstrapPollingResult> {
        return this._pollWithBounds(options, timeoutMinutes, async () => {
            const pool = await this._getPool(account, poolId, options.scheduler);
            return Boolean(pool && pool.allocationState === PoolAllocationState.steady);
        });
    }

    private async _pollPoolTargetAndIdle(
        account: BatchAccount,
        poolId: string,
        targetDedicatedNodes: number,
        options: MultiRegionBootstrapResolvedOptions,
    ): Promise<BootstrapPollingResult> {
        return this._pollWithBounds(options, options.waitForIdleTimeoutMinutes, async () => {
            const pool = await this._getPool(account, poolId, options.scheduler);
            if (!pool || pool.allocationState !== PoolAllocationState.steady) {
                return false;
            }

            const currentDedicatedNodes = this._toNumber(pool.currentDedicatedNodes);
            if (currentDedicatedNodes !== targetDedicatedNodes) {
                return false;
            }

            if (targetDedicatedNodes === 0) {
                return true;
            }

            const nodes = await this._listNodes(account, poolId, options.scheduler);
            if (nodes.length < targetDedicatedNodes) {
                return false;
            }

            return nodes.every((node) => (node.state || "").toLowerCase() === "idle");
        });
    }

    private async _pollWithBounds(
        options: MultiRegionBootstrapResolvedOptions,
        timeoutMinutes: number,
        check: () => Promise<boolean>,
    ): Promise<BootstrapPollingResult> {
        const timeoutMs = Math.max(1000, timeoutMinutes * 60 * 1000);
        const intervalMs = Math.max(250, options.pollIntervalSeconds * 1000);
        const computedAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
        const maxAttempts = Math.min(options.maxPollAttempts, computedAttempts);
        const deadline = Date.now() + timeoutMs;
        let attempts = 0;

        while (attempts < maxAttempts && Date.now() <= deadline) {
            attempts++;
            if (await check()) {
                return { reached: true, attempts };
            }

            if (attempts >= maxAttempts || Date.now() >= deadline) {
                break;
            }
            await this._sleep(intervalMs);
        }

        return { reached: false, attempts };
    }

    private async _resolveTemplateIntent(
        account: BatchAccount,
        options: MultiRegionBootstrapResolvedOptions,
    ): Promise<BootstrapPoolTemplateIntent> {
        const explicitTemplate = options.poolTemplateIntent || {};
        const explicitVmSize = this._nonEmpty(explicitTemplate.vmSize) || DEFAULT_VM_SIZE;
        const explicitNodeAgentSKUId = this._nonEmpty(explicitTemplate.nodeAgentSKUId);
        const explicitImageReference = explicitTemplate.imageReference;

        if (explicitNodeAgentSKUId && explicitImageReference) {
            return {
                vmSize: explicitVmSize,
                nodeAgentSKUId: explicitNodeAgentSKUId,
                imageReference: explicitImageReference,
                startTaskCommandLine: this._nonEmpty(explicitTemplate.startTaskCommandLine),
            };
        }

        const supportedImages = await this._listSupportedImages(account, options.scheduler);
        const picked = this._pickBootstrapImage(supportedImages, explicitTemplate.imageReference);
        if (!picked) {
            throw new Error("Unable to resolve bootstrap image intent from /supportedimages.");
        }

        return {
            vmSize: explicitVmSize,
            nodeAgentSKUId: explicitNodeAgentSKUId || picked.nodeAgentSKUId,
            imageReference: explicitImageReference || picked.imageReference,
            startTaskCommandLine: this._nonEmpty(explicitTemplate.startTaskCommandLine),
        };
    }

    private async _listSupportedImages(account: BatchAccount, scheduler: RequestScheduler): Promise<any[]> {
        const images: any[] = [];
        let nextLink: string | null = "/supportedimages";
        let page = 0;

        while (nextLink) {
            page++;
            if (page > MAX_SUPPORTED_IMAGES_PAGES) {
                break;
            }

            const options = page === 1 ? { params: new HttpParams().set("maxresults", "200") } : {};
            const response = await this._requestForAccountScheduled<BatchListResponse<any>>(
                scheduler,
                account,
                "GET",
                nextLink,
                options,
            );
            const pageItems = response && Array.isArray(response.value) ? response.value : [];
            images.push(...pageItems);
            nextLink = response && response["odata.nextLink"] ? response["odata.nextLink"] : null;
        }

        return images;
    }

    private _pickBootstrapImage(images: any[], explicitImageReference: any): any | null {
        if (!Array.isArray(images) || images.length === 0) {
            return null;
        }

        if (explicitImageReference) {
            const explicitId = this._imageRefIdentity(explicitImageReference);
            const exact = images.find((image) => this._imageRefIdentity(image && image.imageReference) === explicitId);
            if (exact) {
                return exact;
            }
        }

        const linuxImages = images.filter((image) => `${image && image.osType || ""}`.toLowerCase() === "linux");
        const ubuntuByOffer = linuxImages.find((image) => {
            const offer = `${image && image.imageReference && image.imageReference.offer || ""}`.toLowerCase();
            return offer.includes("ubuntu");
        });
        if (ubuntuByOffer) {
            return ubuntuByOffer;
        }

        const ubuntuBySku = linuxImages.find((image) => {
            const sku = `${image && image.imageReference && image.imageReference.sku || ""}`.toLowerCase();
            return sku.includes("ubuntu") || sku.includes("lts");
        });
        if (ubuntuBySku) {
            return ubuntuBySku;
        }

        return linuxImages[0] || images[0];
    }

    private _imageRefIdentity(imageReference: any): string {
        if (!imageReference) {
            return "";
        }
        const publisher = `${imageReference.publisher || ""}`.toLowerCase();
        const offer = `${imageReference.offer || ""}`.toLowerCase();
        const sku = `${imageReference.sku || ""}`.toLowerCase();
        const version = `${imageReference.version || ""}`.toLowerCase();
        const vmImageId = `${imageReference.virtualMachineImageId || ""}`.toLowerCase();
        return [publisher, offer, sku, version, vmImageId].join("|");
    }

    private async _getPool(
        account: BatchAccount,
        poolId: string,
        scheduler: RequestScheduler,
    ): Promise<PoolStatePayload | null> {
        const params = new HttpParams().set(
            "$select",
            "id,allocationState,currentDedicatedNodes,targetDedicatedNodes,enableAutoScale",
        );

        try {
            return await this._requestForAccountScheduled<PoolStatePayload>(
                scheduler,
                account,
                "GET",
                `/pools/${encodeURIComponent(poolId)}`,
                { params },
            );
        } catch (error) {
            if (this._readStatus(error) === 404) {
                return null;
            }
            throw error;
        }
    }

    private async _listNodes(
        account: BatchAccount,
        poolId: string,
        scheduler: RequestScheduler,
    ): Promise<NodeStatePayload[]> {
        const nodes: NodeStatePayload[] = [];
        let nextLink: string | null = `/pools/${encodeURIComponent(poolId)}/nodes`;
        let page = 0;

        while (nextLink) {
            page++;
            if (page > MAX_NODE_LIST_PAGES) {
                throw new Error(`Node polling exceeded max pages for pool '${poolId}'.`);
            }

            const options = page === 1
                ? { params: new HttpParams().set("$select", "id,state").set("maxresults", "200") }
                : {};
            const response = await this._requestForAccountScheduled<BatchListResponse<NodeStatePayload>>(
                scheduler,
                account,
                "GET",
                nextLink,
                options,
            );
            if (response && Array.isArray(response.value)) {
                nodes.push(...response.value);
            }
            nextLink = response && response["odata.nextLink"] ? response["odata.nextLink"] : null;
        }

        return nodes;
    }

    private _resolveOptions(
        config: BEUserConfiguration,
        request: MultiRegionBootstrapRequest,
    ): MultiRegionBootstrapResolvedOptions {
        const throttling = config
            && config.poolControlWorkbench
            && config.poolControlWorkbench.throttling
            ? config.poolControlWorkbench.throttling
            : {} as any;

        const delayMs = typeof throttling.delayMs === "number"
            ? throttling.delayMs
            : throttling.delayMsBetweenRequests;
        const schedulerOptions: RequestSchedulerOptions = {
            concurrency: Math.max(1, Number(throttling.concurrency || 1)),
            delayMs: Math.max(0, Number(delayMs || 0)),
            retryAttempts: Math.max(0, Number(throttling.retryAttempts || 5)),
            retryBackoffSeconds: Array.isArray(throttling.retryBackoffSeconds) && throttling.retryBackoffSeconds.length > 0
                ? throttling.retryBackoffSeconds
                : [2, 4, 8, 16, 32],
            jitterPct: typeof throttling.jitterPct === "number" ? throttling.jitterPct : 0.2,
        };

        return {
            scheduler: new RequestScheduler(schedulerOptions),
            maxTargetPerAccount: Math.max(0, Number(request.maxTargetPerAccount || DEFAULT_MAX_TARGET_PER_ACCOUNT)),
            provisioningTimeoutMinutes: Math.max(
                1,
                Number(request.provisioningTimeoutMinutes || DEFAULT_PROVISIONING_TIMEOUT_MINUTES),
            ),
            waitForIdleTimeoutMinutes: Math.max(
                1,
                Number(request.waitForIdleTimeoutMinutes || DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MINUTES),
            ),
            pollIntervalSeconds: Math.max(
                1,
                Number(request.pollIntervalSeconds || DEFAULT_POLL_INTERVAL_SECONDS),
            ),
            maxPollAttempts: Math.max(1, Number(request.maxPollAttempts || DEFAULT_MAX_POLL_ATTEMPTS)),
            poolIdPattern: this._nonEmpty(request.poolIdPattern) || DEFAULT_POOL_ID_PATTERN,
            poolTemplateIntent: request.poolTemplateIntent || {},
        };
    }

    private async _resolveAccountRefs(request: MultiRegionBootstrapRequest): Promise<WorkbenchAccountRef[]> {
        const requested = request.accountRefs || [];
        const accountRefs = requested.length > 0
            ? requested
            : await this.discoveryService.listAccounts().toPromise();

        return (accountRefs || []).filter((ref) => {
            return ref && ref.accountId && ref.subscriptionId && ref.subscriptionId !== "local";
        });
    }

    private async _resolveAccount(accountRef: WorkbenchAccountRef, scheduler: RequestScheduler): Promise<BatchAccount> {
        return scheduler.run(`resolve-account:${accountRef.accountId}`, async () => {
            const account = await this.accountService.get(accountRef.accountId).toPromise();
            if (!account) {
                throw new Error(`Batch account '${accountRef.accountId}' was not found.`);
            }
            return account;
        });
    }

    private _buildPoolId(pattern: string, location: string): string {
        const sanitizedLocation = `${location || "unknown"}`
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "");
        const date = new Date();
        const yyyy = date.getUTCFullYear().toString();
        const MM = `${date.getUTCMonth() + 1}`.padStart(2, "0");
        const dd = `${date.getUTCDate()}`.padStart(2, "0");
        const HH = `${date.getUTCHours()}`.padStart(2, "0");
        const mm = `${date.getUTCMinutes()}`.padStart(2, "0");
        const rand4 = Math.random().toString(36).slice(2, 6).padEnd(4, "0");

        const poolId = pattern
            .replace("{location}", sanitizedLocation || "unknown")
            .replace("{yyyyMMdd-HHmm}", `${yyyy}${MM}${dd}-${HH}${mm}`)
            .replace("{rand4}", rand4)
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-");

        return poolId.slice(0, 64);
    }

    private async _requestForAccountScheduled<T>(
        scheduler: RequestScheduler,
        account: BatchAccount,
        method: any,
        uri?: any,
        options?: any,
    ): Promise<T> {
        return scheduler.run(this._accountKey(account), async () => {
            return this.batchHttp.requestForAccount(account, method, uri, options).toPromise();
        });
    }

    private _accountKey(account: BatchAccount): string {
        return `account:${account && account.id ? account.id : "unknown-account"}`;
    }

    private _classifyResizeOrQuotaFailure(error: any): {
        isQuotaOrResizeFailure: boolean,
        message: string,
        status?: number,
        code?: string,
    } {
        const status = this._readStatus(error);
        const code = `${error && (error.code || error?.error?.code) || ""}`;
        const message = this._readErrorMessage(error);
        const normalizedCode = code.toLowerCase();
        const normalizedMessage = message.toLowerCase();

        const isQuota = status === 403 || normalizedCode.includes("quota") || normalizedMessage.includes("quota");
        const isResize = status === 409
            || normalizedCode.includes("resize")
            || normalizedCode.includes("allocationstate")
            || normalizedMessage.includes("resize")
            || normalizedMessage.includes("allocation state");

        return {
            isQuotaOrResizeFailure: isQuota || isResize,
            message,
            status,
            code: code || undefined,
        };
    }

    private _appendError(summary: PerAccountSummary, error: any): void {
        summary.errors.push({
            ...error,
            at: new Date().toISOString(),
        });
        const attempts = Number(error && error.attempts);
        if (Number.isFinite(attempts) && attempts > 1) {
            summary.retries += attempts - 1;
        }
        const retries = Number(error && error.retries);
        if (Number.isFinite(retries) && retries > 0) {
            summary.retries += retries;
        }
    }

    private _readStatus(error: any): number | undefined {
        return typeof error?.status === "number" ? error.status : undefined;
    }

    private _readErrorMessage(error: any): string {
        if (!error) {
            return "Unknown error.";
        }
        return error.message || error.statusText || error.code || "Unknown error.";
    }

    private _toNumber(value: any): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private _nonEmpty(value: any): string | null {
        if (typeof value !== "string") {
            return null;
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    private async _sleep(ms: number): Promise<void> {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }
}
