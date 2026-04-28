import { useState, type KeyboardEvent } from "react";
import { Button, Kbd } from "../../components/ui";

interface ComposerProps {
  readonly onSend: (text: string) => void;
  readonly disabled?: boolean;
  readonly hint?: string;
}

export function Composer({ onSend, disabled = false, hint }: ComposerProps) {
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
        <div className="composer-card">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              disabled
                ? "Streaming…"
                : "Message the assistant…"
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
