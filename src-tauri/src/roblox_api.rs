use crate::request_policy::RobloxRequest;
use crate::state::AppState;
use serde_json::Value;
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// Roblox errors come back as {"errors":[{"code":N,"message":"..."}]} (or,
// on some endpoints, a flat {"message":"..."}) -- pull just the human
// message out instead of showing the raw JSON in the UI.
fn extract_roblox_error(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(msg) = v
            .get("errors")
            .and_then(|e| e.as_array())
            .and_then(|a| a.first())
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            return msg.to_string();
        }
        if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
            return msg.to_string();
        }
    }
    body.chars().take(200).collect()
}

pub struct UserInfo {
    pub ok: bool,
    pub username: Option<String>,
    pub user_id: Option<String>,
    pub reason: Option<String>,
    pub status: u16,
}

pub async fn fetch_user_info(state: &AppState, cookie: &str) -> UserInfo {
    let res = state
        .http_no_redirect
        .get("https://users.roblox.com/v1/users/authenticated")
        .header("Cookie", format!(".ROBLOSECURITY={}", cookie))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(8))
        .send_roblox(&state.roblox_requests, Some(cookie))
        .await;
    match res {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            match serde_json::from_str::<Value>(&body) {
                Ok(d)
                    if status == 200
                        && d.get("id").and_then(Value::as_u64).is_some()
                        && d.get("name").and_then(Value::as_str).is_some() =>
                {
                    UserInfo {
                        ok: true,
                        username: d
                            .get("name")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        user_id: d.get("id").map(|v| match v {
                            Value::Number(n) => n.to_string(),
                            Value::String(s) => s.clone(),
                            _ => String::new(),
                        }),
                        reason: None,
                        status,
                    }
                }
                _ => UserInfo {
                    ok: false,
                    username: None,
                    user_id: None,
                    reason: Some(if status == 429 {
                        "Roblox rate limit (HTTP 429). Wait before checking again.".into()
                    } else {
                        format!("HTTP {status}: {}", extract_roblox_error(&body))
                    }),
                    status,
                },
            }
        }
        Err(e) => UserInfo {
            ok: false,
            username: None,
            user_id: None,
            status: e.status,
            reason: Some(e.to_string()),
        },
    }
}

// Err carries the failure reason so the caller can log why, not just fail.
// channel: None (or empty) checks the default production/LIVE channel via
// clientsettingscdn's JSON API. Some("zcanary") etc. checks that specific
// deployment channel instead -- clientsettingscdn's own `?channel=` query
// param is silently ignored (confirmed live: passing zcanary, zintegration,
// or a made-up channel name all return identical production data), so named
// channels go through setup.rbxcdn.com/channel/<name>/version instead,
// which returns the version hash as a plain-text body rather than JSON.
pub async fn get_roblox_version(state: &AppState, channel: Option<&str>) -> Result<String, String> {
    let channel = channel.filter(|c| !c.is_empty());
    let url = match channel {
        Some(ch) => format!(
            "https://setup.rbxcdn.com/channel/{}/version",
            urlencoding::encode(ch)
        ),
        None => "https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer".to_string(),
    };
    let res = state
        .http_no_redirect
        .get(&url)
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(8))
        .send_roblox(&state.roblox_requests, None)
        .await
        .map_err(|e| format!("network error: {e}"))?;
    let status = res.status();
    if status != 200 {
        return Err(format!(
            "unexpected status {status} -- unknown or restricted channel"
        ));
    }
    if channel.is_some() {
        let text = res
            .text()
            .await
            .map_err(|e| format!("bad response body: {e}"))?;
        let text = text.trim();
        if text.is_empty() || !text.starts_with("version-") {
            return Err("response wasn't a version hash".to_string());
        }
        return Ok(text.to_string());
    }
    let json: Value = res
        .json()
        .await
        .map_err(|e| format!("bad response body: {e}"))?;
    json.get("clientVersionUpload")
        .or_else(|| json.get("version"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "response missing version field".to_string())
}

// These legacy auth endpoints require their JSON media type even with no
// payload. Keep one builder for the CSRF probe and launch ticket so retries
// preserve the same request contract. A missing Content-Type causes HTTP 415.
fn empty_auth_post(
    client: &reqwest::Client,
    endpoint: &str,
    cookie: &str,
) -> reqwest::RequestBuilder {
    client
        .post(endpoint)
        .header("Cookie", format!(".ROBLOSECURITY={}", cookie))
        .header("User-Agent", UA)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("Content-Length", "0")
        .body("")
}

fn authentication_error(operation: &str, status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        400 | 415 => format!(
            "Roblox rejected the {operation} request format (HTTP {}). Update KNT Manager and report this application error.",
            status.as_u16()
        ),
        401 => "Roblox rejected this session (HTTP 401). Sign in again before trying to launch.".into(),
        403 => format!("{operation} denied (HTTP 403). Check the account in Roblox before trying again."),
        429 => "Roblox rate limit (HTTP 429). Requests are paused; wait before trying again.".into(),
        500..=599 => format!("Roblox {operation} service is unavailable (HTTP {}). Try again later.", status.as_u16()),
        _ => format!("Roblox {operation} request failed (HTTP {}).", status.as_u16()),
    }
}

// Never send a cached CSRF token to logout: this is only a token probe and
// must not become an authenticated logout request. There is no retry here.
async fn request_csrf_token(
    client: &reqwest::Client,
    policy: &crate::request_policy::RequestPolicy,
    endpoint: &str,
    cookie: &str,
) -> Result<String, String> {
    let response = empty_auth_post(client, endpoint, cookie)
        .send_roblox(policy, Some(cookie))
        .await?;
    if response.status() == 403 && !response.headers().contains_key("rblx-challenge-id") {
        if let Some(token) = response
            .headers()
            .get("x-csrf-token")
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty())
        {
            return Ok(token.to_string());
        }
    }
    if response.status() == 403 {
        policy.pause_authentication(cookie).await;
    }
    Err(authentication_error("CSRF", response.status()))
}

// A single CSRF probe; failures never trigger alternate logout endpoints.
pub async fn get_csrf_token(state: &AppState, cookie: &str) -> Result<String, String> {
    if let Some((token, ts)) = state.csrf_cache.lock().unwrap().get(cookie) {
        if now_ms() - ts < 5 * 60_000 {
            return Ok(token.clone());
        }
    }
    let token = request_csrf_token(
        &state.http_no_redirect,
        &state.roblox_requests,
        "https://auth.roblox.com/v2/logout",
        cookie,
    )
    .await?;
    state
        .csrf_cache
        .lock()
        .unwrap()
        .insert(cookie.to_string(), (token.clone(), now_ms()));
    Ok(token)
}

pub fn invalidate_csrf(state: &AppState, cookie: &str) {
    state.csrf_cache.lock().unwrap().remove(cookie);
}

pub struct TicketResult {
    pub ok: bool,
    pub ticket: Option<String>,
    pub error: Option<String>,
}

// Tickets are consumed by a launch. Never cache or replay a successful ticket.
// Only the server's explicit CSRF refresh allows one repeat of this POST.
pub async fn get_auth_ticket(
    state: &AppState,
    cookie: &str,
    csrf_token: Option<String>,
) -> TicketResult {
    let result = request_auth_ticket(
        &state.http_no_redirect,
        &state.roblox_requests,
        "https://auth.roblox.com/v1/authentication-ticket",
        cookie,
        csrf_token,
    )
    .await;
    invalidate_csrf(state, cookie);
    match result {
        Ok((ticket, token)) => {
            if let Some(token) = token {
                state
                    .csrf_cache
                    .lock()
                    .unwrap()
                    .insert(cookie.to_string(), (token, now_ms()));
            }
            TicketResult {
                ok: true,
                ticket: Some(ticket),
                error: None,
            }
        }
        Err(error) => TicketResult {
            ok: false,
            ticket: None,
            error: Some(error),
        },
    }
}

async fn request_auth_ticket(
    client: &reqwest::Client,
    policy: &crate::request_policy::RequestPolicy,
    endpoint: &str,
    cookie: &str,
    mut token: Option<String>,
) -> Result<(String, Option<String>), String> {
    for attempt in 0..2 {
        let mut request = empty_auth_post(client, endpoint, cookie)
            .header("Referer", "https://www.roblox.com")
            .header("Origin", "https://www.roblox.com");
        if let Some(token) = &token {
            request = request.header("X-CSRF-TOKEN", token);
        }
        let response = request.send_roblox(policy, Some(cookie)).await?;
        let status = response.status();
        if response.headers().contains_key("rblx-challenge-id") {
            return Err("Authentication challenge received. Complete verification in Roblox before trying again.".into());
        }
        if status.is_success() {
            return response
                .headers()
                .get("rbx-authentication-ticket")
                .and_then(|v| v.to_str().ok())
                .filter(|v| !v.is_empty())
                .map(|ticket| (ticket.to_string(), token))
                .ok_or_else(|| "Roblox response did not contain an authentication ticket".into());
        }
        if status == 403 && attempt == 0 && !response.headers().contains_key("rblx-challenge-id") {
            if let Some(fresh) = response
                .headers()
                .get("x-csrf-token")
                .and_then(|v| v.to_str().ok())
                .filter(|v| !v.is_empty())
            {
                token = Some(fresh.to_string());
                continue;
            }
        }
        if status == 403 {
            policy.pause_authentication(cookie).await;
        }
        return Err(authentication_error("authentication", status));
    }
    unreachable!("each attempt returns or consumes the one CSRF refresh")
}

fn extract_place_id(place_id_or_target: &str) -> Option<String> {
    let t = place_id_or_target.trim();
    if t.chars().all(|c| c.is_ascii_digit()) && !t.is_empty() {
        return Some(t.to_string());
    }
    let raw = if t.starts_with("http") {
        t.to_string()
    } else {
        format!("https://{}", t)
    };
    if let Ok(url) = url::Url::parse(&raw) {
        let segs: Vec<&str> = url
            .path_segments()
            .map(|s| s.filter(|x| !x.is_empty()).collect())
            .unwrap_or_default();
        if segs.first() == Some(&"games") {
            if let Some(id) = segs.get(1) {
                if id.chars().all(|c| c.is_ascii_digit()) {
                    return Some(id.to_string());
                }
            }
        }
        for (k, v) in url.query_pairs() {
            if k == "placeId" && v.chars().all(|c| c.is_ascii_digit()) {
                return Some(v.to_string());
            }
        }
    }
    None
}

async fn get_json(state: &AppState, url: &str, cookie: &str) -> Option<Value> {
    let res = state
        .http_no_redirect
        .get(url)
        .header("Cookie", format!(".ROBLOSECURITY={}", cookie))
        .header("Accept", "application/json")
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(5))
        .send_roblox(&state.roblox_requests, Some(cookie))
        .await
        .ok()?;
    res.json::<Value>().await.ok()
}

pub async fn get_game_name(
    state: &AppState,
    place_id_or_target: &str,
    cookie: &str,
) -> Option<String> {
    let place_id = extract_place_id(place_id_or_target)?;
    let url = format!(
        "https://games.roblox.com/v1/games/multiget-place-details?placeIds={}",
        place_id
    );
    if let Some(d) = get_json(state, &url, cookie).await {
        if let Some(name) = d
            .as_array()
            .and_then(|a| a.first())
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
        {
            return Some(name.to_string());
        }
    }
    let uni = get_json(
        state,
        &format!(
            "https://apis.roblox.com/universes/v1/places/{}/universe",
            place_id
        ),
        cookie,
    )
    .await?;
    let universe_id = uni.get("universeId")?;
    let games = get_json(
        state,
        &format!(
            "https://games.roblox.com/v1/games?universeIds={}",
            universe_id
        ),
        cookie,
    )
    .await?;
    games
        .get("data")?
        .as_array()?
        .first()?
        .get("name")?
        .as_str()
        .map(|s| s.to_string())
}

pub async fn follow_redirect(state: &AppState, url: &str) -> String {
    match state
        .http_no_redirect
        .get(url)
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(8))
        .send_roblox(&state.roblox_requests, None)
        .await
    {
        Ok(res) => res
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .unwrap_or(url)
            .to_string(),
        Err(_) => url.to_string(),
    }
}

pub struct ShareLinkResult {
    pub ok: bool,
    pub place_id: Option<String>,
    pub link_code: Option<String>,
    pub error: Option<String>,
}

pub async fn resolve_share_link(
    state: &AppState,
    share_code: &str,
    cookie: &str,
    csrf_token: Option<&str>,
) -> ShareLinkResult {
    let payloads = [
        serde_json::json!({ "linkId": share_code, "linkType": "Server" }).to_string(),
        serde_json::json!({ "code": share_code, "type": "Server" }).to_string(),
    ];
    let mut current_csrf = csrf_token.map(|s| s.to_string()).unwrap_or_default();

    for payload in payloads {
        let (status, headers, body) = post_raw(
            state,
            "https://apis.roblox.com/sharelinks/v1/resolve-link",
            cookie,
            &current_csrf,
            &payload,
        )
        .await;
        if status == 200 {
            if let Some((pid, lc)) = extract_place_link(&body) {
                return ShareLinkResult {
                    ok: true,
                    place_id: Some(pid),
                    link_code: Some(lc),
                    error: None,
                };
            }
        }
        if status == 403 {
            if let Some(fresh) = headers.get("x-csrf-token").and_then(|v| v.to_str().ok()) {
                let (status2, _h2, body2) = post_raw(
                    state,
                    "https://apis.roblox.com/sharelinks/v1/resolve-link",
                    cookie,
                    fresh,
                    &payload,
                )
                .await;
                if status2 == 200 {
                    if let Some((pid, lc)) = extract_place_link(&body2) {
                        return ShareLinkResult {
                            ok: true,
                            place_id: Some(pid),
                            link_code: Some(lc),
                            error: None,
                        };
                    }
                }
                current_csrf = fresh.to_string();
            }
        }
    }
    ShareLinkResult {
        ok: false,
        place_id: None,
        link_code: None,
        error: Some("Could not resolve share link. It may be expired or invalid.".into()),
    }
}

// Compiled once; the patterns are constants and are exercised by the tests
// below, so the unwraps can only fire on first use.
static PLACE_ID_JSON_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r#""placeId"\s*:\s*(\d+)"#).unwrap());
static LINK_CODE_JSON_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
    regex::Regex::new(
        r#""(?:linkCode|privateServerLinkCode|accessCode|linkcode)"\s*:\s*"([A-Za-z0-9_\-]+)""#,
    )
    .unwrap()
});
static ACCESS_CODE_QUERY_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"[?&]accessCode=([^&]+)").unwrap());

fn extract_place_link(body: &str) -> Option<(String, String)> {
    let pid = PLACE_ID_JSON_RE
        .captures(body)?
        .get(1)?
        .as_str()
        .to_string();
    let lc = LINK_CODE_JSON_RE
        .captures(body)?
        .get(1)?
        .as_str()
        .to_string();
    Some((pid, lc))
}

async fn post_raw(
    state: &AppState,
    url: &str,
    cookie: &str,
    csrf: &str,
    body: &str,
) -> (u16, reqwest::header::HeaderMap, String) {
    let res = state
        .http_no_redirect
        .post(url)
        .header("Cookie", format!(".ROBLOSECURITY={}", cookie))
        .header("X-CSRF-TOKEN", csrf)
        .header("Content-Type", "application/json")
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(8))
        .body(body.to_string())
        .send_roblox(&state.roblox_requests, Some(cookie))
        .await;
    match res {
        Ok(r) => {
            let status = r.status().as_u16();
            let headers = r.headers().clone();
            let body = r.text().await.unwrap_or_default();
            (status, headers, body)
        }
        Err(_) => (0, reqwest::header::HeaderMap::new(), String::new()),
    }
}

pub async fn get_access_code(
    state: &AppState,
    place_id: &str,
    link_code: &str,
    cookie: &str,
    csrf_token: &str,
) -> Option<String> {
    let body = serde_json::json!({ "shareCode": link_code, "shareType": "Server" }).to_string();
    let res = state
        .http_no_redirect
        .post("https://apis.roblox.com/sharelinks/v1/resolve")
        .header("Cookie", format!(".ROBLOSECURITY={}", cookie))
        .header("X-CSRF-TOKEN", csrf_token)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Origin", "https://www.roblox.com")
        .header("Referer", "https://www.roblox.com")
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(8))
        .body(body)
        .send_roblox(&state.roblox_requests, Some(cookie))
        .await;
    if let Ok(r) = res {
        if let Ok(d) = r.json::<Value>().await {
            let code = d
                .get("privateServerInviteData")
                .or_else(|| {
                    d.get("resolvedShareData")
                        .and_then(|v| v.get("privateServerInviteData"))
                })
                .or_else(|| {
                    d.get("experienceInviteData")
                        .and_then(|v| v.get("privateServerInviteData"))
                })
                .and_then(|v| v.get("accessCode"))
                .and_then(|v| v.as_str());
            if let Some(code) = code {
                return Some(code.to_string());
            }
        }
    }

    // Fallback: redirect scrape.
    let url = format!(
        "https://www.roblox.com/games/{}?privateServerLinkCode={}",
        place_id, link_code
    );
    let res = state
        .http_no_redirect
        .get(&url)
        .header("Cookie", format!(".ROBLOSECURITY={}", cookie))
        .header("Referer", "https://www.roblox.com")
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(5))
        .send_roblox(&state.roblox_requests, Some(cookie))
        .await
        .ok()?;
    let loc = res
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())?;
    ACCESS_CODE_QUERY_RE
        .captures(loc)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn validate_roblox_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "Invalid Roblox URL".to_string())?;
    let host = parsed.host_str().unwrap_or("");
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some_and(|port| port != 443)
        || !(host == "roblox.com" || host.ends_with(".roblox.com"))
    {
        return Err("Only HTTPS Roblox URLs on port 443 are allowed".into());
    }
    Ok(())
}

// Proxied through Rust since *.roblox.com sends no CORS headers and a
// renderer-side fetch() would get blocked.
pub async fn get_json_public(state: &AppState, url: &str) -> Result<Value, String> {
    validate_roblox_url(url)?;
    let res = state
        .http_no_redirect
        .get(url)
        .header("Accept", "application/json")
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(10))
        .send_roblox(&state.roblox_requests, None)
        .await;
    let res = match res {
        Ok(response) => response,
        Err(error) if error.status != 0 => {
            return Ok(
                serde_json::json!({ "ok": false, "status": error.status, "data": { "errors": [{ "message": error.message }] } }),
            )
        }
        Err(error) => return Err(error.to_string()),
    };
    let status = res.status().as_u16();
    let ok = res.status().is_success();
    let data: Value = res.json().await.unwrap_or(Value::Null);
    Ok(serde_json::json!({ "ok": ok, "status": status, "data": data }))
}

// Fetches the WEAO exploit directory JSON. Only the allowed host is accepted.
pub async fn get_weao_data(state: &AppState) -> Result<Value, String> {
    let url = "https://weao.xyz/api/status/exploits";
    let res = state
        .http
        .get(url)
        .header("Accept", "application/json")
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let data: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(data)
}

// Same as get_json_public but authenticated with the account's cookie —
// some endpoints (e.g. the public server list) now require a logged-in
// session and return empty/errors without it.
pub async fn get_json_auth(state: &AppState, url: &str, cookie: &str) -> Result<Value, String> {
    validate_roblox_url(url)?;
    let res = state
        .http_no_redirect
        .get(url)
        .header("Cookie", format!(".ROBLOSECURITY={}", cookie))
        .header("Accept", "application/json")
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(10))
        .send_roblox(&state.roblox_requests, Some(cookie))
        .await;
    let res = match res {
        Ok(response) => response,
        Err(error) if error.status != 0 => {
            return Ok(
                serde_json::json!({ "ok": false, "status": error.status, "data": { "errors": [{ "message": error.message }] } }),
            )
        }
        Err(error) => return Err(error.to_string()),
    };
    let status = res.status().as_u16();
    let ok = res.status().is_success();
    let data: Value = res.json().await.unwrap_or(Value::Null);
    Ok(serde_json::json!({ "ok": ok, "status": status, "data": data }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn place_id_from_a_bare_id() {
        assert_eq!(extract_place_id("1818"), Some("1818".into()));
        assert_eq!(extract_place_id("  1818  "), Some("1818".into()));
    }

    #[test]
    fn place_id_from_game_urls() {
        for input in [
            "https://www.roblox.com/games/1818/Classic-Crossroads",
            "www.roblox.com/games/1818/Classic-Crossroads",
            "https://www.roblox.com/games/1818",
        ] {
            assert_eq!(
                extract_place_id(input),
                Some("1818".into()),
                "failed for {}",
                input
            );
        }
    }

    #[test]
    fn place_id_from_a_query_parameter() {
        assert_eq!(
            extract_place_id("https://www.roblox.com/games/start?placeId=1818"),
            Some("1818".into())
        );
    }

    #[test]
    fn place_id_rejects_non_numeric_and_junk() {
        assert_eq!(extract_place_id(""), None);
        assert_eq!(extract_place_id("not a link"), None);
        assert_eq!(
            extract_place_id("https://www.roblox.com/games/abc/Name"),
            None
        );
        assert_eq!(
            extract_place_id("https://www.roblox.com/users/1818/profile"),
            None
        );
    }

    #[test]
    fn roblox_errors_use_the_human_message() {
        assert_eq!(
            extract_roblox_error(r#"{"errors":[{"code":0,"message":"Token Validation Failed"}]}"#),
            "Token Validation Failed"
        );
        assert_eq!(
            extract_roblox_error(r#"{"message":"Too many requests"}"#),
            "Too many requests"
        );
    }

    #[test]
    fn non_json_errors_fall_back_to_a_truncated_body() {
        assert_eq!(extract_roblox_error("<html>502</html>"), "<html>502</html>");
        let long = "x".repeat(500);
        assert_eq!(extract_roblox_error(&long).len(), 200, "body is capped");
    }

    #[test]
    fn share_link_extraction_needs_both_ids() {
        let body = r#"{"placeId":1818,"linkCode":"abc-DEF_123"}"#;
        assert_eq!(
            extract_place_link(body),
            Some(("1818".into(), "abc-DEF_123".into()))
        );
        assert_eq!(
            extract_place_link(r#"{"placeId":1818}"#),
            None,
            "no link code"
        );
        assert_eq!(
            extract_place_link(r#"{"linkCode":"abc"}"#),
            None,
            "no place id"
        );
    }

    #[test]
    fn share_link_accepts_the_other_code_field_names() {
        for field in ["privateServerLinkCode", "accessCode", "linkcode"] {
            let body = format!(r#"{{"placeId":7,"{}":"zzz"}}"#, field);
            assert_eq!(
                extract_place_link(&body),
                Some(("7".into(), "zzz".into())),
                "failed for {}",
                field
            );
        }
    }

    #[test]
    fn authenticated_urls_reject_plaintext_credentials_ports_and_untrusted_hosts() {
        for url in [
            "http://users.roblox.com/v1/users/authenticated",
            "https://roblox.com.evil.test/",
            "https://roblox.com:8080/",
            "https://user:password@roblox.com/",
        ] {
            assert!(validate_roblox_url(url).is_err(), "accepted {url}");
        }
        assert!(validate_roblox_url("https://users.roblox.com/v1/users/authenticated").is_ok());
    }

    #[derive(Debug)]
    struct AuthRequest {
        method: String,
        target: String,
        headers: std::collections::HashMap<String, String>,
        body: Vec<u8>,
    }

    impl AuthRequest {
        fn has_auth_format(&self) -> bool {
            self.method == "POST"
                && self.headers.get("accept").map(String::as_str) == Some("application/json")
                && self.headers.get("content-type").map(String::as_str) == Some("application/json")
                && self.headers.get("content-length").map(String::as_str) == Some("0")
                && self.body.is_empty()
        }
    }

    type ObservedRequests = std::sync::Arc<std::sync::Mutex<Vec<AuthRequest>>>;

    // Local HTTP fixture only: never contacts Roblox or needs real credentials.
    // Unlike a response-only stub, it rejects malformed media types with 415
    // and records the complete headers/body, including the second CSRF POST.
    // It keeps accepting after the planned replies to detect unexpected retries.
    async fn ticket_endpoint(responses: Vec<(&str, &str)>) -> (String, ObservedRequests) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = ObservedRequests::default();
        let observed = requests.clone();
        let mut replies: std::collections::VecDeque<String> = responses.into_iter().map(|(status, headers)|
            format!("HTTP/1.1 {status}\r\n{headers}Content-Length: 2\r\nConnection: close\r\n\r\n{{}}")
        ).collect();
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = tokio::time::timeout(Duration::from_secs(2), async {
                    let mut buf = Vec::new();
                    let header_end = loop {
                        let mut chunk = [0; 1024];
                        let len = stream.read(&mut chunk).await.unwrap();
                        assert!(len > 0, "request ended before its headers");
                        buf.extend_from_slice(&chunk[..len]);
                        assert!(buf.len() < 16 * 1024, "oversized fixture request");
                        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break end + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..header_end]);
                    let mut lines = head.lines();
                    let mut first = lines.next().unwrap().split_whitespace();
                    let method = first.next().unwrap().to_string();
                    let target = first.next().unwrap().to_string();
                    let headers: std::collections::HashMap<String, String> = lines
                        .filter_map(|line| line.split_once(':'))
                        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_string()))
                        .collect();
                    let length = headers
                        .get("content-length")
                        .and_then(|v| v.parse::<usize>().ok())
                        .unwrap_or(0);
                    assert!(length < 16 * 1024, "oversized fixture body");
                    while buf.len() < header_end + length {
                        let mut chunk = [0; 1024];
                        let len = stream.read(&mut chunk).await.unwrap();
                        assert!(len > 0, "request ended before its body");
                        buf.extend_from_slice(&chunk[..len]);
                    }
                    AuthRequest {
                        method,
                        target,
                        headers,
                        body: buf[header_end..].to_vec(),
                    }
                })
                .await
                .unwrap();
                let reply = if request.has_auth_format() {
                    replies.pop_front().unwrap_or_else(|| "HTTP/1.1 500 Unexpected Retry\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into())
                } else {
                    "HTTP/1.1 415 Unsupported Media Type\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into()
                };
                observed.lock().unwrap().push(request);
                stream.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        (url, requests)
    }

    fn assert_auth_requests(requests: &ObservedRequests, expected: usize) {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), expected);
        for request in requests.iter() {
            assert!(
                request.has_auth_format(),
                "invalid auth request: {request:?}"
            );
            assert_eq!(
                request.headers.get("cookie").map(String::as_str),
                Some(".ROBLOSECURITY=fake-session")
            );
        }
    }

    #[tokio::test]
    async fn csrf_probe_has_json_media_type_empty_body_and_no_csrf_header() {
        let (url, requests) =
            ticket_endpoint(vec![("403 Forbidden", "x-csrf-token: fresh\r\n")]).await;
        let policy = crate::request_policy::RequestPolicy::default();
        let token = request_csrf_token(
            &reqwest::Client::new(),
            &policy,
            &format!("{url}/v2/logout"),
            "fake-session",
        )
        .await
        .unwrap();
        assert_eq!(token, "fresh");
        assert_auth_requests(&requests, 1);
        let requests = requests.lock().unwrap();
        assert_eq!(requests[0].target, "/v2/logout");
        assert!(!requests[0].headers.contains_key("x-csrf-token"));
    }

    #[tokio::test]
    async fn authentication_retries_once_only_for_explicit_csrf_refresh() {
        let (url, requests) = ticket_endpoint(vec![
            ("403 Forbidden", "x-csrf-token: fresh\r\n"),
            ("200 OK", "rbx-authentication-ticket: ticket-1\r\n"),
        ])
        .await;
        let policy = crate::request_policy::RequestPolicy::default();
        let (ticket, token) =
            request_auth_ticket(&reqwest::Client::new(), &policy, &url, "fake-session", None)
                .await
                .unwrap();
        assert_eq!(ticket, "ticket-1");
        assert_eq!(token.as_deref(), Some("fresh"));
        assert_auth_requests(&requests, 2);
        let requests = requests.lock().unwrap();
        assert!(!requests[0].headers.contains_key("x-csrf-token"));
        assert_eq!(
            requests[1].headers.get("x-csrf-token").map(String::as_str),
            Some("fresh")
        );
        for request in requests.iter() {
            assert_eq!(
                request.headers.get("origin").map(String::as_str),
                Some("https://www.roblox.com")
            );
            assert_eq!(
                request.headers.get("referer").map(String::as_str),
                Some("https://www.roblox.com")
            );
        }
    }

    #[tokio::test]
    async fn authentication_replaces_stale_csrf_and_never_retries_a_second_refresh() {
        for second_status in ["200 OK", "403 Forbidden"] {
            let (url, requests) = ticket_endpoint(vec![
                ("403 Forbidden", "x-csrf-token: fresh\r\n"),
                (
                    second_status,
                    "x-csrf-token: second-refresh\r\nrbx-authentication-ticket: ticket-2\r\n",
                ),
            ])
            .await;
            let policy = crate::request_policy::RequestPolicy::default();
            let result = request_auth_ticket(
                &reqwest::Client::new(),
                &policy,
                &url,
                "fake-session",
                Some("stale".into()),
            )
            .await;
            assert_eq!(result.is_ok(), second_status == "200 OK");
            assert_auth_requests(&requests, 2);
            let requests = requests.lock().unwrap();
            assert_eq!(
                requests[0].headers.get("x-csrf-token").map(String::as_str),
                Some("stale")
            );
            assert_eq!(
                requests[1].headers.get("x-csrf-token").map(String::as_str),
                Some("fresh")
            );
        }
    }

    #[tokio::test]
    async fn authentication_does_not_retry_denials_limits_or_server_failures() {
        for status in [
            "400 Bad Request",
            "401 Unauthorized",
            "403 Forbidden",
            "415 Unsupported Media Type",
            "429 Too Many Requests",
            "500 Internal Server Error",
        ] {
            let (url, requests) = ticket_endpoint(vec![(status, "")]).await;
            let policy = crate::request_policy::RequestPolicy::default();
            let result =
                request_auth_ticket(&reqwest::Client::new(), &policy, &url, "fake-session", None)
                    .await;
            assert!(result.is_err(), "accepted {status}");
            assert_auth_requests(&requests, 1);
            if status.starts_with("415") {
                let error = result.unwrap_err();
                assert!(error.contains("request format") && error.contains("HTTP 415"));
                assert!(!error.contains("Check the account"));
            }
        }
    }

    #[tokio::test]
    async fn authentication_stops_on_security_challenge_even_with_csrf_header() {
        let (url, requests) = ticket_endpoint(vec![(
            "403 Forbidden",
            "x-csrf-token: fresh\r\nrblx-challenge-id: challenge\r\n",
        )])
        .await;
        let policy = crate::request_policy::RequestPolicy::default();
        assert!(
            request_auth_ticket(&reqwest::Client::new(), &policy, &url, "fake-session", None)
                .await
                .is_err()
        );
        assert_auth_requests(&requests, 1);
    }

    #[tokio::test]
    async fn csrf_probe_stops_on_challenge_denial_or_format_error() {
        for (status, headers) in [
            (
                "403 Forbidden",
                "x-csrf-token: fresh\r\nrblx-challenge-id: challenge\r\n",
            ),
            ("403 Forbidden", ""),
            ("415 Unsupported Media Type", ""),
        ] {
            let (url, requests) = ticket_endpoint(vec![(status, headers)]).await;
            let policy = crate::request_policy::RequestPolicy::default();
            let result =
                request_csrf_token(&reqwest::Client::new(), &policy, &url, "fake-session").await;
            assert!(result.is_err(), "accepted {status}");
            assert_auth_requests(&requests, 1);
            if status.starts_with("415") {
                assert!(result.unwrap_err().contains("request format (HTTP 415)"));
            }
        }
    }

    #[tokio::test]
    async fn authentication_requires_a_successful_status_and_nonempty_ticket() {
        for (status, headers) in [
            ("200 OK", ""),
            ("200 OK", "rbx-authentication-ticket: \r\n"),
            (
                "401 Unauthorized",
                "rbx-authentication-ticket: ticket-on-error\r\n",
            ),
        ] {
            let (url, requests) = ticket_endpoint(vec![(status, headers)]).await;
            let policy = crate::request_policy::RequestPolicy::default();
            assert!(request_auth_ticket(
                &reqwest::Client::new(),
                &policy,
                &url,
                "fake-session",
                None
            )
            .await
            .is_err());
            assert_auth_requests(&requests, 1);
        }
    }

    #[tokio::test]
    async fn authentication_format_error_does_not_suspend_a_valid_session() {
        let (url, requests) = ticket_endpoint(vec![
            ("415 Unsupported Media Type", ""),
            ("200 OK", "rbx-authentication-ticket: ticket-after-fix\r\n"),
        ])
        .await;
        let policy = crate::request_policy::RequestPolicy::default();
        let client = reqwest::Client::new();
        assert!(
            request_auth_ticket(&client, &policy, &url, "fake-session", None)
                .await
                .is_err()
        );
        let (ticket, _) = request_auth_ticket(&client, &policy, &url, "fake-session", None)
            .await
            .unwrap();
        assert_eq!(ticket, "ticket-after-fix");
        assert_auth_requests(&requests, 2);
    }
}

// Same CORS gap as roblox.com above -- see altgen.me/docs/generate-accounts.
pub async fn altgen_generate(
    state: &AppState,
    api_key: &str,
    quantity: i64,
) -> Result<Value, String> {
    let body = serde_json::json!({ "type": "ROBLOX_NORMAL", "quantity": quantity.clamp(1, 100) });
    let res = state
        .http
        .post("https://api.altgen.me/api/v1/generate")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .timeout(Duration::from_secs(15))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let data: Value = res.json().await.unwrap_or(Value::Null);
    Ok(serde_json::json!({ "status": status, "data": data }))
}

// ---- follow user ----
// Resolves a username to the place/server they're currently in, so an account
// can be launched straight into it. Two hops: username -> userId, then
// presence -> placeId + gameId (the job/server id).
//
// Roblox only reports placeId/gameId here when the target's "who can see me
// online" privacy setting allows it AND they're in a joinable public server,
// so a "not joinable" result is frequently the target's own privacy/server
// state rather than a lookup failure -- the distinct messages below matter
// for the user being able to tell those apart.
pub async fn follow_user_target(
    state: &AppState,
    cookie: &str,
    username: &str,
) -> Result<Value, String> {
    let name = username.trim().trim_start_matches('@');
    if name.is_empty() {
        return Err("Enter a username".into());
    }

    let csrf = get_csrf_token(state, cookie).await?;

    // 1. username -> userId
    let body = serde_json::json!({
        "usernames": [name],
        "excludeBannedUsers": false
    })
    .to_string();
    let (status, _h, resp) = post_raw(
        state,
        "https://users.roblox.com/v1/usernames/users",
        cookie,
        &csrf,
        &body,
    )
    .await;
    if status != 200 {
        return Err(format!("Username lookup failed (HTTP {})", status));
    }
    let json: Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
    let user = json
        .get("data")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| format!("No Roblox user named \"{}\"", name))?;
    let user_id = user
        .get("id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "Unexpected username lookup response".to_string())?;
    let real_name = user
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(name)
        .to_string();

    // 2. userId -> current presence
    let body = serde_json::json!({ "userIds": [user_id] }).to_string();
    let (status, _h, resp) = post_raw(
        state,
        "https://presence.roblox.com/v1/presence/users",
        cookie,
        &csrf,
        &body,
    )
    .await;
    if status != 200 {
        return Err(format!("Presence lookup failed (HTTP {})", status));
    }
    let json: Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
    let p = json
        .get("userPresences")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| "Unexpected presence response".to_string())?;

    // 0 Offline, 1 Online (site/app, not in a game), 2 InGame, 3 InStudio.
    let ptype = p
        .get("userPresenceType")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if ptype != 2 {
        return Err(format!("{} is not in a game right now", real_name));
    }

    let place_id = p.get("placeId").and_then(|v| v.as_i64());
    let job_id = p.get("gameId").and_then(|v| v.as_str());
    match (place_id, job_id) {
        (Some(pid), Some(jid)) if !jid.is_empty() => Ok(serde_json::json!({
            "username": real_name,
            "target": format!("{}:{}", pid, jid),
        })),
        // In a game, but Roblox withheld the server details -- that's the
        // target's join-privacy setting, not an error on our side.
        _ => Err(format!(
            "{} is in a game, but their server isn't joinable (their privacy settings may hide it)",
            real_name
        )),
    }
}
