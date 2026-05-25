import * as React from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
  const handleOpenChange = (open: boolean) => {
    if (!open && !loading) onCancel();
  };

  return (
    <Dialog open={!hidden} onOpenChange={handleOpenChange}>
      <DialogContent
        aria-describedby={bodyId}
        onEscapeKeyDown={(e) => loading && e.preventDefault()}
        onInteractOutside={(e) => loading && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {typeof message === "string" ? (
            <DialogDescription id={bodyId}>{message}</DialogDescription>
          ) : (
            <div id={bodyId} className="text-sm text-muted-foreground">
              {message}
            </div>
          )}
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={loading}
            aria-label={cancelText}
          >
            {cancelText}
          </Button>
          <Button
            type="button"
            variant={danger ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={loading}
            aria-label={confirmText}
          >
            {loading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Processing...
              </>
            ) : (
              confirmText
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
