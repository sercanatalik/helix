import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Button } from "../../../components/ui";
import { contextHeader, type PendingContextEntry } from "./pending-context";

interface ContextPopoverProps {
  readonly popoverRef: RefObject<HTMLDivElement | null>;
  readonly systemPrompt: string;
  readonly onSaveSystemPrompt: (next: string) => void;
  readonly pendingContext: readonly PendingContextEntry[];
  readonly onAddContext: (entry: PendingContextEntry) => void;
  readonly onRemoveContext: (id: string) => void;
  readonly onClose: () => void;
}

/** Manage everything that rides along on the next message: the persistent
 * system prompt (editable, persisted to localStorage), every pending
 * attachment (file / prompt / resource / custom), and a quick way to add
 * a free-form note. Replaces the chip-row stub so "Add context" lands on
 * a real surface where the user can see what's already in play. */
export function SystemPromptPopover({
  popoverRef,
  systemPrompt,
  onSaveSystemPrompt,
  pendingContext,
  onAddContext,
  onRemoveContext,
  onClose,
}: ContextPopoverProps) {
  const [draft, setDraft] = useState(systemPrompt);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const dirty = draft !== systemPrompt;

  // Re-sync the editor whenever the upstream value changes (cross-tab edits,
  // reset elsewhere). The popover stays mounted across opens so we can't
  // rely on the initialValue lifecycle alone.
  useEffect(() => {
    setDraft(systemPrompt);
  }, [systemPrompt]);

  // Auto-focus the system prompt editor on open and put the caret at the
  // end so the user can append without re-positioning.
  useEffect(() => {
    const ta = promptRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  function commitSystemPrompt() {
    onSaveSystemPrompt(draft);
  }

  return (
    <div
      ref={popoverRef}
      className="ctx-popover"
      role="dialog"
      aria-label="Manage context"
    >
      <div className="ctx-popover-head">
        <div className="ctx-popover-title">
          <span>Context</span>
          <span className="ctx-popover-meta">
            sent as system context every turn
          </span>
        </div>
        <button
          type="button"
          className="ctx-popover-close"
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          ×
        </button>
      </div>

      <div className="ctx-popover-body scroll">
        <SystemPromptSection
          textareaRef={promptRef}
          draft={draft}
          dirty={dirty}
          onChange={setDraft}
          onCommit={commitSystemPrompt}
          onClear={() => {
            setDraft("");
            promptRef.current?.focus();
          }}
        />
        <AttachmentsSection
          pendingContext={pendingContext}
          onRemove={onRemoveContext}
        />
        <AddCustomSection onAdd={onAddContext} />
      </div>
    </div>
  );
}

/* ---------- System prompt ------------------------------------------------ */

interface SystemPromptSectionProps {
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly draft: string;
  readonly dirty: boolean;
  readonly onChange: (next: string) => void;
  readonly onCommit: () => void;
  readonly onClear: () => void;
}

function SystemPromptSection({
  textareaRef,
  draft,
  dirty,
  onChange,
  onCommit,
  onClear,
}: SystemPromptSectionProps) {
  return (
    <section className="ctx-section">
      <header className="ctx-section-head">
        <span className="ctx-section-title">System prompt</span>
        <span className="ctx-section-meta">persisted across sessions</span>
      </header>
      <textarea
        ref={textareaRef}
        className="ctx-textarea"
        value={draft}
        spellCheck
        rows={5}
        placeholder="e.g. You are a senior quant assistant. Prefer concise, sourced answers."
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (
            (e.metaKey || e.ctrlKey) &&
            e.key === "Enter" &&
            !e.nativeEvent.isComposing
          ) {
            e.preventDefault();
            onCommit();
          }
        }}
      />
      <div className="ctx-section-footer">
        <span className="ctx-section-counter">
          {draft.length.toLocaleString()} chars
        </span>
        <span className="ctx-section-spacer" />
        {draft.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear
          </Button>
        ) : null}
        <Button size="sm" onClick={onCommit} disabled={!dirty}>
          {dirty ? "Save" : "Saved"}
        </Button>
      </div>
    </section>
  );
}

/* ---------- Attachments -------------------------------------------------- */

interface AttachmentsSectionProps {
  readonly pendingContext: readonly PendingContextEntry[];
  readonly onRemove: (id: string) => void;
}

function AttachmentsSection({
  pendingContext,
  onRemove,
}: AttachmentsSectionProps) {
  return (
    <section className="ctx-section">
      <header className="ctx-section-head">
        <span className="ctx-section-title">Attached for next message</span>
        <span className="ctx-section-meta">
          {pendingContext.length === 0
            ? "nothing attached"
            : `${pendingContext.length} ${
                pendingContext.length === 1 ? "item" : "items"
              }`}
        </span>
      </header>
      {pendingContext.length === 0 ? (
        <p className="ctx-empty">
          Click a file in the workspace pane, or load an MCP prompt /
          resource — it appears here until the next message is sent.
        </p>
      ) : (
        <ul className="ctx-attach-list">
          {pendingContext.map((entry) => (
            <AttachmentRow
              key={entry.id}
              entry={entry}
              onRemove={() => onRemove(entry.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function AttachmentRow({
  entry,
  onRemove,
}: {
  readonly entry: PendingContextEntry;
  readonly onRemove: () => void;
}) {
  const preview = useMemoPreview(entry.content);
  return (
    <li className="ctx-attach-row" data-kind={entry.kind}>
      <span className="ctx-attach-kind">{entry.kind}</span>
      <div className="ctx-attach-text">
        <div className="ctx-attach-label" title={entry.label}>
          {entry.label}
        </div>
        <div className="ctx-attach-preview">{preview}</div>
      </div>
      <button
        type="button"
        className="ctx-attach-remove"
        onClick={onRemove}
        aria-label={`Remove ${entry.label}`}
        title="Remove"
      >
        ×
      </button>
    </li>
  );
}

/** Strip the attribution header from the saved content so the preview
 * shows the actual body. File entries use a multi-line header capped by
 * a `---` divider; other kinds use a single `[helix …]` line. */
function useMemoPreview(content: string): string {
  let body = content;
  // File-style header: drop everything up to and including the divider.
  const dividerIdx = body.indexOf("\n---\n");
  if (body.startsWith("[helix workspace file") && dividerIdx >= 0) {
    body = body.slice(dividerIdx + 5);
  } else if (body.startsWith("[")) {
    // Single-line header — cut at the first newline.
    const nl = body.indexOf("\n");
    if (nl >= 0) body = body.slice(nl + 1);
  }
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.length > 140 ? `${compact.slice(0, 139)}…` : compact;
}

/* ---------- Add custom --------------------------------------------------- */

interface AddCustomSectionProps {
  readonly onAdd: (entry: PendingContextEntry) => void;
}

function AddCustomSection({ onAdd }: AddCustomSectionProps) {
  const [body, setBody] = useState("");
  const [label, setLabel] = useState("");
  const trimmed = body.trim();
  const labelTrim = label.trim();
  const canAdd = trimmed.length > 0;

  function commit() {
    if (!canAdd) return;
    const finalLabel = labelTrim || autoLabel(trimmed);
    const id = `custom:${finalLabel}:${Date.now()}`;
    onAdd({
      id,
      kind: "custom",
      serverName: "User",
      label: finalLabel,
      content: contextHeader("custom", "User", finalLabel) + trimmed,
    });
    setBody("");
    setLabel("");
  }

  return (
    <section className="ctx-section">
      <header className="ctx-section-head">
        <span className="ctx-section-title">Add a note</span>
        <span className="ctx-section-meta">
          included on the next message only
        </span>
      </header>
      <input
        type="text"
        className="ctx-input"
        placeholder="Label (optional, e.g. Background)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        spellCheck={false}
      />
      <textarea
        className="ctx-textarea"
        rows={3}
        value={body}
        spellCheck
        placeholder="Anything you want the model to know for this turn — context, constraints, scratchpad notes."
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (
            (e.metaKey || e.ctrlKey) &&
            e.key === "Enter" &&
            !e.nativeEvent.isComposing
          ) {
            e.preventDefault();
            commit();
          }
        }}
      />
      <div className="ctx-section-footer">
        <span className="ctx-section-counter">
          {body.length.toLocaleString()} chars
        </span>
        <span className="ctx-section-spacer" />
        <Button size="sm" onClick={commit} disabled={!canAdd}>
          Attach
        </Button>
      </div>
    </section>
  );
}

function autoLabel(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const compact = firstLine.replace(/\s+/g, " ").trim();
  return compact.length > 36 ? `${compact.slice(0, 35)}…` : compact || "Note";
}
