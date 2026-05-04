import { useEffect, useRef, useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "../components/ui";

interface AddWorkspaceDialogProps {
  readonly onClose: () => void;
  readonly onSubmit: (name: string, path: string) => void;
  /** When provided, dialog is in edit mode — fields pre-fill from `initial`,
   * the title flips to "Edit workspace", and the primary button reads
   * "Save". Omitted means add mode (the original behaviour). */
  readonly initial?: { readonly name: string; readonly path: string };
}

export function AddWorkspaceDialog({
  onClose,
  onSubmit,
  initial,
}: AddWorkspaceDialogProps) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [path, setPath] = useState(initial?.path ?? "");
  const [picking, setPicking] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function pickFolder() {
    setPicking(true);
    try {
      const selection = await open({
        title: "Attach folder",
        directory: true,
        multiple: false,
      });
      if (typeof selection === "string") {
        setPath(selection);
        // If the user hasn't named the workspace yet, seed with the folder
        // basename — gcf-desktop's default-display-name behaviour.
        if (!name.trim()) {
          const last = selection.split(/[\\/]/).filter(Boolean).pop();
          if (last) setName(last);
        }
      }
    } catch {
      // Dialog cancellation throws or returns null — either way we just bail.
    } finally {
      setPicking(false);
    }
  }

  // Creating a workspace requires a folder — the file tree, notes, and
  // skills system all key off it, and a folder-less workspace ends up as a
  // dead shell on first use. Edit mode skips this check so existing
  // workspaces can still be detached from a folder via the rail menu.
  const folderRequired = !isEdit;
  const canSubmit = !!name.trim() && (!folderRequired || !!path);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(name.trim(), path);
  }

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={onClose}
    >
      <form
        className="dialog-card"
        role="dialog"
        aria-label={isEdit ? "Edit workspace" : "Add workspace"}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="dialog-title">
          {isEdit ? "Edit workspace" : "Add workspace"}
        </h2>
        <p className="dialog-desc">
          {isEdit
            ? "Give the workspace a short name. Optionally attach a folder so its file tree shows up on the right."
            : "Give the workspace a short name and pick the folder it should anchor to."}
        </p>
        <input
          ref={inputRef}
          className="field-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Personal, Work, Side project…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />

        <div className="dialog-folder-row">
          <Button
            variant="outline"
            size="default"
            onClick={() => void pickFolder()}
            disabled={picking}
          >
            {picking ? "Picking…" : path ? "Change folder" : "Attach folder"}
          </Button>
          {path ? (
            <span className="dialog-folder-path" title={path}>
              {path}
            </span>
          ) : (
            <span className="dialog-folder-hint">
              {folderRequired ? "Required" : "Optional"}
            </span>
          )}
        </div>

        <div className="dialog-actions">
          <Button variant="ghost" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="lg" disabled={!canSubmit}>
            {isEdit ? "Save" : "Add"}
          </Button>
        </div>
      </form>
    </div>
  );
}
