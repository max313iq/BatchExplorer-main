import { take } from "rxjs/operators";
import { MainConfigurationStore } from "./main-configuration-store";

describe("MainConfigurationStore compatibility", () => {
    function createStorage(initialValue: any) {
        return {
            get: jasmine.createSpy("get").and.resolveTo(initialValue),
            set: jasmine.createSpy("set").and.resolveTo(undefined),
        };
    }

    async function loadMergedConfig(userConfig: any) {
        const storage = createStorage(userConfig);
        const store = new MainConfigurationStore<any>(storage as any);
        const merged = await store.config.pipe(take(1)).toPromise();
        return { merged, storage };
    }

    it("keeps backward compatible defaults when settings are missing", async () => {
        const { merged } = await loadMergedConfig({
            theme: "classic",
            features: {
                poolControlWorkbench: true,
            },
        });

        expect(merged.features.poolControlWorkbench).toBe(true);
        expect(merged.features.multiRegionPoolBootstrap).toBe(false);
        expect(merged.poolControlWorkbench.throttling.retryAttempts).toBe(5);
        expect(merged.poolControlWorkbench.throttling.retryBackoffSeconds).toEqual([2, 4, 8, 16, 32]);
        expect(merged.poolControlWorkbench.throttling.delayMs).toBe(250);
        expect(merged.poolControlWorkbench.throttling.delayMsBetweenRequests).toBe(250);
    });

    it("maps legacy delayMsBetweenRequests into delayMs", async () => {
        const { merged } = await loadMergedConfig({
            poolControlWorkbench: {
                throttling: {
                    delayMsBetweenRequests: 900,
                },
            },
        });

        expect(merged.poolControlWorkbench.throttling.delayMs).toBe(900);
        expect(merged.poolControlWorkbench.throttling.delayMsBetweenRequests).toBe(900);
    });

    it("prefers explicit delayMs when both old and new keys exist", async () => {
        const { merged } = await loadMergedConfig({
            poolControlWorkbench: {
                throttling: {
                    delayMs: 450,
                    delayMsBetweenRequests: 900,
                },
            },
        });

        expect(merged.poolControlWorkbench.throttling.delayMs).toBe(450);
        expect(merged.poolControlWorkbench.throttling.delayMsBetweenRequests).toBe(450);
    });
});
