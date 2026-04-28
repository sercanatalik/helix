use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ThemeId {
    #[serde(rename = "dark")]
    Dark,
    #[serde(rename = "light")]
    Light,
    #[serde(rename = "meridian-dark")]
    MeridianDark,
    #[serde(rename = "meridian-light")]
    MeridianLight,
}

impl Default for ThemeId {
    fn default() -> Self {
        Self::MeridianLight
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppView {
    Chat,
    Settings,
}

impl Default for AppView {
    fn default() -> Self {
        Self::Chat
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub path: String,
    pub display_name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAppState {
    pub workspaces: Vec<WorkspaceRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_workspace_id: Option<String>,
    pub sessions: HashMap<String, serde_json::Value>,
    pub selected_session_id_by_workspace: HashMap<String, Option<String>>,
    pub theme: ThemeId,
    pub active_view: AppView,
}
