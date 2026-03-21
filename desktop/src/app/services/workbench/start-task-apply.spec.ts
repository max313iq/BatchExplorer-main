import { of, throwError } from "rxjs";
import {
    StartTaskApplyRequest,
    StartTaskApplyService,
    StartTaskApplyTarget,
} from "./start-task-apply.service";

describe("StartTaskApplyService", () => {
    function createTarget(index = 1): StartTaskApplyTarget {
        return {
            subscriptionId: "sub-1",
            accountId: "account-1",
            accountName: "account-name",
            location: "eastus",
            poolId: `pool-${index}`,
        };
    }

    function createService(overrides: any = {}) {
        const scheduler = {
            run: jasmine.createSpy("run").and.callFake(async (_key: string, callback: () => Promise<any>) => {
                return callback();
            }),
            ...(overrides.scheduler || {}),
        };

        const accountService = {
            get: jasmine.createSpy("get").and.callFake(() => of({
                id: "account-1",
                name: "account-name",
            })),
            ...(overrides.accountService || {}),
        };

        const batchHttp = {
            requestForAccount: jasmine.createSpy("requestForAccount").and.callFake(() => of({})),
            ...(overrides.batchHttp || {}),
        };

        const service = new StartTaskApplyService(
            accountService as any,
            batchHttp as any,
            scheduler as any,
        );

        return { service, scheduler, accountService, batchHttp };
    }

    async function collectEvents(observable: any): Promise<any[]> {
        return new Promise((resolve, reject) => {
            const events: any[] = [];
            observable.subscribe({
                next: (x) => events.push(x),
                error: reject,
                complete: () => resolve(events),
            });
        });
    }

    it("validates that commandLine is required", () => {
        const { service } = createService();
        const preview = service.preview({
            scope: "current",
            startTask: { commandLine: "   " },
            currentTarget: createTarget(),
            confirmationAccepted: true,
        });

        expect(preview.validationErrors).toContain("Start task commandLine is required.");
    });

    it("validates commandLine template syntax before apply", () => {
        const { service } = createService();
        const preview = service.preview({
            scope: "current",
            startTask: { commandLine: "cmd /c echo {{poolId" },
            currentTarget: createTarget(),
            confirmationAccepted: true,
        });

        expect(preview.validationErrors).toContain("Invalid commandLine template: missing closing '}}'.");
    });

    it("supports dry-run preview execution without writes", async () => {
        const { service, scheduler, batchHttp } = createService();
        const events = await collectEvents(service.applyStartTask({
            scope: "current",
            dryRun: true,
            startTask: { commandLine: "cmd /c echo test" },
            currentTarget: createTarget(),
            confirmationAccepted: true,
        }));

        expect(events.length).toBe(3);
        expect(events[0].stage).toBe("started");
        expect(events[1].lastResult.status).toBe("skipped");
        expect(events[2].summary.skipped).toBe(1);
        expect(scheduler.run).not.toHaveBeenCalled();
        expect(batchHttp.requestForAccount).not.toHaveBeenCalled();
    });

    it("applies start task to selected targets sequentially via scheduler", async () => {
        const { service, scheduler, batchHttp } = createService();
        const request: StartTaskApplyRequest = {
            scope: "selected",
            startTask: { commandLine: "cmd /c setup.bat", waitForSuccess: true },
            selectedTargets: [createTarget(1), createTarget(2)],
            confirmationAccepted: true,
        };

        const events = await collectEvents(service.applyStartTask(request));
        const completed = events[events.length - 1];

        expect(scheduler.run).toHaveBeenCalledTimes(2);
        expect(batchHttp.requestForAccount).toHaveBeenCalledTimes(2);
        expect(batchHttp.requestForAccount.calls.mostRecent().args[1]).toBe("PATCH");
        expect(batchHttp.requestForAccount.calls.mostRecent().args[3].body.startTask.commandLine)
            .toBe("cmd /c setup.bat");
        expect(completed.stage).toBe("completed");
        expect(completed.summary.succeeded).toBe(2);
        expect(completed.summary.failed).toBe(0);
    });

    it("renders supported commandLine template tokens per target before patching", async () => {
        const { service, batchHttp } = createService();
        const request: StartTaskApplyRequest = {
            scope: "current",
            startTask: { commandLine: "cmd /c echo {{poolId}} {{location}}" },
            currentTarget: createTarget(3),
            confirmationAccepted: true,
        };

        await collectEvents(service.applyStartTask(request));

        expect(batchHttp.requestForAccount).toHaveBeenCalledTimes(1);
        expect(batchHttp.requestForAccount.calls.mostRecent().args[3].body.startTask.commandLine)
            .toBe("cmd /c echo pool-3 eastus");
    });

    it("resolves current, selected, and all scopes to the correct target set", () => {
        const { service } = createService();
        const currentTarget = createTarget(1);
        const selectedTargets = [createTarget(2), createTarget(3)];
        const allTargets = [createTarget(4), createTarget(5), createTarget(6)];

        const currentPreview = service.preview({
            scope: "current",
            startTask: { commandLine: "cmd /c echo current" },
            currentTarget,
            selectedTargets,
            allTargets,
            confirmationAccepted: true,
        });
        const selectedPreview = service.preview({
            scope: "selected",
            startTask: { commandLine: "cmd /c echo selected" },
            currentTarget,
            selectedTargets,
            allTargets,
            confirmationAccepted: true,
        });
        const allPreview = service.preview({
            scope: "all",
            startTask: { commandLine: "cmd /c echo all" },
            currentTarget,
            selectedTargets,
            allTargets,
            confirmationAccepted: true,
        });

        expect(currentPreview.targets.map((x) => x.poolId)).toEqual(["pool-1"]);
        expect(selectedPreview.targets.map((x) => x.poolId)).toEqual(["pool-2", "pool-3"]);
        expect(allPreview.targets.map((x) => x.poolId)).toEqual(["pool-4", "pool-5", "pool-6"]);
    });

    it("records stop reason and error kind when apply fails", async () => {
        const quotaError: any = new Error("Quota exceeded for target account.");
        quotaError.status = 403;
        quotaError.code = "QuotaExceeded";

        const { service } = createService({
            batchHttp: {
                requestForAccount: jasmine.createSpy("requestForAccount").and.returnValue(throwError(quotaError)),
            },
        });

        const events = await collectEvents(service.applyStartTask({
            scope: "all",
            startTask: { commandLine: "cmd /c fail" },
            allTargets: [createTarget(8)],
            confirmationAccepted: true,
        }));
        const completed = events[events.length - 1];
        const failed = completed.summary.results[0];

        expect(completed.summary.failed).toBe(1);
        expect(failed.status).toBe("failed");
        expect(failed.errorKind).toBe("quota");
        expect(failed.stopReason).toContain("Quota exceeded");
    });
});
