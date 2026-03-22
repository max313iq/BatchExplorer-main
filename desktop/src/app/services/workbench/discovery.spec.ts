import { of } from "rxjs";
import { WorkbenchDiscoveryService } from "./workbench-discovery.service";

describe("WorkbenchDiscoveryService", () => {
    function toList<T>(items: T[]) {
        return {
            toArray: () => items,
        };
    }

    function createNodeCounts(overrides: Partial<any> = {}) {
        return {
            creating: 0,
            idle: 0,
            leavingPool: 0,
            offline: 0,
            preempted: 0,
            rebooting: 0,
            reimaging: 0,
            running: 0,
            startTaskFailed: 0,
            starting: 0,
            total: 0,
            unknown: 0,
            unusable: 0,
            waitingForStartTask: 0,
            ...overrides,
        };
    }

    function createService(overrides: any = {}) {
        const scheduler = {
            run: jasmine.createSpy("run").and.callFake(async (_key: string, callback: () => Promise<any>) => callback()),
            ...(overrides.scheduler || {}),
        };
        const subscriptionService = {
            load: jasmine.createSpy("load").and.returnValue(of(undefined)),
            subscriptions: of(toList([{ subscriptionId: "sub-a" }])),
            ...(overrides.subscriptionService || {}),
        };
        const batchAccountService = {
            get: jasmine.createSpy("get").and.returnValue(of({
                id: "account-a",
                name: "Account A",
                displayName: "Account A",
                url: "https://account-a.batch.azure.com",
            })),
            ...(overrides.batchAccountService || {}),
        };
        const armBatchAccountService = {
            list: jasmine.createSpy("list").and.returnValue(of(toList([]))),
            ...(overrides.armBatchAccountService || {}),
        };
        const localBatchAccountService = {
            load: jasmine.createSpy("load").and.returnValue(of(undefined)),
            accounts: of(toList([])),
            ...(overrides.localBatchAccountService || {}),
        };
        const batchHttp = {
            requestForAccount: jasmine.createSpy("requestForAccount"),
            ...(overrides.batchHttp || {}),
        };

        const service = new WorkbenchDiscoveryService(
            subscriptionService as any,
            batchAccountService as any,
            armBatchAccountService as any,
            localBatchAccountService as any,
            batchHttp as any,
            scheduler as any,
        );

        return { service, subscriptionService, batchAccountService, armBatchAccountService, localBatchAccountService, batchHttp, scheduler };
    }

    it("aggregates discovered accounts with stable de-duplication", async () => {
        const { service } = createService({
            subscriptionService: {
                subscriptions: of(toList([{ subscriptionId: "sub-a" }, { subscriptionId: "sub-b" }])),
            },
            armBatchAccountService: {
                list: jasmine.createSpy("list").and.callFake((subscriptionId: string) => {
                    if (subscriptionId === "sub-a") {
                        return of(toList([
                            { id: "/subs/sub-a/accounts/acc-1", name: "acc-1", displayName: "Zulu", url: "https://zulu" },
                        ]));
                    }
                    return of(toList([
                        { id: "/subs/sub-b/accounts/acc-2", name: "acc-2", displayName: "Alpha", url: "https://alpha" },
                        { id: "/SUBS/SUB-B/ACCOUNTS/ACC-2", name: "acc-2-dup", displayName: "Alpha-Dupe", url: "https://alpha" },
                    ]));
                }),
            },
            localBatchAccountService: {
                accounts: of(toList([
                    { id: "/local/accounts/local-1", name: "local-1", displayName: "Local One", url: "https://local-1" },
                ])),
            },
        });

        const accounts = await service.listAccounts().toPromise();

        expect(accounts.map((x) => x.accountName)).toEqual(["Alpha", "Local One", "Zulu"]);
        expect(accounts.length).toBe(3);
    });

    it("aggregates pools and nodecounts without eager node listing", async () => {
        const accountId = "account-a";
        const { service, batchHttp } = createService({
            batchHttp: {
                requestForAccount: jasmine.createSpy("requestForAccount").and.callFake((_account: any, _method: any, uri: string) => {
                    if (uri === "/pools") {
                        return of({
                            value: [
                                { id: "pool-1", allocationState: "steady" },
                                { id: "pool-2", allocationState: "resizing" },
                            ],
                        });
                    }
                    if (uri === "/nodecounts") {
                        return of({
                            value: [
                                {
                                    poolId: "pool-1",
                                    dedicated: createNodeCounts({ idle: 2, total: 2 }),
                                    lowPriority: createNodeCounts({ running: 1, total: 1 }),
                                },
                                {
                                    poolId: "pool-2",
                                    dedicated: createNodeCounts({ startTaskFailed: 1, total: 1 }),
                                    lowPriority: createNodeCounts({ unusable: 1, total: 1 }),
                                },
                            ],
                        });
                    }
                    throw new Error(`Unexpected URI ${uri}`);
                }),
            },
        });

        const rows = await service.listPools({
            accountId,
            accountName: "Account A",
            subscriptionId: "sub-a",
            location: "eastus",
            endpoint: "https://account-a.batch.azure.com",
        }).toPromise();

        expect(rows.length).toBe(2);
        expect(rows[0].nodeCountsByState.total + rows[1].nodeCountsByState.total).toBe(5);
        const resizingRow = rows.find((x) => x.poolId === "pool-2")!;
        expect(resizingRow.alerts).toContain("Pool allocation is not steady");
        expect(resizingRow.alerts).toContain("Nodes with startTaskFailed state");
        expect(resizingRow.alerts).toContain("Nodes with unusable or unknown state");

        const calledUris = batchHttp.requestForAccount.calls.allArgs().map((args: any[]) => `${args[2]}`);
        expect(calledUris).toContain("/pools");
        expect(calledUris).toContain("/nodecounts");
        expect(calledUris.some((uri) => uri.includes("/nodes"))).toBe(false);
    });
});
