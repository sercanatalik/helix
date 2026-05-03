//! Internet fetch built-in tool.
//!
//! Pulls a single URL through the optional corporate forward proxy and
//! returns the body as plain text. HTML is reduced to readable text with
//! `<script>` / `<style>` blocks dropped and block-level tags converted to
//! line breaks; `text/*` and `application/json` come back verbatim. Output
//! is capped (default 200 KB, hard 500 KB) so a single page can't blow the
//! model's context window.
//!
//! Same proxy plumbing as `web_search.rs` — the renderer reads its
//! `useProxy()` config at call time and forwards it; we rebuild a reqwest
//! client per call so a config change picks up on the next fetch without a
//! process restart.
//!
//! Why no real HTML parser? The model only needs the readable surface, and
//! a regex pass over `<script>` / `<style>` plus tag stripping covers the
//! 95% case without adding a `scraper` / `html5ever` dep. Pages that abuse
//! shadow DOM or render entirely client-side will come back near-empty —
//! that's a known limit, documented in the tool description.
//!
//! Errors come back as `Result<_, String>` so the renderer surfaces them
//! as a tool-call error in the transcript without breaking the agent loop.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;

/// Optional proxy supplied per-call by the renderer. Same shape as
/// `WebSearchProxy` — kept separate so each tool's serde surface is
/// self-documenting and one can move without breaking the other.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchProxy {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchArgs {
    pub url: String,
    /// Cap on output bytes. Default 200_000, hard ceiling 500_000. Smaller
    /// values are honoured down to a 1 KB floor so a malformed call can't
    /// pin the result at zero.
    #[serde(default)]
    pub max_bytes: Option<usize>,
    pub proxy: Option<WebFetchProxy>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResponse {
    /// Original URL the caller asked for.
    pub url: String,
    /// URL after following redirects. Equal to `url` when no redirect fired.
    pub final_url: String,
    pub status: u16,
    /// Lower-cased Content-Type as reported by the server (or empty).
    pub content_type: String,
    /// Decoded body. HTML is stripped to readable text; other text/json
    /// types pass through verbatim.
    pub text: String,
    /// True when `text` was clipped at `max_bytes`.
    pub truncated: bool,
    /// Length of `text` in bytes (post-truncation).
    pub byte_count: usize,
}

const DEFAULT_MAX_BYTES: usize = 200_000;
const HARD_MAX_BYTES: usize = 500_000;
const MIN_MAX_BYTES: usize = 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

#[tauri::command]
pub async fn web_fetch(args: WebFetchArgs) -> Result<WebFetchResponse, String> {
    let url = args.url.trim();
    if url.is_empty() {
        return Err("web_fetch: url is empty".to_string());
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("web_fetch: url must start with http:// or https://".to_string());
    }
    let max_bytes = args
        .max_bytes
        .unwrap_or(DEFAULT_MAX_BYTES)
        .min(HARD_MAX_BYTES)
        .max(MIN_MAX_BYTES);

    let client = build_client(args.proxy.as_ref()).map_err(|e| e.to_string())?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("web_fetch: request failed: {e}"))?;

    let final_url = response.url().to_string();
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    // Capture the body even on non-2xx so the model can read consent walls,
    // anti-bot pages (Yahoo Finance returns HTTP 500 to plain HTTP clients,
    // for example), or "page moved" notices and pivot. The status is
    // surfaced prominently in the response so the agent loop can react. We
    // still bail on bodies we can't usefully decode — same rule as the
    // success path.
    let raw = response
        .bytes()
        .await
        .map_err(|e| format!("web_fetch: read body failed: {e}"))?;

    let body_text = match classify(&content_type) {
        BodyKind::Html => extract_html_text(&raw),
        BodyKind::Text | BodyKind::Json => String::from_utf8_lossy(&raw).into_owned(),
        BodyKind::Unsupported => {
            return Err(format!(
                "web_fetch: unsupported content type `{content_type}` (only text/*, text/html, application/json supported)"
            ));
        }
    };

    let normalized = normalize_whitespace(&body_text);
    let (text, truncated) = clamp_to_bytes(normalized, max_bytes);

    Ok(WebFetchResponse {
        url: url.to_string(),
        final_url,
        status,
        content_type,
        byte_count: text.len(),
        text,
        truncated,
    })
}

/// Reqwest client with optional proxy + Basic auth. Identical shape to the
/// one in `web_search.rs`; kept separate so each tool stays self-contained.
fn build_client(proxy: Option<&WebFetchProxy>) -> Result<reqwest::Client, reqwest::Error> {
    let mut builder = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT);

    if let Some(p) = proxy {
        if p.enabled && !p.host.is_empty() && p.port > 0 {
            let url = format!("http://{}:{}", p.host, p.port);
            let mut rp = reqwest::Proxy::all(&url)?;
            if !p.username.is_empty() {
                rp = rp.basic_auth(&p.username, &p.password);
            }
            builder = builder.proxy(rp);
        }
    }

    builder.build()
}

enum BodyKind {
    Html,
    Text,
    Json,
    Unsupported,
}

/// Map a Content-Type header to how the body should be decoded. Empty
/// strings (servers that omit the header) are treated as HTML — matches
/// browser behaviour and is the common case for the URLs the model fetches.
fn classify(ct: &str) -> BodyKind {
    if ct.starts_with("text/html") || ct.starts_with("application/xhtml") {
        BodyKind::Html
    } else if ct.starts_with("application/json") || ct.starts_with("application/ld+json") {
        BodyKind::Json
    } else if ct.starts_with("text/") {
        BodyKind::Text
    } else if ct.is_empty() {
        BodyKind::Html
    } else {
        BodyKind::Unsupported
    }
}

/// HTML → readable text. Drops `<script>` / `<style>` blocks (their
/// contents are noise), converts block-level open/close tags to newlines so
/// paragraph structure survives, then strips remaining tags and decodes the
/// handful of entities pages actually emit.
fn extract_html_text(raw: &[u8]) -> String {
    let s = String::from_utf8_lossy(raw);
    let no_blocks = drop_noise_blocks(&s);
    let with_breaks = breakify_block_tags(&no_blocks);
    let stripped = strip_tags(&with_breaks);
    decode_entities(&stripped)
}

fn drop_noise_blocks(s: &str) -> String {
    static SCRIPT: OnceLock<Regex> = OnceLock::new();
    static STYLE: OnceLock<Regex> = OnceLock::new();
    static COMMENT: OnceLock<Regex> = OnceLock::new();
    let script = SCRIPT
        .get_or_init(|| Regex::new(r"(?is)<script[^>]*>.*?</script>").expect("static script regex"));
    let style = STYLE
        .get_or_init(|| Regex::new(r"(?is)<style[^>]*>.*?</style>").expect("static style regex"));
    let comment = COMMENT.get_or_init(|| Regex::new(r"(?s)<!--.*?-->").expect("static comment regex"));
    let a = script.replace_all(s, " ");
    let b = style.replace_all(&a, " ");
    comment.replace_all(&b, " ").into_owned()
}

/// Replace block-level open/close tags with newlines so paragraphs and list
/// items don't run together when their tags get stripped. Matches a curated
/// list — anything else falls through to `strip_tags` which just removes it.
fn breakify_block_tags(s: &str) -> String {
    static BLOCK: OnceLock<Regex> = OnceLock::new();
    let block = BLOCK.get_or_init(|| {
        Regex::new(
            r"(?i)<\s*/?\s*(?:p|br|div|li|h[1-6]|tr|hr|article|section|header|footer|nav|aside|table|ul|ol|blockquote|pre)(?:\s[^>]*)?\s*/?\s*>",
        )
        .expect("static block-tag regex")
    });
    block.replace_all(s, "\n").into_owned()
}

fn strip_tags(s: &str) -> String {
    static TAG: OnceLock<Regex> = OnceLock::new();
    let tag = TAG.get_or_init(|| Regex::new(r"(?s)<[^>]+>").expect("static tag regex"));
    tag.replace_all(s, "").into_owned()
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&hellip;", "…")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
}

/// Collapse runs of horizontal whitespace and clamp consecutive newlines to
/// at most two so the output keeps paragraph breaks without carrying every
/// stray blank line a CMS template emitted.
fn normalize_whitespace(s: &str) -> String {
    static H_WS: OnceLock<Regex> = OnceLock::new();
    static V_WS: OnceLock<Regex> = OnceLock::new();
    let h = H_WS.get_or_init(|| Regex::new(r"[ \t]+").expect("static h-ws regex"));
    let v = V_WS.get_or_init(|| Regex::new(r"\n{3,}").expect("static v-ws regex"));
    let with_h = h.replace_all(s, " ");
    // Trim trailing spaces on each line so the v_ws collapse fires reliably.
    let lines: String = with_h
        .lines()
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n");
    v.replace_all(&lines, "\n\n").trim().to_string()
}

/// Truncate to at most `max_bytes` while staying on a UTF-8 char boundary.
/// Returns the (possibly clipped) string and a flag the caller surfaces in
/// the response so the model knows there's more behind it.
fn clamp_to_bytes(s: String, max_bytes: usize) -> (String, bool) {
    if s.len() <= max_bytes {
        return (s, false);
    }
    let mut cut = max_bytes;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    (s[..cut].to_string(), true)
}
