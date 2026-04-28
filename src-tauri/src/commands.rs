use crate::types::{AppView, DesktopAppState, ThemeId};
use std::sync::Mutex;
use tauri::State;

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
