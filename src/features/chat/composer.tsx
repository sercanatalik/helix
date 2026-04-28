import { useState, type KeyboardEvent } from "react";
import { Button, Kbd } from "../../components/ui";

interface ComposerProps {
  readonly onSend: (text: string) => void;
  readonly disabled?: boolean;
  readonly hint?: string;
  readonly modelLabel?: string;
}

export function Composer({
  onSend,
  disabled = false,
  hint,
  modelLabel,
}: ComposerProps) {
  const [text, setText] = useState("");
  const canSend = text.trim().length > 0 && !disabled;

  function submit() {
    if (!canSend) return;
    onSend(text);
    setText("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {hint ? <div className="composer-status">{hint}</div> : null}
        <div className="composer-tools">
          <ToolChip icon={<WrenchIcon />} label="Tools" count="0" disabled />
          <ToolChip icon={<SparkleIcon />} label="Prompts" count="0" disabled />
          <ToolChip icon={<DatabaseIcon />} label="Resources" count="0" disabled />
          <span className="composer-tools-spacer" />
          {modelLabel ? (
            <span className="composer-active-model">{modelLabel}</span>
          ) : null}
        </div>
        <div className="composer-card">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              disabled
                ? "Streaming…"
                : "Message the assistant. Type / for skills."
            }
            rows={1}
            disabled={disabled}
          />
          <div className="composer-toolbar">
            <div className="composer-hint">
              <span>
                <Kbd>↵</Kbd> send
              </span>
              <span>
                <Kbd>⇧</Kbd>+<Kbd>↵</Kbd> newline
              </span>
              <span>
                <Kbd>/</Kbd> skills
              </span>
            </div>
            <Button disabled={!canSend} onClick={submit}>
              Send
              <SendIcon />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ToolChipProps {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly count: string | number;
  readonly active?: boolean;
  readonly disabled?: boolean;
}

function ToolChip({ icon, label, count, active, disabled }: ToolChipProps) {
  return (
    <button
      type="button"
      className="tool-chip"
      data-active={active || undefined}
      data-disabled={disabled || undefined}
      disabled={disabled}
      title={disabled ? `${label} — not yet wired` : label}
    >
      <span className="tool-chip-icon" aria-hidden>
        {icon}
      </span>
      {label}
      <span className="tool-chip-count">{count}</span>
      <ChevronDownIcon />
    </button>
  );
}

function WrenchIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14.7 6.3a4 4 0 0 0-5.66 5.66l-7.04 7.04 2.83 2.83 7.04-7.04a4 4 0 0 0 5.66-5.66l-2.36 2.36-2.83-2.83z" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}
