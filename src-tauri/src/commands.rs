use crate::types::{AppView, DesktopAppState, ThemeId};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// Single source of truth for app state while in-memory. Persistence will
/// arrive in a follow-up phase; the frontend already caches theme in
/// localStorage to keep first paint snappy.
pub type SharedState = Mutex<DesktopAppState>;

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
