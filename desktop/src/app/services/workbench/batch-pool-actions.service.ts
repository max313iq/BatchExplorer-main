import { Injectable } from "@angular/core";
import { HttpMethod, HttpRequestOptions } from "@batch-flask/core";
import { BatchAccount } from "app/models";
import { NodeDeallocationOption } from "app/models/dtos";
import { AzureBatchHttpService } from "app/services/azure-batch/core";
import { Observable, from } from "rxjs";

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

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_DELAY_BETWEEN_REQUESTS_MS = 250;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_SECONDS = [2, 4, 8, 16, 32];

@Injectable({ providedIn: "root" })
export class BatchPoolActionsService {
    private _activeTasks = 0;
    private _pendingSlots: Array<() => void> = [];
    private _accountQueues = new Map<string, Promise<void>>();

    constructor(private batchHttp: AzureBatchHttpService) {
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
        return from(this._schedulePoolAction(account, "resizePool", poolId, true, () => {
            return this._requestForAccount(account, HttpMethod.Post, `/pools/${poolId}/resize`, { body });
        }));
    }

    public stopResize(account: BatchAccount, poolId: string): Observable<any> {
        return from(this._schedulePoolAction(account, "stopResize", poolId, true, () => {
            return this._requestForAccount(account, HttpMethod.Post, `/pools/${poolId}/stopresize`, { body: null });
        }));
    }

    public deletePool(account: BatchAccount, poolId: string): Observable<any> {
        return from(this._schedulePoolAction(account, "deletePool", poolId, false, () => {
            return this._requestForAccount(account, HttpMethod.Delete, `/pools/${poolId}`);
        }));
    }

    public exportPoolJson(account: BatchAccount, poolId: string): Observable<any> {
        return from(this._schedulePoolAction(account, "exportPoolJson", poolId, false, () => {
            return this._requestForAccount(account, HttpMethod.Get, `/pools/${poolId}`);
        }));
    }

    public clonePool(account: BatchAccount, sourcePoolId: string, newPoolId: string): Observable<any> {
        return from(this._schedulePoolAction(account, "clonePool", sourcePoolId, false, async () => {
            const sourcePool = await this._requestForAccount<any>(account, HttpMethod.Get, `/pools/${sourcePoolId}`);
            const body = this._buildPoolCreatePayload(sourcePool, newPoolId);
            return this._requestForAccount(account, HttpMethod.Post, "/pools", { body });
        }));
    }

    public recreatePool(account: BatchAccount, poolId: string, newPoolId?: string): Observable<any> {
        return from(this._schedulePoolAction(account, "recreatePool", poolId, false, async () => {
            const sourcePool = await this._requestForAccount<any>(account, HttpMethod.Get, `/pools/${poolId}`);
            const targetPoolId = newPoolId || poolId;
            const body = this._buildPoolCreatePayload(sourcePool, targetPoolId);
            await this._requestForAccount(account, HttpMethod.Delete, `/pools/${poolId}`);
            return this._requestForAccount(account, HttpMethod.Post, "/pools", { body });
        }));
    }

    private _schedulePoolAction<T>(
        account: BatchAccount,
        actionName: string,
        poolId: string | undefined,
        retryOnConflict: boolean,
        operation: () => Promise<T>): Promise<T> {

        const key = this._getAccountKey(account);
        const previous = this._accountQueues.get(key) || Promise.resolve();
        const task = previous
            .catch(() => {
                // Ensure one failed task does not block subsequent actions for the same account.
            })
            .then(() => this._withGlobalSlot(() => {
                return this._runWithRetry(account, actionName, poolId, retryOnConflict, operation);
            }));

        this._accountQueues.set(key, task.then(() => undefined, () => undefined));
        return task;
    }

    private async _withGlobalSlot<T>(task: () => Promise<T>): Promise<T> {
        await this._acquireSlot();
        try {
            return await task();
        } finally {
            await this._delay(DEFAULT_DELAY_BETWEEN_REQUESTS_MS);
            this._releaseSlot();
        }
    }

    private _acquireSlot(): Promise<void> {
        if (this._activeTasks < DEFAULT_CONCURRENCY) {
            this._activeTasks += 1;
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            this._pendingSlots.push(() => {
                this._activeTasks += 1;
                resolve();
            });
        });
    }

    private _releaseSlot() {
        this._activeTasks = Math.max(0, this._activeTasks - 1);
        const next = this._pendingSlots.shift();
        if (next) {
            next();
        }
    }

    private async _runWithRetry<T>(
        account: BatchAccount,
        actionName: string,
        poolId: string | undefined,
        retryOnConflict: boolean,
        operation: () => Promise<T>): Promise<T> {

        for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt++) {
            try {
                return await operation();
            } catch (error) {
                const status = this._readStatus(error);
                const code = this._readCode(error);
                const kind = this._classifyError(status, code, retryOnConflict);
                const canRetry = this._canRetry(kind, status, attempt, retryOnConflict);

                if (!canRetry) {
                    throw this._toActionError(account, actionName, poolId, attempt, kind, error);
                }

                const retryDelayMs = this._resolveRetryDelayMs(error, attempt);
                await this._delay(retryDelayMs);
            }
        }

        throw this._toActionError(
            account,
            actionName,
            poolId,
            DEFAULT_MAX_ATTEMPTS,
            "fatal",
            new Error(`Action ${actionName} exceeded max attempts (${DEFAULT_MAX_ATTEMPTS})`),
        );
    }

    private _canRetry(
        kind: PoolActionErrorKind,
        status: number | undefined,
        attempt: number,
        retryOnConflict: boolean): boolean {

        if (attempt >= DEFAULT_MAX_ATTEMPTS) {
            return false;
        }

        if (kind !== "transient") {
            return false;
        }

        if (status === 409) {
            return retryOnConflict;
        }

        return true;
    }

    private _classifyError(
        status: number | undefined,
        code: string | undefined,
        retryOnConflict: boolean): PoolActionErrorKind {

        const normalizedCode = (code || "").toLowerCase();

        if (status === 403 || normalizedCode.includes("quota")) {
            return "quota";
        }

        if (status === 409) {
            return retryOnConflict ? "transient" : "fatal";
        }

        if (status === 0 || status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
            return "transient";
        }

        return "fatal";
    }

    private _resolveRetryDelayMs(error: any, attempt: number): number {
        const retryAfter = this._readRetryAfterMs(error);
        if (retryAfter !== null) {
            return retryAfter;
        }

        const delaySeconds = DEFAULT_BACKOFF_SECONDS[Math.min(attempt - 1, DEFAULT_BACKOFF_SECONDS.length - 1)];
        return Math.max(1000, delaySeconds * 1000);
    }

    private _readRetryAfterMs(error: any): number | null {
        const headers = error && error.headers;
        if (!headers || typeof headers.get !== "function") {
            return null;
        }

        const retryAfter = headers.get("Retry-After") || headers.get("retry-after");
        if (!retryAfter) {
            return null;
        }

        const asNumber = Number(retryAfter);
        if (!Number.isNaN(asNumber)) {
            return Math.max(0, Math.floor(asNumber * 1000));
        }

        const asDate = Date.parse(retryAfter);
        if (Number.isNaN(asDate)) {
            return null;
        }

        return Math.max(0, asDate - Date.now());
    }

    private _toActionError(
        account: BatchAccount,
        actionName: string,
        poolId: string | undefined,
        attempt: number,
        kind: PoolActionErrorKind,
        error: any): BatchPoolActionError {

        return new BatchPoolActionError({
            action: actionName,
            kind,
            accountId: this._getAccountKey(account),
            poolId,
            attempt,
            status: this._readStatus(error),
            code: this._readCode(error),
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
        return error && error.code ? `${error.code}` : undefined;
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

    private _delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private _requestForAccount<T>(
        account: BatchAccount,
        method: HttpMethod | string,
        uri: string,
        options?: HttpRequestOptions): Promise<T> {

        const accountAwareRequest = (this.batchHttp as any).requestForAccount;
        if (typeof accountAwareRequest !== "function") {
            return Promise.reject(new BatchPoolActionError({
                action: "requestForAccount",
                kind: "fatal",
                accountId: this._getAccountKey(account),
                attempt: 1,
                details: "AzureBatchHttpService.requestForAccount is unavailable",
                originalError: new Error("Missing requestForAccount"),
            }));
        }
        return this._toPromise<T>(accountAwareRequest.call(this.batchHttp, account, method, uri, options));
    }

    private _toPromise<T>(obs: Observable<T>): Promise<T> {
        return obs.toPromise();
    }
}
