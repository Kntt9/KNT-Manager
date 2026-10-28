//! Shared admission control for Roblox's legacy HTTP APIs. No automatic replay.
use reqwest::{header::HeaderMap, RequestBuilder, StatusCode};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime};
use tokio::sync::Mutex;
use tokio::time::Instant;

const SPACING: Duration = Duration::from_millis(250);
const MAX_BODY: usize = 8 * 1024 * 1024;

#[derive(Default)]
struct PolicyState {
    next_start: Option<Instant>,
    cooldown: Option<Instant>,
    rate_limits: u32,
    invalid_sessions: HashSet<[u8; 32]>,
    denied_sessions: HashMap<[u8; 32], Instant>,
}

#[derive(Default)]
pub struct RequestPolicy(Mutex<PolicyState>);

impl RequestPolicy {
    pub async fn pause_authentication(&self, cookie: &str) {
        self.0.lock().await.denied_sessions.insert(
            Sha256::digest(cookie.as_bytes()).into(),
            Instant::now() + Duration::from_secs(15 * 60),
        );
    }
}

pub struct ApiResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
}

#[derive(Debug)]
pub struct RequestError {
    pub status: u16,
    pub message: String,
}

impl std::fmt::Display for RequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl From<String> for RequestError {
    fn from(message: String) -> Self {
        Self { status: 0, message }
    }
}

impl From<RequestError> for String {
    fn from(error: RequestError) -> Self {
        error.message
    }
}

impl ApiResponse {
    pub fn status(&self) -> StatusCode {
        self.status
    }
    pub fn headers(&self) -> &HeaderMap {
        &self.headers
    }
    pub async fn text(self) -> Result<String, String> {
        Ok(self.body)
    }
    pub async fn json<T: DeserializeOwned>(self) -> Result<T, String> {
        serde_json::from_str(&self.body).map_err(|_| "Invalid JSON response from Roblox".into())
    }
}

fn retry_delay(headers: &HeaderMap, failures: u32, now: SystemTime) -> Duration {
    let fallback = Duration::from_secs(30 * 2u64.pow(failures.saturating_sub(1).min(5)));
    let Some(value) = headers.get("retry-after").and_then(|v| v.to_str().ok()) else {
        return fallback;
    };
    if let Ok(seconds) = value.trim().parse::<u64>() {
        return Duration::from_secs(seconds.max(1));
    }
    chrono::DateTime::parse_from_rfc2822(value)
        .ok()
        .and_then(|date| SystemTime::try_from(date.with_timezone(&chrono::Utc)).ok())
        .and_then(|date| date.duration_since(now).ok())
        .filter(|delay| !delay.is_zero())
        .unwrap_or(fallback)
}

fn remaining(deadline: Instant) -> u64 {
    deadline
        .saturating_duration_since(Instant::now())
        .as_secs()
        .saturating_add(1)
}

pub trait RobloxRequest {
    async fn send_roblox(
        self,
        policy: &RequestPolicy,
        cookie: Option<&str>,
    ) -> Result<ApiResponse, RequestError>;
}

impl RobloxRequest for RequestBuilder {
    async fn send_roblox(
        self,
        policy: &RequestPolicy,
        cookie: Option<&str>,
    ) -> Result<ApiResponse, RequestError> {
        // Keep the guard through the body read: every caller shares one queue,
        // including background validation and manual/group launches.
        let mut state = policy.0.lock().await;
        let identity = cookie
            .filter(|c| !c.is_empty())
            .map(|c| <[u8; 32]>::from(Sha256::digest(c.as_bytes())));
        state
            .denied_sessions
            .retain(|_, until| *until > Instant::now());
        if let Some(identity) = identity {
            if state.invalid_sessions.contains(&identity) {
                return Err(RequestError {
                    status: 401,
                    message: "Session rejected (HTTP 401). Sign in again before retrying.".into(),
                });
            }
            if let Some(until) = state.denied_sessions.get(&identity) {
                return Err(RequestError { status: 403, message: format!("Access denied (HTTP 403). Requests paused for {} seconds; check the account in Roblox.", remaining(*until)) });
            }
        }
        if let Some(until) = state.cooldown.filter(|until| *until > Instant::now()) {
            return Err(RequestError {
                status: 429,
                message: format!(
                    "Roblox rate limit (HTTP 429). Requests paused for {} seconds.",
                    remaining(until)
                ),
            });
        }
        if let Some(next) = state.next_start {
            tokio::time::sleep_until(next).await;
        }
        state.next_start = Some(Instant::now() + SPACING);
        let mut response = self
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    "Roblox request timed out".to_string()
                } else {
                    "Could not connect to Roblox. Check your connection.".to_string()
                }
            })?;
        let status = response.status();
        let headers = response.headers().clone();
        if status == StatusCode::TOO_MANY_REQUESTS {
            state.rate_limits = state.rate_limits.saturating_add(1);
            let delay = retry_delay(&headers, state.rate_limits, SystemTime::now());
            // Fail closed for an unrepresentable server deadline.
            state.cooldown = Some(
                Instant::now()
                    .checked_add(delay)
                    .unwrap_or_else(|| Instant::now() + Duration::from_secs(100 * 365 * 86400)),
            );
        }
        if let Some(identity) = identity {
            if status == StatusCode::UNAUTHORIZED {
                state.invalid_sessions.insert(identity);
            } else if headers.contains_key("rblx-challenge-id") {
                state
                    .denied_sessions
                    .insert(identity, Instant::now() + Duration::from_secs(15 * 60));
            }
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Could not read Roblox response".to_string())?
        {
            if body.len().saturating_add(chunk.len()) > MAX_BODY {
                return Err("Roblox response exceeded the size limit".to_string().into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(ApiResponse {
            status,
            headers,
            body: String::from_utf8_lossy(&body).into_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn endpoint(status: &str, extra: &str, body: &str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let reply = format!(
            "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0; 8192];
            stream.read(&mut buf).await.unwrap();
            stream.write_all(reply.as_bytes()).await.unwrap();
        });
        url
    }

    #[test]
    fn retry_after_supports_seconds_dates_and_backoff() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1445412480);
        let mut headers = HeaderMap::new();
        assert_eq!(retry_delay(&headers, 1, now).as_secs(), 30);
        assert_eq!(retry_delay(&headers, 2, now).as_secs(), 60);
        headers.insert("retry-after", "120".parse().unwrap());
        assert_eq!(retry_delay(&headers, 1, now).as_secs(), 120);
        headers.insert(
            "retry-after",
            "Wed, 21 Oct 2015 07:30:00 GMT".parse().unwrap(),
        );
        assert_eq!(retry_delay(&headers, 1, now).as_secs(), 120);
        headers.insert("retry-after", "invalid".parse().unwrap());
        assert_eq!(retry_delay(&headers, 20, now).as_secs(), 960);
    }

    #[tokio::test]
    async fn rate_limit_stops_other_accounts_without_another_request() {
        let policy = RequestPolicy::default();
        let client = reqwest::Client::new();
        let url = endpoint("429 Too Many Requests", "Retry-After: 60\r\n", "{}").await;
        assert_eq!(
            client
                .get(&url)
                .send_roblox(&policy, Some("a"))
                .await
                .unwrap()
                .status(),
            429
        );
        let err = client
            .get(&url)
            .send_roblox(&policy, Some("b"))
            .await
            .err()
            .unwrap();
        assert_eq!(err.status, 429, "{err}");
    }

    #[tokio::test]
    async fn rejected_session_stays_stopped_but_replacement_can_proceed() {
        let policy = RequestPolicy::default();
        let client = reqwest::Client::new();
        let url = endpoint("401 Unauthorized", "", "{}").await;
        client
            .get(&url)
            .send_roblox(&policy, Some("old"))
            .await
            .unwrap();
        let err = client
            .get(&url)
            .send_roblox(&policy, Some("old"))
            .await
            .err()
            .unwrap();
        assert_eq!(err.status, 401);
        let url = endpoint("200 OK", "", "{}").await;
        assert!(client
            .get(url)
            .send_roblox(&policy, Some("new"))
            .await
            .unwrap()
            .status()
            .is_success());
    }

    #[tokio::test]
    async fn resource_permission_denial_does_not_suspend_a_valid_session() {
        let policy = RequestPolicy::default();
        let client = reqwest::Client::new();
        let url = endpoint("403 Forbidden", "x-csrf-token: fresh\r\n", "{}").await;
        client
            .post(url)
            .send_roblox(&policy, Some("a"))
            .await
            .unwrap();
        let url = endpoint("403 Forbidden", "", "{}").await;
        client
            .post(&url)
            .send_roblox(&policy, Some("a"))
            .await
            .unwrap();
        let success = endpoint("200 OK", "", "{}").await;
        assert!(client
            .get(success)
            .send_roblox(&policy, Some("a"))
            .await
            .unwrap()
            .status()
            .is_success());
        policy.pause_authentication("a").await;
        assert_eq!(
            client
                .post(url)
                .send_roblox(&policy, Some("a"))
                .await
                .err()
                .unwrap()
                .status,
            403
        );
    }

    #[tokio::test]
    async fn concurrent_callers_share_the_minimum_request_interval() {
        let policy = RequestPolicy::default();
        let client = reqwest::Client::new();
        let first = endpoint("200 OK", "", "{}").await;
        let second = endpoint("200 OK", "", "{}").await;
        let started = Instant::now();
        let (a, b) = tokio::join!(
            client.get(first).send_roblox(&policy, Some("a")),
            client.get(second).send_roblox(&policy, Some("b")),
        );
        assert!(a.unwrap().status().is_success());
        assert!(b.unwrap().status().is_success());
        assert!(started.elapsed() >= Duration::from_millis(200));
    }
}
