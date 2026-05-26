import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
const bodyId = "confirmation-dialog-body";
export const ConfirmationDialog = ({ hidden, title, message, confirmText = "Confirm", cancelText = "Cancel", danger = false, onConfirm, onCancel, loading = false, }) => {
    const handleOpenChange = (open) => {
        if (!open && !loading)
            onCancel();
    };
    return (React.createElement(Dialog, { open: !hidden, onOpenChange: handleOpenChange },
        React.createElement(DialogContent, { "aria-describedby": bodyId, onEscapeKeyDown: (e) => loading && e.preventDefault(), onInteractOutside: (e) => loading && e.preventDefault() },
            React.createElement(DialogHeader, null,
                React.createElement(DialogTitle, null, title),
                typeof message === "string" ? (React.createElement(DialogDescription, { id: bodyId }, message)) : (React.createElement("div", { id: bodyId, className: "text-sm text-muted-foreground" }, message))),
            React.createElement(DialogFooter, { className: "gap-2" },
                React.createElement(Button, { type: "button", variant: "outline", onClick: onCancel, disabled: loading, "aria-label": cancelText }, cancelText),
                React.createElement(Button, { type: "button", variant: danger ? "destructive" : "default", onClick: onConfirm, disabled: loading, "aria-label": confirmText }, loading ? (React.createElement(React.Fragment, null,
                    React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin" }),
                    "Processing...")) : (confirmText))))));
};
//# sourceMappingURL=confirmation-dialog.js.map