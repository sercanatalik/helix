import { useEffect, useRef } from "react";
import { Button } from "../components/ui";

interface ConfirmDialogProps {
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** When true, the confirm button uses the destructive (red) variant.
   * Used for delete/discard flows. */
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** Modal confirm-or-cancel dialog. Mirrors the styling of
 * `AddWorkspaceDialog` so dialogs across the app share one look. Esc cancels;
 * Enter confirms. Click on the overlay also cancels. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  return (
    <div className="dialog-overlay" role="presentation" onClick={onCancel}>
      <div
        className="dialog-card"
        role="alertdialog"
        aria-label={title}
        aria-describedby={description ? "confirm-dialog-desc" : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog-title">{title}</h2>
        {description ? (
          <p id="confirm-dialog-desc" className="dialog-desc">
            {description}
          </p>
        ) : null}
        <div className="dialog-actions">
          <Button variant="ghost" size="lg" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={destructive ? "destructive" : "default"}
            size="lg"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
