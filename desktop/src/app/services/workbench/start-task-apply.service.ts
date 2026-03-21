import { Injectable, Optional } from "@angular/core";
import { BatchAccount } from "app/models";
import { StartTaskDto } from "app/models/dtos";
import { AzureBatchHttpService } from "app/services/azure-batch/core";
import { BatchAccountService } from "app/services/batch-account";
import { Observable, Subscriber } from "rxjs";
import { RequestScheduler } from "./request-scheduler";

export type StartTaskApplyScope = "current" | "selected" | "all";

export interface StartTaskApplyTarget {
    subscriptionId: string;
    accountId: string;
    accountName: string;
    location: string;
    poolId: string;
}

export interface StartTaskApplyRequest {
    scope: StartTaskApplyScope;
    startTask: Partial<StartTaskDto>;
    currentTarget?: StartTaskApplyTarget;
    selectedTargets?: StartTaskApplyTarget[];
    allTargets?: StartTaskApplyTarget[];
    dryRun?: boolean;
    confirmationAccepted?: boolean;
}

export interface StartTaskApplyPreview {
    scope: StartTaskApplyScope;
    totalTargets: number;
    targets: StartTaskApplyTarget[];
    validationErrors: string[];
}

export type StartTaskApplyErrorKind = "quota" | "transient" | "fatal";

export interface StartTaskApplyResult {
    target: StartTaskApplyTarget;
    status: "applied" | "skipped" | "failed";
    errorKind?: StartTaskApplyErrorKind;
    stopReason?: string;
    retries: number;
    startedAt: Date;
    finishedAt: Date;
}

export interface StartTaskApplySummary {
    scope: StartTaskApplyScope;
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    startedAt: Date;
    finishedAt: Date;
    results: StartTaskApplyResult[];
}

export interface StartTaskApplyProgress {
    stage: "started" | "running" | "completed";
    totalTargets: number;
    completedTargets: number;
    currentTarget?: StartTaskApplyTarget;
    lastResult?: StartTaskApplyResult;
    summary?: StartTaskApplySummary;
}

const START_TASK_TEMPLATE_TOKENS = [
    "subscriptionId",
    "accountId",
    "accountName",
    "location",
    "poolId",
] as const;

type StartTaskTemplateToken = typeof START_TASK_TEMPLATE_TOKENS[number];

@Injectable({ providedIn: "root" })
export class StartTaskApplyService {
    private scheduler: RequestScheduler;

    constructor(
        private accountService: BatchAccountService,
        private batchHttp: AzureBatchHttpService,
        @Optional() scheduler?: RequestScheduler) {
        this.scheduler = scheduler || new RequestScheduler();
    }

    public preview(request: StartTaskApplyRequest): StartTaskApplyPreview {
        const targets = this._resolveTargets(request);
        const validationErrors = this._validateRequest(request, targets);
        return {
            scope: request.scope,
            totalTargets: targets.length,
            targets,
            validationErrors,
        };
    }

    public applyStartTask(request: StartTaskApplyRequest): Observable<StartTaskApplyProgress> {
        return new Observable((subscriber) => {
            void this._executeApply(request, subscriber);
        });
    }

    private async _executeApply(
        request: StartTaskApplyRequest,
        subscriber: Subscriber<StartTaskApplyProgress>) {
        const startedAt = new Date();
        const preview = this.preview(request);

        if (preview.validationErrors.length > 0) {
            subscriber.error(new Error(preview.validationErrors.join("\n")));
            return;
        }

        subscriber.next({
            stage: "started",
            totalTargets: preview.totalTargets,
            completedTargets: 0,
        });

        const results: StartTaskApplyResult[] = [];
        let completedTargets = 0;

        if (request.dryRun) {
            for (const target of preview.targets) {
                const now = new Date();
                const skippedResult: StartTaskApplyResult = {
                    target,
                    status: "skipped",
                    stopReason: "dryRun",
                    retries: 0,
                    startedAt: now,
                    finishedAt: now,
                };
                results.push(skippedResult);
                completedTargets++;
                subscriber.next({
                    stage: "running",
                    totalTargets: preview.totalTargets,
                    completedTargets,
                    currentTarget: target,
                    lastResult: skippedResult,
                });
            }

            subscriber.next({
                stage: "completed",
                totalTargets: preview.totalTargets,
                completedTargets,
                summary: this._buildSummary(request.scope, results, startedAt),
            });
            subscriber.complete();
            return;
        }

        for (const target of preview.targets) {
            const opStarted = new Date();
            try {
                await this._applyToTarget(target, request.startTask);
                const success: StartTaskApplyResult = {
                    target,
                    status: "applied",
                    retries: 0,
                    startedAt: opStarted,
                    finishedAt: new Date(),
                };
                results.push(success);
                completedTargets++;
                subscriber.next({
                    stage: "running",
                    totalTargets: preview.totalTargets,
                    completedTargets,
                    currentTarget: target,
                    lastResult: success,
                });
            } catch (error) {
                const failed: StartTaskApplyResult = {
                    target,
                    status: "failed",
                    errorKind: this._classifyError(error),
                    stopReason: this._extractErrorMessage(error),
                    retries: 0,
                    startedAt: opStarted,
                    finishedAt: new Date(),
                };
                results.push(failed);
                completedTargets++;
                subscriber.next({
                    stage: "running",
                    totalTargets: preview.totalTargets,
                    completedTargets,
                    currentTarget: target,
                    lastResult: failed,
                });
            }
        }

        subscriber.next({
            stage: "completed",
            totalTargets: preview.totalTargets,
            completedTargets,
            summary: this._buildSummary(request.scope, results, startedAt),
        });
        subscriber.complete();
    }

    private _buildSummary(
        scope: StartTaskApplyScope,
        results: StartTaskApplyResult[],
        startedAt: Date): StartTaskApplySummary {

        const succeeded = results.filter(x => x.status === "applied").length;
        const failed = results.filter(x => x.status === "failed").length;
        const skipped = results.filter(x => x.status === "skipped").length;
        return {
            scope,
            total: results.length,
            succeeded,
            failed,
            skipped,
            startedAt,
            finishedAt: new Date(),
            results,
        };
    }

    private _resolveTargets(request: StartTaskApplyRequest): StartTaskApplyTarget[] {
        if (request.scope === "current") {
            return request.currentTarget ? [request.currentTarget] : [];
        }
        if (request.scope === "selected") {
            return request.selectedTargets || [];
        }
        return request.allTargets || [];
    }

    private _validateRequest(request: StartTaskApplyRequest, targets: StartTaskApplyTarget[]): string[] {
        const errors: string[] = [];
        const commandLine = request.startTask && request.startTask.commandLine;
        if (typeof commandLine !== "string" || commandLine.trim().length === 0) {
            errors.push("Start task commandLine is required.");
        } else {
            errors.push(...this._validateCommandLineTemplate(commandLine));
        }
        if (!request.confirmationAccepted && !request.dryRun) {
            errors.push("Confirmation is required before applying start task changes.");
        }
        if (targets.length === 0) {
            errors.push("No target pools selected for apply scope.");
        }
        return errors;
    }

    private async _applyToTarget(target: StartTaskApplyTarget, startTask: Partial<StartTaskDto>) {
        const account = await this.accountService.get(target.accountId).toPromise();
        if (!account) {
            throw new Error(`Batch account ${target.accountId} not found.`);
        }

        if (typeof this.batchHttp.requestForAccount !== "function") {
            throw new Error("AzureBatchHttpService.requestForAccount is not available.");
        }

        const renderedStartTask: Partial<StartTaskDto> = {
            ...startTask,
            commandLine: this._renderCommandLineTemplate(startTask.commandLine, target),
        };

        await this.scheduler.run(target.accountId, async () => {
            await this.batchHttp.requestForAccount(
                account as BatchAccount,
                "PATCH",
                `/pools/${encodeURIComponent(target.poolId)}`,
                { body: this._buildPatchBody(renderedStartTask) },
            ).toPromise();
        });
    }

    private _validateCommandLineTemplate(commandLine: string): string[] {
        const errors: string[] = [];
        const allowedTokens = new Set<string>(START_TASK_TEMPLATE_TOKENS);
        let cursor = 0;

        while (cursor < commandLine.length) {
            const openIndex = commandLine.indexOf("{{", cursor);
            const closeIndex = commandLine.indexOf("}}", cursor);

            if (closeIndex !== -1 && (openIndex === -1 || closeIndex < openIndex)) {
                errors.push("Invalid commandLine template: unexpected '}}'.");
                break;
            }

            if (openIndex === -1) {
                break;
            }

            const endIndex = commandLine.indexOf("}}", openIndex + 2);
            if (endIndex === -1) {
                errors.push("Invalid commandLine template: missing closing '}}'.");
                break;
            }

            const token = commandLine.slice(openIndex + 2, endIndex).trim();
            if (!token) {
                errors.push("Invalid commandLine template: token name is empty.");
            } else if (!/^[a-zA-Z][\w]*$/.test(token)) {
                errors.push(`Invalid commandLine template token '${token}'.`);
            } else if (!allowedTokens.has(token)) {
                errors.push(
                    `Unsupported commandLine template token '${token}'. `
                    + `Allowed tokens: ${START_TASK_TEMPLATE_TOKENS.join(", ")}.`,
                );
            }

            cursor = endIndex + 2;
        }

        return errors;
    }

    private _renderCommandLineTemplate(
        commandLine: string | undefined,
        target: StartTaskApplyTarget): string | undefined {

        if (typeof commandLine !== "string") {
            return commandLine;
        }

        return commandLine.replace(/\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g, (_match, token: string) => {
            return this._resolveTemplateToken(token as StartTaskTemplateToken, target);
        });
    }

    private _resolveTemplateToken(token: StartTaskTemplateToken, target: StartTaskApplyTarget): string {
        switch (token) {
            case "subscriptionId":
                return target.subscriptionId || "";
            case "accountId":
                return target.accountId || "";
            case "accountName":
                return target.accountName || "";
            case "location":
                return target.location || "";
            case "poolId":
                return target.poolId || "";
            default:
                return "";
        }
    }

    private _buildPatchBody(startTask: Partial<StartTaskDto>) {
        // Use patch semantics with startTask only to avoid accidental removal of other pool settings.
        return {
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
    }

    private _classifyError(error: any): StartTaskApplyErrorKind {
        const status = error && (error.status as number);
        const code = String(error && (error.code || "")).toLowerCase();
        const message = String(error && (error.message || "")).toLowerCase();

        if (status === 409 || status === 429 || status === 408 || (status >= 500 && status <= 599)) {
            return "transient";
        }

        if (code.includes("quota") || message.includes("quota")) {
            return "quota";
        }

        return "fatal";
    }

    private _extractErrorMessage(error: any): string {
        if (!error) {
            return "Unknown error.";
        }
        return error.message || error.statusText || error.code || "Unknown error.";
    }
}
