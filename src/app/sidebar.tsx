import { useMemo } from "react";
import { useProviders } from "../features/providers";
import { useConnectionStatus } from "../hooks/use-connection-status";
import type { SessionId, SessionRecord } from "./types";

interface SidebarProps {
  readonly sessions: readonly SessionRecord[];
  readonly activeId: SessionId | undefined;
  readonly onSelect: (id: SessionId) => void;
  readonly onCreate: () => SessionId;
  readonly onDelete: (id: SessionId) => void;
}

export function Sidebar({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: SidebarProps) {
  const { activeProvider } = useProviders();
  const conn = useConnectionStatus(activeProvider);

  const groups = useMemo(() => groupSessions(sessions), [sessions]);

  const status =
    conn.status === "ok"
      ? "connected"
      : conn.status === "fail"
        ? "error"
        : conn.status === "checking"
          ? "checking"
          : "idle";
  const label = !activeProvider
    ? "no provider"
    : conn.status === "checking"
      ? "checking…"
      : conn.status === "fail"
        ? "unreachable"
        : activeProvider.name;
  const title = !activeProvider
    ? "No active provider — add one in Settings → Providers"
    : conn.status === "fail" && conn.error
      ? `${activeProvider.name} · failed — ${conn.error}`
      : `${activeProvider.name}${activeProvider.model ? ` · ${activeProvider.model}` : ""}`;

  return (
    <aside className="chats-col">
      <div className="chats-col-drag" />
      <div className="chats-header">
        <div className="workspace-title">
          <span className="workspace-title-name">helix-ai</span>
          <span className="workspace-title-path">scaffold workspace</span>
        </div>
        <button
          type="button"
          className="new-conv"
          aria-label="New conversation"
          onClick={() => void onCreate()}
        >
          <PlusIcon />
          <span>New conversation</span>
          <span className="new-conv-kbd">⌘N</span>
        </button>
      </div>

      <div className="chats-scroll scroll">
        {groups.map(({ label: group, items }) => (
          <div key={group}>
            <div className="chats-section-label">
              <span>{group}</span>
            </div>
            {items.map((s) => (
              <ChatRow
                key={s.id}
                session={s}
                active={s.id === activeId}
                onSelect={() => onSelect(s.id)}
                onDelete={() => onDelete(s.id)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="chats-footer">
        <div className="conn-chip" title={title}>
          <span className="conn-chip-dot" data-status={status} />
          <span className="conn-chip-text">{label}</span>
        </div>
      </div>
    </aside>
  );
}

interface ChatRowProps {
  readonly session: SessionRecord;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onDelete: () => void;
}

function ChatRow({ session, active, onSelect, onDelete }: ChatRowProps) {
  const preview = previewOf(session);
  return (
    <div
      className="chat-row"
      role="button"
      tabIndex={0}
      data-active={active || undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="chat-row-title">{session.title}</span>
      <span className="chat-row-time">{relativeTime(session.updatedAt)}</span>
      <span className="chat-row-preview">{preview}</span>
      <button
        type="button"
        className="chat-row-delete"
        aria-label="Delete chat"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

interface SessionGroup {
  readonly label: string;
  readonly items: readonly SessionRecord[];
}

function groupSessions(sessions: readonly SessionRecord[]): SessionGroup[] {
  const sorted = [...sessions].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const sevenDays = 7 * oneDay;

  const today: SessionRecord[] = [];
  const week: SessionRecord[] = [];
  const earlier: SessionRecord[] = [];

  for (const s of sorted) {
    const age = now - new Date(s.updatedAt).getTime();
    if (age < oneDay) today.push(s);
    else if (age < sevenDays) week.push(s);
    else earlier.push(s);
  }

  const out: SessionGroup[] = [];
  if (today.length) out.push({ label: "Today", items: today });
  if (week.length) out.push({ label: "This week", items: week });
  if (earlier.length) out.push({ label: "Earlier", items: earlier });
  return out;
}

function previewOf(session: SessionRecord): string {
  const last = session.transcript[session.transcript.length - 1];
  if (!last) return "No messages yet.";
  const text = last.content.replace(/\s+/g, " ").trim();
  if (!text) return "…";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function relativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.round(days / 30);
  return `${months}mo`;
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

function TrashIcon() {
  return (
    <svg
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
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
    </svg>
  );
}
