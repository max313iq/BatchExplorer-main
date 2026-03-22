import { Injectable, Optional } from "@angular/core";
import { HttpMethod, HttpRequestOptions } from "@batch-flask/core";
import { BatchAccount } from "app/models";
import { NodeDeallocationOption } from "app/models/dtos";
import { AzureBatchHttpService } from "app/services/azure-batch/core";
import { Observable, from } from "rxjs";
import { RequestScheduler } from "./request-scheduler";

export type PoolActionErrorKind = "quota" | "transient" | "fatal";

export interface BatchPoolActionErrorAttributes {
    action: string;
    kind: PoolActionErrorKind;
    accountId: string;
    poolId?: string;
    attempt: number;
    status?: number;
    code?: string;
    details?: string;
    originalError: any;
}

export class BatchPoolActionError extends Error {
    public action: string;
    public kind: PoolActionErrorKind;
    public accountId: string;
    public poolId?: string;
    public attempt: number;
    public status?: number;
    public code?: string;
    public details?: string;
    public originalError: any;

    constructor(attributes: BatchPoolActionErrorAttributes) {
        super(attributes.details || `Pool action '${attributes.action}' failed`);
        this.name = "BatchPoolActionError";
        this.action = attributes.action;
        this.kind = attributes.kind;
        this.accountId = attributes.accountId;
        this.poolId = attributes.poolId;
        this.attempt = attributes.attempt;
        this.status = attributes.status;
        this.code = attributes.code;
        this.details = attributes.details;
        this.originalError = attributes.originalError;
    }
}

interface PoolStartTaskPatch {
    commandLine?: string;
    waitForSuccess?: boolean;
    maxTaskRetryCount?: number;
    resourceFiles?: any[];
    environmentSettings?: any[];
    userIdentity?: any;
    containerSettings?: any;
}

interface PoolSteadyStateResponse {
    id?: string;
    allocationState?: string;
}

class PoolSteadyStateError extends Error {
    public status = 400;
    public code = "PoolNotSteady";

    constructor(public accountId: string, public poolId: string, public allocationState: string) {
        super(`Pool '${poolId}' is not in steady allocation state (current: '${allocationState || "unknown"}').`);
        this.name = "PoolSteadyStateError";
    }
}

@Injectable({ providedIn: "root" })
export class BatchPoolActionsService {
    private scheduler: RequestScheduler;

    constructor(
        private batchHttp: AzureBatchHttpService,
        @Optional() scheduler?: RequestScheduler,
    ) {
        this.scheduler = scheduler || new RequestScheduler();
    }

    public resizePool(
        account: BatchAccount,
        poolId: string,
        targetDedicatedNodes: number,
        deallocationOption: NodeDeallocationOption = NodeDeallocationOption.requeue): Observable<any> {

        const body = {
            targetDedicatedNodes,
            nodeDeallocationOption: deallocationOption,
        };
        return from(this._schedulePoolAction(account, "resizePool", poolId, async () => {
            await this._ensurePoolSteady(account, poolId);
            return this._requestForAccount(account, HttpMethod.Post, `/pools/${encodeURIComponent(poolId)}/resize`, { body });
        }));
    }

    public stopResize(account: BatchAccount, poolId: string): Observable<any> {
        return from(this._schedulePoolAction(account, "stopResize", poolId, async () => {
            return this._requestForAccount(account, HttpMethod.Post, `/pools/${encodeURIComponent(poolId)}/stopresize`, { body: null });
        }));
    }

    public deletePool(account: BatchAccount, poolId: string): Observable<any> {
        return from(this._schedulePoolAction(account, "deletePool", poolId, async () => {
            await this._ensurePoolSteady(account, poolId);
            return this._requestForAccount(account, HttpMethod.Delete, `/pools/${encodeURIComponent(poolId)}`);
        }));
    }

    public exportPoolJson(account: BatchAccount, poolId: string): Observable<any> {
        return this.exportPoolConfigJson(account, poolId);
    }

    public exportPoolConfigJson(account: BatchAccount, poolId: string): Observable<any> {
        return from(this._schedulePoolAction(account, "exportPoolConfigJson", poolId, async () => {
            return this._requestForAccount(account, HttpMethod.Get, `/pools/${encodeURIComponent(poolId)}`);
        }));
    }

    public clonePool(account: BatchAccount, sourcePoolId: string, newPoolId: string): Observable<any> {
        return from(this._schedulePoolAction(account, "clonePool", sourcePoolId, async () => {
            const sourcePool = await this._requestForAccount<any>(account, HttpMethod.Get, `/pools/${encodeURIComponent(sourcePoolId)}`);
            const body = this._buildPoolCreatePayload(sourcePool, newPoolId);
            return this._requestForAccount(account, HttpMethod.Post, "/pools", { body });
        }));
    }

    public recreatePool(account: BatchAccount, poolId: string, newPoolId?: string): Observable<any> {
        return from(this._schedulePoolAction(account, "recreatePool", poolId, async () => {
            const sourcePool = await this._requestForAccount<any>(account, HttpMethod.Get, `/pools/${encodeURIComponent(poolId)}`);
            const targetPoolId = newPoolId || poolId;
            const body = this._buildPoolCreatePayload(sourcePool, targetPoolId);
            await this._ensurePoolSteady(account, poolId);
            await this._requestForAccount(account, HttpMethod.Delete, `/pools/${encodeURIComponent(poolId)}`);
            return this._requestForAccount(account, HttpMethod.Post, "/pools", { body });
        }));
    }

    public applyStartTask(
        account: BatchAccount,
        poolId: string,
        startTask: PoolStartTaskPatch): Observable<any> {

        const body = {
            startTask: {
                commandLine: startTask.commandLine && startTask.commandLine.trim(),
                waitForSuccess: startTask.waitForSuccess,
                maxTaskRetryCount: startTask.maxTaskRetryCount,
                resourceFiles: startTask.resourceFiles || [],
                environmentSettings: startTask.environmentSettings || [],
                userIdentity: startTask.userIdentity,
                containerSettings: startTask.containerSettings,
            },
        };

        return from(this._schedulePoolAction(account, "applyStartTask", poolId, async () => {
            return this._requestForAccount(
                account,
                HttpMethod.Patch,
                `/pools/${encodeURIComponent(poolId)}`,
                { body },
            );
        }));
    }

    private _schedulePoolAction<T>(
        account: BatchAccount,
        actionName: string,
        poolId: string | undefined,
        operation: () => Promise<T>): Promise<T> {
        const accountKey = this._getAccountKey(account);
        return this.scheduler.run(accountKey, async () => {
            try {
                return await operation();
            } catch (error) {
                if (error instanceof BatchPoolActionError) {
                    throw error;
                }
                throw this._toActionError(account, actionName, poolId, this._readAttempt(error), error);
            }
        });
    }

    private _classifyError(status: number | undefined, code: string | undefined): PoolActionErrorKind {

        const normalizedCode = (code || "").toLowerCase();

        if (status === 403 || normalizedCode.includes("quota")) {
            return "quota";
        }

        if (status === 409) {
            return "transient";
        }

        if (status === 0 || status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
            return "transient";
        }

        return "fatal";
    }

    private _toActionError(
        account: BatchAccount,
        actionName: string,
        poolId: string | undefined,
        attempt: number,
        error: any): BatchPoolActionError {

        const status = this._readStatus(error);
        const code = this._readCode(error);
        return new BatchPoolActionError({
            action: actionName,
            kind: this._classifyError(status, code),
            accountId: this._getAccountKey(account),
            poolId,
            attempt,
            status,
            code,
            details: this._readMessage(error),
            originalError: error,
        });
    }

    private _readStatus(error: any): number | undefined {
        if (error && typeof error.status === "number") {
            return error.status;
        }
        return undefined;
    }

    private _readCode(error: any): string | undefined {
        return error && (error.code || error.error?.code) ? `${error.code || error.error?.code}` : undefined;
    }

    private _readMessage(error: any): string | undefined {
        if (!error) {
            return undefined;
        }
        if (error.message) {
            return error.message;
        }
        if (error.error && error.error.message && error.error.message.value) {
            return error.error.message.value;
        }
        if (error.statusText) {
            return error.statusText;
        }
        return undefined;
    }

    private _readAttempt(error: any): number {
        const attempt = Number(error && (error.__attempt ?? error.attempt));
        return Number.isFinite(attempt) && attempt > 0 ? attempt : 1;
    }

    private async _ensurePoolSteady(account: BatchAccount, poolId: string): Promise<void> {
        const params = {
            "$select": "id,allocationState",
        };
        const response = await this._requestForAccount<PoolSteadyStateResponse>(
            account,
            HttpMethod.Get,
            `/pools/${encodeURIComponent(poolId)}`,
            { params },
        );
        const allocationState = String(response && response.allocationState || "").toLowerCase();
        if (allocationState !== "steady") {
            throw new PoolSteadyStateError(this._getAccountKey(account), poolId, response && response.allocationState || "unknown");
        }
    }

    private _buildPoolCreatePayload(sourcePool: any, newPoolId: string): any {
        const payload: any = {
            id: newPoolId,
        };

        const copyFields = [
            "displayName",
            "vmSize",
            "cloudServiceConfiguration",
            "virtualMachineConfiguration",
            "networkConfiguration",
            "resizeTimeout",
            "targetDedicatedNodes",
            "targetLowPriorityNodes",
            "taskSlotsPerNode",
            "taskSchedulingPolicy",
            "autoScaleFormula",
            "autoScaleEvaluationInterval",
            "enableAutoScale",
            "enableInterNodeCommunication",
            "startTask",
            "certificateReferences",
            "applicationPackageReferences",
            "metadata",
            "userAccounts",
            "applicationLicenses",
            "targetNodeCommunicationMode",
            "identity",
        ];

        for (const field of copyFields) {
            if (sourcePool && sourcePool[field] !== undefined) {
                payload[field] = sourcePool[field];
            }
        }

        return payload;
    }

    private _getAccountKey(account: BatchAccount): string {
        return account && account.id ? account.id : `${account && account.url ? account.url : "unknown-account"}`;
    }

    private _requestForAccount<T>(
        account: BatchAccount,
        method: HttpMethod | string,
        uri: string,
        options?: HttpRequestOptions): Promise<T> {

        if (typeof this.batchHttp.requestForAccount !== "function") {
            return Promise.reject(new BatchPoolActionError({
                action: "requestForAccount",
                kind: "fatal",
                accountId: this._getAccountKey(account),
                attempt: 1,
                details: "AzureBatchHttpService.requestForAccount is unavailable",
                originalError: new Error("Missing requestForAccount"),
            }));
        }
        return this._toPromise<T>(this.batchHttp.requestForAccount(account, method, uri, options));
    }

    private _toPromise<T>(obs: Observable<T>): Promise<T> {
        return obs.toPromise();
    }
}
