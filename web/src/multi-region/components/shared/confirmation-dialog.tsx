import * as React from "react";
import { Dialog, DialogType, DialogFooter } from "@fluentui/react/lib/Dialog";
import { PrimaryButton, DefaultButton } from "@fluentui/react/lib/Button";
import { Spinner, SpinnerSize } from "@fluentui/react/lib/Spinner";

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

const bodyId = "confirmation-dialog-body";

export const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
    hidden,
    title,
    message,
    confirmText = "Confirm",
    cancelText = "Cancel",
    danger = false,
    onConfirm,
    onCancel,
    loading = false,
}) => {
    const dialogContentProps = React.useMemo(
        () => ({
            type: DialogType.normal,
            title,
            subText: typeof message === "string" ? message : undefined,
        }),
        [title, message]
    );

    const modalProps = React.useMemo(
        () => ({
            isBlocking: true,
            styles: {
                main: {
                    backgroundColor: "var(--bg-secondary, #1e1e1e)",
                    color: "var(--text-primary, #eee)",
                    minWidth: 400,
                },
            },
            "aria-describedby": bodyId,
        }),
        []
    );

    const confirmButtonStyles = React.useMemo(
        () =>
            danger
                ? {
                      root: {
                          backgroundColor: "var(--danger, #d13438)",
                          borderColor: "var(--danger, #d13438)",
                      },
                      rootHovered: {
                          backgroundColor: "#a52a2d",
                          borderColor: "#a52a2d",
                      },
                      rootPressed: {
                          backgroundColor: "#8c2326",
                          borderColor: "#8c2326",
                      },
                  }
                : undefined,
        [danger]
    );

    return (
        <Dialog
            hidden={hidden}
            onDismiss={onCancel}
            dialogContentProps={dialogContentProps}
            modalProps={modalProps}
        >
            {typeof message !== "string" && <div id={bodyId}>{message}</div>}
            <DialogFooter>
                <PrimaryButton
                    text={loading ? undefined : confirmText}
                    onClick={onConfirm}
                    disabled={loading}
                    styles={confirmButtonStyles}
                    aria-label={confirmText}
                >
                    {loading && (
                        <Spinner
                            size={SpinnerSize.xSmall}
                            styles={{ root: { marginRight: 8 } }}
                        />
                    )}
                    {loading ? "Processing..." : undefined}
                </PrimaryButton>
                <DefaultButton
                    text={cancelText}
                    onClick={onCancel}
                    disabled={loading}
                    aria-label={cancelText}
                />
            </DialogFooter>
        </Dialog>
    );
};
