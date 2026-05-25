/**
 * Unit tests for pool-defaults.ts
 *
 * Covers:
 *   - INITIAL_POOL_DEFAULTS shape sanity.
 *   - loadPoolDefaults / savePoolDefaults / resetPoolDefaults round-trip and
 *     edge cases (missing key, malformed JSON, partial data, localStorage
 *     failures).
 *   - buildPoolConfigFromDefaults: id generation, override application,
 *     fixed vs autoscale branching, optional sections (start task, metadata,
 *     user accounts, network), and conditional pruning.
 */

import {
    INITIAL_POOL_DEFAULTS,
    PoolDefaults,
    buildPoolConfigFromDefaults,
    loadPoolDefaults,
    resetPoolDefaults,
    savePoolDefaults,
} from "../pool-defaults";

const STORAGE_KEY = "batch-pool-defaults";

// Helper: deep-clone INITIAL_POOL_DEFAULTS so individual tests cannot mutate
// the exported singleton (a common subtle source of cross-test pollution).
function cloneInitial(): PoolDefaults {
    return JSON.parse(JSON.stringify(INITIAL_POOL_DEFAULTS)) as PoolDefaults;
}

describe("pool-defaults", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    // ------------------------------------------------------------------
    // INITIAL_POOL_DEFAULTS — sanity / shape
    // ------------------------------------------------------------------

    describe("INITIAL_POOL_DEFAULTS", () => {
        it("has the expected top-level fields", () => {
            expect(INITIAL_POOL_DEFAULTS.poolIdPrefix).toBe("pool");
            expect(INITIAL_POOL_DEFAULTS.displayName).toBe("");
            expect(INITIAL_POOL_DEFAULTS.scaleType).toBe("fixed");
            expect(INITIAL_POOL_DEFAULTS.targetDedicatedNodes).toBe(0);
            expect(INITIAL_POOL_DEFAULTS.targetLowPriorityNodes).toBe(0);
            expect(INITIAL_POOL_DEFAULTS.resizeTimeoutMinutes).toBe(15);
            expect(INITIAL_POOL_DEFAULTS.autoScaleEvaluationInterval).toBe(
                "PT5M",
            );
            expect(INITIAL_POOL_DEFAULTS.osCategory).toBe("linux");
            expect(INITIAL_POOL_DEFAULTS.vmSize).toBe("standard_nd40rs_v2");
            expect(INITIAL_POOL_DEFAULTS.taskSlotsPerNode).toBe(1);
            expect(INITIAL_POOL_DEFAULTS.enableInterNodeCommunication).toBe(
                false,
            );
            expect(INITIAL_POOL_DEFAULTS.taskSchedulingPolicy).toBe("Pack");
            expect(INITIAL_POOL_DEFAULTS.subnetId).toBe("");
        });

        it("has a fully populated VM image reference", () => {
            const img = INITIAL_POOL_DEFAULTS.virtualMachineConfiguration;
            expect(img.nodeAgentSKUId).toBe("batch.node.ubuntu 22.04");
            expect(img.imageReference.publisher).toBe("canonical");
            expect(img.imageReference.offer).toBe(
                "0001-com-ubuntu-server-jammy",
            );
            expect(img.imageReference.sku).toBe("22_04-lts-gen2");
            expect(img.imageReference.version).toBe("latest");
        });

        it("starts with an admin pool-scoped start task", () => {
            const st = INITIAL_POOL_DEFAULTS.startTask;
            expect(st.commandLine).toContain("echo Hello");
            expect(st.maxTaskRetryCount).toBe(3);
            expect(st.waitForSuccess).toBe(true);
            expect(st.userIdentity.autoUser.scope).toBe("pool");
            expect(st.userIdentity.autoUser.elevationLevel).toBe("admin");
            expect(st.environmentSettings).toEqual([]);
            expect(st.resourceFiles).toEqual([]);
        });

        it("has empty metadata and user-account collections", () => {
            expect(INITIAL_POOL_DEFAULTS.metadata).toEqual([]);
            expect(INITIAL_POOL_DEFAULTS.userAccounts).toEqual([]);
        });
    });

    // ------------------------------------------------------------------
    // loadPoolDefaults
    // ------------------------------------------------------------------

    describe("loadPoolDefaults", () => {
        it("returns a fresh copy of INITIAL_POOL_DEFAULTS when storage is empty", () => {
            const loaded = loadPoolDefaults();
            expect(loaded).toEqual(INITIAL_POOL_DEFAULTS);
            // Must be a copy, not the same reference (avoid mutation of the
            // exported singleton).
            expect(loaded).not.toBe(INITIAL_POOL_DEFAULTS);
        });

        it("merges partial persisted data with defaults so new fields stay populated", () => {
            const partial = {
                poolIdPrefix: "myprefix",
                vmSize: "standard_d2_v3",
                // intentionally omit every other field
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(partial));

            const loaded = loadPoolDefaults();
            expect(loaded.poolIdPrefix).toBe("myprefix");
            expect(loaded.vmSize).toBe("standard_d2_v3");
            // Untouched fields fall back to defaults
            expect(loaded.scaleType).toBe(INITIAL_POOL_DEFAULTS.scaleType);
            expect(loaded.taskSchedulingPolicy).toBe(
                INITIAL_POOL_DEFAULTS.taskSchedulingPolicy,
            );
            expect(loaded.startTask).toEqual(INITIAL_POOL_DEFAULTS.startTask);
        });

        it("falls back to defaults when JSON is malformed", () => {
            localStorage.setItem(STORAGE_KEY, "{not valid json");
            expect(loadPoolDefaults()).toEqual(INITIAL_POOL_DEFAULTS);
        });

        it("falls back to defaults when localStorage.getItem throws", () => {
            const spy = jest
                .spyOn(Storage.prototype, "getItem")
                .mockImplementation(() => {
                    throw new Error("storage unavailable");
                });
            try {
                expect(loadPoolDefaults()).toEqual(INITIAL_POOL_DEFAULTS);
            } finally {
                spy.mockRestore();
            }
        });
    });

    // ------------------------------------------------------------------
    // savePoolDefaults / resetPoolDefaults — round trip
    // ------------------------------------------------------------------

    describe("save + load round trip", () => {
        it("persists and rehydrates a fully customized PoolDefaults", () => {
            const customized: PoolDefaults = {
                ...cloneInitial(),
                poolIdPrefix: "research",
                displayName: "Research Pool",
                scaleType: "autoscale",
                targetDedicatedNodes: 4,
                targetLowPriorityNodes: 2,
                resizeTimeoutMinutes: 30,
                autoScaleFormula: "$TargetDedicatedNodes = 8;",
                autoScaleEvaluationInterval: "PT15M",
                osCategory: "windows",
                vmSize: "standard_d4_v3",
                taskSlotsPerNode: 4,
                enableInterNodeCommunication: true,
                taskSchedulingPolicy: "Spread",
                metadata: [{ name: "team", value: "research" }],
                userAccounts: [
                    { name: "dev", password: "x", elevationLevel: "admin" },
                ],
                subnetId: "/subscriptions/x/resourceGroups/y",
            };

            savePoolDefaults(customized);
            const round = loadPoolDefaults();
            expect(round).toEqual(customized);
        });

        it("resetPoolDefaults clears storage and returns defaults", () => {
            savePoolDefaults({ ...cloneInitial(), poolIdPrefix: "tmp" });
            expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

            const back = resetPoolDefaults();
            expect(back).toEqual(INITIAL_POOL_DEFAULTS);
            expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        });

        it("savePoolDefaults silently swallows localStorage failures", () => {
            const spy = jest
                .spyOn(Storage.prototype, "setItem")
                .mockImplementation(() => {
                    throw new Error("QuotaExceeded");
                });
            try {
                expect(() =>
                    savePoolDefaults(cloneInitial()),
                ).not.toThrow();
            } finally {
                spy.mockRestore();
            }
        });
    });

    // ------------------------------------------------------------------
    // buildPoolConfigFromDefaults
    // ------------------------------------------------------------------

    describe("buildPoolConfigFromDefaults", () => {
        it("returns a fixed-scale config from INITIAL defaults with no overrides", () => {
            const before = Date.now();
            const cfg = buildPoolConfigFromDefaults(cloneInitial());
            const after = Date.now();

            // ID is auto-generated as `${prefix}-${ts}`
            expect(cfg.id).toMatch(/^pool-\d+$/);
            const ts = Number(String(cfg.id).split("-")[1]);
            expect(ts).toBeGreaterThanOrEqual(before);
            expect(ts).toBeLessThanOrEqual(after);

            // Empty displayName collapses to undefined
            expect(cfg.displayName).toBeUndefined();

            // Scale defaults to fixed
            expect(cfg.enableAutoScale).toBe(false);
            expect(cfg.targetDedicatedNodes).toBe(0);
            expect(cfg.targetLowPriorityNodes).toBe(0);
            expect(cfg.autoScaleFormula).toBeUndefined();
            expect(cfg.autoScaleEvaluationInterval).toBeUndefined();

            // resizeTimeout is constructed from minutes
            expect(cfg.resizeTimeout).toBe("PT15M");

            // taskSchedulingPolicy is wrapped with nodeFillType
            expect(cfg.taskSchedulingPolicy).toEqual({ nodeFillType: "Pack" });

            // VM config and size pulled straight from defaults
            expect(cfg.vmSize).toBe(INITIAL_POOL_DEFAULTS.vmSize);
            expect(cfg.virtualMachineConfiguration).toBe(
                cloneInitial().virtualMachineConfiguration === undefined
                    ? cfg.virtualMachineConfiguration
                    : cfg.virtualMachineConfiguration,
            );

            // Start task is included because default commandLine is non-empty
            expect(cfg.startTask).toBeDefined();
            const st = cfg.startTask as Record<string, unknown>;
            expect(st.commandLine).toBe(
                INITIAL_POOL_DEFAULTS.startTask.commandLine,
            );
            expect(st.maxTaskRetryCount).toBe(3);
            expect(st.waitForSuccess).toBe(true);
            // Empty arrays are omitted from the start task
            expect(st.environmentSettings).toBeUndefined();
            expect(st.resourceFiles).toBeUndefined();

            // Optional sections are absent when their source arrays/strings are empty
            expect(cfg.metadata).toBeUndefined();
            expect(cfg.userAccounts).toBeUndefined();
            expect(cfg.networkConfiguration).toBeUndefined();
        });

        it("applies overrides for id, vmSize and node counts", () => {
            const cfg = buildPoolConfigFromDefaults(cloneInitial(), {
                id: "explicit-id",
                vmSize: "override_size",
                targetDedicatedNodes: 10,
                targetLowPriorityNodes: 5,
            });
            expect(cfg.id).toBe("explicit-id");
            expect(cfg.vmSize).toBe("override_size");
            expect(cfg.targetDedicatedNodes).toBe(10);
            expect(cfg.targetLowPriorityNodes).toBe(5);
        });

        it("emits autoscale fields and strips target node counts in autoscale mode", () => {
            const defs = cloneInitial();
            defs.scaleType = "autoscale";
            defs.autoScaleFormula = "$TargetDedicatedNodes = 3;";
            defs.autoScaleEvaluationInterval = "PT10M";

            const cfg = buildPoolConfigFromDefaults(defs, {
                targetDedicatedNodes: 99,
                targetLowPriorityNodes: 99,
            });

            expect(cfg.enableAutoScale).toBe(true);
            expect(cfg.autoScaleFormula).toBe("$TargetDedicatedNodes = 3;");
            expect(cfg.autoScaleEvaluationInterval).toBe("PT10M");
            // Even though overrides set them, they are deleted afterwards
            expect("targetDedicatedNodes" in cfg).toBe(false);
            expect("targetLowPriorityNodes" in cfg).toBe(false);
        });

        it("populates displayName when non-empty", () => {
            const defs = cloneInitial();
            defs.displayName = "My Cool Pool";
            const cfg = buildPoolConfigFromDefaults(defs);
            expect(cfg.displayName).toBe("My Cool Pool");
        });

        it("omits the start task when commandLine is blank/whitespace", () => {
            const defs = cloneInitial();
            defs.startTask.commandLine = "    ";
            const cfg = buildPoolConfigFromDefaults(defs);
            expect(cfg.startTask).toBeUndefined();
        });

        it("includes environmentSettings and resourceFiles only when non-empty", () => {
            const defs = cloneInitial();
            defs.startTask.environmentSettings = [
                { name: "FOO", value: "BAR" },
            ];
            defs.startTask.resourceFiles = [
                { httpUrl: "https://example.com/x.sh", filePath: "x.sh" },
            ];

            const cfg = buildPoolConfigFromDefaults(defs);
            const st = cfg.startTask as Record<string, unknown>;
            expect(st.environmentSettings).toEqual([
                { name: "FOO", value: "BAR" },
            ]);
            expect(st.resourceFiles).toEqual([
                { httpUrl: "https://example.com/x.sh", filePath: "x.sh" },
            ]);
        });

        it("includes metadata and userAccounts only when non-empty", () => {
            const defs = cloneInitial();
            defs.metadata = [{ name: "team", value: "ml" }];
            defs.userAccounts = [
                { name: "alice", password: "p", elevationLevel: "nonadmin" },
            ];
            const cfg = buildPoolConfigFromDefaults(defs);
            expect(cfg.metadata).toEqual([{ name: "team", value: "ml" }]);
            expect(cfg.userAccounts).toEqual([
                { name: "alice", password: "p", elevationLevel: "nonadmin" },
            ]);
        });

        it("attaches networkConfiguration when subnetId is set", () => {
            const defs = cloneInitial();
            defs.subnetId =
                "/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v/subnets/s";
            const cfg = buildPoolConfigFromDefaults(defs);
            expect(cfg.networkConfiguration).toEqual({
                subnetId: defs.subnetId,
            });
        });

        it("computes resizeTimeout correctly for non-default minutes", () => {
            const defs = cloneInitial();
            defs.resizeTimeoutMinutes = 45;
            const cfg = buildPoolConfigFromDefaults(defs);
            expect(cfg.resizeTimeout).toBe("PT45M");
        });

        it("propagates Spread scheduling policy", () => {
            const defs = cloneInitial();
            defs.taskSchedulingPolicy = "Spread";
            const cfg = buildPoolConfigFromDefaults(defs);
            expect(cfg.taskSchedulingPolicy).toEqual({
                nodeFillType: "Spread",
            });
        });
    });
});
