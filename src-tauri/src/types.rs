use crate::notes::NoteRecord;
use serde::{Deserialize, Serialize};
use serde_json::Value;
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

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    #[default]
    Http,
    Stdio,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpConnectionStatus {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomHeader {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub transport: McpTransport,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub custom_headers: Option<Vec<CustomHeader>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub attach_basic_auth_header: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_key: Option<String>,
    /// Tools the user has hidden from the model. Opt-out: any tool not in
    /// this list is exposed by default. Mirrors gcf-desktop's contract.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub disabled_tools: Option<Vec<String>>,
    /// Prompts the user has chosen to inject as hidden system context on
    /// every message. Opt-in: prompts default to off because auto-injecting
    /// every advertised prompt would balloon the model's context.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub enabled_prompts: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    pub name: String,
    pub enabled: bool,
    pub transport: McpTransport,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub custom_headers: Option<Vec<CustomHeader>>,
    #[serde(default)]
    pub attach_basic_auth_header: Option<bool>,
    #[serde(default)]
    pub source_key: Option<String>,
    #[serde(default)]
    pub disabled_tools: Option<Vec<String>>,
    #[serde(default)]
    pub enabled_prompts: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub transport: Option<McpTransport>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub custom_headers: Option<Vec<CustomHeader>>,
    #[serde(default)]
    pub attach_basic_auth_header: Option<bool>,
    #[serde(default)]
    pub source_key: Option<String>,
    #[serde(default)]
    pub disabled_tools: Option<Vec<String>>,
    #[serde(default)]
    pub enabled_prompts: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub input_schema: Option<Value>,
    /// Tags advertised by the server. FastMCP exposes these under
    /// `_meta._fastmcp.tags`; we also accept a top-level `tags` array as a
    /// fallback for servers that surface them directly.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tags: Vec<String>,
    /// The full `_meta` payload as advertised by the server, passed through
    /// verbatim. FastMCP namespaces extras under keys like `_fastmcp`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub meta: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPromptArg {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub required: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpPromptInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub arguments: Option<Vec<McpPromptArg>>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub meta: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceInfo {
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub meta: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRuntime {
    pub status: McpConnectionStatus,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
    pub tools: Vec<McpToolInfo>,
    pub prompts: Vec<McpPromptInfo>,
    pub resources: Vec<McpResourceInfo>,
    /// Errors returned by `tools/list`, `prompts/list`, `resources/list` when
    /// they were attempted on a connected server. Stored separately so a
    /// failure on one capability doesn't blank out the others. None means the
    /// list call succeeded (possibly with zero results).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tools_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub prompts_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub resources_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_connected_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPromptMessage {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPromptResult {
    pub messages: Vec<McpPromptMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceResult {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// -- Skills (Claude Desktop / Claude Code parity) ---------------------------

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
    /// Embedded in the helix binary at compile time. Always available, no
    /// filesystem dependency. Lowest precedence: a same-named user or
    /// project skill overrides it.
    Builtin,
    /// Loaded from `~/.claude/skills/`. Available across all workspaces.
    User,
    /// Loaded from `<workspace>/.claude/skills/`. Project-scoped; takes
    /// precedence over a same-named user skill.
    Project,
}

/// Parsed YAML frontmatter from a `SKILL.md`. Internal — gets folded into
/// the public `Skill` struct so the wire format is flat.
#[derive(Clone, Debug, Default)]
pub struct SkillFrontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
    pub when_to_use: Option<String>,
    pub argument_hint: Option<String>,
    pub arguments: Option<Vec<String>>,
    pub disable_model_invocation: Option<bool>,
    pub user_invocable: Option<bool>,
    pub allowed_tools: Option<Vec<String>>,
    pub paths: Option<Vec<String>>,
}

/// A skill discovered on disk — wire-shape mirrors what Claude Code's
/// frontmatter exposes plus a few helix-specific fields (`id`, `source`,
/// `error`) the UI needs to render the skills list.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    /// Stable id derived from `<source>::<directory-name>`. Survives reloads
    /// so the frontend can keep selection / pending-invocation state across
    /// filesystem refreshes.
    pub id: String,
    /// Display name. Frontmatter `name` if present, otherwise the directory
    /// name (matches Claude Code's fallback rules).
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub when_to_use: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub argument_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub arguments: Option<Vec<String>>,
    pub disable_model_invocation: bool,
    pub user_invocable: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub paths: Option<Vec<String>>,
    /// The markdown content following the frontmatter. Pre-loaded so the
    /// frontend can invoke a skill without a follow-up round-trip.
    pub body: String,
    pub source: SkillSource,
    /// Absolute path of the skill folder.
    pub directory: String,
    /// Absolute path of the `SKILL.md` file. Useful for "Open in editor".
    pub skill_md_path: String,
    /// Populated when frontmatter parsing or file reading failed. The skill
    /// still appears in the list so the user can fix it; `body` is empty in
    /// that case.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
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
    pub mcp_servers: Vec<McpServerConfig>,
    pub mcp_runtime: HashMap<String, McpServerRuntime>,
    /// Skills discovered under `~/.claude/skills` and the active
    /// workspace's `.claude/skills`. Live-updated as files change on disk.
    pub skills: Vec<Skill>,
    /// Markdown notes scanned out of the active workspace folder. Empty
    /// when no workspace is attached or when the active workspace has no
    /// `.md` files. Refreshed on demand by `list_notes`.
    pub notes: Vec<NoteRecord>,
}
