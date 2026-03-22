import { of, throwError } from "rxjs";
import { BatchPoolActionError, BatchPoolActionsService } from "./batch-pool-actions.service";

describe("BatchPoolActionsService", () => {
    function createService(overrides: any = {}) {
        const scheduler = {
            run: jasmine.createSpy("run").and.callFake(async (_key: string, callback: () => Promise<any>) => callback()),
            ...(overrides.scheduler || {}),
        };
        const batchHttp = {
            requestForAccount: jasmine.createSpy("requestForAccount"),
            ...(overrides.batchHttp || {}),
        };
        const service = new BatchPoolActionsService(batchHttp as any, scheduler as any);
        return { service, batchHttp, scheduler };
    }

    const account: any = {
        id: "acc-1",
        url: "https://acc-1.batch.azure.com",
    };

    it("enforces steady-state guard before resize and blocks non-steady pools", async () => {
        const { service, batchHttp } = createService({
            batchHttp: {
                requestForAccount: jasmine.createSpy("requestForAccount").and.callFake((_account: any, method: string, uri: string) => {
                    if (method === "GET" && uri === "/pools/pool-a") {
                        return of({ id: "pool-a", allocationState: "resizing" });
                    }
                    return of({});
                }),
            },
        });

        const promise = service.resizePool(account, "pool-a", 2).toPromise();
        await expectAsync(promise).toBeRejected();

        let error: any;
        try {
            await promise;
        } catch (e) {
            error = e;
        }

        expect(error instanceof BatchPoolActionError).toBe(true);
        expect(error.kind).toBe("fatal");
        expect(error.code).toBe("PoolNotSteady");

        const resizePosts = batchHttp.requestForAccount.calls.allArgs()
            .filter((args: any[]) => args[1] === "POST" && `${args[2]}`.includes("/resize"));
        expect(resizePosts.length).toBe(0);
    });

    it("classifies quota failures as quota stop reason for bootstrap orchestration", async () => {
        const quotaError: any = new Error("Quota exceeded");
        quotaError.status = 403;
        quotaError.code = "QuotaExceeded";

        const { service } = createService({
            batchHttp: {
                requestForAccount: jasmine.createSpy("requestForAccount").and.callFake((_account: any, method: string, uri: string) => {
                    if (method === "GET" && uri === "/pools/pool-a") {
                        return of({ id: "pool-a", allocationState: "steady" });
                    }
                    if (method === "POST" && uri === "/pools/pool-a/resize") {
                        return throwError(quotaError);
                    }
                    return of({});
                }),
            },
        });

        let error: any;
        try {
            await service.resizePool(account, "pool-a", 3).toPromise();
        } catch (e) {
            error = e;
        }

        expect(error instanceof BatchPoolActionError).toBe(true);
        expect(error.kind).toBe("quota");
        expect(error.status).toBe(403);
    });

    it("classifies conflict/throttling failures as transient stop reason for bootstrap orchestration", async () => {
        const transientError: any = new Error("Pool is resizing");
        transientError.status = 409;
        transientError.code = "OperationInvalidForCurrentState";

        const { service } = createService({
            batchHttp: {
                requestForAccount: jasmine.createSpy("requestForAccount").and.callFake((_account: any, method: string, uri: string) => {
                    if (method === "GET" && uri === "/pools/pool-a") {
                        return of({ id: "pool-a", allocationState: "steady" });
                    }
                    if (method === "POST" && uri === "/pools/pool-a/resize") {
                        return throwError(transientError);
                    }
                    return of({});
                }),
            },
        });

        let error: any;
        try {
            await service.resizePool(account, "pool-a", 3).toPromise();
        } catch (e) {
            error = e;
        }

        expect(error instanceof BatchPoolActionError).toBe(true);
        expect(error.kind).toBe("transient");
        expect(error.status).toBe(409);
    });
});
