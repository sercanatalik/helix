mod commands;
mod data_tools;
mod mcp;
mod mcp_defaults;
mod skills;
mod tools;
mod types;

use commands::{SharedMcp, SharedSkills, SharedState, WatcherState};
use data_tools::DataFrameStore;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{App, Emitter, Manager};
use types::DesktopAppState;

const STATE_CHANGED_EVENT: &str = "helix://state-changed";

/// Search the usual spots for an `mcp.config.json` shipped alongside the app.
/// Mirrors gcf-desktop's lookup so an existing config file works in either
/// project. Returns `None` when nothing is found — defaults loading is opt-in.
fn resolve_mcp_config(app: &App) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("mcp.config.json"));
        candidates.push(cwd.join("../mcp.config.json"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("mcp.config.json"));
        }
    }
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("mcp.config.json"));
    }
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        candidates.push(PathBuf::from(manifest).join("../mcp.config.json"));
    }
    for candidate in &candidates {
        if candidate.exists() {
            return Some(candidate.canonicalize().unwrap_or_else(|_| candidate.clone()));
        }
    }
    None
}

/// Seed `state.mcp_servers` from a config file the first time the app boots
/// with that file present. Each entry's `sourceKey` is unique per file, so
/// re-running the app doesn't duplicate the seeded record after the user has
/// edited or removed it.
fn seed_default_servers(state: &SharedState, path: &std::path::Path) {
    let entries = mcp_defaults::load_from_path(path);
    if entries.is_empty() {
        return;
    }
    let mut guard = state.lock().expect("state poisoned");
    let existing_keys: std::collections::HashSet<String> = guard
        .mcp_servers
        .iter()
        .filter_map(|s| s.source_key.clone())
        .collect();
    for entry in entries {
        if existing_keys.contains(&entry.source_key) {
            continue;
        }
        let mut config = entry.config;
        config.id = format!("mcp_{}", uuid::Uuid::new_v4().simple());
        guard.mcp_servers.push(config);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::builder()
        .parse_default_env()
        .filter_level(log::LevelFilter::Info)
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage::<SharedState>(Mutex::new(DesktopAppState::default()));
            app.manage::<WatcherState>(Mutex::new(None));
            // Polars-backed data tools store. Lives for the app lifetime;
            // bounded internally via LRU eviction.
            app.manage::<DataFrameStore>(DataFrameStore::new());

            let app_handle = app.handle().clone();
            let manager = Arc::new(mcp::McpManager::new(move |runtime| {
                // Push runtime updates back into shared state, then emit a
                // snapshot the frontend can swap in wholesale. We resolve the
                // state through `AppHandle` so the McpManager doesn't need to
                // own its own clone of the mutex.
                let Some(state) = app_handle.try_state::<SharedState>() else {
                    return;
                };
                let snapshot = {
                    let mut guard = state.lock().expect("state poisoned");
                    guard.mcp_runtime = runtime;
                    guard.clone()
                };
                let _ = app_handle.emit(STATE_CHANGED_EVENT, &snapshot);
            }));
            app.manage::<SharedMcp>(manager.clone());

            if let Some(path) = resolve_mcp_config(app) {
                log::info!("[mcp-defaults] using config path: {}", path.display());
                let state = app.state::<SharedState>();
                seed_default_servers(&state, &path);
            }

            // Kick off the initial sync so any enabled-by-default servers
            // start connecting on launch.
            let initial_configs = app
                .state::<SharedState>()
                .lock()
                .expect("state poisoned")
                .mcp_servers
                .clone();
            if !initial_configs.is_empty() {
                let manager_for_init = manager.clone();
                tauri::async_runtime::spawn(async move {
                    manager_for_init
                        .sync_from_config(initial_configs, None)
                        .await;
                });
            }

            // -- Skills -------------------------------------------------
            //
            // Claude Desktop / Claude Code parity: scan ~/.claude/skills
            // and the active workspace's .claude/skills, watch for live
            // changes, and emit snapshots so the UI updates without a
            // round-trip.
            let app_handle_skills = app.handle().clone();
            let skills_manager = skills::SkillsManager::new(move |skills_list| {
                let Some(state) = app_handle_skills.try_state::<SharedState>() else {
                    return;
                };
                let snapshot = {
                    let mut guard = state.lock().expect("state poisoned");
                    guard.skills = skills_list;
                    guard.clone()
                };
                let _ = app_handle_skills.emit(STATE_CHANGED_EVENT, &snapshot);
            });
            app.manage::<SharedSkills>(skills_manager.clone());
            // Watch the user-level dir up front; project-level gets wired
            // when the frontend calls `set_skills_workspace`. An initial
            // rescan populates the state with whatever's already on disk.
            skills_manager.watch_user_root();
            skills_manager.rescan();

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(manager) = window.try_state::<SharedMcp>() {
                    let manager = manager.inner().clone();
                    tauri::async_runtime::block_on(async move {
                        manager.shutdown().await;
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::get_state,
            commands::set_theme,
            commands::set_active_view,
            commands::list_workspace_tree,
            commands::watch_workspace,
            commands::unwatch_workspace,
            commands::add_mcp_server,
            commands::update_mcp_server,
            commands::remove_mcp_server,
            commands::reconnect_mcp_server,
            commands::set_mcp_tool_enabled,
            commands::set_mcp_prompt_enabled,
            commands::call_mcp_prompt,
            commands::read_mcp_resource,
            commands::call_mcp_tool,
            commands::test_mcp_server,
            commands::set_skills_workspace,
            commands::reload_skills,
            commands::render_skill,
            tools::read_file,
            tools::read_pdf,
            tools::write_file,
            tools::edit_file,
            tools::glob_files,
            tools::grep_search,
            tools::search_files,
            data_tools::read_excel,
            data_tools::analyse_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
