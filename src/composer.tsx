import { useState } from "react";
import { Button, Kbd } from "./components/ui";

export function Composer() {
  const [text, setText] = useState("");
  const canSend = text.trim().length > 0;

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        <div className="composer-card">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Message the assistant.  (Backend not wired up yet.)"
            rows={1}
            disabled
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
            <Button disabled={!canSend}>
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
