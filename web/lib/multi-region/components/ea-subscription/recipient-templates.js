/**
 * RecipientTemplates — persisted, named snapshots of a recipient list
 * so the operator can re-load a common batch (e.g. "Customer A monthly
 * provisioning") without re-clicking the picker.
 *
 * The persisted form stores only `(tenantId, ownerObjectId)` pairs — no
 * display labels — because tenant users may be deactivated/renamed
 * between visits. Hydration relies on the existing recipientCatalog
 * lookup the parent already does.
 *
 * Persistence is per-key via `usePersistedState` so the page can
 * recover from a refresh. Cross-tab sync is intentionally OFF to avoid
 * surprising the operator mid-batch.
 */
import * as React from "react";
import { BookMarked, ChevronRight, Plus, Save, Trash2, } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { usePersistedState } from "../../hooks/use-persisted-state";
const STORAGE_KEY = "ea-subscription:recipient-templates";
function newId() {
    return `tpl-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
}
const isTemplate = (x) => {
    if (!x || typeof x !== "object")
        return false;
    const t = x;
    if (typeof t.id !== "string")
        return false;
    if (typeof t.name !== "string")
        return false;
    if (!Array.isArray(t.pairs))
        return false;
    return true;
};
export const RecipientTemplates = ({ currentPairs, onLoad, disabled, }) => {
    const [templates, setTemplates] = usePersistedState(STORAGE_KEY, [], {
        version: 1,
        migrate: (raw) => {
            if (Array.isArray(raw) && raw.every(isTemplate)) {
                return raw;
            }
            return undefined;
        },
    });
    const [open, setOpen] = React.useState(false);
    const [newName, setNewName] = React.useState("");
    const handleSave = React.useCallback(() => {
        const name = newName.trim();
        if (!name)
            return;
        if (currentPairs.length === 0)
            return;
        setTemplates((prev) => {
            const now = Date.now();
            const exists = prev.findIndex((t) => t.name.toLowerCase() === name.toLowerCase());
            if (exists >= 0) {
                const next = prev.slice();
                next[exists] = Object.assign(Object.assign({}, next[exists]), { pairs: currentPairs.slice(), updatedAt: now });
                return next;
            }
            return [
                ...prev,
                {
                    id: newId(),
                    name,
                    pairs: currentPairs.slice(),
                    createdAt: now,
                    updatedAt: now,
                },
            ];
        });
        setNewName("");
    }, [newName, currentPairs, setTemplates]);
    const handleDelete = React.useCallback((id) => {
        setTemplates((prev) => prev.filter((t) => t.id !== id));
    }, [setTemplates]);
    const sorted = React.useMemo(() => templates.slice().sort((a, b) => b.updatedAt - a.updatedAt), [templates]);
    return (React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-dashed border-border bg-surface-sunken px-3 py-2" },
        React.createElement("button", { type: "button", className: "flex w-full items-center justify-between gap-2 text-xs", onClick: () => setOpen((o) => !o), "aria-expanded": open },
            React.createElement("span", { className: "flex items-center gap-1.5 font-medium" },
                React.createElement(BookMarked, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Recipient templates",
                templates.length > 0 && (React.createElement("span", { className: "ml-1 rounded-full bg-muted px-1.5 py-0.5 text-2xs font-normal text-muted-foreground" }, templates.length))),
            React.createElement(ChevronRight, { className: cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ease-out", open && "rotate-90"), "aria-hidden": true })),
        open && (React.createElement("div", { className: "flex flex-col gap-2" },
            React.createElement("p", { className: "text-2xs text-muted-foreground" }, "Save the current recipient list under a name and reload it on future visits. Stored locally in this browser \u2014 no Azure round-trip."),
            React.createElement("div", { className: "flex flex-wrap items-end gap-2" },
                React.createElement("div", { className: "flex min-w-[180px] flex-1 flex-col gap-1" },
                    React.createElement(Label, { htmlFor: "ea-tpl-name", className: "text-2xs" }, "Template name"),
                    React.createElement(Input, { id: "ea-tpl-name", value: newName, onChange: (e) => setNewName(e.target.value), placeholder: "Customer A monthly", autoComplete: "off", spellCheck: false, disabled: disabled, className: "text-xs" })),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleSave, disabled: disabled || !newName.trim() || currentPairs.length === 0, "aria-label": "Save current recipients as template", className: "gap-1" },
                    React.createElement(Save, { className: "h-3 w-3", "aria-hidden": true }),
                    "Save current (",
                    currentPairs.length,
                    ")")),
            sorted.length === 0 ? (React.createElement("p", { className: "text-2xs text-muted-foreground" }, "No templates yet. Pick recipients above, then save them under a name for re-use.")) : (React.createElement("ul", { className: "flex flex-col gap-1", role: "list", "aria-label": "Saved recipient templates" }, sorted.map((t) => (React.createElement("li", { key: t.id, className: "flex items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-1.5" },
                React.createElement("div", { className: "flex min-w-0 flex-1 flex-col" },
                    React.createElement("span", { className: "truncate text-xs font-medium text-foreground" }, t.name),
                    React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        t.pairs.length,
                        " recipient",
                        t.pairs.length === 1 ? "" : "s",
                        " \u00B7 updated",
                        " ",
                        new Date(t.updatedAt).toLocaleDateString())),
                React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => onLoad(t.pairs.slice(), t.name), disabled: disabled || t.pairs.length === 0, "aria-label": `Load template ${t.name}`, className: "gap-1" },
                    React.createElement(Plus, { className: "h-3 w-3", "aria-hidden": true }),
                    "Load"),
                React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => handleDelete(t.id), disabled: disabled, "aria-label": `Delete template ${t.name}`, className: "h-7 w-7" },
                    React.createElement(Trash2, { className: "h-3 w-3", "aria-hidden": true })))))))))));
};
//# sourceMappingURL=recipient-templates.js.map