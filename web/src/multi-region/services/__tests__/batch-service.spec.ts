import {
    listPools,
    createPool,
    patchPool,
    deletePool,
    listNodes,
    performNodeAction,
    removeNodes,
} from "../batch-service";

describe("batch-service", () => {
    const TOKEN = "batch-token-xyz";
    const ENDPOINT = "myaccount.eastus.batch.azure.com";

    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.resetAllMocks();
    });

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function mockFetchOk(body?: unknown): void {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => body ?? {},
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

    function lastFetchUrl(): string {
        const calls = (global.fetch as jest.Mock).mock.calls;
        return calls[calls.length - 1][0] as string;
    }

    function lastFetchOptions(): RequestInit {
        const calls = (global.fetch as jest.Mock).mock.calls;
        return calls[calls.length - 1][1] as RequestInit;
    }

    // -----------------------------------------------------------------------
    // listPools
    // -----------------------------------------------------------------------

    describe("listPools", () => {
        it("returns pools from a single page", async () => {
            mockFetchOk({
                value: [
                    {
                        id: "pool-1",
                        vmSize: "Standard_D2s_v3",
                        state: "active",
                    },
                    {
                        id: "pool-2",
                        vmSize: "Standard_D4s_v3",
                        state: "active",
                    },
                ],
            });

            const result = await listPools(ENDPOINT, TOKEN);

            expect(result).toHaveLength(2);
            expect(result[0].id).toBe("pool-1");
            expect(result[1].id).toBe("pool-2");
        });

        it("builds the correct URL with https prefix and api-version", async () => {
            mockFetchOk({ value: [] });

            await listPools(ENDPOINT, TOKEN);

            const url = lastFetchUrl();
            expect(url).toMatch(
                /^https:\/\/myaccount\.eastus\.batch\.azure\.com\/pools\?/
            );
            expect(url).toContain("api-version=2024-07-01.20.0");
        });

        it("does not double-prefix https if already present", async () => {
            mockFetchOk({ value: [] });

            await listPools(`https://${ENDPOINT}`, TOKEN);

            const url = lastFetchUrl();
            expect(url).toMatch(
                /^https:\/\/myaccount\.eastus\.batch\.azure\.com\/pools\?/
            );
            // Ensure no double https://
            expect(url).not.toContain("https://https://");
        });

        it("follows odata.nextLink for pagination", async () => {
            (global.fetch as jest.Mock)
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        value: [{ id: "pool-1" }],
                        "odata.nextLink":
                            "https://myaccount.eastus.batch.azure.com/pools?skiptoken=abc",
                    }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        value: [{ id: "pool-2" }],
                    }),
                });

            const result = await listPools(ENDPOINT, TOKEN);

            expect(result).toHaveLength(2);
            expect(global.fetch).toHaveBeenCalledTimes(2);
        });

        it("sends correct headers", async () => {
            mockFetchOk({ value: [] });

            await listPools(ENDPOINT, TOKEN);

            const opts = lastFetchOptions();
            const headers = opts.headers as Record<string, string>;
            expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
            expect(headers.Accept).toContain("odata=minimalmetadata");
        });

        it("throws AzureRequestError on failure", async () => {
            mockFetchError(401, "Unauthorized", "Token expired");

            await expect(listPools(ENDPOINT, TOKEN)).rejects.toThrow(
                "Token expired"
            );
        });
    });

    // -----------------------------------------------------------------------
    // createPool
    // -----------------------------------------------------------------------

    describe("createPool", () => {
        it("sends POST with pool config", async () => {
            mockFetchOk();

            const config = {
                id: "my-pool",
                vmSize: "Standard_D2s_v3",
                targetDedicatedNodes: 5,
            };
            await createPool(ENDPOINT, config, TOKEN);

            const opts = lastFetchOptions();
            expect(opts.method).toBe("POST");
            expect(JSON.parse(opts.body as string)).toEqual(config);

            const url = lastFetchUrl();
            expect(url).toContain("/pools?");
        });

        it("sends Content-Type header for body", async () => {
            mockFetchOk();

            await createPool(ENDPOINT, { id: "p1" }, TOKEN);

            const headers = lastFetchOptions().headers as Record<
                string,
                string
            >;
            expect(headers["Content-Type"]).toContain("odata=minimalmetadata");
        });

        it("throws on failure", async () => {
            mockFetchError(409, "PoolExists", "Pool already exists");

            await expect(
                createPool(ENDPOINT, { id: "existing" }, TOKEN)
            ).rejects.toThrow("Pool already exists");
        });
    });

    // -----------------------------------------------------------------------
    // patchPool
    // -----------------------------------------------------------------------

    describe("patchPool", () => {
        it("sends PATCH with partial body", async () => {
            mockFetchOk();

            const patch = { targetDedicatedNodes: 10 };
            await patchPool(ENDPOINT, "my-pool", patch, TOKEN);

            const opts = lastFetchOptions();
            expect(opts.method).toBe("PATCH");
            expect(JSON.parse(opts.body as string)).toEqual(patch);

            const url = lastFetchUrl();
            expect(url).toContain("/pools/my-pool?");
        });

        it("encodes the pool ID in the URL", async () => {
            mockFetchOk();

            await patchPool(ENDPOINT, "pool with spaces", {}, TOKEN);

            const url = lastFetchUrl();
            expect(url).toContain("/pools/pool%20with%20spaces?");
        });

        it("throws on failure", async () => {
            mockFetchError(404, "PoolNotFound", "Pool not found");

            await expect(
                patchPool(ENDPOINT, "missing-pool", {}, TOKEN)
            ).rejects.toThrow("Pool not found");
        });
    });

    // -----------------------------------------------------------------------
    // deletePool
    // -----------------------------------------------------------------------

    describe("deletePool", () => {
        it("sends DELETE request", async () => {
            mockFetchOk();

            await deletePool(ENDPOINT, "my-pool", TOKEN);

            const opts = lastFetchOptions();
            expect(opts.method).toBe("DELETE");
            expect(lastFetchUrl()).toContain("/pools/my-pool?");
        });

        it("throws on failure", async () => {
            mockFetchError(404, "PoolNotFound", "No such pool");

            await expect(deletePool(ENDPOINT, "ghost", TOKEN)).rejects.toThrow(
                "No such pool"
            );
        });
    });

    // -----------------------------------------------------------------------
    // listNodes
    // -----------------------------------------------------------------------

    describe("listNodes", () => {
        it("returns nodes from a single page", async () => {
            mockFetchOk({
                value: [
                    { id: "node-1", state: "idle" },
                    { id: "node-2", state: "running" },
                ],
            });

            const result = await listNodes(ENDPOINT, "my-pool", TOKEN);

            expect(result).toHaveLength(2);
            expect(result[0].id).toBe("node-1");
        });

        it("builds the correct URL with pool ID", async () => {
            mockFetchOk({ value: [] });

            await listNodes(ENDPOINT, "pool-1", TOKEN);

            const url = lastFetchUrl();
            expect(url).toContain("/pools/pool-1/nodes?");
        });

        it("follows pagination", async () => {
            (global.fetch as jest.Mock)
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        value: [{ id: "n1" }],
                        "odata.nextLink": "https://x.batch.azure.com/next",
                    }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        value: [{ id: "n2" }],
                    }),
                });

            const result = await listNodes(ENDPOINT, "pool-1", TOKEN);
            expect(result).toHaveLength(2);
        });

        it("throws on failure", async () => {
            mockFetchError(404, "PoolNotFound", "Pool not found");

            await expect(listNodes(ENDPOINT, "missing", TOKEN)).rejects.toThrow(
                "Pool not found"
            );
        });
    });

    // -----------------------------------------------------------------------
    // performNodeAction
    // -----------------------------------------------------------------------

    describe("performNodeAction", () => {
        it.each([
            ["reboot", "reboot"],
            ["reimage", "reimage"],
            ["disableScheduling", "disablescheduling"],
            ["enableScheduling", "enablescheduling"],
        ] as const)(
            "maps action '%s' to path segment '%s'",
            async (action, expectedSegment) => {
                mockFetchOk();

                await performNodeAction(
                    ENDPOINT,
                    "pool-1",
                    "node-1",
                    action,
                    TOKEN
                );

                const url = lastFetchUrl();
                expect(url).toContain(
                    `/pools/pool-1/nodes/node-1/${expectedSegment}?`
                );
            }
        );

        it("sends POST with empty body", async () => {
            mockFetchOk();

            await performNodeAction(
                ENDPOINT,
                "pool-1",
                "node-1",
                "reboot",
                TOKEN
            );

            const opts = lastFetchOptions();
            expect(opts.method).toBe("POST");
            expect(JSON.parse(opts.body as string)).toEqual({});
        });

        it("throws on failure", async () => {
            mockFetchError(409, "NodeBusy", "Node is busy");

            await expect(
                performNodeAction(ENDPOINT, "pool-1", "node-1", "reboot", TOKEN)
            ).rejects.toThrow("Node is busy");
        });
    });

    // -----------------------------------------------------------------------
    // removeNodes
    // -----------------------------------------------------------------------

    describe("removeNodes", () => {
        it("sends POST with nodeList body", async () => {
            mockFetchOk();

            await removeNodes(ENDPOINT, "pool-1", ["node-1", "node-2"], TOKEN);

            const opts = lastFetchOptions();
            expect(opts.method).toBe("POST");
            expect(JSON.parse(opts.body as string)).toEqual({
                nodeList: ["node-1", "node-2"],
            });

            const url = lastFetchUrl();
            expect(url).toContain("/pools/pool-1/removenodes?");
        });

        it("throws on failure", async () => {
            mockFetchError(400, "InvalidRequest", "Bad node list");

            await expect(
                removeNodes(ENDPOINT, "pool-1", ["bad"], TOKEN)
            ).rejects.toThrow("Bad node list");
        });
    });
});
