use crate::paths::app_data_dir;
use crate::state::AppState;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Command;

pub(crate) fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

// ---- native helper (RobloxNative.exe) resolution ----
// Tauri's resource_dir() returns a \\?\-prefixed path on Windows that
// csc.exe's argument parser chokes on, so it has to be stripped first.
fn strip_verbatim_prefix(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

fn native_src_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok().map(|d| {
        strip_verbatim_prefix(&d)
            .join("resources")
            .join("RobloxNative.cs")
    })
}
fn bundled_native_exe_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok().map(|d| {
        strip_verbatim_prefix(&d)
            .join("resources")
            .join("RobloxNative.exe")
    })
}

// Baked in at compile time so the exe works standalone without its sibling
// resources/ folder; extracted to the app data dir on first use.
const EMBEDDED_NATIVE_EXE: &[u8] = include_bytes!("../resources/RobloxNative.exe");

static EMBEDDED_NATIVE_SHA: once_cell::sync::Lazy<[u8; 32]> = once_cell::sync::Lazy::new(|| {
    use sha2::Digest;
    sha2::Sha256::digest(EMBEDDED_NATIVE_EXE).into()
});

// Content-hashed, not length-compared. The helper speaks a line protocol now,
// so an older extracted copy isn't merely stale -- it doesn't understand
// "daemon" at all, prints usage to stderr and exits immediately, which the
// supervisor would then see as a crash and restart forever. A same-length
// build is unlikely but entirely possible, and the failure mode is an endless
// stream of spawned processes, so this compares what's actually in the file.
fn ensure_embedded_native_exe() -> Option<PathBuf> {
    let out = app_data_dir().join("RobloxNative.exe");
    let needs_write = match std::fs::read(&out) {
        Ok(bytes) => {
            use sha2::Digest;
            let on_disk: [u8; 32] = sha2::Sha256::digest(&bytes).into();
            on_disk != *EMBEDDED_NATIVE_SHA
        }
        Err(_) => true,
    };
    if needs_write {
        std::fs::create_dir_all(out.parent()?).ok()?;
        // A running helper holds this file open and the write fails; callers
        // sweep strays before extracting, so that's already handled.
        if let Err(e) = std::fs::write(&out, EMBEDDED_NATIVE_EXE) {
            eprintln!("[helper] could not refresh RobloxNative.exe: {}", e);
            // Only fall through to the existing copy if there is one -- better
            // a stale helper than none, and the version check above will retry
            // on the next run.
            if !out.exists() {
                return None;
            }
        }
    }
    Some(out)
}

fn find_csc() -> Option<PathBuf> {
    let win = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".to_string());
    for c in [
        Path::new(&win)
            .join("Microsoft.NET")
            .join("Framework64")
            .join("v4.0.30319")
            .join("csc.exe"),
        Path::new(&win)
            .join("Microsoft.NET")
            .join("Framework")
            .join("v4.0.30319")
            .join("csc.exe"),
    ] {
        if c.exists() {
            return Some(c);
        }
    }
    None
}

// Memoized for the app session: Some(Some(path)) = usable exe, Some(None) =
// resolved-to-unavailable, None = not yet resolved.
pub async fn ensure_native_helper(app: &AppHandle, state: &AppState) -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    {
        let cached = state.native_helper_path.lock().unwrap().clone();
        if let Some(resolved) = cached {
            return resolved;
        }
    }
    let resolved = resolve_native_helper(app).await;
    *state.native_helper_path.lock().unwrap() = Some(resolved.clone());
    resolved
}

async fn resolve_native_helper(app: &AppHandle) -> Option<PathBuf> {
    // Installed builds ship RobloxNative.exe as a normal loose resource next
    // to MultiRoblox.exe (see tauri.conf.json's bundle.resources) -- prefer
    // that plain, installer-placed file over self-extracting the embedded
    // copy. A binary that writes another PE from its own resources to disk
    // at runtime and executes it is a classic dropper behavior pattern to
    // heuristic/ML antivirus scanners, even when (as here) it's benign; not
    // doing that at all in the common case is strictly better than doing it
    // and hoping a scanner doesn't mind. The embedded fallback below still
    // covers running the bare .exe standalone without its resources/ folder.
    if let Some(b) = bundled_native_exe_path(app) {
        if b.exists() {
            return Some(b);
        }
    }
    if let Some(p) = ensure_embedded_native_exe() {
        return Some(p);
    }
    let src = native_src_path(app)?;
    if !src.exists() {
        return None;
    }
    let out_exe = app_data_dir().join("RobloxNative.exe");
    if let (Ok(out_meta), Ok(src_meta)) = (std::fs::metadata(&out_exe), std::fs::metadata(&src)) {
        if let (Ok(out_t), Ok(src_t)) = (out_meta.modified(), src_meta.modified()) {
            if out_t >= src_t {
                return Some(out_exe);
            }
        }
    }
    let csc = find_csc()?;
    let mut cmd = Command::new(&csc);
    cmd.args([
        "/nologo",
        "/optimize+",
        "/platform:x64",
        "/target:exe",
        "/r:System.Drawing.dll",
        &format!("/out:{}", out_exe.display()),
        &src.to_string_lossy(),
    ]);
    hide_window(&mut cmd);
    cmd.stdout(Stdio::null()).stderr(Stdio::piped());
    // Same leak as the RobloxNative.exe timeout fixes elsewhere: without
    // this, a timeout below drops output_timeout's internal child without
    // killing it, leaking a stuck csc.exe.
    cmd.kill_on_drop(true);
    let ok = match cmd.output_timeout(Duration::from_secs(30)).await {
        Some(Ok(output)) => output.status.success() && out_exe.exists(),
        _ => out_exe.exists(),
    };
    if ok {
        Some(out_exe)
    } else {
        None
    }
}

// tokio's Child has no built-in output() timeout.
trait OutputTimeout {
    async fn output_timeout(self, dur: Duration) -> Option<std::io::Result<std::process::Output>>;
}
impl OutputTimeout for Command {
    async fn output_timeout(
        mut self,
        dur: Duration,
    ) -> Option<std::io::Result<std::process::Output>> {
        tokio::time::timeout(dur, self.output()).await.ok()
    }
}

// Compiled once rather than per call. do_launch alone rebuilt three of these
// on every single launch; the patterns are constants so the unwraps here can
// only ever fire on the first use, never mid-launch.
static TASKLIST_PID_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r#""RobloxPlayerBeta\.exe","(\d+)""#).unwrap());
static JOB_SHORTHAND_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
    regex::Regex::new(r"^(\d+)[,:]\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$").unwrap()
});
static PLACE_ID_GAMES_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"/games/(\d+)").unwrap());
static PLACE_ID_ANY_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"/(\d+)").unwrap());

// ---- singleton mutex ----
// The one helper process owns ROBLOX_singletonMutex on a dedicated thread for
// the whole session (see helper.rs / MutexHolder in RobloxNative.cs). Nothing
// here spawns or kills a process any more -- these just tell the daemon which
// state to be in, and block until it has actually applied it.
/// Logs any RobloxPlayerBeta.exe processes that are already running when
/// MultiRoblox starts. These are orphans from a previous session or launched
/// outside the app. Useful for diagnosing "random Roblox windows" reports.
pub async fn log_startup_roblox_state(app: &AppHandle, state: &AppState) {
    if !cfg!(windows) {
        return;
    }
    if let Some(alive) = native_pids(app, state).await {
        let count = alive.len();
        if count > 0 {
            let pids_str: Vec<String> = alive.iter().map(|p| p.to_string()).collect();
            emit_log(
                app,
                "warn",
                "system",
                &format!(
                    "Found {} RobloxPlayerBeta.exe process(es) already running at startup (PIDs: {})",
                    count,
                    pids_str.join(", ")
                ),
                Some(serde_json::json!({ "pids": pids_str.join(", "), "count": count })),
            );
        }
    }
}

pub async fn start_mutex_holder(app: &AppHandle, state: &AppState) {
    if crate::helper::ensure(app, state).await.is_none() {
        eprintln!("[mutex] native helper unavailable");
    }
}

pub async fn set_multi_instance(app: &AppHandle, state: &AppState, on: bool) {
    let cmd = if on { "mutex|on" } else { "mutex|off" };
    if let Err(e) = crate::helper::call(app, state, cmd, crate::helper::SLOW_TIMEOUT).await {
        eprintln!("[mutex] {}: {}", cmd, e);
    }
}

// Re-acquires the mutex and re-closes any singleton handles. Roblox exiting
// can leave the name in a state where a fresh acquire is the only way to be
// certain we still own it, which is why kill-all runs this.
pub async fn restart_mutex_holder(app: &AppHandle, state: &AppState) {
    if let Err(e) =
        crate::helper::call(app, state, "mutex|rehold", crate::helper::SLOW_TIMEOUT).await
    {
        eprintln!("[mutex] rehold: {}", e);
    }
}

// Stops the helper and waits for it to actually exit -- called right before
// wiping app data, since the running helper holds its own exe file (which
// lives in that folder) open, and Windows won't delete a folder out from
// under an open handle.
pub async fn stop_all_native_helpers(state: &AppState) {
    if let Some(handle) = state.watch_handle.lock().unwrap().take() {
        handle.abort();
    }
    state
        .antiafk_on
        .store(false, std::sync::atomic::Ordering::SeqCst);
    crate::helper::shutdown(state).await;
}

// Resets every in-memory field that could otherwise point at data which no
// longer exists after a full app-data wipe (a memoized helper-exe path, a
// cached decryption key derived from a now-deleted salt, tracked PIDs for
// accounts that no longer exist, etc). Deliberately leaves login_cancel
// alone -- an in-progress login window closing on its own is harmless.
pub fn reset_state_for_wipe(state: &AppState) {
    *state.session_pass.lock().unwrap() = None;
    *state.cached_key.lock().unwrap() = None;
    *state.cached_legacy_key.lock().unwrap() = None;
    *state.native_helper_path.lock().unwrap() = None;
    // Lift the shutdown latch stop_all_native_helpers set, so the helper is
    // allowed to start again once the folder has been re-created. The sweep
    // flag stays set -- we just stopped the only helper there was, so there's
    // nothing stray to clear.
    state
        .helper_shutdown
        .store(false, std::sync::atomic::Ordering::SeqCst);
    state.account_pids.lock().unwrap().clear();
    state.manual_priority.lock().unwrap().clear();
    state.watched_accounts.lock().unwrap().clear();
    state.miss_counts.lock().unwrap().clear();
    state.auto_relaunch_history.lock().unwrap().clear();
    state.manual_kills.lock().unwrap().clear();
    state.home_accounts.lock().unwrap().clear();
    state.csrf_cache.lock().unwrap().clear();
    state.ticket_cache.lock().unwrap().clear();
    *state.last_launch_ts.lock().unwrap() = 0;
    clear_persisted_instances(state);
}

// ---- anti-AFK ----
// Runs on a background thread inside the one helper process. Toggling it is a
// request, not a spawn/kill, so switching it on and off repeatedly can't leave
// a stray process behind.
pub async fn start_antiafk(app: &AppHandle, state: &AppState) {
    if !cfg!(windows) {
        return;
    }
    let s = crate::settings::load_settings();
    let mut deadline = s
        .get("antiAfkInterval")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if deadline < 60 {
        deadline = 19 * 60; // 19 min, under the ~20-min idle kick
    }
    // vk 0 = helper default (VK_SHIFT).
    match crate::helper::call(
        app,
        state,
        &format!("antiafk|{}|0", deadline),
        crate::helper::DEFAULT_TIMEOUT,
    )
    .await
    {
        Ok(_) => {
            state
                .antiafk_on
                .store(true, std::sync::atomic::Ordering::SeqCst);
            emit_log(
                app,
                "ok",
                "afk",
                &format!("Anti-AFK started (interval: {} min)", deadline / 60),
                Some(serde_json::json!({ "intervalSec": deadline })),
            );
        }
        Err(e) => {
            eprintln!("[antiafk] {}", e);
            emit_log(
                app,
                "warn",
                "afk",
                &format!("Could not start Anti-AFK: {}", e),
                None,
            );
        }
    }
}

pub fn stop_antiafk(state: &AppState) {
    if !state
        .antiafk_on
        .swap(false, std::sync::atomic::Ordering::SeqCst)
    {
        return; // wasn't running; don't log a stop that never happened
    }
    emit_log(&state.app_handle, "warn", "afk", "Anti-AFK stopped", None);
    // Fire-and-forget: the helper stops its own thread. Nothing to reap.
    let app = state.app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let st = app.state::<AppState>();
        let _ = crate::helper::call(&app, &st, "antiafk|0", crate::helper::DEFAULT_TIMEOUT).await;
    });
}

// `extra` must stay nested under "meta" -- renderer.js's log handler expects it there.
pub fn emit_log(app: &AppHandle, level: &str, category: &str, message: &str, extra: Option<Value>) {
    let payload = serde_json::json!({
        "level": level,
        "category": category,
        "message": message,
        "meta": extra.unwrap_or_else(|| Value::Object(serde_json::Map::new())),
    });
    let _ = app.emit("log:entry", payload);
}

// ---- Roblox process helpers ----
// None means tasklist failed to run -- callers must not treat that as
// "confirmed zero processes" or a transient spawn failure looks like a
// closed account.
async fn tasklist(filter_image: &str) -> Option<String> {
    if !cfg!(windows) {
        return Some(String::new());
    }
    let mut cmd = Command::new("cmd");
    cmd.args([
        "/c",
        &format!(
            r#"tasklist /FI "IMAGENAME eq {}" /FO CSV /NH"#,
            filter_image
        ),
    ]);
    hide_window(&mut cmd);
    match cmd.output().await {
        Ok(out) => Some(String::from_utf8_lossy(&out.stdout).to_string()),
        Err(_) => None,
    }
}

// Asks the resident helper instead of shelling out and regex-parsing CSV.
// Falls back to tasklist() only if the helper can't be started at all.
async fn native_pids(app: &AppHandle, state: &AppState) -> Option<std::collections::HashSet<u32>> {
    if !cfg!(windows) {
        return Some(std::collections::HashSet::new());
    }
    match crate::helper::call(app, state, "pids", Duration::from_secs(10)).await {
        Ok(payload) => Some(
            payload
                .split(',')
                .filter_map(|s| s.trim().parse::<u32>().ok())
                .collect(),
        ),
        Err(_) => {
            let out = tasklist("RobloxPlayerBeta.exe").await?;
            Some(
                TASKLIST_PID_RE
                    .captures_iter(&out)
                    .filter_map(|c| c[1].parse::<u32>().ok())
                    .collect(),
            )
        }
    }
}

// RobloxPlayerBeta PIDs sitting in the "home" (tray): they own at least one
// top-level window but none is visible. The launcher home that survives when
// the user closes a game with the X is exactly this, so a watch tick can tell
// "went to home" apart from "really closed". Falls back to an empty set if the
// helper is unavailable (a missed signal only ever costs the amber badge).
// Returns Some(pids) when the helper confirmed the answer, None when the
// helper was unavailable or timed out. Callers MUST treat None as "we don't
// know" — an empty Some means "no home process", but None means the probe
// itself failed, and conflating the two is what used to drain every home
// account (and fire roblox:closed for all of them) on a single slow tick.
async fn home_pids(app: &AppHandle, state: &AppState) -> Option<std::collections::HashSet<u32>> {
    if !cfg!(windows) {
        return Some(std::collections::HashSet::new());
    }
    match crate::helper::call(app, state, "home", Duration::from_secs(10)).await {
        Ok(payload) => Some(
            payload
                .split(',')
                .filter_map(|s| s.trim().parse::<u32>().ok())
                .collect(),
        ),
        Err(_) => None,
    }
}

pub async fn set_roblox_volume(app: &AppHandle, state: &AppState, percent: f64) -> Value {
    if !cfg!(windows) {
        return serde_json::json!({ "ok": false, "count": 0, "error": "Windows only" });
    }
    let pct = percent.round().clamp(0.0, 100.0) as i64;
    match crate::helper::call(
        app,
        state,
        &format!("volume|{}", pct),
        crate::helper::DEFAULT_TIMEOUT,
    )
    .await
    {
        Ok(payload) => {
            let count = payload.trim().parse::<i64>().unwrap_or(0);
            serde_json::json!({ "ok": true, "count": count })
        }
        Err(e) => serde_json::json!({ "ok": false, "count": 0, "error": e }),
    }
}

// The accounts this app currently considers Running, derived from real
// process state. Deliberately the *only* definition: the badge count and the
// list the accounts grid reconciles against both come from here, so the two
// can never drift apart.
//
// An account is running when the PID attributed to it is alive. Instances the
// user started outside MultiRoblox are never included -- Kill can't act on
// them, so counting them would make the badge and the button disagree.
// Accounts launched through the OS URI handler sometimes never get a PID
// attributed at all; those fall back to the same coarse "is any Roblox
// running" signal watch_tick uses for them, and only while still watched.
pub fn running_account_ids(state: &AppState, alive: &std::collections::HashSet<u32>) -> Vec<String> {
    // watched before pids everywhere these two are held together, so no two
    // call sites can take them in opposite orders and deadlock.
    let watched = state.watched_accounts.lock().unwrap();
    let pids = state.account_pids.lock().unwrap();
    let mut ids: Vec<String> = pids
        .iter()
        .filter(|(_, pid)| alive.contains(pid) || is_launcher_process(**pid))
        .map(|(id, _)| id.clone())
        .collect();
    if !alive.is_empty() {
        for id in watched.keys() {
            if !pids.contains_key(id) {
                ids.push(id.clone());
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

fn owned_running_count(state: &AppState, alive: &std::collections::HashSet<u32>) -> u32 {
    running_account_ids(state, alive).len() as u32
}

pub async fn count_roblox_processes(app: &AppHandle, state: &AppState) -> u32 {
    match cached_or_spawn_pids(app, state).await {
        Some(alive) => owned_running_count(state, &alive),
        None => 0,
    }
}

/// The Running set the accounts grid reconciles against. Reads the same PID
/// snapshot count_roblox_processes does, so a poll of both in the same tick
/// can't return a list and a count that disagree.
pub async fn running_ids(app: &AppHandle, state: &AppState) -> Vec<String> {
    match cached_or_spawn_pids(app, state).await {
        Some(alive) => running_account_ids(state, &alive),
        // Couldn't read the process list this time. Answering "nothing is
        // running" would blank every card over a transient helper hiccup, so
        // hand back the last known tracking state and let the next poll (or
        // the watch tick) correct it.
        None => {
            let mut ids: Vec<String> = state
                .watched_accounts
                .lock()
                .unwrap()
                .keys()
                .cloned()
                .collect();
            ids.sort();
            ids
        }
    }
}

// ---- instance mirror (instances.json) ----
// account_pids only ever lived in memory, so closing MultiRoblox with clients
// still open threw away the only record of which process belonged to which
// account -- the next start saw N running RobloxPlayerBeta.exe and no way to
// attribute any of them, and reported 0 running. Mirroring the map to disk is
// what makes startup recovery possible.

/// The process's own creation timestamp (FILETIME ticks). Windows recycles
/// PIDs aggressively, so this is what proves a PID found at startup is the
/// same process we launched rather than a stranger that inherited the number.
#[cfg(windows)]
pub fn process_start_time(pid: u32) -> Option<u64> {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return None;
        };
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let ok =
            GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user).is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        Some(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
    }
}
#[cfg(not(windows))]
fn process_start_time(_pid: u32) -> Option<u64> {
    None
}

fn load_persisted_instances() -> Vec<(String, u32, Option<u64>)> {
    crate::jsonfile::read_array(&crate::paths::instances_path())
        .into_iter()
        .filter_map(|e| {
            let id = e.get("accountId")?.as_str()?.to_string();
            let pid = u32::try_from(e.get("pid")?.as_u64()?).ok()?;
            let start = e.get("startTime").and_then(|v| v.as_u64());
            Some((id, pid, start))
        })
        .collect()
}

/// Writes the current account -> PID map out. Cheap to call from anywhere
/// that touches account_pids (including the once-a-second watch tick): the
/// file is only rewritten when the map actually changed.
pub fn persist_instances(state: &AppState) {
    let mut snapshot: Vec<(String, u32)> = state
        .account_pids
        .lock()
        .unwrap()
        .iter()
        .map(|(id, pid)| (id.clone(), *pid))
        .collect();
    snapshot.sort();
    {
        let mut last = state.persisted_instances.lock().unwrap();
        if last.as_ref() == Some(&snapshot) {
            return;
        }
        *last = Some(snapshot.clone());
    }
    let entries: Vec<Value> = snapshot
        .iter()
        .map(|(id, pid)| {
            serde_json::json!({
                "accountId": id,
                "pid": pid,
                "startTime": process_start_time(*pid),
            })
        })
        .collect();
    let path = crate::paths::instances_path();
    let body = serde_json::to_string(&entries).unwrap_or_else(|_| "[]".to_string());
    if let Err(e) = crate::jsonfile::write_atomic(&path, &body) {
        eprintln!("[instances] could not write {}: {}", path.display(), e);
    }
}

/// Drops the mirror entirely (app-data wipe, or a deliberate kill-everything
/// on exit) so the next start has nothing stale to restore.
pub fn clear_persisted_instances(state: &AppState) {
    *state.persisted_instances.lock().unwrap() = None;
    let _ = std::fs::remove_file(crate::paths::instances_path());
}

/// Reconciles in-memory tracking with the processes that actually exist, and
/// is the single path every consumer goes through: startup recovery, the
/// Reload buttons on the dashboard and the accounts tab, and the kill paths.
///
/// Idempotent. Running it twice in a row produces the same state, and it only
/// ever emits events for accounts whose Running/Stopped status really changed.
pub async fn sync_running_instances(app: &AppHandle, state: &AppState) -> Result<u32, ()> {
    if !cfg!(windows) {
        return Ok(0);
    }

    // Serialize against kill-all / kill-home / wipe so a sync can never
    // re-adopt a process mid-kill or repopulate maps the kill just cleared.
    let _ops_guard = state.ops_lock.lock().await;

    // Deliberately the helper's live answer rather than watch_pid_cache: a
    // manual Reload has to reflect the machine right now, and the cache is
    // empty entirely whenever nothing is being watched (which is exactly the
    // state a fresh start is in).
    let Some(alive_pids) = native_pids(app, state).await else {
        // Can't enumerate. Reporting "nothing is running" here would tear
        // down tracking for instances that are perfectly alive, so refuse
        // instead and let the caller surface the failure.
        eprintln!("[sync] could not enumerate Roblox processes");
        return Err(());
    };
    emit_log(app, "info", "sync", &format!("[SYNC] Enumerated {} Roblox processes", alive_pids.len()), Some(serde_json::json!({ "pids": alive_pids.iter().copied().collect::<Vec<u32>>() })));

    let now = now_ms();
    let before: std::collections::HashSet<String> =
        running_account_ids(state, &alive_pids).into_iter().collect();

    let tracked: Vec<(String, u32)> = state
        .account_pids
        .lock()
        .unwrap()
        .iter()
        .map(|(id, pid)| (id.clone(), *pid))
        .collect();
    let watched: Vec<(String, i64)> = state
        .watched_accounts
        .lock()
        .unwrap()
        .iter()
        .map(|(id, ready)| (id.clone(), *ready))
        .collect();
    let had_pid: std::collections::HashSet<&str> =
        tracked.iter().map(|(id, _)| id.as_str()).collect();

    // Survivors: accounts whose tracked PID is still alive. claimed doubles as
    // the duplicate guard -- two accounts pointing at one PID is always a
    // bookkeeping bug (a bad adoption), and only the first keeps it.
    let mut claimed: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut survivors: Vec<(String, u32)> = Vec::new();
    for (id, pid) in &tracked {
        // is_launcher_process keeps custom-launcher accounts (Fishtrap etc.)
        // as survivors — their process name isn't RobloxPlayerBeta.exe so
        // they never show up in alive_pids. It only matches the configured
        // launcher exe, so recycled PIDs can't fake a running account.
        if (alive_pids.contains(pid) || is_launcher_process(*pid)) && claimed.insert(*pid) {
            survivors.push((id.clone(), *pid));
        }
    }

    // Re-attach instances a previous session left running. Only PIDs that are
    // currently a RobloxPlayerBeta.exe *and* whose process creation timestamp
    // still matches what we recorded -- that pair is what keeps a recycled PID
    // from being attributed to the wrong account.
    let mut restored: Vec<(String, u32)> = Vec::new();
    for (id, pid, start) in load_persisted_instances() {
        if claimed_by(&survivors, &id) || !alive_pids.contains(&pid) || claimed.contains(&pid) {
            continue;
        }
        if let Some(recorded) = start {
            if process_start_time(pid) != Some(recorded) {
                continue;
            }
        }
        claimed.insert(pid);
        survivors.push((id.clone(), pid));
        restored.push((id, pid));
    }

    // Accounts launched through the URI handler can be watched without ever
    // having had a PID attributed. Give them an unclaimed process if one is
    // going spare; otherwise keep them only while their launch grace window
    // is still open. An account whose *own* PID just died is not eligible --
    // adopting a stranger for it is precisely what used to leave a closed
    // account stuck on Running forever.
    //
    // The shared "home" (tray) launcher is deliberately NOT adoptable: it is
    // one process serving every amber account, and attributing it to a
    // pidless account would pin that account on Running for as long as the
    // tray is open. If the probe fails (None) we simply don't exclude — the
    // worst case is a rare mis-adoption the watch loop will correct.
    let home_now: std::collections::HashSet<u32> = home_pids(app, state).await.unwrap_or_default();
    let mut orphans: Vec<u32> = alive_pids
        .iter()
        .filter(|p| !claimed.contains(p) && !home_now.contains(p))
        .copied()
        .collect();
    orphans.sort_unstable();
    let mut adopted: Vec<(String, u32)> = Vec::new();
    let mut pidless: Vec<String> = Vec::new();
    for (id, ready_at) in &watched {
        if claimed_by(&survivors, id) || had_pid.contains(id.as_str()) {
            continue;
        }
        if let Some(pid) = orphans.pop() {
            claimed.insert(pid);
            survivors.push((id.clone(), pid));
            adopted.push((id.clone(), pid));
        } else if now < *ready_at {
            pidless.push(id.clone());
        }
    }

    // Single write-back, so nothing observes a half-updated map.
    {
        let mut watched_map = state.watched_accounts.lock().unwrap();
        let mut pid_map = state.account_pids.lock().unwrap();
        let mut misses = state.miss_counts.lock().unwrap();
        pid_map.clear();
        misses.clear();
        let previous: std::collections::HashMap<String, i64> = watched_map.drain().collect();
        for (id, pid) in &survivors {
            pid_map.insert(id.clone(), *pid);
            // A launch still inside its grace window keeps that deadline; an
            // instance we just proved is up can be watched immediately.
            watched_map.insert(id.clone(), previous.get(id).copied().unwrap_or(now));
            misses.insert(id.clone(), 0);
        }
        for id in &pidless {
            watched_map.insert(id.clone(), previous.get(id).copied().unwrap_or(now));
            misses.insert(id.clone(), 0);
        }
    }

    let after: std::collections::HashSet<String> =
        running_account_ids(state, &alive_pids).into_iter().collect();
    for id in before.difference(&after) {
        clear_manual_priority(state, id);
        let _ = app.emit("roblox:closed", id);
    }

    persist_instances(state);

    for (id, pid) in &restored {
        emit_log(
            app,
            "info",
            "sync",
            &format!("[SYNC] Reattached a Roblox instance left running for account {} (PID {})", id, pid),
            Some(serde_json::json!({ "accountId": id, "pid": pid })),
        );
        let _ = app.emit("roblox:started", id.clone());
    }
    for (id, pid) in &adopted {
        emit_log(
            app,
            "info",
            "sync",
            &format!("[SYNC] Attributed unclaimed PID {} to account {}", pid, id),
            Some(serde_json::json!({ "accountId": id, "pid": pid })),
        );
        let _ = app.emit("roblox:started", id.clone());
    }

    let running_count = after.len() as u32;
    let _ = app.emit("roblox:count", running_count);

    if state.watched_accounts.lock().unwrap().is_empty() && state.home_accounts.lock().unwrap().is_empty() {
        stop_watch_poll_if_idle(state);
    } else {
        start_watch_poll(app, app.clone());
        ensure_pid_watcher(app, state).await;
    }
    apply_priority_policy(state, &crate::settings::load_settings()).await;

    Ok(running_count)
}

fn claimed_by(survivors: &[(String, u32)], account_id: &str) -> bool {
    survivors.iter().any(|(id, _)| id == account_id)
}

// Just hands idle physical pages back to the OS -- doesn't touch the
// process itself, can't crash it.
#[cfg(windows)]
fn trim_process_memory(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::EmptyWorkingSet;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA,
    };
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA, false, pid)
        else {
            return false;
        };
        let ok = EmptyWorkingSet(handle).is_ok();
        let _ = CloseHandle(handle);
        ok
    }
}
#[cfg(not(windows))]
fn trim_process_memory(_pid: u32) -> bool {
    false
}

// Matches Task Manager's own priority names/mapping (its "Low" is
// IDLE_PRIORITY_CLASS, not a literal low-priority constant).
#[cfg(windows)]
fn priority_class_from_name(name: &str) -> Option<windows::Win32::System::Threading::PROCESS_CREATION_FLAGS> {
    use windows::Win32::System::Threading::{
        ABOVE_NORMAL_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS, HIGH_PRIORITY_CLASS,
        IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, REALTIME_PRIORITY_CLASS,
    };
    Some(match name {
        "realtime" => REALTIME_PRIORITY_CLASS,
        "high" => HIGH_PRIORITY_CLASS,
        "abovenormal" => ABOVE_NORMAL_PRIORITY_CLASS,
        "normal" => NORMAL_PRIORITY_CLASS,
        "belownormal" => BELOW_NORMAL_PRIORITY_CLASS,
        "low" => IDLE_PRIORITY_CLASS,
        _ => return None,
    })
}

#[cfg(windows)]
fn set_process_priority(pid: u32, class_name: &str) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, SetPriorityClass, PROCESS_SET_INFORMATION};
    let Some(class) = priority_class_from_name(class_name) else {
        return false;
    };
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_SET_INFORMATION, false, pid) else {
            return false;
        };
        let ok = SetPriorityClass(handle, class).is_ok();
        let _ = CloseHandle(handle);
        ok
    }
}
#[cfg(not(windows))]
fn set_process_priority(_pid: u32, _class_name: &str) -> bool {
    false
}

// Manually set priorities stick -- recorded here so apply_priority_policy's
// automatic multi-instance rule leaves this account alone until it's
// relaunched.
pub fn set_account_priority(state: &AppState, account_id: &str, class_name: &str) -> Value {
    let Some(pid) = state.account_pids.lock().unwrap().get(account_id).copied() else {
        return serde_json::json!({ "ok": false, "error": "Account isn't running" });
    };
    if set_process_priority(pid, class_name) {
        state
            .manual_priority
            .lock()
            .unwrap()
            .insert(account_id.to_string(), class_name.to_string());
        serde_json::json!({ "ok": true })
    } else {
        serde_json::json!({ "ok": false, "error": "Failed to set priority" })
    }
}

pub fn clear_manual_priority(state: &AppState, account_id: &str) {
    state.manual_priority.lock().unwrap().remove(account_id);
}

// User opt-in (Settings -> Performance): once more than one account is
// running, Windows splits CPU evenly across every instance even though only
// one is actually being interacted with -- dropping the rest to Below
// Normal lets the OS scheduler favor whichever isn't idle. Re-evaluated
// after every launch/kill so it self-corrects back to Normal once only one
// instance is left running. Accounts with a manual override (right-click ->
// Set priority) are skipped so the automatic rule doesn't stomp on it.
async fn apply_priority_policy(state: &AppState, settings: &serde_json::Map<String, Value>) {
    let enabled = settings
        .get("lowPriorityMultiInstance")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !enabled {
        return;
    }
    let accounts: Vec<(String, u32)> = state
        .account_pids
        .lock()
        .unwrap()
        .iter()
        .map(|(id, pid)| (id.clone(), *pid))
        .collect();
    let class_name = if accounts.len() > 1 { "belownormal" } else { "normal" };
    let overridden = state.manual_priority.lock().unwrap();
    for (account_id, pid) in accounts {
        if overridden.contains_key(&account_id) {
            continue;
        }
        set_process_priority(pid, class_name);
    }
}

pub async fn trim_roblox_memory(app: &AppHandle, state: &AppState) -> Value {
    let Some(alive_pids) = cached_or_spawn_pids(app, state).await else {
        return serde_json::json!({ "ok": false, "trimmed": 0, "total": 0, "error": "could not enumerate Roblox processes" });
    };

    // Skip PIDs still inside their launch grace window -- trimming while a
    // client is still loading assets can cause a stutter.
    let now = now_ms();
    let launching_pids: std::collections::HashSet<u32> = {
        let watched = state.watched_accounts.lock().unwrap();
        let pids = state.account_pids.lock().unwrap();
        watched
            .iter()
            .filter(|(_, ready_at)| now < **ready_at)
            .filter_map(|(id, _)| pids.get(id).copied())
            .collect()
    };

    let mut total = 0u32;
    let mut trimmed = 0u32;
    for pid in alive_pids {
        if launching_pids.contains(&pid) {
            continue;
        }
        total += 1;
        if trim_process_memory(pid) {
            trimmed += 1;
        }
    }
    serde_json::json!({ "ok": true, "trimmed": trimmed, "total": total })
}

pub async fn trim_account_memory(app: &AppHandle, state: &AppState, account_id: &str) -> Value {
    let Some(pid) = state.account_pids.lock().unwrap().get(account_id).copied() else {
        return serde_json::json!({ "ok": false, "error": "No tracked Roblox instance for this account" });
    };
    if state
        .watched_accounts
        .lock()
        .unwrap()
        .get(account_id)
        .is_some_and(|ready_at| now_ms() < *ready_at)
    {
        return serde_json::json!({ "ok": false, "error": "Instance is still launching" });
    }
    let Some(alive_pids) = cached_or_spawn_pids(app, state).await else {
        return serde_json::json!({ "ok": false, "error": "Could not enumerate Roblox processes" });
    };
    if !alive_pids.contains(&pid) {
        return serde_json::json!({ "ok": false, "error": "This Roblox instance is no longer running" });
    }
    if trim_process_memory(pid) {
        serde_json::json!({ "ok": true })
    } else {
        serde_json::json!({ "ok": false, "error": "Could not trim this Roblox instance" })
    }
}

// Waits for specific PIDs to disappear. Scoped to our own processes: a
// blanket "no RobloxPlayerBeta.exe anywhere" wait would never be satisfied
// while an instance the user started outside MultiRoblox is still open.
async fn wait_for_pids_closed(
    app: &AppHandle,
    state: &AppState,
    pids: &[u32],
    max_wait: Duration,
) {
    let started = std::time::Instant::now();
    loop {
        match native_pids(app, state).await {
            // Couldn't enumerate -- no point spinning on an unanswerable question.
            None => return,
            Some(alive) if !pids.iter().any(|p| alive.contains(p)) => return,
            _ => {}
        }
        if started.elapsed() >= max_wait {
            return;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

pub async fn kill_all_roblox(app: &AppHandle, state: &AppState) -> Value {
    // Serialize against sync / kill-home / wipe. Without this, a concurrent
    // sync could re-adopt a process mid-kill, and two kill-alls could double
    // up their state teardown. The lock is held for the whole operation so
    // nobody observes a half-killed world.
    let _ops_guard = state.ops_lock.lock().await;

    // Accounts sitting in the "home" (tray) also need a closed event when the
    // launcher dies, and the home set itself must be cleared — otherwise the
    // backend keeps ghost accounts that getHomeIds would report forever.
    let home_ids: Vec<String> = state.home_accounts.lock().unwrap().iter().cloned().collect();

    let watched_ids: Vec<String> = state
        .watched_accounts
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();

    for id in &watched_ids {
        state.manual_kills.lock().unwrap().insert(id.clone());
    }

    let tracked_pids: Vec<u32> = state.account_pids.lock().unwrap().values().copied().collect();
    let untracked = watched_ids.len().saturating_sub(tracked_pids.len());

    let notify = |app: &AppHandle, ids: &[String]| {
        for id in ids {
            let _ = app.emit("roblox:closed", id);
        }
        let _ = app.emit("roblox:allClosed", ());
    };

    if !cfg!(windows) {
        // Non-Windows: nothing to kill, but still tear down state + notify.
        state.watched_accounts.lock().unwrap().clear();
        state.miss_counts.lock().unwrap().clear();
        state.account_pids.lock().unwrap().clear();
        state.manual_priority.lock().unwrap().clear();
        state.home_accounts.lock().unwrap().clear();
        stop_watch_poll_if_idle(state);
        persist_instances(state);
        notify(app, &watched_ids);
        return serde_json::json!({ "ok": false, "error": "Windows only" });
    }

    // Build the kill target set from BOTH sources:
    //   - tracked_pids: PIDs we already know belong to launched accounts (authoritative).
    //   - native_pids(): live RobloxPlayerBeta.exe PIDs via the helper (reliable
    //     in-process enumeration) — catches stragglers that lost their
    //     attribution, including the launcher "home" process sitting in the
    //     tray. (The old tasklist-based get_all_roblox_pids was broken: the
    //     quoted /FI filter never survived cmd.exe, so it always returned
    //     empty and orphan/home processes escaped the kill.)
    let all_roblox_pids = native_pids(app, state).await.unwrap_or_default();

    // Verify each tracked PID is actually alive before assuming it is. A
    // stale entry in account_pids (process died between launch and now) would
    // otherwise be counted as a "kill" that never happened.
    let mut targets: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for pid in &tracked_pids {
        if pid_is_alive(*pid) {
            targets.insert(*pid);
        }
    }
    for pid in &all_roblox_pids {
        targets.insert(*pid);
    }

    if targets.is_empty() {
        state.watched_accounts.lock().unwrap().clear();
        state.miss_counts.lock().unwrap().clear();
        state.account_pids.lock().unwrap().clear();
        state.manual_priority.lock().unwrap().clear();
        state.home_accounts.lock().unwrap().clear();
        stop_watch_poll_if_idle(state);
        persist_instances(state);
        notify(app, &watched_ids);
        for id in &home_ids {
            let _ = app.emit("roblox:closed", id);
        }
        let _ = app.emit("roblox:allClosed", ());
        return serde_json::json!({ "ok": true, "killed": 0, "total": 0, "untracked": untracked, "orphans": 0, "pending": 0 });
    }

    // Step 1: per-PID taskkill. Kill every tracked PID individually with /T
    // (kill the whole tree rooted at that PID), since the image-name filter
    // misses them. Do up to 3 passes -- Roblox can briefly refuse to die.
    let mut still_alive: std::collections::HashSet<u32> = targets.iter().copied().collect();
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(600)).await;
        }
        for pid in targets.iter().copied() {
            let mut cmd = Command::new("cmd");
            cmd.args(["/c", &format!("taskkill /F /T /PID {}", pid)]);
            hide_window(&mut cmd);
            let _ = tokio::time::timeout(Duration::from_secs(6), cmd.output()).await;
        }
        // Also do a single image-name sweep in case there are extra Roblox
        // processes that weren't tracked (orphan / manually launched).
        {
            let mut cmd = Command::new("cmd");
            cmd.args(["/c", "taskkill /F /T /IM RobloxPlayerBeta.exe"]);
            hide_window(&mut cmd);
            let _ = tokio::time::timeout(Duration::from_secs(6), cmd.output()).await;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;

        // Recompute survivors by actually checking each target PID -- tasklist
        // /IM is unreliable when the binary was renamed, so we ask the kernel
        // directly via OpenProcess whether each PID still exists.
        still_alive = targets
            .iter()
            .copied()
            .filter(|pid| pid_is_alive(*pid))
            .collect();
        if still_alive.is_empty() {
            break;
        }
    }

    // Step 2: anything that survived taskkill gets the Win32 TerminateProcess
    // hammer. This is what catches Roblox's anti-taskkill tricks.
    #[cfg(windows)]
    if !still_alive.is_empty() {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        for pid in still_alive.clone() {
            unsafe {
                if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                    let _ = TerminateProcess(handle, 1);
                    let _ = CloseHandle(handle);
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(600)).await;
        still_alive = targets
            .iter()
            .copied()
            .filter(|pid| pid_is_alive(*pid))
            .collect();
    }

    // Step 3: verify. Whatever's still alive at this point is a kill failure.
    // Count survivors from `targets` (the union of tracked + image-name we
    // actually tried to kill), not `all_roblox_pids` -- the image-name filter
    // is the same one that missed renamed processes in the first place, and
    // using its empty result as the baseline would report `killed: 0` even
    // when we successfully terminated every tracked process.
    let confirmed_killed = targets.len() - still_alive.len();
    let orphans_killed = confirmed_killed.saturating_sub(tracked_pids.len());

    // One final sweep: re-enumerate and catch any process that started
    // *during* the kill (unlikely but possible when the user double-clicks
    // Roblox or a scheduled task re-launches it). If there are still Roblox
    // processes around, do one more image-name kill pass.
    let final_pids = native_pids(app, state).await.unwrap_or_default();
    let mut final_survivors: std::collections::HashSet<u32> = final_pids
        .iter()
        .filter(|p| pid_is_alive(**p))
        .copied()
        .collect();
    // Only re-sweep when the final enumeration shows processes that were NOT
    // part of the original targets (i.e. genuinely new during the kill).
    let has_new = final_survivors.iter().any(|p| !targets.contains(p));
    if !final_survivors.is_empty() && has_new {
        emit_log(app, "warn", "kill", &format!("[KILL] {} new Roblox process(es) appeared during kill — re-sweeping", final_survivors.len()), None);
        for pid in &final_survivors {
            let mut cmd = Command::new("cmd");
            cmd.args(["/c", &format!("taskkill /F /T /PID {}", pid)]);
            hide_window(&mut cmd);
            let _ = tokio::time::timeout(Duration::from_secs(6), cmd.output()).await;
        }
        tokio::time::sleep(Duration::from_millis(600)).await;
        let recheck = native_pids(app, state).await.unwrap_or_default();
        final_survivors = recheck.iter().filter(|p| pid_is_alive(**p)).copied().collect();
    }

    emit_log(app, "info", "kill", &format!("[KILL] Killed {}/{} tracked PIDs, {} still alive after final sweep", confirmed_killed, targets.len(), final_survivors.len()), Some(serde_json::json!({
        "killed": confirmed_killed, "total": targets.len(), "orphans": orphans_killed, "pending": final_survivors.len()
    })));

    // Only wipe the per-account state after the FINAL sweep confirms there
    // are no survivors. If processes are still alive, the internal state must
    // keep representing them — clearing it now would make the counter/UI show
    // 0 while Roblox is still running. The frontend treats ok:false as "do not
    // clear the UI", so a partial kill leaves everything in place for a retry.
    let pending = final_survivors.len();
    if pending > 0 {
        emit_log(
            app,
            "warn",
            "kill",
            &format!("[KILL] {} Roblox process(es) still alive — internal state preserved", pending),
            Some(serde_json::json!({ "pending": pending, "killed": confirmed_killed })),
        );
        return serde_json::json!({
            "ok": false,
            "killed": confirmed_killed,
            "total": all_roblox_pids.len(),
            "untracked": untracked,
            "orphans": orphans_killed,
            "pending": pending,
            "error": format!("{} Roblox process(es) still alive", pending)
        });
    }

    state.watched_accounts.lock().unwrap().clear();
    state.miss_counts.lock().unwrap().clear();
    state.account_pids.lock().unwrap().clear();
    state.manual_priority.lock().unwrap().clear();
    state.home_accounts.lock().unwrap().clear();
    stop_watch_poll_if_idle(state);
    persist_instances(state);

    restart_mutex_holder(app, state).await;
    notify(app, &watched_ids);
    // Also notify home accounts so the frontend amber badges clear.
    for id in &home_ids {
        let _ = app.emit("roblox:closed", id);
    }
    let _ = app.emit("roblox:allClosed", ());

    serde_json::json!({
        "ok": true,
        "killed": confirmed_killed,
        "total": all_roblox_pids.len(),
        "untracked": untracked,
        "orphans": orphans_killed,
        "pending": serde_json::Value::Null
    })
}

// Kills the shared Roblox "home" (tray) launcher process(es). Every account
// sitting in the home shares that one process, so they all lose their amber
// badge at once. This is the dedicated "close the tray" action — separate
// from killing individual accounts and from the full kill-all.
pub async fn kill_home_roblox(app: &AppHandle, state: &AppState) -> Value {
    // Same serialization as kill-all: a concurrent sync or kill-all must not
    // interleave with the home teardown.
    let _ops_guard = state.ops_lock.lock().await;
    let Some(home) = home_pids(app, state).await else {
        return serde_json::json!({ "ok": false, "error": "Could not enumerate home processes" });
    };
    let mut killed = 0u32;
    for pid in &home {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", &format!("taskkill /F /T /PID {}", pid)]);
        hide_window(&mut cmd);
        let _ = tokio::time::timeout(Duration::from_secs(6), cmd.output()).await;
        killed += 1;
    }
    // Whatever we killed (or that already died on its own): drop every home
    // account so the UI clears the amber badges immediately.
    let gone: Vec<String> = state.home_accounts.lock().unwrap().drain().collect();
    for account_id in &gone {
        let _ = app.emit("roblox:closed", account_id.clone());
    }
    serde_json::json!({ "ok": true, "killed": killed, "cleared": gone.len() })
}

async fn get_all_roblox_pids() -> Option<Vec<u32>> {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "tasklist /FI \\\"IMAGENAME eq RobloxPlayerBeta.exe\\\" /FO CSV /NH"]);
        hide_window(&mut cmd);

        match tokio::time::timeout(Duration::from_secs(3), cmd.output()).await {
            Ok(Ok(output)) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let pids: Vec<u32> = stdout
                    .lines()
                    .filter_map(|line| {
                        let parts: Vec<&str> = line.split(',').collect();
                        if parts.len() >= 2 {
                            parts[1].trim_matches('"').parse::<u32>().ok()
                        } else {
                            None
                        }
                    })
                    .collect();
                if pids.is_empty() { None } else { Some(pids) }
            }
            _ => None,
        }
    }
    #[cfg(not(windows))]
    None
}

// Direct kernel probe: "does this PID still exist?". Used by kill_all because
// tasklist's image-name filter missed renamed Roblox binaries in the field,
// and the kill was silently doing nothing. OpenProcess(SYNCHRONIZE) only
// succeeds if a process object exists for that PID, regardless of its image
// name. PID reuse isn't an issue here -- these are PIDs we just stored from
// do_launch's own Process::pid().
#[cfg(windows)]
fn pid_is_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
    unsafe {
        match OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            Ok(h) => {
                // The app detaches from spawned clients with std::mem::forget
                // (do_launch), so a process handle stays open forever and the
                // kernel keeps the dead process's object (and PID) reachable
                // via OpenProcess even after it has exited. "OpenProcess
                // succeeded" is therefore NOT proof the process is running.
                // WaitForSingleObject with a 0ms timeout distinguishes: a live
                // process is not signaled -> WAIT_TIMEOUT (0x102); an exited
                // one is signaled -> WAIT_OBJECT_0 (0).
                let alive =
                    WaitForSingleObject(h, 0) == windows::Win32::Foundation::WAIT_EVENT(0x0000_0102);
                let _ = CloseHandle(h);
                alive
            }
            Err(_) => false,
        }
    }
}

#[cfg(not(windows))]
fn pid_is_alive(_pid: u32) -> bool {
    false
}

// Returns the full path of the executable for a given PID. Used to
// distinguish a custom-launcher (Fishtrap etc.) process from a recycled
// PID that happens to be alive but points at a completely unrelated exe.
#[cfg(windows)]
fn process_exe_path(pid: u32) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => {
                let mut buf = [0u16; 1024];
                let mut len = buf.len() as u32;
                let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
                CloseHandle(h).ok();
                if ok.is_ok() {
                    Some(String::from_utf16_lossy(&buf[..len as usize]))
                } else {
                    None
                }
            }
            Err(_) => None,
        }
    }
}
#[cfg(not(windows))]
fn process_exe_path(_pid: u32) -> Option<String> {
    None
}

// True when the live process at `pid` matches the user-configured custom
// launcher path (case-insensitive). Returns false when no custom launcher
// is configured, so the normal RobloxPlayerBeta path is never affected.
fn is_launcher_process(pid: u32) -> bool {
    let s = crate::settings::load_settings();
    let path = s
        .get("launcherPath")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let Some(path) = path else {
        return false;
    };
    match process_exe_path(pid) {
        Some(p) => p.eq_ignore_ascii_case(path),
        None => false,
    }
}

pub async fn kill_account_roblox(app: &AppHandle, state: &AppState, account_id: &str) -> Value {
    state.manual_kills.lock().unwrap().insert(account_id.to_string());
    
    let pid = state.account_pids.lock().unwrap().get(account_id).copied();

    let notify_and_cleanup = |app: &AppHandle, success: bool| {
        state.watched_accounts.lock().unwrap().remove(account_id);
        state.miss_counts.lock().unwrap().remove(account_id);
        state.account_pids.lock().unwrap().remove(account_id);
        state.home_accounts.lock().unwrap().remove(account_id);
        clear_manual_priority(state, account_id);
        stop_watch_poll_if_idle(state);
        persist_instances(state);
        if success {
            let _ = app.emit("roblox:closed", account_id);
        }
    };

    if !cfg!(windows) {
        notify_and_cleanup(app, false);
        return serde_json::json!({ "ok": false, "error": "Windows only" });
    }
    let Some(pid) = pid else {
        // No tracked PID. The account may be sitting in the Roblox "home"
        // (tray): the game process is gone but the hidden launcher window is
        // still around. IMPORTANT: the home window is ONE shared process, not
        // one per account — killing it would also close every other account
        // sitting in the home. So "kill" for a home account only drops the
        // amber state for THIS account; the shared launcher stays up so other
        // accounts keep their badge. Use "Kill all Roblox" to close the
        // launcher itself.
        if state.home_accounts.lock().unwrap().contains(account_id) {
            state.home_accounts.lock().unwrap().remove(account_id);
            notify_and_cleanup(app, true);
            return serde_json::json!({ "ok": true });
        }
        notify_and_cleanup(app, false);
        return serde_json::json!({ "ok": false, "error": "No tracked process for this account" });
    };

    let mut killed = false;
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", &format!("taskkill /F /PID {} /T", pid)]);
        hide_window(&mut cmd);
        match tokio::time::timeout(Duration::from_secs(6), cmd.output()).await {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                killed = output.status.success()
                    || stdout.contains("SUCCESS")
                    || stdout.contains("not found");
            }
            Ok(Err(_)) => {}
            Err(_) => {}
        }
        if killed {
            tokio::time::sleep(Duration::from_millis(400)).await;
            if let Some(alive) = cached_or_spawn_pids(app, state).await {
                if !alive.contains(&pid) {
                    break;
                }
            }
            killed = false;
        }
    }

    if !killed {
        #[cfg(windows)]
        {
            use windows::Win32::Foundation::CloseHandle;
            use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
            let terminate_result = unsafe {
                match OpenProcess(PROCESS_TERMINATE, false, pid) {
                    Ok(handle) => {
                        let result = TerminateProcess(handle, 1).is_ok();
                        let _ = CloseHandle(handle);
                        result
                    }
                    Err(_) => false,
                }
            };
            if terminate_result {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if let Some(alive) = cached_or_spawn_pids(app, state).await {
                    killed = !alive.contains(&pid);
                }
            }
        }
    }

    let _ = app.emit("roblox:closed", account_id);
    notify_and_cleanup(app, true);
    apply_priority_policy(state, &crate::settings::load_settings()).await;

    if killed {
        serde_json::json!({ "ok": true })
    } else {
        serde_json::json!({ "ok": true, "pending": true })
    }
}

// Runs before every launch. Used to spawn (and then have to reap) a fresh
// one-shot process each time -- the single biggest source of "a new
// RobloxNative process every time I launch an account". Now it's one request
// on the pipe the helper is already holding open.
async fn close_singleton_handles_only(app: &AppHandle, state: &AppState) {
    if let Err(e) = crate::helper::call(app, state, "closehandles", crate::helper::SLOW_TIMEOUT).await
    {
        eprintln!("[closehandles] {}", e);
    }
}

async fn close_singleton_and_hold_mutex(app: &AppHandle, state: &AppState) {
    if !cfg!(windows) {
        return;
    }
    // ensure() awaits the daemon's READY, which it only sends once it owns the
    // mutex -- so this still guarantees the mutex is held before we launch.
    start_mutex_holder(app, state).await;
    close_singleton_handles_only(app, state).await;
}

// Third-party bootstrappers (Bloxstrap, Froststrap, Voidstrap, Fishstrap)
// install Roblox under their own %LOCALAPPDATA%\<Name>\Versions\ folder
// instead of the vanilla one. A hardcoded vanilla-first priority picked a
// stale, long-unused vanilla install over the bootstrapper someone actually
// plays through, so this instead compares RobloxPlayerBeta.exe's own
// mtime across every root and picks whichever is genuinely newest -- a
// bootstrapper's mod overlay only overwrites content/asset files on launch,
// never the exe itself, so the exe's mtime reliably tracks the last real
// Roblox self-update (and therefore actual use) for that install.
const ROBLOX_INSTALL_ROOTS: [&str; 5] = ["Roblox", "Bloxstrap", "Froststrap", "Voidstrap", "Fishstrap"];

fn get_latest_roblox_install() -> Option<(&'static str, PathBuf, PathBuf)> {
    let home = dirs_home()?;
    let local_appdata = home.join("AppData").join("Local");
    let mut best: Option<(&'static str, PathBuf, PathBuf, std::time::SystemTime)> = None;
    for root in ROBLOX_INSTALL_ROOTS {
        let versions_base = local_appdata.join(root).join("Versions");
        let Ok(entries) = std::fs::read_dir(&versions_base) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("version-") {
                continue;
            }
            let dir = versions_base.join(&*name);
            let exe = dir.join("RobloxPlayerBeta.exe");
            let Ok(meta) = std::fs::metadata(&exe) else { continue };
            let Ok(mtime) = meta.modified() else { continue };
            if best.as_ref().map(|(_, _, _, t)| mtime > *t).unwrap_or(true) {
                best = Some((root, dir, exe, mtime));
            }
        }
    }
    best.map(|(root, dir, exe, _)| (root, dir, exe))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE").ok().map(PathBuf::from)
}

// Vanilla Roblox keeps FFlags per-version-folder; Bloxstrap-family forks
// instead keep one fixed copy under Modifications\ that gets overlaid in at
// launch time, so the per-version path doesn't work for those.
pub fn get_fflag_path() -> Option<PathBuf> {
    let (root, dir, _) = get_latest_roblox_install()?;
    if root == "Roblox" {
        Some(dir.join("ClientSettings").join("ClientAppSettings.json"))
    } else {
        let local_appdata = dirs_home()?.join("AppData").join("Local");
        Some(
            local_appdata
                .join(root)
                .join("Modifications")
                .join("ClientSettings")
                .join("ClientAppSettings.json"),
        )
    }
}

// A real exe is tens of MB; anything smaller is still mid-self-update and
// spawning it triggers Roblox's own repair/reinstall prompt.
const MIN_PLAUSIBLE_EXE_BYTES: u64 = 5_000_000;

// live_version is the current LIVE-channel clientVersionUpload (e.g.
// "version-0123456789abcdef"), which is exactly the install's own
// version-folder name -- so this is a plain string compare, no parsing.
// A locally installed copy that isn't LIVE (stale cache, beta/canary
// channel someone's bootstrapper pulled, etc.) is refused here rather than
// force-launched; returning None falls through to the existing
// roblox-player: URI fallback, which hands off to Roblox's own updater to
// fetch/launch the real LIVE client instead.
async fn spawn_roblox_direct(
    roblox_uri: &str,
    live_version: Option<&str>,
    launcher_path: Option<&str>,
) -> Option<u32> {
    // Custom launcher (e.g. Fishtrap, Bloxstrap) takes precedence over the
    // official install when configured — same URI handed to a different exe.
    let exe = if let Some(p) = launcher_path {
        std::path::PathBuf::from(p)
    } else {
        let (root, dir, exe) = get_latest_roblox_install()?;
        // Bootstrapper forks (Bloxstrap etc.) only touch their version folder's
        // mtime/name on their OWN update cadence, not on every Roblox content
        // update -- so this folder-name compare can go permanently stale for
        // them even on a fully current install. That made lock-channel users on
        // a bootstrapper fail this check on every single launch, fall through to
        // the roblox-player: URI updater every time, and effectively "redownload"
        // Roblox on every launch. Only vanilla installs keep this signal honest.
        if root == "Roblox" {
            if let Some(live) = live_version {
                let installed = dir.file_name()?.to_str()?;
                if installed != live {
                    return None;
                }
            }
        }
        exe
    };
    let meta = std::fs::metadata(&exe).ok()?;
    if meta.len() < MIN_PLAUSIBLE_EXE_BYTES {
        return None;
    }
    let mut cmd = Command::new(&exe);
    cmd.arg(roblox_uri)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_window(&mut cmd);
    let child = cmd.spawn().ok()?;
    let pid = child.id();
    std::mem::forget(child); // detached: outlives this process
    pid
}

// ---- watch loop ----
// One shared poll covers every watched account instead of a spawn per
// account per tick. MISS_THRESHOLD * POLL_INTERVAL gives ~2s worst-case
// close-detection latency while still tolerating a single transient miss.
// The PID readings come from the resident RobloxNative "watch" helper doing
// real process enumeration (not flaky tasklist parsing), so one miss of
// tolerance is enough -- faster than the old 3x2s=6s, so the card updates
// and the watcher shuts down within ~2s of Roblox actually closing.
const MISS_THRESHOLD: u32 = 2;
pub const POLL_INTERVAL: Duration = Duration::from_secs(1);
pub const LAUNCH_DELAY_MS: i64 = 15_000;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// Bounds how often crash-recovery will relaunch a single account so a bad
// cookie/target that crashes immediately on every launch can't spin-loop.
const AUTO_RELAUNCH_MAX: usize = 3;
const AUTO_RELAUNCH_WINDOW_MS: i64 = 10 * 60 * 1000;

fn auto_relaunch_allowed(state: &AppState, account_id: &str) -> bool {
    let now = now_ms();
    let mut hist = state.auto_relaunch_history.lock().unwrap();
    let entry = hist.entry(account_id.to_string()).or_default();
    entry.retain(|t| now - *t < AUTO_RELAUNCH_WINDOW_MS);
    if entry.len() >= AUTO_RELAUNCH_MAX {
        return false;
    }
    entry.push(now);
    true
}

fn stop_watch_poll_if_idle(state: &AppState) {
    if state.watched_accounts.lock().unwrap().is_empty() && state.home_accounts.lock().unwrap().is_empty() {
        if let Some(handle) = state.watch_handle.lock().unwrap().take() {
            handle.abort();
        }
        stop_pid_watcher(state);
    }
}

// Turns on the helper's PID broadcast thread; it pushes "E|PIDS|..." events
// which helper.rs drops straight into watch_pid_cache. Idempotent -- asking
// twice just re-arms the same thread inside the same process.
async fn ensure_pid_watcher(app: &AppHandle, state: &AppState) {
    let _ = crate::helper::call(
        app,
        state,
        &format!("watch|{}", POLL_INTERVAL.as_millis()),
        crate::helper::DEFAULT_TIMEOUT,
    )
    .await;
}

fn stop_pid_watcher(state: &AppState) {
    *state.watch_pid_cache.lock().unwrap() = None;
    let app = state.app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let st = app.state::<AppState>();
        let _ = crate::helper::call(&app, &st, "watch|0", crate::helper::DEFAULT_TIMEOUT).await;
    });
}

// The watcher's last report if running, else a one-off spawn.
async fn cached_or_spawn_pids(app: &AppHandle, state: &AppState) -> Option<std::collections::HashSet<u32>> {
    if let Some(pids) = state.watch_pid_cache.lock().unwrap().clone() {
        return Some(pids);
    }
    native_pids(app, state).await
}

// Polls for whichever new RobloxPlayerBeta.exe PID appears after the
// URI-handler fallback (do_launch has no PID back from that path the way
// spawn_roblox_direct gives one). Scoped to a fresh `pids_before` snapshot
// taken right before the fallback fires and to PIDs no other account already
// claims, so it can't steal an unrelated, already-running Roblox window --
// unlike a blind "first available orphan" grab, which would happily adopt
// any pre-existing untracked window (one the user opened outside
// MultiRoblox entirely) the moment this account's watch tick came up empty.
async fn wait_for_new_roblox_pid(
    app: &AppHandle,
    state: &AppState,
    pids_before: &std::collections::HashSet<u32>,
    timeout: Duration,
) -> Option<u32> {
    let started = std::time::Instant::now();
    loop {
        if let Some(alive) = native_pids(app, state).await {
            let claimed: std::collections::HashSet<u32> =
                state.account_pids.lock().unwrap().values().copied().collect();
            if let Some(new_pid) = alive
                .iter()
                .find(|p| !pids_before.contains(p) && !claimed.contains(p))
            {
                return Some(*new_pid);
            }
        }
        if started.elapsed() >= timeout {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

fn start_watch_poll(app: &AppHandle, state_handle: tauri::AppHandle) {
    let already = app
        .state::<AppState>()
        .watch_handle
        .lock()
        .unwrap()
        .is_some();
    if already {
        return;
    }
    let handle = tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            watch_tick(&state_handle).await;
        }
    });
    *app.state::<AppState>().watch_handle.lock().unwrap() = Some(handle);
}

pub async fn watch_roblox(app: &AppHandle, account_id: &str) {
    let st = app.state::<AppState>();
    st.watched_accounts
        .lock()
        .unwrap()
        .insert(account_id.to_string(), now_ms() + LAUNCH_DELAY_MS);
    st.miss_counts
        .lock()
        .unwrap()
        .insert(account_id.to_string(), 0);
    start_watch_poll(app, app.clone());
    ensure_pid_watcher(app, &st).await;
}

static WATCH_TICK_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

async fn watch_tick(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.watched_accounts.lock().unwrap().is_empty() && state.home_accounts.lock().unwrap().is_empty() {
        stop_watch_poll_if_idle(&state);
        return;
    }
    // Re-entrancy guard: a slow tick under heavy load can outlast
    // POLL_INTERVAL, and two concurrent ticks racing on the same maps can
    // false-positive a running account as closed. Skip instead.
    if WATCH_TICK_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }
    let pids = cached_or_spawn_pids(app, &state).await;
    WATCH_TICK_IN_FLIGHT.store(false, Ordering::SeqCst);
    // Couldn't get a reading this tick (helper unavailable, spawn/timeout
    // failure) -- can't tell who's alive. Bail without touching miss counts
    // so a still-running account never gets penalized for it.
    let Some(alive_pids) = pids else {
        return;
    };

    let now = now_ms();
    let mut closed: Vec<String> = Vec::new();
    let mut candidates: Vec<String> = Vec::new();
    let claimed: std::collections::HashSet<u32> = {
        let watched = state.watched_accounts.lock().unwrap();
        let pids = state.account_pids.lock().unwrap();
        watched
            .keys()
            .filter_map(|id| pids.get(id).copied())
            .collect()
    };
    let mut orphans: Vec<u32> = alive_pids
        .iter()
        .filter(|p| !claimed.contains(p))
        .copied()
        .collect();

    let any_running = !alive_pids.is_empty();
    let watched_snapshot: Vec<(String, i64)> = state
        .watched_accounts
        .lock()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    for (account_id, ready_at) in watched_snapshot {
        if now < ready_at {
            continue;
        }
        let pid = state.account_pids.lock().unwrap().get(&account_id).copied();
        // No tracked PID means this account launched via the URI-handler
        // fallback (direct spawn failed or Roblox wasn't found at the
        // expected install path) -- we can't identify which specific process
        // is "ours", so fall back to the coarse "is anything running at all"
        // signal instead of declaring it closed outright.
        let mut running = match pid {
            // Tracked PID: alive_pids only contains RobloxPlayerBeta.exe
            // processes. A custom launcher (Fishtrap etc.) won't be in that
            // set, so fall back to checking whether the live process is
            // literally the configured launcher exe — never a blanket
            // "any PID is alive" (that would treat recycled PIDs as running
            // and break close-detection for the normal Roblox path).
            Some(p) => alive_pids.contains(&p) || is_launcher_process(p),
            None => any_running,
        };
        // Adopt an unclaimed PID only for an account that has never had one
        // attributed -- do_launch's own post-fallback poll
        // (wait_for_new_roblox_pid) is the primary way a URI-handler-launched
        // account gets a real PID, and this is the secondary net for the rare
        // case where Roblox took longer to start than that poll's window.
        //
        // Deliberately NOT applied to an account whose tracked PID just died:
        // handing it whichever stranger happens to be alive (a client the
        // user opened outside MultiRoblox, or one left over from a previous
        // session) is what used to pin a closed account on Running forever
        // and stop the count from ever coming down.
        if !orphans.is_empty() && pid.is_none() {
            let adopted = orphans.remove(0);
            state
                .account_pids
                .lock()
                .unwrap()
                .insert(account_id.clone(), adopted);
            running = true;
        }
        if !running {
            let misses = {
                let mut mc = state.miss_counts.lock().unwrap();
                let m = mc.entry(account_id.clone()).or_insert(0);
                *m += 1;
                *m
            };
            if misses >= MISS_THRESHOLD {
                candidates.push(account_id);
            }
        } else {
            state.miss_counts.lock().unwrap().insert(account_id, 0);
        }
    }

    // A game that died while a hidden launcher window is still around went to
    // the Roblox "home" (closed with the X): amber badge instead of closed.
    // Never for manual kills -- those really close the account.
    if !candidates.is_empty() {
        // Some(pids) = helper confirmed; None = helper failed (timeout/busy)
        // — we don't know whether this is "home" or "closed", so defer the
        // decision to the next tick instead of guessing. Guessing was the bug:
        // a single slow tick used to treat every candidate as closed and
        // permanently lose the amber state.
        let home_now = home_pids(app, &state).await;
        for account_id in &candidates {
            let is_manual = state.manual_kills.lock().unwrap().contains(account_id);
            let went_home = match &home_now {
                Some(h) if !h.is_empty() && !is_manual => true,
                Some(_) => false,
                None => continue, // probe failed — defer this account
            };
            if went_home {
                state.home_accounts.lock().unwrap().insert(account_id.clone());
                state.watched_accounts.lock().unwrap().remove(account_id);
                state.miss_counts.lock().unwrap().remove(account_id);
                state.account_pids.lock().unwrap().remove(account_id);
                clear_manual_priority(&state, account_id);
                let accounts = crate::storage::load_accounts(&state);
                let username = accounts
                    .iter()
                    .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(account_id.as_str()))
                    .and_then(|a| a.get("username").and_then(|v| v.as_str()))
                    .unwrap_or(account_id);
                emit_log(
                    app,
                    "warn",
                    "crash",
                    &format!("Roblox closed to the home for {} — game exited, launcher stays in the tray", username),
                    Some(serde_json::json!({ "accountId": account_id, "username": username })),
                );
                let _ = app.emit("roblox:home", account_id.clone());
            } else {
                closed.push(account_id.clone());
            }
        }
    }

    for account_id in &closed {
        if state.manual_kills.lock().unwrap().contains(account_id) {
            state.manual_kills.lock().unwrap().remove(account_id);
            state.watched_accounts.lock().unwrap().remove(account_id);
            state.miss_counts.lock().unwrap().remove(account_id);
            state.account_pids.lock().unwrap().remove(account_id);
            clear_manual_priority(&state, account_id);
            let _ = app.emit("roblox:closed", account_id);
            continue;
        }
        
        state.watched_accounts.lock().unwrap().remove(account_id);
        state.miss_counts.lock().unwrap().remove(account_id);
        let accounts = crate::storage::load_accounts(&state);
        let acct = accounts
            .iter()
            .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(account_id.as_str()))
            .cloned()
            .unwrap_or(Value::Null);
        let username = acct.get("username").and_then(|v| v.as_str());
        let user_id = acct.get("userId").and_then(|v| v.as_str());
        let pid = state.account_pids.lock().unwrap().get(account_id).copied();
        emit_log(
            app,
            "warn",
            "crash",
            &format!(
                "Roblox closed unexpectedly for {} (missed {} consecutive checks)",
                username.unwrap_or(account_id),
                MISS_THRESHOLD
            ),
            Some(
                serde_json::json!({ "accountId": account_id, "username": username, "userId": user_id, "pid": pid }),
            ),
        );
        state.account_pids.lock().unwrap().remove(account_id);
        clear_manual_priority(&state, account_id);
        let _ = app.emit("roblox:closed", account_id);
        let close_settings = crate::settings::load_settings();
        apply_priority_policy(&state, &close_settings).await;

        let auto_relaunch = close_settings.get("autoRelaunch").and_then(|v| v.as_bool()).unwrap_or(false);
        if auto_relaunch {
            let cookie = acct.get("cookie").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let target = acct.get("gameTarget").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !cookie.is_empty() {
                if auto_relaunch_allowed(&state, account_id) {
                    emit_log(app, "info", "crash", &format!("Auto-relaunching {}...", username.unwrap_or(account_id)), None);
                    let app2 = app.clone();
                    let account_id2 = account_id.clone();
                    tauri::async_runtime::spawn(async move {
                        let st = app2.state::<AppState>();
                        // Same lock manual launches use -- without it a
                        // mass-crash could fire several concurrent launches
                        // with no stagger between them.
                        let _guard = st.launch_lock.lock().await;
                        let _ = do_launch(&app2, &st, &account_id2, &cookie, &target).await;
                    });
                } else {
                    emit_log(
                        app,
                        "warn",
                        "crash",
                        &format!("Auto-relaunch skipped for {} -- too many recent crashes", username.unwrap_or(account_id)),
                        None,
                    );
                }
            }
        }
    }

    // The hidden home window itself is gone (user closed it from the tray,
    // or it was killed) -> previously-home accounts are plainly closed now.
    // Only drain when the helper confirms the launcher is gone (Some(empty));
    // None means the probe itself failed and we should wait for the next tick.
    if !state.home_accounts.lock().unwrap().is_empty() {
        if let Some(home) = home_pids(app, &state).await {
            if home.is_empty() {
            let gone: Vec<String> = state.home_accounts.lock().unwrap().drain().collect();
            for account_id in gone {
                emit_log(
                    app,
                    "info",
                    "close",
                    &format!("Roblox home closed for {}", account_id),
                    Some(serde_json::json!({ "accountId": account_id })),
                );
                let _ = app.emit("roblox:closed", account_id);
            }
        }
    }
    }

    // Same definition as count_roblox_processes, and computed after the closed
    // accounts above were dropped from account_pids, so the pushed count and
    // the polled one can't disagree.
    let _ = app.emit("roblox:count", owned_running_count(&state, &alive_pids));
    // Keep the on-disk mirror in step with whatever this tick changed
    // (adoptions, closures) so a restart from here recovers the right set.
    // No-ops unless the map actually moved.
    persist_instances(&state);
    stop_watch_poll_if_idle(&state);
}

// ---- launch ----
// Minimum gap between one launch finishing and the next one spawning. Launches
// are already serialized by launch_lock, so this is extra spacing on top of
// that -- it keeps clients from starting close enough together to contend for
// CPU/disk or to hammer the auth-ticket endpoint. Because the lock means the
// next launch reaches the check almost immediately, in practice this sleeps
// very nearly its full value on every launch after the first.
const LAUNCH_STAGGER_MS: i64 = 2_000;

// A launch can legitimately take ~30s -- staggering, CSRF, ticket retries with
// backoff, then up to three spawn attempts -- so it needs a way out. The flag
// is registered before the launch queues on launch_lock, so a launch that
// hasn't started yet can be abandoned too.
pub fn register_launch(state: &AppState, account_id: &str) -> std::sync::Arc<AtomicBool> {
    let flag = std::sync::Arc::new(AtomicBool::new(false));
    state
        .launch_cancel
        .lock()
        .unwrap()
        .insert(account_id.to_string(), flag.clone());
    flag
}

pub fn finish_launch(state: &AppState, account_id: &str) {
    state.launch_cancel.lock().unwrap().remove(account_id);
}

pub fn cancel_launch(state: &AppState, account_id: &str) -> bool {
    match state.launch_cancel.lock().unwrap().get(account_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false, // nothing in flight for this account
    }
}

fn launch_cancelled(state: &AppState, account_id: &str) -> bool {
    state
        .launch_cancel
        .lock()
        .unwrap()
        .get(account_id)
        .map(|f| f.load(Ordering::SeqCst))
        .unwrap_or(false)
}

fn cancelled_result() -> Value {
    serde_json::json!({ "success": false, "cancelled": true, "error": "Launch cancelled" })
}

pub async fn do_launch(
    app: &AppHandle,
    state: &AppState,
    account_id: &str,
    cookie: &str,
    target: &str,
) -> Value {
    close_singleton_and_hold_mutex(app, state).await;
    if launch_cancelled(state, account_id) {
        return cancelled_result();
    }

    let since_last = now_ms() - *state.last_launch_ts.lock().unwrap();
    if *state.last_launch_ts.lock().unwrap() > 0 && since_last < LAUNCH_STAGGER_MS {
        tokio::time::sleep(Duration::from_millis(
            (LAUNCH_STAGGER_MS - since_last) as u64,
        ))
        .await;
    }
    if launch_cancelled(state, account_id) {
        return cancelled_result();
    }

    let csrf_token = crate::roblox_api::get_csrf_token(state, cookie).await;
    let Some(csrf_token) = csrf_token else {
        let accounts = crate::storage::load_accounts(state);
        let username = find_username(&accounts, account_id);
        emit_log(
            app,
            "err",
            "launch",
            &format!(
                "Launch failed for {}: could not get CSRF token (cookie may be expired)",
                username.clone().unwrap_or_else(|| account_id.to_string())
            ),
            Some(serde_json::json!({ "accountId": account_id, "username": username })),
        );
        return serde_json::json!({ "success": false, "error": "Failed to get CSRF token. Is the account cookie still valid?" });
    };

    let ticket_result =
        crate::roblox_api::get_auth_ticket(state, cookie, Some(csrf_token.clone())).await;
    if !ticket_result.ok {
        let accounts = crate::storage::load_accounts(state);
        let username = find_username(&accounts, account_id);
        emit_log(
            app,
            "err",
            "launch",
            &format!(
                "Launch failed for {}: auth ticket error - {}",
                username.clone().unwrap_or_else(|| account_id.to_string()),
                ticket_result.error.clone().unwrap_or_default()
            ),
            Some(serde_json::json!({ "accountId": account_id, "username": username })),
        );
        return serde_json::json!({ "success": false, "error": format!("Failed to get auth ticket: {}", ticket_result.error.unwrap_or_default()) });
    }
    let ticket = ticket_result.ticket.unwrap_or_default();
    // Last point before we start spawning processes -- after this the client
    // is Roblox's to manage, and cancelling would mean killing it instead.
    if launch_cancelled(state, account_id) {
        return cancelled_result();
    }

    let t = target.trim();
    let mut launcher_url = String::new();

    // "placeId:jobId" or "placeId,jobId" shorthand for joining one specific
    // running server instance. (Pattern lives in JOB_SHORTHAND_RE above.)
    if !t.is_empty() {
        if let Some(caps) = JOB_SHORTHAND_RE.captures(t) {
            launcher_url = format!(
                "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestGameJob&placeId={}&gameId={}&isPlayTogetherGame=false",
                &caps[1], &caps[2]
            );
        } else if t.chars().all(|c| c.is_ascii_digit()) {
            launcher_url = format!("https://assetgame.roblox.com/game/placelauncher.ashx?request=RequestGame&placeId={}&isPlayTogetherGame=false", t);
        } else {
            let mut raw_url = if t.starts_with("http") {
                t.to_string()
            } else {
                format!("https://{}", t)
            };
            if let Ok(parsed0) = url::Url::parse(&raw_url) {
                let host = parsed0.host_str().unwrap_or("");
                if host == "ro.blox.com" || host.ends_with(".ro.blox.com") {
                    raw_url = crate::roblox_api::follow_redirect(state, &raw_url).await;
                }
            }
            let parsed = url::Url::parse(&raw_url).ok();
            match parsed {
                None => {
                    return serde_json::json!({ "success": false, "error": "Unrecognised input. Enter a place ID, game URL, or private server link." })
                }
                Some(parsed_url) => {
                    let query: std::collections::HashMap<String, String> =
                        parsed_url.query_pairs().into_owned().collect();
                    let private_code = query.get("privateServerLinkCode").cloned();
                    let share_code = query.get("code").cloned();
                    let share_type = query.get("type").cloned();
                    let job_id = query
                        .get("jobId")
                        .or_else(|| query.get("gameInstanceId"))
                        .or_else(|| query.get("serverJobId"))
                        .cloned();
                    let path = parsed_url.path();
                    let place_id = PLACE_ID_GAMES_RE
                        .captures(path)
                        .or_else(|| PLACE_ID_ANY_RE.captures(path))
                        .map(|c| c[1].to_string())
                        .or_else(|| query.get("placeId").cloned());

                    if let (Some(job_id), Some(place_id)) = (&job_id, &place_id) {
                        launcher_url = format!(
                            "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestGameJob&placeId={}&gameId={}&isPlayTogetherGame=false",
                            place_id, job_id
                        );
                    } else if let (Some(private_code), Some(place_id)) = (&private_code, &place_id)
                    {
                        let access_code = crate::roblox_api::get_access_code(
                            state,
                            place_id,
                            private_code,
                            &cookie,
                            &csrf_token,
                        )
                        .await;
                        match access_code {
                            None => {
                                return serde_json::json!({ "success": false, "error": "Could not resolve private server access code. The link may be expired or you may not have permission." })
                            }
                            Some(access_code) => {
                                launcher_url = format!(
                                    "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestPrivateGame&placeId={}&accessCode={}&linkCode={}",
                                    place_id, access_code, private_code
                                );
                            }
                        }
                    } else if path == "/share" || (share_code.is_some() && share_type.is_some()) {
                        let Some(code) = share_code else {
                            return serde_json::json!({ "success": false, "error": "Invalid share link -- no code found." });
                        };
                        let resolved = crate::roblox_api::resolve_share_link(
                            state,
                            &code,
                            &cookie,
                            Some(&csrf_token),
                        )
                        .await;
                        if !resolved.ok {
                            return serde_json::json!({ "success": false, "error": resolved.error.unwrap_or_else(|| "Could not resolve share link. It may be expired or invalid.".into()) });
                        }
                        launcher_url = format!(
                            "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestGameJob&placeId={}&isPlayTogetherGame=false&linkCode={}",
                            resolved.place_id.unwrap_or_default(),
                            resolved.link_code.unwrap_or_default()
                        );
                    } else if let Some(place_id) = place_id {
                        launcher_url = format!("https://assetgame.roblox.com/game/placelauncher.ashx?request=RequestGame&placeId={}&isPlayTogetherGame=false", place_id);
                    } else {
                        return serde_json::json!({ "success": false, "error": "Could not find a Place ID in the URL." });
                    }
                }
            }
        }
    }

    let launch_time = now_ms();
    let browser_id: u64 = rand::random::<u64>() % 9_000_000_000_000 + 1_000_000_000_000;

    // Settings > Roblox: which deployment channel to run, and whether that
    // choice is pinned. Unlocked always means production/LIVE (empty
    // channel), matching the previous hardcoded behavior.
    let launch_settings = crate::settings::load_settings();
    let lock_channel = launch_settings
        .get("lockChannel")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let channel = if lock_channel {
        launch_settings
            .get("robloxChannel")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    };

    let roblox_uri = if !launcher_url.is_empty() {
        format!(
            "roblox-player:1+launchmode:play+gameinfo:{}+launchtime:{}+placelauncherurl:{}+browsertrackerid:{}+robloxLocale:en_us+gameLocale:en_us+channel:{}+LaunchExp:InApp",
            ticket, launch_time, urlencoding::encode(&launcher_url), browser_id, urlencoding::encode(&channel)
        )
    } else {
        format!(
            "roblox-player:1+launchmode:app+gameinfo:{}+launchtime:{}+browsertrackerid:{}+robloxLocale:en_us+gameLocale:en_us+channel:{}",
            ticket, launch_time, browser_id, urlencoding::encode(&channel)
        )
    };

    // Only ever launch the current build for the target channel (LIVE by
    // default, or the locked channel above) -- a stale cached version-folder
    // or a different channel a bootstrapper pulled down shouldn't get
    // force-launched just because it's the newest thing physically on disk.
    // Unknown (network failure or timeout) doesn't block launch, since
    // that's Roblox's API being unreachable, not a real mismatch. Every
    // other network call in this file is timeout-wrapped except this one
    // was -- an unresponsive (not just erroring) clientsettingscdn/
    // setup.rbxcdn.com would otherwise hang the Launch button forever with
    // no recovery, since this runs on every single launch.
    let live_version = if lock_channel {
        tokio::time::timeout(
            Duration::from_secs(5),
            crate::roblox_api::get_roblox_version(state, Some(channel.as_str())),
        )
        .await
        .ok()
        .and_then(|r| r.ok())
    } else {
        None
    };

    // Falling through to the OS URI handler on spawn failure is what
    // triggers Roblox's own "reinstall?" prompt -- usually just a launch
    // catching Roblox mid self-update with a truncated exe (or, now, a
    // non-LIVE install), so retry a few times before giving up to that
    // fallback, which hands off to Roblox's own updater.
    // Custom launcher path (e.g. Fishtrap) — when set, that exe receives the
    // same roblox-player URI instead of the official RobloxPlayerBeta.
    let launcher_path = launch_settings
        .get("launcherPath")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string());

    let mut spawned_pid: Option<u32> = None;
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(3)).await;
            // The retry backoff is the longest stretch of this whole path;
            // bail out here rather than making the user wait it out.
            if launch_cancelled(state, account_id) {
                return cancelled_result();
            }
        }
        spawned_pid = spawn_roblox_direct(&roblox_uri, live_version.as_deref(), launcher_path.as_deref()).await;
        if spawned_pid.is_some() {
            break;
        }
    }
    match spawned_pid {
        Some(pid) => {
            state
                .account_pids
                .lock()
                .unwrap()
                .insert(account_id.to_string(), pid);
            // Mirror it out straight away: the attribution is only useful for
            // startup recovery if it survives the app being closed with this
            // client still open.
            persist_instances(state);
            // Fired the instant the process exists, not after the trailing
            // priority/bookkeeping work below or the JSON round-trip back to
            // the caller -- that gap (small on its own, but stacked behind
            // CSRF/ticket fetches and the inter-launch stagger for every
            // account after the first) is what made the UI's "launched"
            // color feel like it lagged the real state of the world.
            let _ = app.emit("roblox:started", account_id);
        }
        None => {
            // Snapshot alive PIDs before handing off to the OS URI handler,
            // then poll for whichever new one shows up -- gives this
            // fallback-launched account a real, precisely-attributed PID
            // immediately, instead of leaving it untracked for the shared
            // watch loop's much coarser adoption to (maybe, eventually)
            // pick up.
            let pids_before = cached_or_spawn_pids(app, state)
                .await
                .unwrap_or_default();
            let _ = tauri_plugin_opener::open_url(&roblox_uri, None::<&str>);
            if let Some(pid) =
                wait_for_new_roblox_pid(app, state, &pids_before, Duration::from_secs(10)).await
            {
                state
                    .account_pids
                    .lock()
                    .unwrap()
                    .insert(account_id.to_string(), pid);
                persist_instances(state);
                let _ = app.emit("roblox:started", account_id);
            }
        }
    }

    apply_priority_policy(state, &launch_settings).await;

    *state.last_launch_ts.lock().unwrap() = now_ms();
    crate::roblox_api::invalidate_ticket(state, &cookie);

    let mut accounts = crate::storage::load_accounts(state);
    let (username, user_id) = if let Some(idx) = accounts
        .iter()
        .position(|a| a.get("id").and_then(|v| v.as_str()) == Some(account_id))
    {
        accounts[idx]["lastUsed"] = Value::String(chrono::Utc::now().to_rfc3339());
        let username = accounts[idx]
            .get("username")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let user_id = accounts[idx]
            .get("userId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let _ = crate::storage::save_accounts(state, accounts.clone());
        (username, user_id)
    } else {
        (None, None)
    };
    let pid = state.account_pids.lock().unwrap().get(account_id).copied();

    emit_log(
        app,
        "ok",
        "launch",
        &format!(
            "Launched Roblox for {}",
            username.clone().unwrap_or_else(|| account_id.to_string())
        ),
        Some(
            serde_json::json!({ "accountId": account_id, "username": username, "userId": user_id, "target": if t.is_empty() { "Roblox home" } else { t }, "pid": pid }),
        ),
    );

    watch_roblox(app, account_id).await;

    if let Some(vol) = launch_settings
        .get("masterVolume")
        .and_then(|v| v.as_f64())
    {
        if vol != 100.0 {
            let app2 = app.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(9)).await;
                let st = app2.state::<AppState>();
                set_roblox_volume(&app2, &st, vol).await;
            });
        }
    }

    serde_json::json!({ "success": true })
}

fn find_username(accounts: &[Value], account_id: &str) -> Option<String> {
    accounts
        .iter()
        .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(account_id))
        .and_then(|a| a.get("username"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}
