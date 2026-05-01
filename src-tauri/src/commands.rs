use crate::mcp::{CallToolOutcome, McpManager, McpTestResult};
use crate::skills::{self, SkillsManager};
use crate::types::{
    AppView, DesktopAppState, McpPromptResult, McpResourceResult, McpServerConfig, McpServerInput,
    McpServerPatch, Skill, ThemeId,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

/// Single source of truth for app state while in-memory. Persistence will
/// arrive in a follow-up phase; the frontend already caches theme in
/// localStorage to keep first paint snappy.
pub type SharedState = Mutex<DesktopAppState>;

/// The MCP client manager — holds live `rmcp` connections and reconciles them
/// against `DesktopAppState.mcp_servers`. Mutations to the server list trigger
/// `sync_from_config`, which connects/disconnects on a background task; the
/// manager pushes runtime updates back into `DesktopAppState.mcp_runtime` via
/// the `on_change` callback installed in `lib.rs`.
pub type SharedMcp = Arc<McpManager>;

/// The skills manager — owns filesystem watchers for `~/.claude/skills` and
/// the active workspace's `.claude/skills`, re-scanning on every change so
/// `DesktopAppState.skills` stays in sync with on-disk SKILL.md files.
pub type SharedSkills = Arc<SkillsManager>;

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}

#[tauri::command]
pub fn get_state(state: State<'_, SharedState>) -> DesktopAppState {
    state.lock().expect("state poisoned").clone()
}

#[tauri::command]
pub fn set_theme(theme: ThemeId, state: State<'_, SharedState>) -> DesktopAppState {
    let mut guard = state.lock().expect("state poisoned");
    guard.theme = theme;
    guard.clone()
}

#[tauri::command]
pub fn set_active_view(view: AppView, state: State<'_, SharedState>) -> DesktopAppState {
    let mut guard = state.lock().expect("state poisoned");
    guard.active_view = view;
    guard.clone()
}

/// One node of a flattened folder tree. The frontend handles expand/collapse
/// state on its own — we send everything up to the cap and depth limit, the
/// UI decides what's visible.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    /// Absolute path on disk.
    pub path: String,
    /// Display name (basename).
    pub name: String,
    /// `"folder"` or `"file"`.
    pub kind: &'static str,
    /// 0 for direct children of the workspace root, 1 for grandchildren, …
    pub depth: u32,
    /// File size in bytes; absent for folders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

const MAX_DEPTH: u32 = 4;
const MAX_ENTRIES: usize = 1500;

/// Folders and files we don't want to show by default — heavy or generated.
fn is_noise(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".svn"
            | ".hg"
            | ".DS_Store"
            | "node_modules"
            | "dist"
            | "build"
            | "target"
            | ".next"
            | ".turbo"
            | ".cache"
            | ".idea"
            | ".vscode"
            | "__pycache__"
            | ".venv"
            | "venv"
            | ".pytest_cache"
            | ".mypy_cache"
    ) || name.starts_with('.') && name.len() > 1
}

fn walk_dir(dir: &Path, depth: u32, out: &mut Vec<TreeEntry>) {
    if depth > MAX_DEPTH || out.len() >= MAX_ENTRIES {
        return;
    }
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };

    let mut folders: Vec<(String, PathBuf)> = Vec::new();
    let mut files: Vec<(String, PathBuf)> = Vec::new();

    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_noise(&name) {
            continue;
        }
        let path = entry.path();
        let kind = entry.file_type().ok();
        if kind.map(|k| k.is_dir()).unwrap_or(false) {
            folders.push((name, path));
        } else if kind.map(|k| k.is_file()).unwrap_or(false) {
            files.push((name, path));
        }
    }

    folders.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    files.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

    for (name, path) in folders {
        if out.len() >= MAX_ENTRIES {
            return;
        }
        out.push(TreeEntry {
            path: path.to_string_lossy().to_string(),
            name,
            kind: "folder",
            depth,
            size: None,
        });
        walk_dir(&path, depth + 1, out);
    }
    for (name, path) in files {
        if out.len() >= MAX_ENTRIES {
            return;
        }
        let size = std::fs::metadata(&path).ok().map(|m| m.len());
        out.push(TreeEntry {
            path: path.to_string_lossy().to_string(),
            name,
            kind: "file",
            depth,
            size,
        });
    }
}

/// List the contents of a workspace folder, depth-limited and noise-filtered.
/// Returns a flat list in display order (folders first, recursive).
#[tauri::command]
pub fn list_workspace_tree(path: String) -> Result<Vec<TreeEntry>, String> {
    let root = PathBuf::from(&path);
    if !root.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut out = Vec::new();
    walk_dir(&root, 0, &mut out);
    Ok(out)
}

/// Holds the active workspace folder watcher, if any. Only one folder is
/// watched at a time — switching workspaces drops the previous watcher and
/// installs a new one.
pub type WatcherState = Mutex<Option<RecommendedWatcher>>;

/// Start watching the given folder for filesystem changes. Emits a
/// `workspace-tree-changed` Tauri event on every change; the renderer
/// debounces and refetches the tree.
#[tauri::command]
pub fn watch_workspace(
    app: AppHandle,
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let mut guard = state.lock().expect("watcher poisoned");
    // Drop existing watcher first — its OS handles release as it goes out
    // of scope.
    *guard = None;

    let app_handle = app.clone();
    let mut watcher = notify::recommended_watcher(
        move |res: notify::Result<notify::Event>| {
            // Ignore raw errors — notify can produce them transiently when
            // files vanish mid-event. Emit once per change; the renderer
            // debounces.
            if res.is_ok() {
                let _ = app_handle.emit("workspace-tree-changed", ());
            }
        },
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    *guard = Some(watcher);
    Ok(())
}

/// Stop the active workspace watcher (if any). Idempotent.
#[tauri::command]
pub fn unwatch_workspace(state: State<'_, WatcherState>) -> Result<(), String> {
    let mut guard = state.lock().expect("watcher poisoned");
    *guard = None;
    Ok(())
}

// -- MCP -----------------------------------------------------------------

fn snapshot_mcp_configs(state: &State<'_, SharedState>) -> Vec<McpServerConfig> {
    state
        .lock()
        .expect("state poisoned")
        .mcp_servers
        .clone()
}

/// Spawn a background sync against the manager's current desired set. Helix
/// has no basic-auth concept yet, so the token is always `None` — the field
/// is preserved on the wire for parity with gcf-desktop.
fn spawn_mcp_sync(mcp: SharedMcp, configs: Vec<McpServerConfig>) {
    tauri::async_runtime::spawn(async move {
        mcp.sync_from_config(configs, None).await;
    });
}

fn normalize_input(input: McpServerInput) -> McpServerInput {
    let mut out = input;
    out.name = out.name.trim().to_string();
    if out.name.is_empty() {
        out.name = "Untitled MCP server".to_string();
    }
    out
}

fn apply_patch(server: &mut McpServerConfig, patch: McpServerPatch) {
    if let Some(name) = patch.name {
        server.name = name;
    }
    if let Some(enabled) = patch.enabled {
        server.enabled = enabled;
    }
    if let Some(transport) = patch.transport {
        server.transport = transport;
    }
    if let Some(url) = patch.url {
        server.url = if url.is_empty() { None } else { Some(url) };
    }
    if let Some(command) = patch.command {
        server.command = if command.is_empty() {
            None
        } else {
            Some(command)
        };
    }
    if let Some(args) = patch.args {
        server.args = if args.is_empty() { None } else { Some(args) };
    }
    if let Some(env) = patch.env {
        server.env = if env.is_empty() { None } else { Some(env) };
    }
    if let Some(headers) = patch.custom_headers {
        server.custom_headers = if headers.is_empty() {
            None
        } else {
            Some(headers)
        };
    }
    if let Some(attach) = patch.attach_basic_auth_header {
        server.attach_basic_auth_header = if attach { Some(true) } else { None };
    }
    if let Some(source_key) = patch.source_key {
        server.source_key = if source_key.is_empty() {
            None
        } else {
            Some(source_key)
        };
    }
    if let Some(disabled) = patch.disabled_tools {
        server.disabled_tools = if disabled.is_empty() {
            None
        } else {
            Some(disabled)
        };
    }
    if let Some(enabled_prompts) = patch.enabled_prompts {
        server.enabled_prompts = if enabled_prompts.is_empty() {
            None
        } else {
            Some(enabled_prompts)
        };
    }
}

#[tauri::command]
pub fn add_mcp_server(
    input: McpServerInput,
    state: State<'_, SharedState>,
    mcp: State<'_, SharedMcp>,
) -> DesktopAppState {
    let normalized = normalize_input(input);
    let config = McpServerConfig {
        id: format!("mcp_{}", Uuid::new_v4().simple()),
        name: normalized.name,
        enabled: normalized.enabled,
        transport: normalized.transport,
        url: normalized.url,
        command: normalized.command,
        args: normalized.args,
        env: normalized.env,
        custom_headers: normalized.custom_headers,
        attach_basic_auth_header: normalized.attach_basic_auth_header,
        source_key: normalized.source_key,
        disabled_tools: normalized.disabled_tools,
        enabled_prompts: normalized.enabled_prompts,
    };
    let snapshot = {
        let mut guard = state.lock().expect("state poisoned");
        guard.mcp_servers.push(config);
        guard.clone()
    };
    spawn_mcp_sync(mcp.inner().clone(), snapshot.mcp_servers.clone());
    snapshot
}

#[tauri::command]
pub fn update_mcp_server(
    id: String,
    patch: McpServerPatch,
    state: State<'_, SharedState>,
    mcp: State<'_, SharedMcp>,
) -> DesktopAppState {
    let snapshot = {
        let mut guard = state.lock().expect("state poisoned");
        for server in guard.mcp_servers.iter_mut() {
            if server.id == id {
                apply_patch(server, patch);
                break;
            }
        }
        guard.clone()
    };
    spawn_mcp_sync(mcp.inner().clone(), snapshot.mcp_servers.clone());
    snapshot
}

#[tauri::command]
pub fn remove_mcp_server(
    id: String,
    state: State<'_, SharedState>,
    mcp: State<'_, SharedMcp>,
) -> DesktopAppState {
    let snapshot = {
        let mut guard = state.lock().expect("state poisoned");
        guard.mcp_servers.retain(|s| s.id != id);
        guard.mcp_runtime.remove(&id);
        guard.clone()
    };
    spawn_mcp_sync(mcp.inner().clone(), snapshot.mcp_servers.clone());
    snapshot
}

#[tauri::command]
pub async fn reconnect_mcp_server(
    id: String,
    state: State<'_, SharedState>,
    mcp: State<'_, SharedMcp>,
) -> Result<DesktopAppState, String> {
    let manager = mcp.inner().clone();
    manager.force_disconnect(&id).await;
    let configs = snapshot_mcp_configs(&state);
    manager.sync_from_config(configs, None).await;
    Ok(state.lock().expect("state poisoned").clone())
}

#[tauri::command]
pub fn set_mcp_tool_enabled(
    server_id: String,
    tool_name: String,
    enabled: bool,
    state: State<'_, SharedState>,
) -> DesktopAppState {
    let mut guard = state.lock().expect("state poisoned");
    for server in guard.mcp_servers.iter_mut() {
        if server.id != server_id {
            continue;
        }
        let mut disabled = server.disabled_tools.clone().unwrap_or_default();
        if enabled {
            disabled.retain(|n| n != &tool_name);
        } else if !disabled.iter().any(|n| n == &tool_name) {
            disabled.push(tool_name.clone());
        }
        server.disabled_tools = if disabled.is_empty() {
            None
        } else {
            Some(disabled)
        };
        break;
    }
    guard.clone()
}

/// Toggle a prompt's "always inject as system context" flag. Mirrors
/// `set_mcp_tool_enabled` but with reversed default semantics — prompts are
/// opt-in, so the field stores the *enabled* set rather than the disabled set.
#[tauri::command]
pub fn set_mcp_prompt_enabled(
    server_id: String,
    prompt_name: String,
    enabled: bool,
    state: State<'_, SharedState>,
) -> DesktopAppState {
    let mut guard = state.lock().expect("state poisoned");
    for server in guard.mcp_servers.iter_mut() {
        if server.id != server_id {
            continue;
        }
        let mut active = server.enabled_prompts.clone().unwrap_or_default();
        if enabled {
            if !active.iter().any(|n| n == &prompt_name) {
                active.push(prompt_name.clone());
            }
        } else {
            active.retain(|n| n != &prompt_name);
        }
        server.enabled_prompts = if active.is_empty() {
            None
        } else {
            Some(active)
        };
        break;
    }
    guard.clone()
}

#[tauri::command]
pub async fn call_mcp_prompt(
    server_id: String,
    name: String,
    args: HashMap<String, String>,
    mcp: State<'_, SharedMcp>,
) -> Result<McpPromptResult, String> {
    Ok(mcp.inner().get_prompt(&server_id, &name, args).await)
}

#[tauri::command]
pub async fn read_mcp_resource(
    server_id: String,
    uri: String,
    mcp: State<'_, SharedMcp>,
) -> Result<McpResourceResult, String> {
    Ok(mcp.inner().read_resource(&server_id, &uri).await)
}

/// Call a tool on a connected MCP server. The arguments shape mirrors what
/// an LLM tool-use payload carries (a JSON object); non-object values get
/// wrapped under a `value` key so primitives still round-trip. Returns the
/// flattened text content plus an `isError` flag so the agent loop can
/// surface tool failures distinctly from successful but empty results.
#[tauri::command]
pub async fn call_mcp_tool(
    server_id: String,
    tool_name: String,
    args: serde_json::Value,
    mcp: State<'_, SharedMcp>,
) -> Result<CallToolOutcome, String> {
    Ok(mcp.inner().call_tool(&server_id, &tool_name, args).await)
}

// -- Skills --------------------------------------------------------------

/// Switch the project skills root being watched. Pass `None` (or an empty
/// string) when no workspace is active; pass the workspace's absolute path
/// otherwise. Triggers an immediate rescan; the resulting skills list is
/// pushed back synchronously via the `SkillsManager` on_change callback,
/// so the snapshot we return already reflects it.
#[tauri::command]
pub fn set_skills_workspace(
    workspace: Option<String>,
    state: State<'_, SharedState>,
    skills_state: State<'_, SharedSkills>,
) -> DesktopAppState {
    let path = workspace.and_then(|p| {
        let trimmed = p.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(PathBuf::from(trimmed))
        }
    });
    skills_state.inner().set_workspace(path);
    state.lock().expect("state poisoned").clone()
}

/// Force a manual rescan. Useful for a "Refresh" button in the skills pane
/// or when the user creates `.claude/skills/` for the first time (the
/// watcher won't have fired since the directory didn't exist when the
/// manager started).
#[tauri::command]
pub fn reload_skills(
    state: State<'_, SharedState>,
    skills_state: State<'_, SharedSkills>,
) -> DesktopAppState {
    skills_state.inner().rescan();
    state.lock().expect("state poisoned").clone()
}

/// Render a skill into the string the frontend should send as a hidden
/// system message. Substitutes the user-supplied argument string into the
/// SKILL.md body following Claude Code's substitution rules
/// (`$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, named placeholders).
#[tauri::command]
pub fn render_skill(
    skill_id: String,
    arguments: Option<String>,
    state: State<'_, SharedState>,
) -> Result<String, String> {
    let guard = state.lock().expect("state poisoned");
    let skill: &Skill = guard
        .skills
        .iter()
        .find(|s| s.id == skill_id)
        .ok_or_else(|| format!("unknown skill id: {skill_id}"))?;
    if let Some(err) = &skill.error {
        return Err(format!("skill {skill_id} is broken: {err}"));
    }
    let raw = arguments.unwrap_or_default();
    let named = skill.arguments.clone().unwrap_or_default();
    Ok(skills::substitute_arguments(&skill.body, &raw, &named))
}

/// One-shot connection test against the supplied server input. Spawns a
/// fresh transport, runs the MCP handshake, lists tools/prompts/resources,
/// then drops the connection. Independent of the persistent `McpManager`
/// state — used by the form's "Test connection" button so the user can
/// validate URL / command / args before saving (and without disturbing any
/// already-connected sessions).
#[tauri::command]
pub async fn test_mcp_server(input: McpServerInput) -> McpTestResult {
    // The id never reaches the wire — the test just needs valid transport
    // fields. Use a sentinel so any error log entries are recognisable.
    let probe = McpServerConfig {
        id: "__test__".to_string(),
        name: input.name,
        // The test connects regardless of the user's "enabled on launch" flag —
        // they're explicitly asking us to dial it now.
        enabled: true,
        transport: input.transport,
        url: input.url,
        command: input.command,
        args: input.args,
        env: input.env,
        custom_headers: input.custom_headers,
        attach_basic_auth_header: input.attach_basic_auth_header,
        source_key: input.source_key,
        disabled_tools: input.disabled_tools,
        enabled_prompts: input.enabled_prompts,
    };
    crate::mcp::test_connection(&probe).await
}
