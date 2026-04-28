import { useCallback, useEffect, useRef, useState } from "react";
import { AddWorkspaceDialog } from "./app/add-workspace-dialog";
import { WorkspacePanel } from "./app/workspace-panel";
import { WorkspaceRail } from "./app/workspace-rail";
import { Sidebar } from "./app/sidebar";
import { Titlebar } from "./app/titlebar";
import {
  createEmptyState,
  type DesktopAppState,
  type SessionRecord,
  type TranscriptMessage,
  type WorkspaceRecord,
} from "./app/types";
import { Composer, Transcript } from "./features/chat";
import { Settings } from "./features/settings";
import { useProviders } from "./features/providers";
import { useChat } from "./hooks/use-chat";
import { useSessions } from "./hooks/use-sessions";
import { useWorkspaces } from "./hooks/use-workspaces";

export function App() {
  const [state, setState] = useState<DesktopAppState>(createEmptyState());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const workspacesApi = useWorkspaces();
  const sessionsApi = useSessions(workspacesApi.activeId);
  const [isAddingWorkspace, setIsAddingWorkspace] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

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

  // The right panel is meaningful only when the active workspace has a path
  // and the chat view (not settings) is active.
  const showPanel =
    panelOpen &&
    state.activeView !== "settings" &&
    !!workspacesApi.activeWorkspace?.path;

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
        onRemoveWorkspace={workspacesApi.removeWorkspace}
        canTogglePanel={!!workspacesApi.activeWorkspace?.path}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((v) => !v)}
      />
      <Sidebar
        workspace={workspacesApi.activeWorkspace}
        sessions={sessionsApi.sessions}
        activeId={sessionsApi.activeId}
        onSelect={sessionsApi.setActive}
        onCreate={sessionsApi.createSession}
        onDelete={sessionsApi.deleteSession}
      />
      <main className="main-pane">
        {isSettings ? (
          <>
            <Titlebar title="Settings" onBack={() => void onSelectView("chat")} />
            <Settings />
          </>
        ) : (
          <>
            <Titlebar
              title={
                sessionsApi.activeSession?.title ??
                workspacesApi.activeWorkspace?.displayName ??
                "helix-ai"
              }
              subtitle={
                sessionsApi.activeSession
                  ? workspacesApi.activeWorkspace?.displayName
                  : "no chat"
              }
            />
            <ChatView
              activeWorkspace={workspacesApi.activeWorkspace}
              activeSession={sessionsApi.activeSession}
              setMessages={sessionsApi.setMessages}
              createSession={sessionsApi.createSession}
            />
          </>
        )}
      </main>
      {showPanel && workspacesApi.activeWorkspace ? (
        <WorkspacePanel
          workspace={workspacesApi.activeWorkspace}
          onClose={() => setPanelOpen(false)}
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
  readonly createSession: () => string;
}

function ChatView({
  activeWorkspace,
  activeSession,
  setMessages,
  createSession,
}: ChatViewProps) {
  const { activeProvider } = useProviders();
  const messages = activeSession?.transcript ?? EMPTY_MESSAGES;

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

  const { isStreaming, error, send } = useChat({
    provider: activeProvider,
    messages,
    onMessagesChange,
  });

  const hint = error
    ? error
    : !activeProvider
      ? "No enabled provider. Add one in Settings → Providers."
      : !activeProvider.model
        ? `Provider "${activeProvider.name}" has no default model — set one in Settings.`
        : undefined;

  return (
    <>
      {activeSession ? (
        <Transcript messages={messages} />
      ) : (
        <EmptyChat workspaceName={activeWorkspace?.displayName} />
      )}
      <Composer
        onSend={(text) => void send(text)}
        disabled={isStreaming || !activeProvider || !activeProvider.model}
        hint={hint}
        modelLabel={activeProvider?.model}
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
