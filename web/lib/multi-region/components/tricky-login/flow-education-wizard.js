/**
 * Flow-education wizard — "Why are you using this flow?" dialog.
 *
 * Pure educational surface. Triggered from the method-picker card; opens
 * a dialog showing one entry per flow with:
 *   - What it does (operator-facing)
 *   - When to use it
 *   - Defensive vs offensive framing
 *   - Wire-shape headline (mitmproxy-eye-view)
 *   - Corpus playbook + source reference
 *
 * NO side effects beyond a local "current entry" selector. NO mint. NO
 * token material exposed (the wizard is metadata-only by construction —
 * the FLOW_EDUCATION data lives in corpus-advisories.ts and is static).
 */
import * as React from "react";
import { BookOpen, ChevronLeft, ChevronRight, ExternalLink, Info, Sparkles, X, Zap, Repeat2, } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { FLOW_EDUCATION } from "./corpus-advisories";
const METHOD_ICON = {
    "msal-silent": Repeat2,
    "foci-exchange": Zap,
    auto: Sparkles,
};
/**
 * Tabbed wizard dialog. Each tab is one of the three flows; the body
 * renders the entry's static fields and the corpus citation. Keyboard:
 * Esc closes (Radix default), Left/Right arrows step entries.
 */
export const FlowEducationWizard = ({ open, onOpenChange, initialMethod, }) => {
    var _a, _b;
    // Selected entry index — defaults to the initial method.
    const initialIndex = React.useMemo(() => {
        if (!initialMethod)
            return 0;
        const idx = FLOW_EDUCATION.findIndex((e) => e.method === initialMethod);
        return idx >= 0 ? idx : 0;
    }, [initialMethod]);
    const [index, setIndex] = React.useState(initialIndex);
    // Reset to the initial index whenever the dialog re-opens.
    React.useEffect(() => {
        if (open)
            setIndex(initialIndex);
    }, [open, initialIndex]);
    // Arrow-key navigation within the open dialog. Bound on the dialog
    // content's keydown so we don't capture global key events.
    const handleContentKeyDown = React.useCallback((e) => {
        if (e.key === "ArrowRight") {
            e.preventDefault();
            setIndex((i) => (i + 1) % FLOW_EDUCATION.length);
        }
        else if (e.key === "ArrowLeft") {
            e.preventDefault();
            setIndex((i) => (i - 1 + FLOW_EDUCATION.length) % FLOW_EDUCATION.length);
        }
    }, []);
    const entry = FLOW_EDUCATION[index];
    const EntryIcon = (_b = METHOD_ICON[(_a = entry === null || entry === void 0 ? void 0 : entry.method) !== null && _a !== void 0 ? _a : "auto"]) !== null && _b !== void 0 ? _b : Sparkles;
    return (React.createElement(Dialog, { open: open, onOpenChange: onOpenChange },
        React.createElement(DialogContent, { className: "max-w-2xl", onKeyDown: handleContentKeyDown, "aria-describedby": "flow-education-description" },
            React.createElement(DialogHeader, null,
                React.createElement(DialogTitle, { className: "flex items-center gap-2 text-base" },
                    React.createElement(BookOpen, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                    "Why are you using this flow?"),
                React.createElement(DialogDescription, { id: "flow-education-description" }, "Operator-education guide for the three Tricky Login flows. Each entry includes the on-the-wire shape and a citation to the authoritative corpus playbook so you can read the source code yourself.")),
            React.createElement("div", { className: "flex gap-2 border-b pb-2", role: "tablist", "aria-label": "Flow education tabs" }, FLOW_EDUCATION.map((e, i) => {
                const Icon = METHOD_ICON[e.method];
                const selected = i === index;
                return (React.createElement("button", { key: e.method, type: "button", role: "tab", "aria-selected": selected, "aria-controls": `flow-edu-panel-${e.method}`, onClick: () => setIndex(i), className: cn("flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground") },
                    React.createElement(Icon, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                    React.createElement("span", null, e.label)));
            })),
            entry && (React.createElement("div", { id: `flow-edu-panel-${entry.method}`, role: "tabpanel", "aria-labelledby": `flow-edu-tab-${entry.method}`, className: "flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-2 text-sm" },
                React.createElement("div", { className: "flex items-center gap-2" },
                    React.createElement(EntryIcon, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                    React.createElement("span", { className: "font-semibold" }, entry.label),
                    React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                        "Step ",
                        index + 1,
                        " / ",
                        FLOW_EDUCATION.length)),
                React.createElement("div", { className: "flex flex-col gap-1" },
                    React.createElement("div", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "What it does"),
                    React.createElement("p", { className: "m-0 text-xs" }, entry.whatItDoes)),
                React.createElement("div", { className: "flex flex-col gap-1" },
                    React.createElement("div", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "When to use it"),
                    React.createElement("p", { className: "m-0 text-xs" }, entry.whenToUse)),
                React.createElement("div", { className: "grid gap-3 sm:grid-cols-2" },
                    React.createElement("div", { className: "flex flex-col gap-1 rounded-md border bg-success/5 p-2" },
                        React.createElement("div", { className: "text-2xs uppercase tracking-wider text-success" }, "Defensive framing"),
                        React.createElement("p", { className: "m-0 text-2xs leading-snug" }, entry.defensiveFraming)),
                    React.createElement("div", { className: "flex flex-col gap-1 rounded-md border bg-warning/5 p-2" },
                        React.createElement("div", { className: "text-2xs uppercase tracking-wider text-warning" }, "Offensive framing"),
                        React.createElement("p", { className: "m-0 text-2xs leading-snug" }, entry.offensiveFraming))),
                React.createElement("div", { className: "flex flex-col gap-1" },
                    React.createElement("div", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Wire shape (mitmproxy view)"),
                    React.createElement("pre", { className: "m-0 whitespace-pre-wrap break-words rounded border bg-muted/30 p-2 font-mono text-2xs leading-snug" }, entry.wireShape)),
                React.createElement("div", { className: "flex flex-col gap-1 rounded-md border bg-card/40 p-2" },
                    React.createElement("div", { className: "flex items-center gap-2 text-2xs uppercase tracking-wider text-muted-foreground" },
                        React.createElement(Info, { className: "h-3 w-3", "aria-hidden": true }),
                        "Authoritative corpus reference"),
                    React.createElement("p", { className: "m-0 text-2xs" },
                        React.createElement("span", { className: "font-semibold" }, "Playbook:"),
                        " ",
                        React.createElement("code", { className: "font-mono" }, entry.corpusRef)),
                    React.createElement("p", { className: "m-0 text-2xs" },
                        React.createElement("span", { className: "font-semibold" }, "Source:"),
                        " ",
                        React.createElement("code", { className: "break-all font-mono" }, entry.corpusSource)),
                    React.createElement("p", { className: "m-0 pt-1 text-3xs italic text-muted-foreground" }, "Corpus root: C:\\Users\\baimgprodsesa1\\Desktop\\New folder\\")))),
            React.createElement(DialogFooter, { className: "flex flex-row items-center justify-between gap-2 sm:justify-between" },
                React.createElement("div", { className: "flex items-center gap-2" },
                    React.createElement(Button, { variant: "outline", size: "sm", onClick: () => setIndex((i) => (i - 1 + FLOW_EDUCATION.length) % FLOW_EDUCATION.length), className: "gap-1", "aria-label": "Previous flow" },
                        React.createElement(ChevronLeft, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Prev"),
                    React.createElement(Button, { variant: "outline", size: "sm", onClick: () => setIndex((i) => (i + 1) % FLOW_EDUCATION.length), className: "gap-1", "aria-label": "Next flow" },
                        "Next",
                        React.createElement(ChevronRight, { className: "h-3.5 w-3.5", "aria-hidden": true }))),
                React.createElement(Button, { variant: "default", size: "sm", onClick: () => onOpenChange(false), className: "gap-1", "aria-label": "Close flow education" },
                    React.createElement(ExternalLink, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                    "Got it")))));
};
// Re-export the icon X for callers who want a close-button glyph that
// matches the rest of the wizard surface (currently unused — kept for
// future expansion).
export { X as WizardCloseIcon };
//# sourceMappingURL=flow-education-wizard.js.map