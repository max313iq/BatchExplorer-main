/**
 * GPU Calculator page — what-if speed/cost scenarios over the GPU catalogue
 * plus a live read-out of GPUs across active pools, region by region.
 *
 * Every user input flows through the URL so refreshing or sharing a link
 * preserves the full scenario (per Design Contract §4.3). On top of that:
 *
 *   - Workload PRESETS for common shapes (quick benchmark, inference, small /
 *     medium / large training) one-click seed the form.
 *   - Named SAVED scenarios persist to localStorage so an operator can park
 *     a frequently-recomputed configuration and recall it later.
 *   - EXPORT menu dumps the scenario + per-region rollup as CSV or JSON.
 *   - "Copy link" button puts a fully-qualified shareable URL on the
 *     clipboard.
 *   - RECOMMENDATION card highlights the cheapest VM that hits a target
 *     speed and the cheapest VM-per-GPU-count combo.
 *   - Side-by-side compare supports up to THREE scenarios (A/B/C) with
 *     DELTAS (Δ speed, Δ $, Δ %) measured against scenario A.
 *   - HOTKEYS: `c` copies the formatted summary, `s` saves scenario A,
 *     `1` enables 1-way (A only), `2` adds B, `3` adds C. The shortcuts
 *     ignore key presses fired from inside an input / select / textarea so
 *     typing a count of "2" never trips the compare hotkey.
 *   - JSON IMPORT: paste a previously-exported scenario list back into the
 *     saved-scenarios dropdown to round-trip via clipboard.
 *   - Cost breakdown panel exposes the FORMULA used so the number is
 *     auditable.
 *   - InfoTooltips on every non-obvious metric, plus a "What is Mnos/s?"
 *     glossary tooltip on the speed-settings card.
 *   - A reverse-calc input: "How long would N billion node-evaluations
 *     take?" — turn target work into hours-needed at the current scenario.
 *   - "Reset all" wipes URL state + saved validation back to defaults.
 *   - All numeric inputs are NaN- and bound-guarded (count ≤10000,
 *     hours ≤8760, target-work ≤1e9 Gnos).
 *
 * Deviation: Contract task asks for an "A100" empty-state default, but the
 * VM-size catalogue (vm-sizes.ts) only ships H100 and V100. We default the
 * empty-state action to H100 (the highest-perf entry available) so the
 * button picks a real, resolvable GPU type.
 */
import * as React from "react";
export declare const GpuCalculatorPage: React.FC;
//# sourceMappingURL=gpu-calculator-page.d.ts.map