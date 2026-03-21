import { RequestScheduler, RequestSchedulerQueueOverflowError } from "./request-scheduler";

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe("RequestScheduler", () => {
    function createScheduler(overrides: any = {}) {
        const SchedulerCtor: any = RequestScheduler as any;
        return new SchedulerCtor({
            concurrency: 1,
            delayMs: 0,
            retryAttempts: 5,
            retryBackoffSeconds: [0, 0, 0, 0, 0],
            jitterPct: 0,
            maxQueueSize: 100,
            ...overrides,
        });
    }

    it("enforces global concurrency", async () => {
        const scheduler: any = createScheduler({ concurrency: 1 });

        let active = 0;
        let maxActive = 0;
        const runTask = async () => scheduler.run("account-a", async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await delay(15);
            active--;
            return true;
        });

        await Promise.all([runTask(), runTask(), runTask()]);
        expect(maxActive).toBe(1);
    });

    it("serializes operations with the same key", async () => {
        const scheduler: any = createScheduler({ concurrency: 3 });

        let sameKeyActive = 0;
        let sameKeyMax = 0;

        const runTask = async () => scheduler.run("shared-account", async () => {
            sameKeyActive++;
            sameKeyMax = Math.max(sameKeyMax, sameKeyActive);
            await delay(10);
            sameKeyActive--;
            return true;
        });

        await Promise.all([runTask(), runTask(), runTask()]);
        expect(sameKeyMax).toBe(1);
    });

    it("retries transient throttling errors", async () => {
        const scheduler: any = createScheduler({
            retryAttempts: 3,
            retryBackoffSeconds: [0, 0, 0],
        });
        let attempts = 0;

        const result = await scheduler.run("account-a", async () => {
            attempts++;
            if (attempts < 3) {
                const error: any = new Error("throttled");
                error.status = 429;
                throw error;
            }
            return "ok";
        });

        expect(result).toBe("ok");
        expect(attempts).toBe(3);
    });

    it("honors Retry-After header when present", async () => {
        const delays: number[] = [];
        const scheduler: any = createScheduler({
            retryAttempts: 1,
            retryBackoffSeconds: [0],
            sleep: async (ms: number) => {
                delays.push(ms);
            },
        });
        let attempts = 0;

        await scheduler.run("account-a", async () => {
            attempts++;
            if (attempts === 1) {
                const error: any = new Error("throttled");
                error.status = 429;
                error.headers = {
                    get: (name: string) => name.toLowerCase() === "retry-after" ? "2" : null,
                };
                throw error;
            }
            return "ok";
        });

        expect(delays.length).toBe(1);
        expect(delays[0]).toBe(2000);
    });

    it("applies exponential backoff with jitter", async () => {
        const delays: number[] = [];
        const scheduler: any = createScheduler({
            retryAttempts: 1,
            retryBackoffSeconds: [2],
            jitterPct: 0.2,
            random: () => 1,
            sleep: async (ms: number) => {
                delays.push(ms);
            },
        });
        let attempts = 0;

        await scheduler.run("account-a", async () => {
            attempts++;
            if (attempts === 1) {
                const error: any = new Error("transient");
                error.status = 503;
                throw error;
            }
            return "ok";
        });

        expect(delays.length).toBe(1);
        expect(delays[0]).toBe(2400);
    });

    it("uses Retry-After date when it is larger than computed backoff", async () => {
        const delays: number[] = [];
        const now = Date.parse("2026-01-01T00:00:00.000Z");
        const retryAt = new Date(now + 5000).toUTCString();
        const scheduler: any = createScheduler({
            retryAttempts: 1,
            retryBackoffSeconds: [2],
            jitterPct: 0,
            now: () => now,
            sleep: async (ms: number) => {
                delays.push(ms);
            },
        });
        let attempts = 0;

        await scheduler.run("account-a", async () => {
            attempts++;
            if (attempts === 1) {
                const error: any = new Error("throttled");
                error.status = 429;
                error.headers = {
                    get: (name: string) => name.toLowerCase() === "retry-after" ? retryAt : null,
                };
                throw error;
            }
            return "ok";
        });

        expect(delays.length).toBe(1);
        expect(delays[0]).toBe(5000);
    });

    it("does not retry fatal 4xx errors", async () => {
        const scheduler: any = createScheduler({
            retryAttempts: 3,
            retryBackoffSeconds: [0, 0, 0],
        });
        let attempts = 0;
        const error: any = new Error("bad request");
        error.status = 400;
        const promise = scheduler.run("account-a", async () => {
            attempts++;
            throw error;
        });
        await expectAsync(promise).toBeRejected();

        expect(attempts).toBe(1);
    });

    it("applies global pacing between scheduled starts", async () => {
        let now = 0;
        const delays: number[] = [];
        const scheduler: any = createScheduler({
            concurrency: 2,
            delayMs: 50,
            now: () => now,
            sleep: async (ms: number) => {
                delays.push(ms);
                now += ms;
            },
        });

        await Promise.all([
            scheduler.run("account-a", async () => {
                return true;
            }),
            scheduler.run("account-b", async () => {
                return true;
            }),
        ]);

        expect(delays).toEqual([50]);
    });

    it("rejects new work when queue capacity is reached", async () => {
        let release: () => void;
        const blocker = new Promise<void>((resolve) => {
            release = resolve;
        });

        const scheduler: any = createScheduler({
            concurrency: 1,
            maxQueueSize: 2,
        });

        const first = scheduler.run("a", async () => {
            await blocker;
            return "first";
        });
        const second = scheduler.run("b", async () => "second");
        const thirdPromise = scheduler.run("c", async () => "third");

        await expectAsync(thirdPromise).toBeRejectedWithError(RequestSchedulerQueueOverflowError);

        release!();
        await Promise.all([first, second]);
    });
});
