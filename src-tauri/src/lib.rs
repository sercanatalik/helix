mod commands;
mod types;

use commands::SharedState;
use std::sync::Mutex;
use tauri::Manager;
use types::DesktopAppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage::<SharedState>(Mutex::new(DesktopAppState::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::get_state,
            commands::set_theme,
            commands::set_active_view,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
