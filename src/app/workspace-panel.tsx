import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { TreeEntry } from "../lib/tauri-api";
import type { WorkspaceRecord } from "./types";

interface WorkspacePanelProps {
  readonly workspace: WorkspaceRecord;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; entries: readonly TreeEntry[] }
  | { kind: "error"; message: string };

export function WorkspacePanel({ workspace }: WorkspacePanelProps) {
  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  // Local expand/collapse state, keyed by folder path. Defaults to "open" for
  // the root level (depth 0) so the user sees something on first paint.
  const [expansion, setExpansion] = useState<Record<string, boolean>>({});

  const fetchTree = useCallback(async (path: string) => {
    try {
      const entries = await window.helixApi.listWorkspaceTree(path);
      return { ok: true as const, entries };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, message };
    }
  }, []);

  // Refetch the tree whenever the active workspace changes, install a fs
  // watcher for live updates, and tear both down on unmount / swap.
  useEffect(() => {
    if (!workspace.path) {
      setLoad({ kind: "ok", entries: [] });
      return;
    }

    let cancelled = false;
    setLoad({ kind: "loading" });
    setExpansion({});

    async function load(path: string) {
      const result = await fetchTree(path);
      if (cancelled) return;
      if (result.ok) setLoad({ kind: "ok", entries: result.entries });
      else setLoad({ kind: "error", message: result.message });
    }

    void load(workspace.path);

    // Install fs watcher and event listener. Multiple notify events can fire
    // for one user save (rename + write + chmod) — debounce 300ms on the
    // renderer so we refetch once per quiescent burst.
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const unlistenPromise = listen("workspace-tree-changed", () => {
      if (cancelled) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (cancelled) return;
        void load(workspace.path);
      }, 300);
    });

    void window.helixApi.watchWorkspace(workspace.path).catch(() => {
      // Watcher failure shouldn't block the panel — the tree still loaded.
    });

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      void window.helixApi.unwatchWorkspace().catch(() => undefined);
      void unlistenPromise.then((un) => un()).catch(() => undefined);
    };
  }, [workspace.id, workspace.path, fetchTree]);

  // Filter to visible entries: skip anything under a collapsed folder.
  const visibleEntries = useMemo(() => {
    if (load.kind !== "ok") return [];
    const out: TreeEntry[] = [];
    let collapsedAtDepth = Number.POSITIVE_INFINITY;
    for (const entry of load.entries) {
      if (entry.depth > collapsedAtDepth) continue;
      collapsedAtDepth = Number.POSITIVE_INFINITY;
      out.push(entry);
      if (entry.kind === "folder") {
        // Default: depth 0 open, deeper folders closed.
        const openByDefault = entry.depth === 0;
        const isOpen = expansion[entry.path] ?? openByDefault;
        if (!isOpen) collapsedAtDepth = entry.depth;
      }
    }
    return out;
  }, [load, expansion]);

  function toggleFolder(path: string, depth: number) {
    setExpansion((prev) => ({
      ...prev,
      [path]: !(prev[path] ?? depth === 0),
    }));
  }

  return (
    <aside className="panel">
      <div className="panel-header">
        <span className="panel-title">{workspace.displayName}</span>
        <span className="panel-path" title={workspace.path}>
          {workspace.path}
        </span>
      </div>
      <div className="panel-scroll scroll">
        {load.kind === "loading" ? (
          <div className="panel-empty">Loading…</div>
        ) : load.kind === "error" ? (
          <div className="panel-empty panel-error">{load.message}</div>
        ) : load.kind === "ok" && load.entries.length === 0 ? (
          <div className="panel-empty">Empty folder.</div>
        ) : (
          visibleEntries.map((entry) => (
            <TreeRow
              key={entry.path}
              entry={entry}
              expanded={
                entry.kind === "folder"
                  ? (expansion[entry.path] ?? entry.depth === 0)
                  : false
              }
              onToggle={() => toggleFolder(entry.path, entry.depth)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

interface TreeRowProps {
  readonly entry: TreeEntry;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

function TreeRow({ entry, expanded, onToggle }: TreeRowProps) {
  const isFolder = entry.kind === "folder";
  return (
    <button
      type="button"
      className="tree-row"
      data-kind={entry.kind}
      style={{ paddingLeft: 8 + entry.depth * 12 }}
      title={entry.path}
      onClick={isFolder ? onToggle : undefined}
    >
      <span className="tree-row-icon" aria-hidden>
        {isFolder ? (expanded ? <ChevronDownIcon /> : <ChevronRightIcon />) : (
          <FileIcon />
        )}
      </span>
      <span className="tree-row-name">{entry.name}</span>
    </button>
  );
}

function ChevronRightIcon() {
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
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function ChevronDownIcon() {
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
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}
