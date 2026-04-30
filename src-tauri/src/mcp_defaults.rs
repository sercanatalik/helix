use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use crate::types::{CustomHeader, McpServerConfig, McpTransport};

pub struct McpDefaultEntry {
    pub source_key: String,
    pub config: McpServerConfig,
}

pub fn load_from_path(path: &Path) -> Vec<McpDefaultEntry> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(err) => {
            log::info!(
                "[mcp-defaults] no config at {}: {err}",
                path.display()
            );
            return Vec::new();
        }
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(err) => {
            log::warn!("[mcp-defaults] failed to parse {}: {err}", path.display());
            return Vec::new();
        }
    };
    let entries = parse(value);
    log::info!(
        "[mcp-defaults] loaded {} entries from {}",
        entries.len(),
        path.display()
    );
    entries
}

fn parse(value: Value) -> Vec<McpDefaultEntry> {
    let Some(servers) = value.get("mcpServers").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    for (key, v) in servers {
        if let Some(entry) = parse_entry(key, v) {
            entries.push(entry);
        }
    }
    entries
}

fn parse_entry(key: &str, v: &Value) -> Option<McpDefaultEntry> {
    let obj = v.as_object()?;
    let transport = infer_transport(obj);
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(key)
        .to_string();
    let enabled = obj.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
    let url = obj
        .get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let command = obj
        .get("command")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let args = obj.get("args").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|a| a.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>()
    });
    let env = obj.get("env").and_then(|v| v.as_object()).map(|o| {
        o.iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect::<HashMap<_, _>>()
    });
    let custom_headers = parse_headers(obj);
    let attach_basic_auth_header = obj
        .get("attachBasicAuthHeader")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    Some(McpDefaultEntry {
        source_key: key.to_string(),
        config: McpServerConfig {
            id: String::new(),
            name,
            enabled,
            transport,
            url,
            command,
            args,
            env,
            custom_headers,
            attach_basic_auth_header: if attach_basic_auth_header {
                Some(true)
            } else {
                None
            },
            source_key: Some(key.to_string()),
            disabled_tools: None,
        },
    })
}

fn infer_transport(obj: &serde_json::Map<String, Value>) -> McpTransport {
    match obj.get("transport").and_then(|v| v.as_str()) {
        Some("stdio") => return McpTransport::Stdio,
        Some("http") => return McpTransport::Http,
        _ => {}
    }
    if obj
        .get("url")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
    {
        return McpTransport::Http;
    }
    if obj
        .get("command")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
    {
        return McpTransport::Stdio;
    }
    McpTransport::Http
}

fn parse_headers(obj: &serde_json::Map<String, Value>) -> Option<Vec<CustomHeader>> {
    if let Some(arr) = obj.get("customHeaders").and_then(|v| v.as_array()) {
        let mut out = Vec::new();
        for entry in arr {
            let e = entry.as_object()?;
            let name = e.get("name")?.as_str()?.to_string();
            let value = e.get("value")?.as_str()?.to_string();
            out.push(CustomHeader { name, value });
        }
        return if out.is_empty() { None } else { Some(out) };
    }
    if let Some(obj_headers) = obj.get("headers").and_then(|v| v.as_object()) {
        let mut out = Vec::new();
        for (k, v) in obj_headers {
            if let Some(s) = v.as_str() {
                out.push(CustomHeader {
                    name: k.clone(),
                    value: s.to_string(),
                });
            }
        }
        return if out.is_empty() { None } else { Some(out) };
    }
    None
}
