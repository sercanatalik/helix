mod commands;
mod types;

use commands::{SharedState, WatcherState};
use std::sync::Mutex;
use tauri::Manager;
use types::DesktopAppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage::<SharedState>(Mutex::new(DesktopAppState::default()));
            app.manage::<WatcherState>(Mutex::new(None));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::get_state,
            commands::set_theme,
            commands::set_active_view,
            commands::list_workspace_tree,
            commands::watch_workspace,
            commands::unwatch_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
