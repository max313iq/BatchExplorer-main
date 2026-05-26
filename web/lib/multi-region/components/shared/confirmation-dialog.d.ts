import * as React from "react";
export interface ConfirmationDialogProps {
    hidden: boolean;
    title: string;
    message: string | React.ReactNode;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
    loading?: boolean;
}
export declare const ConfirmationDialog: React.FC<ConfirmationDialogProps>;
//# sourceMappingURL=confirmation-dialog.d.ts.map