import { useCallback, useEffect, useState } from "react";
import { WorkspaceRail } from "./app/workspace-rail";
import { Sidebar } from "./app/sidebar";
import { Titlebar } from "./app/titlebar";
import { createEmptyState, type DesktopAppState } from "./app/types";
import { Composer, Transcript } from "./features/chat";
import { Settings } from "./features/settings";

export function App() {
  const [state, setState] = useState<DesktopAppState>(createEmptyState());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
    <div className="app-shell" data-sidebar-collapsed={sidebarCollapsed}>
      <WorkspaceRail
        activeView={state.activeView}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
        collapsed={sidebarCollapsed}
        onOpenSettings={() => void onSelectView("settings")}
      />
      <Sidebar />
      <main className="main-pane">
        {isSettings ? (
          <>
            <Titlebar title="Settings" onBack={() => void onSelectView("chat")} />
            <Settings />
          </>
        ) : (
          <>
            <Titlebar title="helix-ai" subtitle="scaffold" />
            <ChatView />
          </>
        )}
      </main>
    </div>
  );
}

function ChatView() {
  return (
    <>
      <Transcript />
      <Composer />
    </>
  );
}
