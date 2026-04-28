# helix-ai

Minimal desktop scaffold modeled on `gcf-desktop`. This is the bare structural
skeleton — Tauri v2 + Rust backend + React + Vite — with no LLM integration, no
MCP, no design system, and no UI styling beyond a tiny CSS reset.

## Prerequisites

- Node 20+ (pnpm 10+ recommended)
- Rust toolchain 1.80+

## Getting started

```bash
pnpm install
pnpm tauri:dev
```

## Project layout

```
src-tauri/
  Cargo.toml               # name = "helix-ai"
  tauri.conf.json          # window + bundle config
  capabilities/default.json
  build.rs
  src/
    main.rs, lib.rs        # Tauri builder + invoke handler registration
    commands.rs            # #[tauri::command] handlers (ping, get_state)
    types.rs               # serde structs mirroring src/types.ts

src/
  main.tsx                 # React entrypoint, installs window.helixApi
  App.tsx                  # top-level layout
  sidebar.tsx              # placeholder
  composer.tsx             # placeholder
  transcript.tsx           # placeholder
  settings.tsx             # placeholder
  types.ts                 # shared state types (TS mirror of types.rs)
  global.d.ts              # window.helixApi declaration
  lib/
    tauri-api.ts           # invoke wrapper exposed as window.helixApi
    utils.ts               # cn() helper
  styles/
    styles.css             # minimal reset
  components/              # reserved for future UI components
  hooks/                   # reserved for future hooks
```

## What's intentionally absent

- LLM client (LiteLLM, OpenAI, Anthropic, etc.)
- MCP support
- Tailwind / shadcn / design tokens
- Persistence layer
- Streaming, agents, skills, workspace tooling

These will be added in follow-up phases.
