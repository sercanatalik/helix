use std::collections::HashMap;
use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, GetPromptRequestParams, RawContent, ReadResourceRequestParams,
};
use rmcp::service::RunningService;
use rmcp::transport::child_process::TokioChildProcess;
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use rmcp::{RoleClient, ServiceExt};
use reqwest::header::{HeaderName, HeaderValue};
use serde::Serialize;
use serde_json::{Map as JsonMap, Value};
use time::OffsetDateTime;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::types::{
    McpConnectionStatus, McpPromptArg, McpPromptInfo, McpPromptMessage, McpPromptResult,
    McpResourceInfo, McpResourceResult, McpServerConfig, McpServerRuntime, McpToolInfo,
    McpTransport,
};

type ClientService = Arc<RunningService<RoleClient, ()>>;

struct Entry {
    #[allow(dead_code)]
    config: McpServerConfig,
    client: ClientService,
    config_hash: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallToolOutcome {
    pub content: String,
    pub is_error: bool,
}

pub struct McpManager {
    inner: Arc<Mutex<Inner>>,
    on_change: Arc<dyn Fn(HashMap<String, McpServerRuntime>) + Send + Sync>,
}

struct Inner {
    entries: HashMap<String, Entry>,
    runtime: HashMap<String, McpServerRuntime>,
    syncing: bool,
    resync_requested: Option<PendingSync>,
}

struct PendingSync {
    configs: Vec<McpServerConfig>,
    basic_auth_token: Option<String>,
}

impl McpManager {
    pub fn new<F>(on_change: F) -> Self
    where
        F: Fn(HashMap<String, McpServerRuntime>) + Send + Sync + 'static,
    {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                entries: HashMap::new(),
                runtime: HashMap::new(),
                syncing: false,
                resync_requested: None,
            })),
            on_change: Arc::new(on_change),
        }
    }

    #[allow(dead_code)]
    pub async fn runtime_snapshot(&self) -> HashMap<String, McpServerRuntime> {
        self.inner.lock().await.runtime.clone()
    }

    pub async fn sync_from_config(
        &self,
        configs: Vec<McpServerConfig>,
        basic_auth_token: Option<String>,
    ) {
        {
            let mut guard = self.inner.lock().await;
            if guard.syncing {
                guard.resync_requested = Some(PendingSync {
                    configs,
                    basic_auth_token,
                });
                return;
            }
            guard.syncing = true;
        }

        let mut current_configs = configs;
        let mut current_token = basic_auth_token;
        loop {
            self.do_sync(current_configs, current_token).await;
            let mut guard = self.inner.lock().await;
            if let Some(pending) = guard.resync_requested.take() {
                current_configs = pending.configs;
                current_token = pending.basic_auth_token;
                continue;
            }
            guard.syncing = false;
            break;
        }
    }

    async fn do_sync(
        &self,
        configs: Vec<McpServerConfig>,
        basic_auth_token: Option<String>,
    ) {
        // Build wanted map of enabled servers.
        let mut wanted: HashMap<String, McpServerConfig> = HashMap::new();
        for c in configs.iter() {
            if c.enabled {
                wanted.insert(c.id.clone(), c.clone());
            }
        }

        // Disconnect anything not wanted or whose hash changed.
        let to_disconnect: Vec<(String, bool)> = {
            let guard = self.inner.lock().await;
            guard
                .entries
                .iter()
                .map(|(id, entry)| {
                    let mut should_disconnect = true;
                    if let Some(w) = wanted.get(id) {
                        let new_hash = hash_config(w);
                        if new_hash == entry.config_hash {
                            should_disconnect = false;
                        }
                    }
                    (id.clone(), should_disconnect)
                })
                .filter(|(_, flag)| *flag)
                .collect()
        };
        for (id, _) in to_disconnect {
            self.disconnect(&id).await;
        }

        // Clean runtime entries for servers removed from config entirely.
        {
            let existing_ids: std::collections::HashSet<String> =
                configs.iter().map(|c| c.id.clone()).collect();
            let mut guard = self.inner.lock().await;
            guard
                .runtime
                .retain(|id, _| existing_ids.contains(id));
        }

        // Reflect disconnected state for disabled but-present servers.
        for c in configs.iter() {
            if c.enabled {
                continue;
            }
            let mut guard = self.inner.lock().await;
            let needs_update = guard
                .runtime
                .get(&c.id)
                .map(|rt| rt.status != McpConnectionStatus::Disconnected)
                .unwrap_or(true);
            if needs_update {
                guard.runtime.insert(
                    c.id.clone(),
                    McpServerRuntime {
                        status: McpConnectionStatus::Disconnected,
                        ..Default::default()
                    },
                );
            }
        }

        // Connect any wanted server that isn't connected yet.
        let to_connect: Vec<McpServerConfig> = {
            let guard = self.inner.lock().await;
            wanted
                .values()
                .filter(|w| !guard.entries.contains_key(&w.id))
                .cloned()
                .collect()
        };
        for cfg in to_connect {
            self.connect(cfg, basic_auth_token.clone()).await;
        }

        self.emit_runtime().await;
    }

    async fn connect(
        &self,
        config: McpServerConfig,
        _basic_auth_token: Option<String>,
    ) {
        self.set_runtime(
            &config.id,
            McpServerRuntime {
                status: McpConnectionStatus::Connecting,
                ..Default::default()
            },
        )
        .await;
        self.emit_runtime().await;

        let connect_result = build_and_connect(&config).await;
        match connect_result {
            Ok(client) => {
                let client: ClientService = Arc::new(client);
                let (tools, tools_error) = safe_list_tools(&client).await;
                let (prompts, prompts_error) = safe_list_prompts(&client).await;
                let (resources, resources_error) =
                    safe_list_resources(&client).await;
                let now = current_iso8601();

                {
                    let mut guard = self.inner.lock().await;
                    let hash = hash_config(&config);
                    guard.entries.insert(
                        config.id.clone(),
                        Entry {
                            config: config.clone(),
                            client: client.clone(),
                            config_hash: hash,
                        },
                    );
                    guard.runtime.insert(
                        config.id.clone(),
                        McpServerRuntime {
                            status: McpConnectionStatus::Connected,
                            tools,
                            prompts,
                            resources,
                            tools_error,
                            prompts_error,
                            resources_error,
                            last_connected_at: Some(now),
                            ..Default::default()
                        },
                    );
                }
                self.emit_runtime().await;
            }
            Err(err) => {
                self.set_runtime(
                    &config.id,
                    McpServerRuntime {
                        status: McpConnectionStatus::Error,
                        error: Some(err),
                        ..Default::default()
                    },
                )
                .await;
                self.emit_runtime().await;
            }
        }
    }

    async fn disconnect(&self, id: &str) {
        let entry = {
            let mut guard = self.inner.lock().await;
            guard.entries.remove(id)
        };
        if let Some(entry) = entry {
            // Unwrap Arc if we're the last holder, else just drop.
            if let Ok(service) = Arc::try_unwrap(entry.client) {
                if let Err(err) = service.cancel().await {
                    log::warn!("[mcp] cancel failed for {id}: {err}");
                }
            }
        }
        self.set_runtime(
            id,
            McpServerRuntime {
                status: McpConnectionStatus::Disconnected,
                ..Default::default()
            },
        )
        .await;
    }

    pub async fn force_disconnect(&self, id: &str) {
        let has = {
            let guard = self.inner.lock().await;
            guard.entries.contains_key(id)
        };
        if has {
            self.disconnect(id).await;
            self.emit_runtime().await;
        }
    }

    pub async fn shutdown(&self) {
        let ids: Vec<String> = {
            let guard = self.inner.lock().await;
            guard.entries.keys().cloned().collect()
        };
        for id in ids {
            self.disconnect(&id).await;
        }
        self.emit_runtime().await;
    }

    async fn client(&self, id: &str) -> Option<ClientService> {
        let guard = self.inner.lock().await;
        guard.entries.get(id).map(|e| e.client.clone())
    }

    pub async fn call_tool(
        &self,
        server_id: &str,
        tool_name: &str,
        args: Value,
    ) -> CallToolOutcome {
        let Some(client) = self.client(server_id).await else {
            return CallToolOutcome {
                content: format!("MCP server \"{server_id}\" is not connected."),
                is_error: true,
            };
        };
        let arguments = match args {
            Value::Object(map) => Some(map),
            Value::Null => None,
            other => {
                let mut map = JsonMap::new();
                map.insert("value".into(), other);
                Some(map)
            }
        };
        let mut params = CallToolRequestParams::new(tool_name.to_string());
        if let Some(args) = arguments {
            params = params.with_arguments(args);
        }
        match client.call_tool(params).await {
            Ok(result) => {
                let content = extract_text_from_contents(&result.content);
                CallToolOutcome {
                    content,
                    is_error: result.is_error.unwrap_or(false),
                }
            }
            Err(err) => CallToolOutcome {
                content: err.to_string(),
                is_error: true,
            },
        }
    }

    pub async fn read_resource(
        &self,
        server_id: &str,
        uri: &str,
    ) -> McpResourceResult {
        let Some(client) = self.client(server_id).await else {
            return McpResourceResult {
                content: String::new(),
                error: Some("server not connected".to_string()),
            };
        };
        let params = ReadResourceRequestParams::new(uri.to_string());
        match client.read_resource(params).await {
            Ok(result) => {
                let mut parts = Vec::new();
                for c in result.contents.iter() {
                    match c {
                        rmcp::model::ResourceContents::TextResourceContents { text, .. } => {
                            parts.push(text.clone());
                        }
                        rmcp::model::ResourceContents::BlobResourceContents { .. } => {
                            parts.push("[binary]".to_string());
                        }
                    }
                }
                McpResourceResult {
                    content: parts.join("\n"),
                    error: None,
                }
            }
            Err(err) => McpResourceResult {
                content: String::new(),
                error: Some(err.to_string()),
            },
        }
    }

    pub async fn get_prompt(
        &self,
        server_id: &str,
        name: &str,
        args: HashMap<String, String>,
    ) -> McpPromptResult {
        let Some(client) = self.client(server_id).await else {
            return McpPromptResult {
                messages: Vec::new(),
                error: Some("server not connected".to_string()),
            };
        };
        let arguments = if args.is_empty() {
            None
        } else {
            let mut map = JsonMap::new();
            for (k, v) in args.into_iter() {
                map.insert(k, Value::String(v));
            }
            Some(map)
        };
        let mut params = GetPromptRequestParams::new(name.to_string());
        if let Some(args) = arguments {
            params = params.with_arguments(args);
        }
        match client.get_prompt(params).await {
            Ok(result) => {
                let messages = result
                    .messages
                    .into_iter()
                    .map(|m| McpPromptMessage {
                        role: format!("{:?}", m.role).to_lowercase(),
                        content: prompt_content_text(&m.content),
                    })
                    .collect();
                McpPromptResult {
                    messages,
                    error: None,
                }
            }
            Err(err) => McpPromptResult {
                messages: Vec::new(),
                error: Some(err.to_string()),
            },
        }
    }

    async fn set_runtime(&self, id: &str, runtime: McpServerRuntime) {
        let mut guard = self.inner.lock().await;
        guard.runtime.insert(id.to_string(), runtime);
    }

    async fn emit_runtime(&self) {
        let snapshot = self.inner.lock().await.runtime.clone();
        (self.on_change)(snapshot);
    }
}

/// One-shot connection test. Builds the transport, performs the MCP
/// handshake, runs the three list calls, then drops the connection. The
/// result mirrors what the manager would store in `McpServerRuntime` after
/// a real connect — the UI surfaces it the same way (counts plus per-list
/// errors) so the test button matches the post-connect behaviour.
#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpTestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompts_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resources_error: Option<String>,
    /// Wall-clock duration of the full connect + discover cycle, in ms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

pub async fn test_connection(config: &McpServerConfig) -> McpTestResult {
    let started = std::time::Instant::now();
    match build_and_connect(config).await {
        Ok(client) => {
            let client: ClientService = Arc::new(client);
            let (tools, tools_error) = safe_list_tools(&client).await;
            let (prompts, prompts_error) = safe_list_prompts(&client).await;
            let (resources, resources_error) =
                safe_list_resources(&client).await;
            // Try to release the rmcp service cleanly. If we don't hold the
            // last Arc reference we just drop our handle.
            if let Ok(service) = Arc::try_unwrap(client) {
                let _ = service.cancel().await;
            }
            McpTestResult {
                ok: true,
                error: None,
                tool_count: Some(tools.len()),
                prompt_count: Some(prompts.len()),
                resource_count: Some(resources.len()),
                tools_error,
                prompts_error,
                resources_error,
                duration_ms: Some(started.elapsed().as_millis() as u64),
            }
        }
        Err(err) => McpTestResult {
            ok: false,
            error: Some(err),
            duration_ms: Some(started.elapsed().as_millis() as u64),
            ..Default::default()
        },
    }
}

async fn build_and_connect(
    config: &McpServerConfig,
) -> Result<RunningService<RoleClient, ()>, String> {
    match config.transport {
        McpTransport::Stdio => {
            let cmd_name = config
                .command
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "Stdio MCP server needs a command.".to_string())?;
            let mut cmd = Command::new(cmd_name);
            if let Some(args) = &config.args {
                cmd.args(args);
            }
            if let Some(env) = &config.env {
                for (k, v) in env.iter() {
                    cmd.env(k, v);
                }
            }
            let transport =
                TokioChildProcess::new(cmd).map_err(|e| format!("spawn failed: {e}"))?;
            ().serve(transport)
                .await
                .map_err(|e| format!("MCP initialize failed: {e}"))
        }
        McpTransport::Http => {
            let url = config
                .url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "HTTP MCP server needs a URL.".to_string())?;
            let mut headers: HashMap<HeaderName, HeaderValue> = HashMap::new();
            if let Some(list) = &config.custom_headers {
                for h in list.iter() {
                    let name = h.name.trim();
                    if name.is_empty() {
                        continue;
                    }
                    let header_name = HeaderName::from_bytes(name.as_bytes())
                        .map_err(|e| format!("invalid header name '{name}': {e}"))?;
                    let header_value = HeaderValue::from_str(&h.value)
                        .map_err(|e| format!("invalid header value for '{name}': {e}"))?;
                    headers.insert(header_name, header_value);
                }
            }
            let config_builder = StreamableHttpClientTransportConfig::with_uri(url.to_string())
                .custom_headers(headers);
            let transport = StreamableHttpClientTransport::from_config(config_builder);
            ().serve(transport)
                .await
                .map_err(|e| format!("MCP initialize failed: {e}"))
        }
    }
}

fn hash_config(config: &McpServerConfig) -> String {
    // Order-stable signature that changes whenever reconnect would be needed.
    let headers: Vec<(String, String)> = config
        .custom_headers
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|h| (h.name, h.value))
        .collect();
    let payload = serde_json::json!({
        "transport": match config.transport {
            McpTransport::Http => "http",
            McpTransport::Stdio => "stdio",
        },
        "url": config.url.clone().unwrap_or_default(),
        "command": config.command.clone().unwrap_or_default(),
        "args": config.args.clone().unwrap_or_default(),
        "env": config.env.clone().unwrap_or_default(),
        "headers": headers,
    });
    payload.to_string()
}

/// Result of a discovery list call. Each helper returns `(items, error)` —
/// callers store both so a list-method failure surfaces in the UI instead of
/// silently leaving the count at 0. A successful empty response yields
/// `(vec![], None)`, which the UI treats as "server advertised nothing."
async fn safe_list_tools(
    client: &ClientService,
) -> (Vec<McpToolInfo>, Option<String>) {
    match client.list_all_tools().await {
        Ok(tools) => (
            tools
                .into_iter()
                .map(|t| McpToolInfo {
                    name: t.name.to_string(),
                    description: t.description.map(|d| d.to_string()),
                    input_schema: serde_json::to_value(&t.input_schema).ok(),
                })
                .collect(),
            None,
        ),
        Err(err) => {
            let msg = err.to_string();
            log::warn!("[mcp] listTools failed: {msg}");
            (Vec::new(), Some(msg))
        }
    }
}

async fn safe_list_prompts(
    client: &ClientService,
) -> (Vec<McpPromptInfo>, Option<String>) {
    match client.list_all_prompts().await {
        Ok(prompts) => (
            prompts
                .into_iter()
                .map(|p| McpPromptInfo {
                    name: p.name,
                    description: p.description,
                    arguments: p.arguments.map(|args| {
                        args.into_iter()
                            .map(|a| McpPromptArg {
                                name: a.name,
                                description: a.description,
                                required: a.required,
                            })
                            .collect()
                    }),
                })
                .collect(),
            None,
        ),
        Err(err) => {
            let msg = err.to_string();
            log::warn!("[mcp] listPrompts failed: {msg}");
            (Vec::new(), Some(msg))
        }
    }
}

async fn safe_list_resources(
    client: &ClientService,
) -> (Vec<McpResourceInfo>, Option<String>) {
    match client.list_all_resources().await {
        Ok(resources) => (
            resources
                .into_iter()
                .map(|r| McpResourceInfo {
                    uri: r.uri.clone(),
                    name: Some(r.name.clone()),
                    description: r.description.clone(),
                    mime_type: r.mime_type.clone(),
                })
                .collect(),
            None,
        ),
        Err(err) => {
            let msg = err.to_string();
            log::warn!("[mcp] listResources failed: {msg}");
            (Vec::new(), Some(msg))
        }
    }
}

fn extract_text_from_contents(contents: &[rmcp::model::Content]) -> String {
    let mut parts = Vec::new();
    for c in contents {
        match &c.raw {
            RawContent::Text(t) => parts.push(t.text.clone()),
            RawContent::Resource(e) => {
                if let rmcp::model::ResourceContents::TextResourceContents { text, .. } =
                    &e.resource
                {
                    parts.push(text.clone());
                }
            }
            RawContent::Image(img) => parts.push(format!(
                "[image: {}, {} base64 chars]",
                img.mime_type,
                img.data.len()
            )),
            RawContent::Audio(a) => parts.push(format!(
                "[audio: {}, {} base64 chars]",
                a.mime_type,
                a.data.len()
            )),
            RawContent::ResourceLink(l) => parts.push(format!("[resource: {}]", l.uri)),
        }
    }
    parts.join("\n")
}

fn prompt_content_text(content: &rmcp::model::PromptMessageContent) -> String {
    match content {
        rmcp::model::PromptMessageContent::Text { text } => text.clone(),
        rmcp::model::PromptMessageContent::Image { .. } => "[image]".to_string(),
        rmcp::model::PromptMessageContent::Resource { .. } => "[resource]".to_string(),
        rmcp::model::PromptMessageContent::ResourceLink { .. } => "[resource-link]".to_string(),
    }
}

fn current_iso8601() -> String {
    match OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339) {
        Ok(s) => s,
        Err(_) => "".to_string(),
    }
}
