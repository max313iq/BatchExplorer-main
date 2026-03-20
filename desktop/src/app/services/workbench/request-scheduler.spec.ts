import { RequestScheduler } from "./request-scheduler";

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
            backoffSeconds: [0, 0, 0, 0, 0],
            jitterPct: 0,
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
            backoffSeconds: [0, 0, 0],
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
});
