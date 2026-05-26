/**
 * Audience Matrix — corpus-grounded reachability table.
 *
 * What this is
 * ------------
 * A small, READ-ONLY companion table that surfaces the static FOCI reachability
 * map from `audience-matrix-corpus.ts`:
 *
 *   For each AUDIENCE_COLUMNS key, which annotated FOCI clients are known
 *   to tokenize for that audience (per
 *   `dirkjanm/family-of-client-ids-research/scope-map.txt` and
 *   `dafthack/azure-ad-first-party-apps-permissions/README.md`)?
 *
 * The matrix already shows OBSERVED reachability ("did mint X succeed for
 * row Y"). This table shows the PREDICTED reachability ("which family members
 * are known to mint to this audience"). Together they answer:
 *
 *   - "Why does my Azure CLI RT mint Graph?"   → because Azure CLI is on the
 *      Graph-reaching list (annotation; visible here).
 *   - "Why didn't my Outlook Mobile RT mint ARM?" → because Outlook Mobile is
 *      NOT on the ARM-reaching list (annotation; visible here).
 *
 * Hardening notes
 * ---------------
 * - Pure render. No fetch, no token material. The corpus data is frozen
 *   at module load by `audience-matrix-corpus.ts`.
 * - Collapsed-by-default (operator dismisses noisy detail). Open state is
 *   persisted via `usePersistedState` so the choice survives reload.
 *
 * Corpus citations
 * ----------------
 * - `_AZURE_LOGIN_METHODS.md` §FOCI
 * - `_analysis_dirkjanm.md` §FOCI
 * - `dirkjanm/family-of-client-ids-research/scope-map.txt`
 * - `dafthack/azure-ad-first-party-apps-permissions/README.md`
 */
import * as React from "react";
import { ChevronDown, ChevronRight, Layers, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { AUDIENCE_TO_FOCI_CLIENTS, fociClientsReachingAudience, getAudienceRisk, tierShort, tierTextClass, } from "./audience-matrix-corpus";
import { AUDIENCE_COLUMNS } from "./audience-matrix-helpers";
const STORAGE_KEY = "audience-matrix.reachability.open";
/**
 * Defender-facing static reachability table. Read-only. Highlights rows for
 * the currently focused FOCI client when provided.
 */
export const AudienceReachabilityTable = ({ highlightClientId }) => {
    var _a;
    const [open, setOpen] = usePersistedState(STORAGE_KEY, false);
    // Normalise once — `highlightClientId` is operator-supplied (it comes
    // from the focused row); lowercase + trim defends against case skew.
    const focus = (_a = highlightClientId === null || highlightClientId === void 0 ? void 0 : highlightClientId.trim().toLowerCase()) !== null && _a !== void 0 ? _a : "";
    // Pre-compute, per audience column key:
    //   - the annotated FOCI clients reaching it (frozen array from the corpus
    //     module),
    //   - a boolean "does the focused client appear here", and
    //   - the count badge.
    const rows = React.useMemo(() => {
        return AUDIENCE_COLUMNS.map((col) => {
            var _a;
            const clients = (_a = AUDIENCE_TO_FOCI_CLIENTS[col.key]) !== null && _a !== void 0 ? _a : [];
            const hit = focus
                ? clients.some((c) => c.id.toLowerCase() === focus)
                : false;
            return {
                key: col.key,
                short: col.short,
                clients,
                hit,
                count: fociClientsReachingAudience(col.key),
                risk: getAudienceRisk(col.key),
            };
        });
    }, [focus]);
    // Summary line — count of audiences with at least one annotated reach.
    const annotatedCount = React.useMemo(() => rows.filter((r) => r.count > 0).length, [rows]);
    return (React.createElement(Card, null,
        React.createElement(CardContent, { className: "p-3" },
            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                React.createElement(Button, { type: "button", size: "sm", variant: "ghost", onClick: () => setOpen(!open), "aria-expanded": open, "aria-controls": "audience-reachability-body", className: "gap-1 px-1" },
                    open ? (React.createElement(ChevronDown, { className: "h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(ChevronRight, { className: "h-3.5 w-3.5", "aria-hidden": true })),
                    React.createElement(ShieldCheck, { className: "h-3.5 w-3.5 text-info", "aria-hidden": true }),
                    React.createElement("span", { className: "text-xs font-semibold" }, "Audience reachability (annotated)")),
                React.createElement(Badge, { variant: "outline", className: "text-3xs" },
                    annotatedCount,
                    "/",
                    AUDIENCE_COLUMNS.length,
                    " audiences with annotated reach"),
                React.createElement("span", { className: "text-3xs text-muted-foreground" },
                    "Source:",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "dirkjanm/family-of-client-ids-research/scope-map.txt"),
                    " ",
                    "+",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "dafthack/azure-ad-first-party-apps-permissions")),
                focus && (React.createElement(Badge, { variant: "info", className: "ml-auto text-3xs" },
                    "Focused on client ",
                    focus.slice(0, 8),
                    "\u2026"))),
            open && (React.createElement("div", { id: "audience-reachability-body", className: "mt-3 overflow-x-auto" },
                React.createElement("table", { className: "w-full border-separate border-spacing-0 text-2xs" },
                    React.createElement("thead", null,
                        React.createElement("tr", null,
                            React.createElement("th", { scope: "col", className: "border-b px-2 py-1 text-left font-semibold uppercase tracking-wider text-muted-foreground" }, "Audience"),
                            React.createElement("th", { scope: "col", className: "border-b px-2 py-1 text-left font-semibold uppercase tracking-wider text-muted-foreground" }, "Risk"),
                            React.createElement("th", { scope: "col", className: "border-b px-2 py-1 text-left font-semibold uppercase tracking-wider text-muted-foreground" }, "Annotated FOCI clients that reach it"))),
                    React.createElement("tbody", null, rows.map((r) => (React.createElement("tr", { key: r.key, className: r.hit
                            ? "bg-warning/10"
                            : focus
                                ? "opacity-50"
                                : "" },
                        React.createElement("th", { scope: "row", className: "border-b px-2 py-1 text-left align-top font-mono" }, r.short),
                        React.createElement("td", { className: "border-b px-2 py-1 align-top" },
                            React.createElement(Tooltip, null,
                                React.createElement(TooltipTrigger, { asChild: true },
                                    React.createElement("span", { className: `inline-flex h-4 items-center rounded bg-muted/40 px-1 font-mono leading-none ${tierTextClass(r.risk.tier)}`, "aria-label": `Risk: ${r.risk.tier}` }, tierShort(r.risk.tier))),
                                React.createElement(TooltipContent, null,
                                    React.createElement("p", { className: "m-0 max-w-xs text-xs" }, r.risk.rationale)))),
                        React.createElement("td", { className: "border-b px-2 py-1 align-top" }, r.clients.length === 0 ? (React.createElement("span", { className: "text-muted-foreground" }, "(uncalibrated \u2014 annotated profile set does not list a reach here)")) : (React.createElement("div", { className: "flex flex-wrap gap-1" }, r.clients.map((c) => (React.createElement(Tooltip, { key: c.id },
                            React.createElement(TooltipTrigger, { asChild: true },
                                React.createElement(Badge, { variant: focus && c.id.toLowerCase() === focus
                                        ? "warning"
                                        : "outline", className: "font-mono text-3xs" },
                                    React.createElement(Layers, { className: "h-2.5 w-2.5", "aria-hidden": true }),
                                    c.name)),
                            React.createElement(TooltipContent, null,
                                React.createElement("p", { className: "m-0 font-mono text-3xs" }, c.id),
                                React.createElement("p", { className: "m-0 text-3xs text-muted-foreground" },
                                    "Reaches ",
                                    r.key,
                                    " per scope-map.txt"))))))))))))))))));
};
//# sourceMappingURL=audience-matrix-reachability.js.map