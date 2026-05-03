# helix-ai

Tauri v2 desktop chat client with first-class MCP, OpenAI-compatible LLM
streaming, Claude-style skills, a markdown notes editor, and a workspace
panel that doubles as the model's filesystem.

## Prerequisites

- Node 20+ (pnpm 10+ recommended)
- Rust toolchain 1.80+
- ripgrep on PATH (used by the `search_files` built-in tool; the rest of
  the search surface falls back to an in-process Rust implementation)

## Getting started

```bash
pnpm install
pnpm tauri:dev
```

## Project layout

```
src-tauri/
  Cargo.toml, tauri.conf.json, capabilities/default.json, build.rs
  src/
    main.rs, lib.rs        # Tauri builder + invoke handler registration
    commands.rs            # #[tauri::command] handlers
    types.rs               # serde structs mirroring src/app/types.ts
    mcp/, skills/, workspace/, notes/, search/, data/
                           # Domain modules — MCP transport, skill scanner,
                           # filesystem watcher, notes scanner, ripgrep
                           # bridge, Polars/calamine data tools.

src/
  main.tsx, App.tsx, global.d.ts
  app/                     # App shell (state types, top-level layouts).
    types.ts               # TS mirror of types.rs
    sidebar.tsx, workspace-rail.tsx, main-dock.tsx, titlebar.tsx
    workspace-panel/       # Right-side files + notes pane
    add-workspace-dialog.tsx, confirm-dialog.tsx, brand-mark.tsx
  features/                # User-facing features.
    chat/
      composer/            # Message input, slash commands, model picker,
                           # MCP/builtin palettes, context-window chip
      transcript.tsx       # Message list + streaming + tool-call rows
      mcp-palette.tsx, builtin-palette.tsx
    notes/                 # BlockNote rich editor + CodeMirror markdown
                           # mode, with KaTeX + Vega-Lite block plugins
    providers/             # LLM provider config (OpenAI-compatible)
    settings/              # Settings shell + General/Appearance/Skills/
                           # MCP/Providers panes
  components/              # Generic UI atoms.
    ui/                    # Button, Badge, Card, Sep, Kbd
    markdown.tsx           # Streamdown wrapper with LaTeX + code prefix
                           # normalization, memoized for streaming
    vega-chart.tsx, vega-chart-impl.tsx
                           # Lazy-loaded vega/vega-lite renderer
  hooks/                   # use-chat, use-sessions, use-workspaces,
                           # use-notes, use-mcp-servers, use-skills,
                           # use-models, use-providers, use-theme, ...
  lib/
    api/                   # Tauri command wrappers, split per domain:
                           # core, mcp, skills, builtin-tools, notes,
                           # workspace
    builtin-tools/         # Read/Write/Edit/Glob/Grep + Excel + analyse,
                           # split into defs/dispatcher/formatters/
                           # preferences. Sentinel-routed through the
                           # same agent loop as MCP tools.
    llm/                   # OpenAI-compatible streaming client + model
                           # traits + token estimator
    markdown/              # Streamdown plugins (LaTeX, code prefix, …)
    mcp/                   # Server presets
    notes/, sessions/, workspaces/
                           # localStorage persistence per domain
    tauri-api.ts           # Barrel that assembles helixApi from lib/api/*
    utils.ts               # cn() helper
  styles/
    tokens.css, base.css, layout.css, index.css
    components/            # chat, sidebar, markdown, forms, panel, notes,
                           # dialog — split by domain matching the React tree
  themes/                  # dark / light / meridian variants
```

## Architecture

- **State.** `App.tsx` owns the top-level `DesktopAppState` snapshot. Most
  mutations go through Tauri commands that return the post-write state and
  also push pushes via the `helix://state-changed` event (subscribed to in
  `App.tsx` and a few targeted hooks). Per-domain hooks
  (`useSessions`, `useWorkspaces`, `useNotes`, `useMcpServers`, `useSkills`,
  `useProviders`) wrap localStorage persistence and the Tauri round-trips.
- **Streaming chat.** `useChat` owns the agent loop: send → stream chunks →
  patch the active assistant message in place → if the model requests tool
  calls, run them through MCP or the built-in dispatcher and continue the
  loop. Streamed token patches preserve identity for non-active messages
  so `MessageView` and `Markdown` (both `React.memo`) skip re-renders for
  the rest of the transcript.
- **MCP.** Servers are configured in Settings → MCP and stored in
  `app_data/mcp.json`. The Rust side maintains transports (stdio, SSE,
  streamable-http) and pushes runtime status (`connecting → connected →
  error`) on the state event. Tools, prompts, and resources surface in
  the composer via `McpPalette`. Tool calls from the model are routed by
  `serverId` — the sentinel `__builtin__` runs against the local
  dispatcher in `lib/builtin-tools/`, anything else through the MCP
  transport.
- **Skills.** Claude-Desktop / Claude-Code parity: the backend watches
  `~/.claude/skills` and `<workspace>/.claude/skills`, parses each
  `SKILL.md`, and surfaces them in the slash menu. Metadata (name +
  description) is preloaded into the model's system context on every send;
  the full body is injected only when the user explicitly invokes one with
  `/skill-name args`.
- **Notes.** Markdown files inside the active workspace folder. The Rust
  side scans the folder, the renderer renders via BlockNote (rich) or
  CodeMirror (raw markdown). Vega-Lite, KaTeX inline / display blocks are
  injected as custom BlockNote schema. Detached note windows are real
  Tauri windows hydrated from the same `getNoteRecord` command.
- **Workspace files.** `WorkspacePanel` shows a tree + the notes list. The
  Rust side owns `list_workspace_tree`, `watch_workspace`, and the
  destructive operations (delete/rename/create). Clicking a file pushes
  it into the composer's pending context as if the model had called
  `read_file`.

## Built-in tools

The model sees Read / Write / Edit / Glob / Grep / Search Files / Read PDF /
Read Excel / Analyse Data plus `clear`. They all live in
`src/lib/builtin-tools/` and are advertised through the same OpenAI tool
contract as MCP tools — the `__builtin__` sentinel server id is what tells
`useChat` to route them locally instead of through MCP.

## Scripts

- `pnpm dev` — Vite dev server (renderer only)
- `pnpm tauri:dev` — full desktop dev loop
- `pnpm build` — production renderer bundle
- `pnpm tauri:build` — packaged desktop binary
- `pnpm typecheck` — `tsc --noEmit`

## What's still missing

- No automated tests (manual UAT only)
- No telemetry / error reporting
- Tokenization is approximate (chars/4 + per-message overhead) — the
  context-window chip is an estimate, not exact
