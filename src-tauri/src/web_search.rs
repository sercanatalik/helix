//! Internet search built-in tool.
//!
//! Hits DuckDuckGo's HTML endpoint (no API key needed) through an optional
//! corporate forward proxy and parses the results into a structured list.
//! The renderer reads its `useProxy()` config at call time and forwards
//! the four fields the user typed in Settings → Proxy; we rebuild a
//! reqwest client per call so a config change picks up on the next search
//! without a process restart.
//!
//! Why DuckDuckGo HTML and not an API? The point of this tool is "works
//! out of the box behind a corporate proxy with no extra accounts" — every
//! API alternative (Brave, Bing, Tavily, Serper) requires the user to
//! register a key first. The HTML endpoint is rate-limited but stable
//! enough for an in-chat reference lookup; users who need scale can swap
//! in an MCP-backed search server.
//!
//! Output is a compact JSON list — the dispatcher renders it into a
//! markdown body the model can quote from.
//!
//! Errors come back as `Result<_, String>` so the renderer surfaces them
//! as a tool-call error in the transcript without breaking the agent loop.
//!
//! No HTML parser dependency: we walk the response with the regex crate
//! (already a dep) against DDG's stable result shell. If their markup
//! shifts the regex misses gracefully and we return an empty list rather
//! than panic.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;

/// Optional proxy supplied per-call by the renderer. Mirrors the
/// `ProxyConfig` shape in `src/lib/proxy.ts` — `enabled=false` is the same
/// as omitting the field. Username/password drive HTTP Basic auth on the
/// proxy connection itself; empty username == no auth.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchProxy {
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
pub struct WebSearchArgs {
    pub query: String,
    /// Cap on the number of results returned. Defaults to 8 — same shape
    /// most "agent loop" search tools converge on. Hard ceiling of 25 to
    /// keep the payload size reasonable.
    #[serde(default)]
    pub limit: Option<usize>,
    /// Optional region hint (e.g. `us-en`, `uk-en`). DuckDuckGo defaults
    /// when omitted; pass-through verbatim.
    #[serde(default)]
    pub region: Option<String>,
    pub proxy: Option<WebSearchProxy>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResponse {
    pub query: String,
    pub hits: Vec<WebSearchHit>,
    /// True when DuckDuckGo returned a result block but our parser
    /// couldn't make sense of it (markup churn). Surfaces as a hint in the
    /// rendered tool output without breaking the agent loop.
    pub parse_warning: Option<String>,
}

const DEFAULT_LIMIT: usize = 8;
const MAX_LIMIT: usize = 25;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const SEARCH_ENDPOINT: &str = "https://html.duckduckgo.com/html/";
const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

#[tauri::command]
pub async fn web_search(args: WebSearchArgs) -> Result<WebSearchResponse, String> {
    let query = args.query.trim();
    if query.is_empty() {
        return Err("web_search: query is empty".to_string());
    }
    let limit = args.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT).max(1);
    let region = args.region.unwrap_or_default();

    let client = build_client(args.proxy.as_ref()).map_err(|e| e.to_string())?;

    let mut form: Vec<(&str, &str)> = vec![("q", query)];
    if !region.is_empty() {
        form.push(("kl", region.as_str()));
    }

    let response = client
        .post(SEARCH_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("web_search: request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "web_search: upstream returned HTTP {}",
            response.status()
        ));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("web_search: read body failed: {e}"))?;

    let (hits, warning) = parse_results(&body, limit);

    Ok(WebSearchResponse {
        query: query.to_string(),
        hits,
        parse_warning: warning,
    })
}

/// Reqwest client with optional proxy + Basic auth. We rebuild per call
/// rather than caching because the renderer can change proxy settings at
/// runtime; the cost (one TLS handshake per search) is negligible.
fn build_client(proxy: Option<&WebSearchProxy>) -> Result<reqwest::Client, reqwest::Error> {
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

/// Pull `<a class="result__a" href="...">title</a>` plus the matching
/// snippet block out of DDG's HTML shell. Returns whatever the regex
/// caught, with a soft-warning string when nothing matched at all (so the
/// caller can tell "no results" apart from "DDG changed their markup").
fn parse_results(html: &str, limit: usize) -> (Vec<WebSearchHit>, Option<String>) {
    // Capture group 1: href, group 2: title HTML.
    let anchor = anchor_re();
    // Capture group 1: snippet HTML — DDG wraps each result in a
    // `result` table-row with the snippet in `.result__snippet` directly
    // beneath the title link. Greedy across whitespace, ungreedy on body.
    let snippet = snippet_re();

    let mut hits: Vec<WebSearchHit> = Vec::new();
    let snippet_iter: Vec<&str> = snippet
        .captures_iter(html)
        .map(|c| c.get(1).map_or("", |m| m.as_str()))
        .collect();

    for (idx, cap) in anchor.captures_iter(html).enumerate() {
        if hits.len() >= limit {
            break;
        }
        let raw_url = cap.get(1).map_or("", |m| m.as_str());
        let raw_title = cap.get(2).map_or("", |m| m.as_str());
        let url = clean_ddg_redirect(raw_url);
        let title = strip_tags(raw_title);
        if title.is_empty() || url.is_empty() {
            continue;
        }
        let snippet_html = snippet_iter.get(idx).copied().unwrap_or("");
        let snippet = strip_tags(snippet_html);
        hits.push(WebSearchHit {
            title,
            url,
            snippet,
        });
    }

    let warning = if hits.is_empty() && html.contains("result__a") {
        Some(
            "DuckDuckGo returned a result block but the parser couldn't extract entries. The HTML shell may have changed.".to_string(),
        )
    } else {
        None
    };

    (hits, warning)
}

fn anchor_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?is)<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#)
            .expect("static anchor regex")
    })
}

fn snippet_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?is)<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</[a-zA-Z]+>"#)
            .expect("static snippet regex")
    })
}

/// DDG wraps every result URL in `//duckduckgo.com/l/?uddg=<encoded>&...`.
/// Pull the underlying URL out so the model gets the canonical link
/// directly. Falls through unchanged when the anchor is already a full
/// URL (mainly for `!bang` redirects and ads, which we'd skip anyway).
fn clean_ddg_redirect(href: &str) -> String {
    let trimmed = href.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Normalise leading `//` to a real scheme so url::Url can parse it.
    let with_scheme = if let Some(rest) = trimmed.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        trimmed.to_string()
    };

    // Look for `?uddg=<encoded>` and decode.
    if let Some(idx) = with_scheme.find("uddg=") {
        let tail = &with_scheme[idx + 5..];
        let end = tail.find('&').unwrap_or(tail.len());
        let encoded = &tail[..end];
        if let Some(decoded) = percent_decode(encoded) {
            return decoded;
        }
    }
    with_scheme
}

/// Minimal percent-decoder — `%XX` pairs only, leaves the rest of the
/// string alone. Avoids pulling in `urlencoding` for one call site. Returns
/// `None` when an escape sequence is malformed so the caller can fall back
/// to the raw URL instead of corrupting it.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)? as u8;
            let lo = (bytes[i + 2] as char).to_digit(16)? as u8;
            out.push((hi << 4) | lo);
            i += 3;
        } else if b == b'+' {
            out.push(b' ');
            i += 1;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Strip the small set of HTML tags DDG emits inside titles + snippets
/// (`<b>`, `<em>`, `<span>` for highlighting) and decode the handful of
/// entities it produces. Not a general HTML decoder — but DDG's surface
/// is small, and a real parser dependency is overkill for this.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    decode_entities(out.trim())
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
}
