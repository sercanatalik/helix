import { useEffect, useRef, useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "../components/ui";

interface AddWorkspaceDialogProps {
  readonly onClose: () => void;
  readonly onAdd: (name: string, path: string) => void;
}

export function AddWorkspaceDialog({ onClose, onAdd }: AddWorkspaceDialogProps) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
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

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onAdd(trimmed, path);
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
        aria-label="Add workspace"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="dialog-title">Add workspace</h2>
        <p className="dialog-desc">
          Give the workspace a short name. Optionally attach a folder so its
          file tree shows up on the right.
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
            <span className="dialog-folder-hint">Optional</span>
          )}
        </div>

        <div className="dialog-actions">
          <Button variant="ghost" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="lg" disabled={!name.trim()}>
            Add
          </Button>
        </div>
      </form>
    </div>
  );
}
