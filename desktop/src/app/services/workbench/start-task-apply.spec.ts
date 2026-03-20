import { of } from "rxjs";
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
});
