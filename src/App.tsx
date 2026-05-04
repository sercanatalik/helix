import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { AddWorkspaceDialog } from "./app/add-workspace-dialog";
import { MainDock } from "./app/main-dock";
import { WorkspacePanel } from "./app/workspace-panel";
import { WorkspaceRail } from "./app/workspace-rail";
import { Sidebar } from "./app/sidebar";
import { Titlebar } from "./app/titlebar";
import {
  createEmptyState,
  type DesktopAppState,
  type NoteId,
  type NoteRecord,
  type SessionRecord,
  type TranscriptMessage,
  type WorkspaceId,
  type WorkspaceRecord,
} from "./app/types";
import { Composer, Transcript } from "./features/chat";
import type { ComposerHandle } from "./features/chat";
import type { TreeEntry } from "./lib/tauri-api";
import { useProviders } from "./features/providers";

// Heavy panes deferred behind React.lazy so the initial chunk stays small.
// `NoteEditorContainer` pulls BlockNote + CodeMirror + shiki (~1MB raw); the
// settings pane only matters when the user opens it. `vega-chart-impl` is
// already lazy via `components/vega-chart.tsx`.
const NoteEditorContainer = lazy(() =>
  import("./features/notes").then((m) => ({ default: m.NoteEditorContainer })),
);
const Settings = lazy(() =>
  import("./features/settings").then((m) => ({ default: m.Settings })),
);
import { useChat } from "./hooks/use-chat";
import { useNotes } from "./hooks/use-notes";
import { useSessions } from "./hooks/use-sessions";
import { useWorkspaces } from "./hooks/use-workspaces";
import {
  loadOpenNoteIdsByWorkspace,
  saveOpenNoteIdsByWorkspace,
} from "./lib/notes/storage";

export function App() {
  const [state, setState] = useState<DesktopAppState>(createEmptyState());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const workspacesApi = useWorkspaces();
  const sessionsApi = useSessions(workspacesApi.activeId);
  const notesApi = useNotes(workspacesApi.activeWorkspace);
  const [isAddingWorkspace, setIsAddingWorkspace] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  // Imperative handle into the active Composer. Lets the workspace panel
  // push a file (read via the same `read_file` Tauri command the model
  // uses) straight into the composer's pending-context list — no global
  // store, no event bus. Null when the chat view isn't mounted (e.g. a
  // note editor has the main pane).
  const composerRef = useRef<ComposerHandle | null>(null);
  // Per-workspace ordered list of open note tabs in the main dock. The
  // active note id (owned by `useNotes`) decides which of these is focused.
  const [openIdsByWorkspace, setOpenIdsByWorkspace] = useState<
    Record<WorkspaceId, NoteId[]>
  >(() => loadOpenNoteIdsByWorkspace());
  useEffect(() => {
    saveOpenNoteIdsByWorkspace(openIdsByWorkspace);
  }, [openIdsByWorkspace]);

  const openAddWorkspace = useCallback(() => {
    setIsAddingWorkspace(true);
  }, []);

  const onConfirmAddWorkspace = useCallback(
    (name: string, path: string) => {
      workspacesApi.addWorkspace(name, path);
      setIsAddingWorkspace(false);
    },
    [workspacesApi],
  );

  // Notes are workspace-folder-only. Without an attached path the panel is
  // hidden and notes can't be created — same gating as the file tree.
  const hasWorkspacePath = !!workspacesApi.activeWorkspace?.path;

  // The right panel is meaningful only when the active workspace has a path
  // and the chat view (not settings) is active.
  const showPanel =
    panelOpen && state.activeView !== "settings" && hasWorkspacePath;

  const refresh = useCallback(async () => {
    try {
      const next = await window.helixApi.getState();
      setState(next);
    } catch {
      // Backend not ready yet — keep the empty default.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Subscribe to push updates from the Rust side. The McpManager emits
  // snapshots on connect/disconnect/error transitions so MCP UIs reflect
  // live status without polling. Cheap to keep mounted — the listener is a
  // no-op when nothing is happening.
  useEffect(() => {
    return window.helixApi.onStateChanged(setState);
  }, []);

  // Keep the project skills root in sync with the active workspace. The
  // Rust SkillsManager already watches `~/.claude/skills`; this call
  // (re)attaches the project-level watcher whenever the user switches
  // workspaces. Empty/missing path falls back to user-level only.
  useEffect(() => {
    const path = workspacesApi.activeWorkspace?.path;
    void window.helixApi
      .setSkillsWorkspace(path && path.length > 0 ? path : undefined)
      .then(setState)
      .catch(() => {
        // Backend not ready yet — push will arrive on the next snapshot.
      });
  }, [workspacesApi.activeWorkspace?.path]);

  useEffect(() => {
    function handler(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      if (event.key === "b") {
        event.preventDefault();
        setSidebarCollapsed((v) => !v);
      } else if (event.key === ",") {
        event.preventDefault();
        void window.helixApi.setActiveView("settings").then(setState);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const onSelectView = useCallback(async (view: "chat" | "settings") => {
    const next = await window.helixApi.setActiveView(view);
    setState(next);
  }, []);

  const isSettings = state.activeView === "settings";

  // Selecting a chat / creating a new conversation pulls the user out of
  // note view by clearing `activeNoteId`. Selecting a note flips the main
  // pane the other way. The panel and the chats sidebar each own one half
  // of that swap.
  const handleSelectSession = useCallback(
    (id: string) => {
      sessionsApi.setActive(id);
      notesApi.setActive(undefined);
    },
    [sessionsApi, notesApi],
  );

  const handleCreateSession = useCallback(() => {
    notesApi.setActive(undefined);
    return sessionsApi.createSession();
  }, [sessionsApi, notesApi]);

  // ---- Dock open-tab helpers --------------------------------------------
  const wsId = workspacesApi.activeId;
  const openIds = wsId ? (openIdsByWorkspace[wsId] ?? []) : [];

  // Resolve open ids against the live notes list. Drops any id that no
  // longer maps to a real file (deleted on disk, moved out of workspace).
  const openNotes = useMemo<readonly NoteRecord[]>(() => {
    if (openIds.length === 0) return [];
    const byId = new Map(notesApi.notes.map((n) => [n.id, n] as const));
    const out: NoteRecord[] = [];
    for (const id of openIds) {
      const n = byId.get(id);
      if (n) out.push(n);
    }
    return out;
  }, [openIds, notesApi.notes]);

  // Garbage-collect stale ids out of storage once the underlying scan
  // confirms a note is gone. Runs only when the resolved set shrinks below
  // the persisted set; a no-op otherwise.
  useEffect(() => {
    if (!wsId) return;
    if (openIds.length === 0) return;
    if (openIds.length === openNotes.length) return;
    const live = new Set(openNotes.map((n) => n.id));
    setOpenIdsByWorkspace((curr) => {
      const list = curr[wsId] ?? [];
      const next = list.filter((id) => live.has(id));
      if (next.length === list.length) return curr;
      return { ...curr, [wsId]: next };
    });
  }, [wsId, openIds, openNotes]);

  const ensureOpen = useCallback(
    (id: NoteId) => {
      if (!wsId) return;
      setOpenIdsByWorkspace((curr) => {
        const list = curr[wsId] ?? [];
        if (list.includes(id)) return curr;
        return { ...curr, [wsId]: [...list, id] };
      });
    },
    [wsId],
  );

  const handleOpenNote = useCallback(
    (id: NoteId) => {
      ensureOpen(id);
      notesApi.setActive(id);
    },
    [ensureOpen, notesApi],
  );

  const handleCloseNote = useCallback(
    (id: NoteId) => {
      if (!wsId) return;
      const list = openIdsByWorkspace[wsId] ?? [];
      const idx = list.indexOf(id);
      if (idx === -1) return;
      const next = list.filter((x) => x !== id);
      setOpenIdsByWorkspace((curr) => ({ ...curr, [wsId]: next }));
      // If we just closed the focused tab, advance to the neighbour on
      // the right (or fall back to chat if nothing's left).
      if (notesApi.activeId === id) {
        if (next.length === 0) {
          notesApi.setActive(undefined);
        } else {
          const target = next[Math.min(idx, next.length - 1)];
          notesApi.setActive(target);
        }
      }
    },
    [wsId, openIdsByWorkspace, notesApi],
  );

  const handleSelectChatTab = useCallback(() => {
    notesApi.setActive(undefined);
  }, [notesApi]);

  const handleCreateNoteForDock = useCallback(async () => {
    const note = await notesApi.createNote();
    if (note) ensureOpen(note.id);
    return note;
  }, [notesApi, ensureOpen]);

  const handleDetachNote = useCallback(
    (note: NoteRecord) => {
      const ws = workspacesApi.activeWorkspace;
      if (!ws) return;
      void window.helixApi.openNoteWindow(
        ws.id,
        ws.path,
        note.path,
        note.id,
        note.title,
      );
      handleCloseNote(note.id);
    },
    [workspacesApi.activeWorkspace, handleCloseNote],
  );

  // Workspace panel → composer. Click a file row in the right sidebar and
  // its content rides along on the next message as hidden system context,
  // attributed to the `read_file` built-in tool. Binary kinds are skipped
  // for now — images / PDFs need a different routing (multimodal content
  // blocks vs. plain text), so silently no-op rather than dump a base64
  // blob into the prompt.
  const handleAttachFileToContext = useCallback(
    async (entry: TreeEntry) => {
      if (entry.kind !== "file") return;
      const composer = composerRef.current;
      if (!composer) return;
      const ws = workspacesApi.activeWorkspace;
      try {
        const result = await window.helixApi.readFile(entry.path);
        if (result.kind !== "text" && result.kind !== "notebook") return;
        const relPath =
          ws?.path && entry.path.startsWith(ws.path)
            ? entry.path.slice(ws.path.length).replace(/^[\\/]+/, "")
            : entry.name;
        composer.attachWorkspaceFile({
          absPath: entry.path,
          relPath,
          content: result.content,
        });
      } catch {
        // Read failure is non-fatal — the panel already shows the file as
        // present, and the user will retry or pick a different one.
      }
    },
    [workspacesApi.activeWorkspace],
  );

  // Auto-open the active note as a tab when it's set from outside the dock
  // (sidebar selection, restore from storage). Cheap — runs only when the
  // active id flips.
  useEffect(() => {
    const id = notesApi.activeId;
    if (id) ensureOpen(id);
  }, [notesApi.activeId, ensureOpen]);

  // The note editor takes over the main pane whenever a note is active and
  // the workspace has a folder path (so we can save back to disk). Without
  // a path, notes don't exist for this workspace at all.
  const showNoteEditor =
    !isSettings &&
    hasWorkspacePath &&
    !!notesApi.activeNote &&
    !!workspacesApi.activeWorkspace;

  const dockActiveId: "chat" | NoteId = notesApi.activeNote
    ? notesApi.activeNote.id
    : "chat";

  const chatSubtitle =
    sessionsApi.activeSession?.title ??
    workspacesApi.activeWorkspace?.displayName ??
    undefined;

  return (
    <div
      className="app-shell"
      data-sidebar-collapsed={sidebarCollapsed}
      data-panel-open={showPanel}
    >
      <WorkspaceRail
        activeView={state.activeView}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
        collapsed={sidebarCollapsed}
        onOpenSettings={() => void onSelectView("settings")}
        workspaces={workspacesApi.workspaces}
        activeWorkspaceId={workspacesApi.activeId}
        onSelectWorkspace={workspacesApi.setActive}
        onAddWorkspace={openAddWorkspace}
        canTogglePanel={hasWorkspacePath}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((v) => !v)}
      />
      <Sidebar
        workspace={workspacesApi.activeWorkspace}
        sessions={sessionsApi.sessions}
        activeId={sessionsApi.activeId}
        onSelect={handleSelectSession}
        onCreate={handleCreateSession}
        onDelete={sessionsApi.deleteSession}
      />
      <main className="main-pane">
        {isSettings ? (
          <>
            <Titlebar title="Settings" onBack={() => void onSelectView("chat")} />
            <Suspense fallback={<PaneFallback />}>
              <Settings />
            </Suspense>
          </>
        ) : (
          <>
            <MainDock
              chatSubtitle={chatSubtitle}
              openNotes={openNotes}
              activeId={dockActiveId}
              onSelectChat={handleSelectChatTab}
              onSelectNote={handleOpenNote}
              onCloseNote={handleCloseNote}
              onDetachNote={handleDetachNote}
            />
            {showNoteEditor && notesApi.activeNote && workspacesApi.activeWorkspace ? (
              <Suspense fallback={<PaneFallback />}>
                <NoteEditorContainer
                  workspace={workspacesApi.activeWorkspace}
                  note={notesApi.activeNote}
                  onRenamed={notesApi.setActive}
                />
              </Suspense>
            ) : (
              <ChatView
                activeWorkspace={workspacesApi.activeWorkspace}
                activeSession={sessionsApi.activeSession}
                setMessages={sessionsApi.setMessages}
                setContextResetAt={sessionsApi.setContextResetAt}
                createSession={sessionsApi.createSession}
                composerRef={composerRef}
              />
            )}
          </>
        )}
      </main>
      {showPanel && workspacesApi.activeWorkspace ? (
        <WorkspacePanel
          workspace={workspacesApi.activeWorkspace}
          onClose={() => setPanelOpen(false)}
          notes={notesApi.notes}
          activeNoteId={notesApi.activeId}
          notesLoading={notesApi.loading}
          onSelectNote={handleOpenNote}
          onCreateNote={handleCreateNoteForDock}
          onDeleteNote={notesApi.deleteNote}
          onOpenNoteWindow={(note) => {
            const ws = workspacesApi.activeWorkspace;
            if (!ws) return;
            void window.helixApi.openNoteWindow(
              ws.id,
              ws.path,
              note.path,
              note.id,
              note.title,
            );
          }}
          onSelectFile={(entry) => void handleAttachFileToContext(entry)}
        />
      ) : null}
      {isAddingWorkspace ? (
        <AddWorkspaceDialog
          onClose={() => setIsAddingWorkspace(false)}
          onAdd={onConfirmAddWorkspace}
        />
      ) : null}
    </div>
  );
}

interface ChatViewProps {
  readonly activeWorkspace: WorkspaceRecord | undefined;
  readonly activeSession: SessionRecord | undefined;
  readonly setMessages: (
    id: string,
    messages: readonly TranscriptMessage[],
  ) => void;
  readonly setContextResetAt: (
    id: string,
    timestamp: string | undefined,
  ) => void;
  readonly createSession: () => string;
  /** Ref attached to the rendered Composer so the parent (App) can push
   * workspace files into pending context when the user clicks them in the
   * right sidebar. */
  readonly composerRef?: Ref<ComposerHandle>;
}

function PaneFallback() {
  return <div className="pane-fallback" role="status" aria-live="polite" />;
}

function ChatView({
  activeWorkspace,
  activeSession,
  setMessages,
  setContextResetAt,
  createSession,
  composerRef,
}: ChatViewProps) {
  const { activeProvider } = useProviders();
  const messages = activeSession?.transcript ?? EMPTY_MESSAGES;
  const contextResetAt = activeSession?.contextResetAt;
  // Per-session model override. Kept here (not in ProviderConfig) so picking
  // a model from the composer doesn't mutate the persisted provider — it's
  // a transient choice that resets when the user switches providers.
  const [selectedModel, setSelectedModel] = useState<string | undefined>(
    undefined,
  );
  // Reset the override whenever the provider changes — a model id from one
  // provider isn't necessarily valid on another.
  useEffect(() => {
    setSelectedModel(undefined);
  }, [activeProvider?.id]);

  // Track the active session id in a ref so streaming chunks within one
  // send() flow don't see a stale undefined and re-create on every chunk.
  const activeIdRef = useRef<string | undefined>(activeSession?.id);
  useEffect(() => {
    activeIdRef.current = activeSession?.id;
  }, [activeSession?.id]);

  const onMessagesChange = useCallback(
    (next: readonly TranscriptMessage[]) => {
      let id = activeIdRef.current;
      if (!id) {
        id = createSession();
        activeIdRef.current = id;
      }
      setMessages(id, next);
    },
    [createSession, setMessages],
  );

  const onResetContext = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    setContextResetAt(id, new Date().toISOString());
  }, [setContextResetAt]);

  // Hard reset: wipe the visible transcript and clear `contextResetAt`
  // (no leftover divider over an empty list). Used by `/clear` and the
  // built-in `clear` tool. Distinct from the soft reset above, which the
  // context-usage chip uses to free model context without losing scrollback.
  const onClearTranscript = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    setMessages(id, []);
    setContextResetAt(id, undefined);
  }, [setMessages, setContextResetAt]);

  const { isStreaming, error, send, stop } = useChat({
    provider: activeProvider,
    messages,
    onMessagesChange,
    contextResetAt,
  });

  const hasModel = !!(selectedModel || activeProvider?.model);
  const hint = error
    ? error
    : !activeProvider
      ? "No enabled provider. Add one in Settings → Providers."
      : !hasModel
        ? `Provider "${activeProvider.name}" has no default model — pick one or set one in Settings.`
        : undefined;

  return (
    <>
      {activeSession ? (
        <Transcript messages={messages} contextResetAt={contextResetAt} />
      ) : (
        <EmptyChat workspaceName={activeWorkspace?.displayName} />
      )}
      <Composer
        ref={composerRef}
        onSend={(text, extras) => void send(text, extras)}
        onStop={stop}
        disabled={!activeProvider || !hasModel}
        isStreaming={isStreaming}
        hint={hint}
        provider={activeProvider}
        selectedModel={selectedModel}
        onSelectModel={setSelectedModel}
        messages={messages}
        contextResetAt={contextResetAt}
        onResetContext={onResetContext}
        onClearTranscript={onClearTranscript}
        workspacePath={activeWorkspace?.path || undefined}
      />
    </>
  );
}

interface EmptyChatProps {
  readonly workspaceName: string | undefined;
}

function EmptyChat({ workspaceName }: EmptyChatProps) {
  const where = workspaceName
    ? `in ${workspaceName}`
    : "in this workspace";
  return (
    <section className="transcript scroll">
      <div className="transcript-inner empty-chat">
        <div className="empty-chat-card">
          <div className="empty-logo">
            <div className="empty-logo-mark">hx</div>
          </div>
          <h2 className="empty-chat-title">New chat</h2>
          <p className="empty-chat-desc">
            Send a message to start a conversation {where}. Type{" "}
            <kbd>/</kbd> to invoke a skill, or just press <kbd>↵</kbd> to send.
          </p>
        </div>
      </div>
    </section>
  );
}

const EMPTY_MESSAGES: readonly TranscriptMessage[] = [];
