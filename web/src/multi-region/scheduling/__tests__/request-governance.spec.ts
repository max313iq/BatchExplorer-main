import { RequestGovernance, GovernanceStats } from "../request-governance";
import { AzureRequestError } from "../../services/types";

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("RequestGovernance", () => {
    // -----------------------------------------------------------------------
    // Basic read / write execution
    // -----------------------------------------------------------------------

    describe("read()", () => {
        it("executes and returns the result", async () => {
            const gov = new RequestGovernance({
                baseBackoffMs: 10,
                writeDelayMs: 0,
            });
            const result = await gov.read("key1", async () => 42);
            expect(result).toBe(42);
        });

        it("increments totalReads in stats", async () => {
            const gov = new RequestGovernance({
                baseBackoffMs: 10,
                writeDelayMs: 0,
            });
            await gov.read("k1", async () => "a");
            await gov.read("k2", async () => "b");
            expect(gov.stats.totalReads).toBe(2);
        });
    });

    describe("write()", () => {
        it("executes and returns the result", async () => {
            const gov = new RequestGovernance({
                baseBackoffMs: 10,
                writeDelayMs: 0,
            });
            const result = await gov.write(async () => "written");
            expect(result).toBe("written");
        });

        it("increments totalWrites in stats", async () => {
            const gov = new RequestGovernance({
                baseBackoffMs: 10,
                writeDelayMs: 0,
            });
            await gov.write(async () => {});
            expect(gov.stats.totalWrites).toBe(1);
        });
    });

    // -----------------------------------------------------------------------
    // Deduplication
    // -----------------------------------------------------------------------

    describe("deduplication", () => {
        it("deduplicates concurrent reads with the same key", async () => {
            const gov = new RequestGovernance({
                baseBackoffMs: 10,
                writeDelayMs: 0,
            });
            let callCount = 0;
            const fn = async () => {
                callCount++;
                await delay(20);
                return "result";
            };

            const [r1, r2] = await Promise.all([
                gov.read("same-key", fn),
                gov.read("same-key", fn),
            ]);

            expect(r1).toBe("result");
            expect(r2).toBe("result");
            // The actual fn should only have been called once
            expect(callCount).toBe(1);
            expect(gov.stats.deduplicatedReads).toBe(1);
        });

        it("does not deduplicate reads with different keys", async () => {
            const gov = new RequestGovernance({
                baseBackoffMs: 10,
                writeDelayMs: 0,
            });
            let callCount = 0;
            const fn = async () => {
                callCount++;
                await delay(5);
                return callCount;
            };

            await Promise.all([gov.read("key-a", fn), gov.read("key-b", fn)]);

            expect(callCount).toBe(2);
            expect(gov.stats.deduplicatedReads).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // Concurrency limits
    // -----------------------------------------------------------------------

    describe("concurrency", () => {
        it("allows multiple concurrent reads (up to readConcurrency)", async () => {
            const gov = new RequestGovernance({
                readConcurrency: 3,
                writeDelayMs: 0,
                baseBackoffMs: 10,
            });
            let maxConcurrent = 0;
            let current = 0;

            const task = async () => {
                current++;
                maxConcurrent = Math.max(maxConcurrent, current);
                await delay(15);
                current--;
                return true;
            };

            // Use different keys so dedup doesn't coalesce them
            await Promise.all([
                gov.read("r1", task),
                gov.read("r2", task),
                gov.read("r3", task),
            ]);

            expect(maxConcurrent).toBeGreaterThan(1);
            expect(maxConcurrent).toBeLessThanOrEqual(3);
        });

        it("serializes write operations (writeConcurrency=1)", async () => {
            const gov = new RequestGovernance({
                writeConcurrency: 1,
                writeDelayMs: 0,
                baseBackoffMs: 10,
            });
            const order: number[] = [];

            const p1 = gov.write(async () => {
                order.push(1);
                await delay(20);
                order.push(11);
            });
            const p2 = gov.write(async () => {
                order.push(2);
                await delay(5);
                order.push(22);
            });

            await Promise.all([p1, p2]);

            // Write 1 must fully complete before write 2 starts
            expect(order).toEqual([1, 11, 2, 22]);
        });
    });

    // -----------------------------------------------------------------------
    // Retry logic (withRetry)
    // -----------------------------------------------------------------------

    describe("withRetry", () => {
        it("retries on 429 and eventually succeeds", async () => {
            const gov = new RequestGovernance({
                maxRetries: 3,
                baseBackoffMs: 1,
                jitterPct: 0,
                writeDelayMs: 0,
            });
            let attempt = 0;

            const result = await gov.withRetry(async () => {
                attempt++;
                if (attempt < 3) {
                    throw new AzureRequestError(
                        "Too many requests",
                        429,
                        "TooManyRequests",
                        {}
                    );
                }
                return "success";
            });

            expect(result).toBe("success");
            expect(attempt).toBe(3);
            expect(gov.stats.retryCount).toBe(2);
            expect(gov.stats.throttleCount).toBe(2);
        });

        it("retries on 500, 502, 503 errors", async () => {
            const gov = new RequestGovernance({
                maxRetries: 2,
                baseBackoffMs: 1,
                jitterPct: 0,
                writeDelayMs: 0,
            });

            for (const status of [500, 502, 503]) {
                gov.resetStats();
                let attempt = 0;
                const result = await gov.withRetry(async () => {
                    attempt++;
                    if (attempt === 1) {
                        throw new AzureRequestError(
                            "Server error",
                            status,
                            "ServerError",
                            {}
                        );
                    }
                    return "ok";
                });
                expect(result).toBe("ok");
                expect(gov.stats.retryCount).toBe(1);
            }
        });

        it("does NOT retry 400 errors", async () => {
            const gov = new RequestGovernance({
                maxRetries: 3,
                baseBackoffMs: 1,
                writeDelayMs: 0,
            });

            await expect(
                gov.withRetry(async () => {
                    throw new AzureRequestError(
                        "Bad request",
                        400,
                        "BadRequest",
                        {}
                    );
                })
            ).rejects.toThrow("Bad request");
            expect(gov.stats.retryCount).toBe(0);
        });

        it("does NOT retry 403 errors", async () => {
            const gov = new RequestGovernance({
                maxRetries: 3,
                baseBackoffMs: 1,
                writeDelayMs: 0,
            });

            await expect(
                gov.withRetry(async () => {
                    throw new AzureRequestError(
                        "Forbidden",
                        403,
                        "Forbidden",
                        {}
                    );
                })
            ).rejects.toThrow("Forbidden");
            expect(gov.stats.retryCount).toBe(0);
        });

        it("does NOT retry 404 errors", async () => {
            const gov = new RequestGovernance({
                maxRetries: 3,
                baseBackoffMs: 1,
                writeDelayMs: 0,
            });

            await expect(
                gov.withRetry(async () => {
                    throw new AzureRequestError(
                        "Not found",
                        404,
                        "NotFound",
                        {}
                    );
                })
            ).rejects.toThrow("Not found");
            expect(gov.stats.retryCount).toBe(0);
        });

        it("retries on TypeError (network failure)", async () => {
            const gov = new RequestGovernance({
                maxRetries: 2,
                baseBackoffMs: 1,
                jitterPct: 0,
                writeDelayMs: 0,
            });
            let attempt = 0;

            const result = await gov.withRetry(async () => {
                attempt++;
                if (attempt === 1) {
                    throw new TypeError("Failed to fetch");
                }
                return "recovered";
            });

            expect(result).toBe("recovered");
            expect(gov.stats.retryCount).toBe(1);
        });

        it("gives up after maxRetries", async () => {
            const gov = new RequestGovernance({
                maxRetries: 2,
                baseBackoffMs: 1,
                jitterPct: 0,
                writeDelayMs: 0,
            });

            await expect(
                gov.withRetry(async () => {
                    throw new AzureRequestError(
                        "Server error",
                        500,
                        "InternalError",
                        {}
                    );
                })
            ).rejects.toThrow("Server error");
            expect(gov.stats.retryCount).toBe(2);
        });

        it("invokes onThrottle callback on 429", async () => {
            const throttleEvents: Array<{ status: number; attempt: number }> =
                [];
            const gov = new RequestGovernance({
                maxRetries: 2,
                baseBackoffMs: 1,
                jitterPct: 0,
                writeDelayMs: 0,
                onThrottle: (info) =>
                    throttleEvents.push({
                        status: info.status,
                        attempt: info.attempt,
                    }),
            });

            let attempt = 0;
            await gov.withRetry(async () => {
                attempt++;
                if (attempt <= 2) {
                    throw new AzureRequestError(
                        "Throttled",
                        429,
                        "TooManyRequests",
                        {}
                    );
                }
                return "ok";
            });

            expect(throttleEvents).toHaveLength(2);
            expect(throttleEvents[0]).toEqual({ status: 429, attempt: 1 });
            expect(throttleEvents[1]).toEqual({ status: 429, attempt: 2 });
        });
    });

    // -----------------------------------------------------------------------
    // Stats
    // -----------------------------------------------------------------------

    describe("stats", () => {
        it("returns correct initial stats", () => {
            const gov = new RequestGovernance();
            const stats = gov.stats;
            expect(stats).toEqual({
                totalReads: 0,
                totalWrites: 0,
                deduplicatedReads: 0,
                retryCount: 0,
                throttleCount: 0,
                lastThrottleAt: null,
            });
        });

        it("returns a snapshot (not a live reference)", () => {
            const gov = new RequestGovernance();
            const snap1 = gov.stats;
            // Mutating the snapshot should not affect internal state
            (snap1 as GovernanceStats).totalReads = 999;
            expect(gov.stats.totalReads).toBe(0);
        });

        it("resets stats correctly", async () => {
            const gov = new RequestGovernance({
                baseBackoffMs: 1,
                writeDelayMs: 0,
            });
            await gov.read("k", async () => 1);
            await gov.write(async () => 2);
            expect(gov.stats.totalReads).toBe(1);
            expect(gov.stats.totalWrites).toBe(1);

            gov.resetStats();

            expect(gov.stats).toEqual({
                totalReads: 0,
                totalWrites: 0,
                deduplicatedReads: 0,
                retryCount: 0,
                throttleCount: 0,
                lastThrottleAt: null,
            });
        });
    });
});
