import { of } from "rxjs";
import { BatchNodeActionsService } from "./batch-node-actions.service";

describe("BatchNodeActionsService chunking", () => {
    function createService(overrides: any = {}) {
        const http = {
            requestForAccount: jasmine.createSpy("requestForAccount").and.returnValue(of({})),
            ...(overrides.http || {}),
        };
        const service = new BatchNodeActionsService(http as any);
        return { service, http };
    }

    it("chunks remove-nodes requests to max 100 node IDs per call", async () => {
        const { service, http } = createService({
            http: {
                requestForAccount: jasmine.createSpy("requestForAccount").and.callFake((_account: any, method: string, uri: string) => {
                    if (method === "GET" && uri === "/pools/pool-a") {
                        return of({ id: "pool-a", allocationState: "steady" });
                    }
                    return of({});
                }),
            },
        });
        const nodeIds = Array.from({ length: 245 }, (_x, i) => `node-${i}`);

        const result = await service.removeNodes({ id: "acc-1" } as any, "pool-a", nodeIds).toPromise();

        expect(result.totalTargets).toBe(245);
        expect(http.requestForAccount).toHaveBeenCalledTimes(4);

        const payloadSizes = http.requestForAccount.calls.allArgs()
            .filter((args: any[]) => args[1] === "POST" && args[2] === "/pools/pool-a/removenodes")
            .map((args: any[]) => {
            const body = args[3] && args[3].body;
            return Array.isArray(body && body.nodeList) ? body.nodeList.length : -1;
        });

        expect(payloadSizes).toEqual([100, 100, 45]);
        expect(payloadSizes.every((size) => size > 0 && size <= 100)).toBe(true);
    });
});
