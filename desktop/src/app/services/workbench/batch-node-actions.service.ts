import { HttpHeaders, HttpParams } from "@angular/common/http";
import { Injectable, Optional } from "@angular/core";
import { HttpRequestOptions } from "@batch-flask/core";
import { Node } from "app/models";
import { AzureBatchHttpService } from "app/services/azure-batch/core";
import { Observable, from } from "rxjs";
import { RequestScheduler } from "./request-scheduler";

export type NodeActionClassification = "quota" | "transient" | "fatal";

export type BulkNodeActionKind =
    | "removeNodes"
    | "rebootNodes"
    | "reimageNodes"
    | "enableSchedulingNodes"
    | "disableSchedulingNodes";

export type DisableSchedulingOption = "terminate" | "requeue" | "taskCompletion";

export interface NodeActionFailure {
    nodeId?: string;
    chunkIndex?: number;
    status?: number;
    code?: string;
    message: string;
    classification: NodeActionClassification;
    attempt: number;
}

export interface NodeActionResult {
    nodeId?: string;
    chunkIndex?: number;
    success: boolean;
    attempts: number;
    startedAt: string;
    finishedAt: string;
    failure?: NodeActionFailure;
}

export interface BulkNodeActionResult {
    action: BulkNodeActionKind;
    poolId: string;
    totalTargets: number;
    successCount: number;
    failureCount: number;
    startedAt: string;
    finishedAt: string;
    results: NodeActionResult[];
}

export interface PoolStartTaskSummary {
    commandLine: string;
    waitForSuccess: boolean;
    maxTaskRetryCount: number;
    environmentSettingsCount: number;
    resourceFilesCount: number;
    userIdentity: string;
}

export interface PoolConfigurationSummary {
    id: string;
    vmSize: string;
    allocationState: string;
    currentDedicatedNodes: number;
    targetDedicatedNodes: number;
    currentLowPriorityNodes: number;
    targetLowPriorityNodes: number;
    taskSlotsPerNode: number;
    enableAutoScale: boolean;
    nodeAgentSKUId: string;
    imageReference: string;
    startTask: PoolStartTaskSummary;
}

interface BatchListResponse<TEntity> {
    value: TEntity[];
    "odata.nextLink"?: string;
}

interface PoolStateResponse {
    id?: string;
    allocationState?: string;
}

@Injectable({ providedIn: "root" })
export class BatchNodeActionsService {
    private readonly _maxRemoveNodesPerRequest = 100;
    private readonly _maxListPages = 200;
    private readonly _retryBackoffSeconds = [2, 4, 8, 16, 32];
    private readonly _retryJitterPercent = 0.2;

    private scheduler: RequestScheduler;

    constructor(
        private http: AzureBatchHttpService,
        @Optional() scheduler?: RequestScheduler,
    ) {
        this.scheduler = scheduler || new RequestScheduler();
    }

    public listNodes(account: unknown, poolId: string): Observable<Node[]> {
        return from(this._listNodes(account, poolId));
    }

    public getPoolConfiguration(account: unknown, poolId: string): Observable<PoolConfigurationSummary> {
        return from(this._getPoolConfiguration(account, poolId));
    }

    public removeNodes(account: unknown, poolId: string, nodeIds: string[]): Observable<BulkNodeActionResult> {
        return from(this._removeNodes(account, poolId, nodeIds));
    }

    public restartPoolNodes(account: unknown, poolId: string): Observable<BulkNodeActionResult> {
        return from(this._restartPoolNodes(account, poolId));
    }

    public rebootNode(account: unknown, poolId: string, nodeId: string): Observable<NodeActionResult> {
        return from(this._nodeAction("rebootNodes", account, poolId, nodeId, () => {
            return this._requestWithRetry(
                () => this._requestForAccount<any>(account, "POST", `/pools/${poolId}/nodes/${nodeId}/reboot`, { body: null }),
                true,
            ).then((result) => result.attempts);
        }));
    }

    public reimageNode(account: unknown, poolId: string, nodeId: string): Observable<NodeActionResult> {
        return from(this._nodeAction("reimageNodes", account, poolId, nodeId, () => {
            return this._requestWithRetry(
                () => this._requestForAccount<any>(account, "POST", `/pools/${poolId}/nodes/${nodeId}/reimage`, { body: null }),
                true,
            ).then((result) => result.attempts);
        }));
    }

    public enableScheduling(account: unknown, poolId: string, nodeId: string): Observable<NodeActionResult> {
        return from(this._nodeAction("enableSchedulingNodes", account, poolId, nodeId, () => {
            return this._requestWithRetry(
                () => this._requestForAccount<any>(
                    account,
                    "POST",
                    `/pools/${poolId}/nodes/${nodeId}/enablescheduling`,
                    { body: null },
                ),
                true,
            ).then((result) => result.attempts);
        }));
    }

    public disableScheduling(
        account: unknown,
        poolId: string,
        nodeId: string,
        option: DisableSchedulingOption = "taskCompletion",
    ): Observable<NodeActionResult> {
        return from(this._nodeAction("disableSchedulingNodes", account, poolId, nodeId, () => {
            const params = new HttpParams().set("nodeDeallocationOption", option);
            return this._requestWithRetry(
                () => this._requestForAccount<any>(
                    account,
                    "POST",
                    `/pools/${poolId}/nodes/${nodeId}/disablescheduling`,
                    { body: null, params },
                ),
                true,
            ).then((result) => result.attempts);
        }));
    }

    public rebootNodes(account: unknown, poolId: string, nodeIds: string[]): Observable<BulkNodeActionResult> {
        return from(this._runNodeActionInSequence("rebootNodes", account, poolId, nodeIds, (nodeId) => {
            return this.rebootNode(account, poolId, nodeId);
        }));
    }

    public reimageNodes(account: unknown, poolId: string, nodeIds: string[]): Observable<BulkNodeActionResult> {
        return from(this._runNodeActionInSequence("reimageNodes", account, poolId, nodeIds, (nodeId) => {
            return this.reimageNode(account, poolId, nodeId);
        }));
    }

    public enableSchedulingNodes(account: unknown, poolId: string, nodeIds: string[]): Observable<BulkNodeActionResult> {
        return from(this._runNodeActionInSequence("enableSchedulingNodes", account, poolId, nodeIds, (nodeId) => {
            return this.enableScheduling(account, poolId, nodeId);
        }));
    }

    public disableSchedulingNodes(
        account: unknown,
        poolId: string,
        nodeIds: string[],
        option: DisableSchedulingOption = "taskCompletion",
    ): Observable<BulkNodeActionResult> {
        return from(this._runNodeActionInSequence("disableSchedulingNodes", account, poolId, nodeIds, (nodeId) => {
            return this.disableScheduling(account, poolId, nodeId, option);
        }));
    }

    private async _listNodes(account: unknown, poolId: string): Promise<Node[]> {
        const select = "id,state,schedulingState,stateTransitionTime,errors";
        const params = new HttpParams()
            .set("$select", select)
            .set("maxresults", "1000");

        let page = 0;
        let nextLink: string | undefined = `/pools/${poolId}/nodes`;
        const nodes: Node[] = [];

        while (nextLink) {
            page += 1;
            if (page > this._maxListPages) {
                throw new Error(`Node listing exceeded max page limit (${this._maxListPages}) for pool '${poolId}'.`);
            }

            const options: HttpRequestOptions = page === 1 ? { params } : {};
            const responseResult = await this._requestWithRetry<BatchListResponse<any>>(
                () => this._requestForAccount<BatchListResponse<any>>(account, "GET", nextLink, options),
                false,
            );
            const response = responseResult.result;

            for (const item of response.value || []) {
                nodes.push(new Node({ ...item, poolId }));
            }

            nextLink = response["odata.nextLink"];
        }

        return nodes;
    }

    private async _getPoolConfiguration(account: unknown, poolId: string): Promise<PoolConfigurationSummary> {
        const select = [
            "id",
            "vmSize",
            "allocationState",
            "currentDedicatedNodes",
            "targetDedicatedNodes",
            "currentLowPriorityNodes",
            "targetLowPriorityNodes",
            "taskSlotsPerNode",
            "enableAutoScale",
            "virtualMachineConfiguration",
            "startTask",
        ].join(",");

        const params = new HttpParams().set("$select", select);
        const responseResult = await this._requestWithRetry<any>(
            () => this._requestForAccount<any>(account, "GET", `/pools/${poolId}`, { params }),
            false,
        );
        const pool = responseResult.result || {};
        const vmConfig = pool.virtualMachineConfiguration || {};
        const imageReference = vmConfig.imageReference || {};

        return {
            id: `${pool.id || poolId}`,
            vmSize: `${pool.vmSize || "-"}`,
            allocationState: `${pool.allocationState || "unknown"}`,
            currentDedicatedNodes: this._toNonNegativeNumber(pool.currentDedicatedNodes),
            targetDedicatedNodes: this._toNonNegativeNumber(pool.targetDedicatedNodes),
            currentLowPriorityNodes: this._toNonNegativeNumber(pool.currentLowPriorityNodes),
            targetLowPriorityNodes: this._toNonNegativeNumber(pool.targetLowPriorityNodes),
            taskSlotsPerNode: this._toNonNegativeNumber(pool.taskSlotsPerNode, 1),
            enableAutoScale: Boolean(pool.enableAutoScale),
            nodeAgentSKUId: `${vmConfig.nodeAgentSKUId || "-"}`,
            imageReference: this._toImageReference(imageReference),
            startTask: this._toStartTaskSummary(pool.startTask),
        };
    }

    private async _removeNodes(account: unknown, poolId: string, nodeIds: string[]): Promise<BulkNodeActionResult> {
        const startedAt = new Date().toISOString();
        const uniqueNodeIds = Array.from(new Set(nodeIds.filter((x) => Boolean(x))));
        await this._ensurePoolSteady(account, poolId);
        const chunks = this._chunk(uniqueNodeIds, this._maxRemoveNodesPerRequest);
        const results: NodeActionResult[] = [];

        for (let index = 0; index < chunks.length; index++) {
            const chunk = chunks[index];
            const chunkStartedAt = new Date().toISOString();

            try {
                const requestResult = await this._requestWithRetry(
                    () => this._requestForAccount<any>(
                        account,
                        "POST",
                        `/pools/${poolId}/removenodes`,
                        { body: { nodeList: chunk } },
                    ),
                    true,
                );
                const attempts = requestResult.attempts;

                results.push({
                    chunkIndex: index,
                    success: true,
                    attempts,
                    startedAt: chunkStartedAt,
                    finishedAt: new Date().toISOString(),
                });
            } catch (error) {
                const failure = this._toFailure(error, this._attemptFromError(error));
                results.push({
                    chunkIndex: index,
                    success: false,
                    attempts: this._attemptFromError(error),
                    startedAt: chunkStartedAt,
                    finishedAt: new Date().toISOString(),
                    failure,
                });
            }
        }

        return this._bulkResult("removeNodes", poolId, uniqueNodeIds.length, startedAt, results);
    }

    private async _restartPoolNodes(account: unknown, poolId: string): Promise<BulkNodeActionResult> {
        const nodes = await this._listNodes(account, poolId);
        const nodeIds = nodes.map((node) => node.id).filter((id) => Boolean(id));
        return this._runNodeActionInSequence("rebootNodes", account, poolId, nodeIds, (nodeId) => {
            return this.rebootNode(account, poolId, nodeId);
        });
    }

    private async _nodeAction(
        _kind: BulkNodeActionKind,
        _account: unknown,
        _poolId: string,
        nodeId: string,
        execute: () => Promise<number>,
    ): Promise<NodeActionResult> {
        const startedAt = new Date().toISOString();

        try {
            const attempts = await execute();
            return {
                nodeId,
                success: true,
                attempts,
                startedAt,
                finishedAt: new Date().toISOString(),
            };
        } catch (error) {
            return {
                nodeId,
                success: false,
                attempts: this._attemptFromError(error),
                startedAt,
                finishedAt: new Date().toISOString(),
                failure: this._toFailure(error, this._attemptFromError(error), nodeId),
            };
        }
    }

    private async _runNodeActionInSequence(
        action: BulkNodeActionKind,
        account: unknown,
        poolId: string,
        nodeIds: string[],
        callback: (nodeId: string) => Observable<NodeActionResult>,
    ): Promise<BulkNodeActionResult> {
        const startedAt = new Date().toISOString();
        const uniqueNodeIds = Array.from(new Set(nodeIds.filter((x) => Boolean(x))));
        const results: NodeActionResult[] = [];

        for (const nodeId of uniqueNodeIds) {
            const nodeResult = await callback(nodeId).toPromise() as NodeActionResult;
            results.push(nodeResult);
        }

        return this._bulkResult(action, poolId, uniqueNodeIds.length, startedAt, results);
    }

    private _bulkResult(
        action: BulkNodeActionKind,
        poolId: string,
        totalTargets: number,
        startedAt: string,
        results: NodeActionResult[],
    ): BulkNodeActionResult {
        const successCount = results.filter((x) => x.success).length;
        return {
            action,
            poolId,
            totalTargets,
            successCount,
            failureCount: results.length - successCount,
            startedAt,
            finishedAt: new Date().toISOString(),
            results,
        };
    }

    private async _requestForAccount<T>(
        account: unknown,
        method: string,
        uri: string,
        options: HttpRequestOptions = {},
    ): Promise<T> {
        if (typeof this.http.requestForAccount !== "function") {
            throw new Error("AzureBatchHttpService.requestForAccount is required for workbench multi-account operations.");
        }
        return this.scheduler.run(this._accountKey(account), async () => {
            return this.http.requestForAccount(account, method, uri, options).toPromise();
        });
    }

    private async _requestWithRetry<T>(
        request: () => Promise<T>,
        retryOnConflict: boolean,
    ): Promise<{ result: T, attempts: number }> {
        let attempt = 1;
        while (attempt <= this._retryBackoffSeconds.length + 1) {
            try {
                const result = await request();
                return { result, attempts: attempt };
            } catch (error) {
                const classification = this._classifyError(error);
                const status = this._statusCode(error);
                const canRetryStatus = classification === "transient"
                    || (retryOnConflict && status === 409);
                const hasAttemptsLeft = attempt <= this._retryBackoffSeconds.length;

                if (!canRetryStatus || !hasAttemptsLeft) {
                    (error as any).__attempt = attempt;
                    throw error;
                }

                const delayMs = this._computeRetryDelayMs(error, attempt);
                await this._sleep(delayMs);
                attempt += 1;
            }
        }

        throw new Error("Unexpected retry loop termination.");
    }

    private _computeRetryDelayMs(error: any, attempt: number): number {
        const retryAfter = this._retryAfterMs(error);
        if (retryAfter !== null) {
            return retryAfter;
        }

        const backoffSeconds = this._retryBackoffSeconds[Math.max(0, Math.min(attempt - 1, this._retryBackoffSeconds.length - 1))];
        const jitter = 1 + ((Math.random() * 2 - 1) * this._retryJitterPercent);
        return Math.max(250, Math.floor(backoffSeconds * 1000 * jitter));
    }

    private _retryAfterMs(error: any): number | null {
        const headers: HttpHeaders = error?.headers;
        const retryAfterRaw = headers?.get?.("Retry-After") || headers?.get?.("retry-after");
        if (!retryAfterRaw) {
            return null;
        }

        if (/^\d+$/.test(retryAfterRaw)) {
            return Math.max(250, parseInt(retryAfterRaw, 10) * 1000);
        }

        const retryAt = new Date(retryAfterRaw).getTime();
        if (Number.isNaN(retryAt)) {
            return null;
        }
        return Math.max(250, retryAt - Date.now());
    }

    private _statusCode(error: any): number | undefined {
        return typeof error?.status === "number" ? error.status : undefined;
    }

    private _classifyError(error: any): NodeActionClassification {
        const status = this._statusCode(error);
        const code = `${error?.code || ""}`.toLowerCase();
        const message = `${error?.message || ""}`.toLowerCase();

        if (status === 403 || code.includes("quota") || message.includes("quota")) {
            return "quota";
        }

        if (status === 0 || status === 408 || status === 409 || status === 429 || status === 500 || status === 502
            || status === 503 || status === 504) {
            return "transient";
        }

        return "fatal";
    }

    private _toFailure(error: any, attempt: number, nodeId?: string): NodeActionFailure {
        return {
            nodeId,
            status: this._statusCode(error),
            code: error?.code,
            message: error?.message || "Unknown error",
            classification: this._classifyError(error),
            attempt,
        };
    }

    private _attemptFromError(error: any): number {
        return typeof error?.__attempt === "number" ? error.__attempt : 1;
    }

    private _toImageReference(imageReference: any): string {
        const publisher = imageReference?.publisher;
        const offer = imageReference?.offer;
        const sku = imageReference?.sku;
        const version = imageReference?.version;

        if (publisher || offer || sku || version) {
            const values = [publisher, offer, sku, version].filter((x) => Boolean(x));
            return values.join("/");
        }

        return imageReference?.virtualMachineImageId || "-";
    }

    private _toStartTaskSummary(startTask: any): PoolStartTaskSummary {
        const userIdentity = startTask?.userIdentity || {};
        const autoUser = userIdentity?.autoUser || {};
        const userName = userIdentity?.userName || autoUser?.scope || autoUser?.elevationLevel || "-";

        return {
            commandLine: `${startTask?.commandLine || "-"}`,
            waitForSuccess: startTask?.waitForSuccess !== false,
            maxTaskRetryCount: this._toNonNegativeNumber(startTask?.maxTaskRetryCount, 0),
            environmentSettingsCount: Array.isArray(startTask?.environmentSettings) ? startTask.environmentSettings.length : 0,
            resourceFilesCount: Array.isArray(startTask?.resourceFiles) ? startTask.resourceFiles.length : 0,
            userIdentity: `${userName}`,
        };
    }

    private _toNonNegativeNumber(value: any, fallback = 0): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    }

    private _chunk(values: string[], size: number): string[][] {
        const chunks: string[][] = [];
        for (let index = 0; index < values.length; index += size) {
            chunks.push(values.slice(index, index + size));
        }
        return chunks;
    }

    private async _ensurePoolSteady(account: unknown, poolId: string): Promise<void> {
        const response = await this._requestForAccount<PoolStateResponse>(
            account,
            "GET",
            `/pools/${encodeURIComponent(poolId)}`,
            { params: { "$select": "id,allocationState" } },
        );

        const allocationState = String(response?.allocationState || "").toLowerCase();
        if (allocationState !== "steady") {
            const error: any = new Error(
                `Pool '${poolId}' is not in steady allocation state (current: '${response?.allocationState || "unknown"}').`,
            );
            error.code = "PoolNotSteady";
            error.status = 400;
            throw error;
        }
    }

    private _accountKey(account: any): string {
        if (account?.id) {
            return String(account.id);
        }
        if (account?.url) {
            return String(account.url);
        }
        return "unknown-account";
    }

    private async _sleep(ms: number): Promise<void> {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }
}
