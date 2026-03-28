import {
    listSubscriptions,
    listBatchAccounts,
    getBatchAccount,
    createResourceGroup,
    createBatchAccount,
} from "../arm-service";
import { AzureRequestError } from "../types";

describe("arm-service", () => {
    const TOKEN = "test-token-abc";

    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.resetAllMocks();
    });

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function mockFetchOk(body: unknown): void {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => body,
        });
    }

    function mockFetchError(
        status: number,
        code: string,
        message: string
    ): void {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: false,
            status,
            json: async () => ({ error: { code, message } }),
        });
    }

    // -----------------------------------------------------------------------
    // listSubscriptions
    // -----------------------------------------------------------------------

    describe("listSubscriptions", () => {
        it("returns subscriptions from a single page", async () => {
            mockFetchOk({
                value: [
                    {
                        subscriptionId: "sub-1",
                        displayName: "Test Sub",
                        state: "Enabled",
                        tenantId: "tenant-1",
                    },
                ],
            });

            const result = await listSubscriptions(TOKEN);

            expect(result).toHaveLength(1);
            expect(result[0].subscriptionId).toBe("sub-1");
            expect(result[0].displayName).toBe("Test Sub");
            expect(global.fetch).toHaveBeenCalledTimes(1);
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("/subscriptions"),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: `Bearer ${TOKEN}`,
                    }),
                })
            );
        });

        it("includes correct api-version in URL", async () => {
            mockFetchOk({ value: [] });

            await listSubscriptions(TOKEN);

            const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(url).toContain("api-version=2022-12-01");
        });

        it("follows nextLink for pagination", async () => {
            (global.fetch as jest.Mock)
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        value: [
                            {
                                subscriptionId: "sub-1",
                                displayName: "Sub 1",
                                state: "Enabled",
                                tenantId: "t1",
                            },
                        ],
                        nextLink: "https://management.azure.com/next-page",
                    }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        value: [
                            {
                                subscriptionId: "sub-2",
                                displayName: "Sub 2",
                                state: "Enabled",
                                tenantId: "t1",
                            },
                        ],
                    }),
                });

            const result = await listSubscriptions(TOKEN);

            expect(result).toHaveLength(2);
            expect(result[0].subscriptionId).toBe("sub-1");
            expect(result[1].subscriptionId).toBe("sub-2");
            expect(global.fetch).toHaveBeenCalledTimes(2);
            expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe(
                "https://management.azure.com/next-page"
            );
        });

        it("throws AzureRequestError on non-ok response", async () => {
            mockFetchError(403, "AuthorizationFailed", "Forbidden");

            const promise = listSubscriptions("bad-token");
            await expect(promise).rejects.toThrow("Forbidden");
        });

        it("thrown error is an AzureRequestError instance", async () => {
            mockFetchError(403, "AuthorizationFailed", "Forbidden");

            try {
                await listSubscriptions("bad-token");
                fail("should have thrown");
            } catch (err) {
                expect(err).toBeInstanceOf(AzureRequestError);
                expect((err as AzureRequestError).status).toBe(403);
                expect((err as AzureRequestError).code).toBe(
                    "AuthorizationFailed"
                );
            }
        });

        it("returns empty array when value is empty", async () => {
            mockFetchOk({ value: [] });

            const result = await listSubscriptions(TOKEN);
            expect(result).toEqual([]);
        });
    });

    // -----------------------------------------------------------------------
    // listBatchAccounts
    // -----------------------------------------------------------------------

    describe("listBatchAccounts", () => {
        it("returns batch accounts for a subscription", async () => {
            mockFetchOk({
                value: [
                    {
                        id: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Batch/batchAccounts/acct1",
                        name: "acct1",
                        type: "Microsoft.Batch/batchAccounts",
                        location: "eastus",
                        properties: {
                            accountEndpoint: "acct1.eastus.batch.azure.com",
                            provisioningState: "Succeeded",
                        },
                    },
                ],
            });

            const result = await listBatchAccounts("sub-1", TOKEN);

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe("acct1");
            expect(result[0].location).toBe("eastus");
        });

        it("includes correct subscription ID and api-version in URL", async () => {
            mockFetchOk({ value: [] });

            await listBatchAccounts("sub-123", TOKEN);

            const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(url).toContain("/subscriptions/sub-123/");
            expect(url).toContain("providers/Microsoft.Batch/batchAccounts");
            expect(url).toContain("api-version=2024-02-01");
        });

        it("handles pagination", async () => {
            (global.fetch as jest.Mock)
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        value: [
                            {
                                id: "a1",
                                name: "acct1",
                                type: "t",
                                location: "eastus",
                                properties: {},
                            },
                        ],
                        nextLink: "https://management.azure.com/next",
                    }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        value: [
                            {
                                id: "a2",
                                name: "acct2",
                                type: "t",
                                location: "westus",
                                properties: {},
                            },
                        ],
                    }),
                });

            const result = await listBatchAccounts("sub-1", TOKEN);
            expect(result).toHaveLength(2);
        });

        it("throws AzureRequestError on failure", async () => {
            mockFetchError(
                404,
                "SubscriptionNotFound",
                "Subscription not found"
            );

            await expect(listBatchAccounts("bad-sub", TOKEN)).rejects.toThrow(
                "Subscription not found"
            );
        });
    });

    // -----------------------------------------------------------------------
    // getBatchAccount
    // -----------------------------------------------------------------------

    describe("getBatchAccount", () => {
        it("returns a single batch account", async () => {
            const account = {
                id: "/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Batch/batchAccounts/myacct",
                name: "myacct",
                type: "Microsoft.Batch/batchAccounts",
                location: "eastus",
                properties: {
                    accountEndpoint: "myacct.eastus.batch.azure.com",
                    provisioningState: "Succeeded",
                    dedicatedCoreQuota: 100,
                    lowPriorityCoreQuota: 500,
                    poolQuota: 50,
                },
            };
            mockFetchOk(account);

            const result = await getBatchAccount(
                "sub-1",
                "rg",
                "myacct",
                TOKEN
            );

            expect(result.name).toBe("myacct");
            expect(result.properties.dedicatedCoreQuota).toBe(100);
        });

        it("builds the correct URL with encoded path segments", async () => {
            mockFetchOk({
                id: "x",
                name: "acct",
                type: "t",
                location: "l",
                properties: {},
            });

            await getBatchAccount("sub/1", "rg name", "my acct", TOKEN);

            const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(url).toContain("/subscriptions/sub%2F1/");
            expect(url).toContain("/resourceGroups/rg%20name/");
            expect(url).toContain("/batchAccounts/my%20acct");
            expect(url).toContain("api-version=2024-02-01");
        });

        it("sends Authorization header", async () => {
            mockFetchOk({
                id: "x",
                name: "a",
                type: "t",
                location: "l",
                properties: {},
            });

            await getBatchAccount("sub-1", "rg", "acct", TOKEN);

            const headers = (global.fetch as jest.Mock).mock.calls[0][1]
                .headers;
            expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
        });

        it("throws on non-ok response", async () => {
            mockFetchError(403, "Forbidden", "Access denied");

            await expect(
                getBatchAccount("sub-1", "rg", "acct", TOKEN)
            ).rejects.toThrow("Access denied");
        });
    });

    // -----------------------------------------------------------------------
    // createResourceGroup
    // -----------------------------------------------------------------------

    describe("createResourceGroup", () => {
        it("creates a resource group with PUT", async () => {
            const rg = {
                id: "/subscriptions/sub-1/resourceGroups/my-rg",
                name: "my-rg",
                location: "eastus",
                properties: { provisioningState: "Succeeded" },
            };
            mockFetchOk(rg);

            const result = await createResourceGroup(
                "sub-1",
                "my-rg",
                "eastus",
                TOKEN
            );

            expect(result.name).toBe("my-rg");
            expect(result.location).toBe("eastus");

            const call = (global.fetch as jest.Mock).mock.calls[0];
            expect(call[1].method).toBe("PUT");
            expect(call[1].headers["Content-Type"]).toBe("application/json");
            expect(JSON.parse(call[1].body)).toEqual({ location: "eastus" });
        });

        it("uses the resource group API version", async () => {
            mockFetchOk({
                id: "x",
                name: "rg",
                location: "l",
                properties: { provisioningState: "Succeeded" },
            });

            await createResourceGroup("sub-1", "rg", "westus", TOKEN);

            const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(url).toContain("api-version=2021-04-01");
            expect(url).toContain("/resourcegroups/rg");
        });

        it("throws on non-ok response", async () => {
            mockFetchError(409, "Conflict", "RG already exists differently");

            await expect(
                createResourceGroup("sub-1", "rg", "eastus", TOKEN)
            ).rejects.toThrow("RG already exists differently");
        });
    });

    // -----------------------------------------------------------------------
    // createBatchAccount
    // -----------------------------------------------------------------------

    describe("createBatchAccount", () => {
        it("creates a batch account with PUT", async () => {
            const account = {
                id: "/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Batch/batchAccounts/newacct",
                name: "newacct",
                type: "Microsoft.Batch/batchAccounts",
                location: "eastus",
                properties: { provisioningState: "Creating" },
            };
            mockFetchOk(account);

            const result = await createBatchAccount(
                "sub-1",
                "rg",
                "newacct",
                "eastus",
                TOKEN
            );

            expect(result.name).toBe("newacct");
            expect(result.properties.provisioningState).toBe("Creating");

            const call = (global.fetch as jest.Mock).mock.calls[0];
            expect(call[1].method).toBe("PUT");
            const body = JSON.parse(call[1].body);
            expect(body.location).toBe("eastus");
            expect(body.properties).toEqual({ autoStorage: null });
        });

        it("uses the Batch API version in URL", async () => {
            mockFetchOk({
                id: "x",
                name: "a",
                type: "t",
                location: "l",
                properties: {},
            });

            await createBatchAccount("sub-1", "rg", "acct", "eastus", TOKEN);

            const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(url).toContain("api-version=2024-02-01");
            expect(url).toContain("/batchAccounts/acct");
        });

        it("throws AzureRequestError on failure", async () => {
            mockFetchError(400, "InvalidAccountName", "Account name invalid");

            await expect(
                createBatchAccount("sub-1", "rg", "BAD!", "eastus", TOKEN)
            ).rejects.toThrow("Account name invalid");
        });

        it("sends proper Authorization and Content-Type headers", async () => {
            mockFetchOk({
                id: "x",
                name: "a",
                type: "t",
                location: "l",
                properties: {},
            });

            await createBatchAccount("sub-1", "rg", "acct", "eastus", TOKEN);

            const headers = (global.fetch as jest.Mock).mock.calls[0][1]
                .headers;
            expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
            expect(headers["Content-Type"]).toBe("application/json");
        });
    });
});
