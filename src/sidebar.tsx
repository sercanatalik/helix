export function Sidebar() {
  return (
    <aside className="chats-col">
      <div className="chats-col-drag" />
      <div className="chats-header">
        <div className="workspace-title">
          <span className="workspace-title-name">helix-ai</span>
          <span className="workspace-title-path">scaffold workspace</span>
        </div>
        <button type="button" className="new-conv" aria-label="New conversation">
          <PlusIcon />
          <span>New conversation</span>
          <span className="new-conv-kbd">⌘N</span>
        </button>
      </div>

      <div className="chats-scroll scroll">
        <div className="chats-section-label">
          <span className="dot" aria-hidden />
          <span>Today</span>
        </div>
        <button type="button" className="chat-row" data-active>
          <span className="chat-row-title">Welcome chat</span>
          <span className="chat-row-time">now</span>
          <span className="chat-row-preview">No messages yet — placeholder.</span>
        </button>

        <div className="chats-section-label">
          <span>Earlier</span>
        </div>
        <button type="button" className="chat-row">
          <span className="chat-row-title">Design exploration</span>
          <span className="chat-row-time">2d</span>
          <span className="chat-row-preview">Layout study based on gcf-desktop.</span>
        </button>
      </div>

      <div className="chats-footer">
        <div className="conn-chip" title="Backend not yet wired up">
          <span className="conn-chip-dot" data-status="idle" />
          <span className="conn-chip-text">no proxy</span>
        </div>
      </div>
    </aside>
  );
}

function PlusIcon() {
  return (
    <svg
      className="new-conv-icon"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
