use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;
use tokio::process::Child;

pub struct AppState {
    pub app_handle: AppHandle,
    pub http: reqwest::Client,
    pub http_no_redirect: reqwest::Client,

    pub session_pass: Mutex<Option<String>>,
    pub cached_key: Mutex<Option<[u8; 32]>>,
    pub cached_legacy_key: Mutex<Option<[u8; 32]>>,
    /// Cached launcher path from settings to avoid reading settings.json
    /// on every watch tick. Cleared whenever settings are saved.
    pub cached_launcher_path: Mutex<Option<String>>,

    // The one resident RobloxNative.exe (see helper.rs). It replaces what used
    // to be a separate child per concern -- mutex holder, anti-AFK, PID
    // watcher -- plus a fresh one-shot process per launch for closehandles and
    // per slider move for volume.
    pub helper: tokio::sync::Mutex<Option<Arc<crate::helper::Helper>>>,
    pub helper_child: Mutex<Option<Child>>,
    pub helper_shutdown: AtomicBool,
    pub helper_swept: AtomicBool,
    pub helper_restarts: Mutex<Vec<i64>>,
    pub helper_next_attempt: Mutex<i64>,
    pub antiafk_on: AtomicBool,

    pub native_helper_path: Mutex<Option<Option<std::path::PathBuf>>>, // Some(None) = unavailable
    pub account_pids: Mutex<HashMap<String, u32>>,
    pub manual_priority: Mutex<HashMap<String, String>>,
    pub watched_accounts: Mutex<HashMap<String, i64>>,
    pub miss_counts: Mutex<HashMap<String, u32>>,
    pub watch_handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pub auto_relaunch_history: Mutex<HashMap<String, Vec<i64>>>,
    pub manual_kills: Mutex<std::collections::HashSet<String>>,
    pub watch_pid_cache: Mutex<Option<std::collections::HashSet<u32>>>,
    /// Accounts whose game instance went to the Roblox "home" (tray): the
    /// game process died but a hidden launcher/home window is still around.
    /// UI shows them amber instead of plain closed.
    pub home_accounts: Mutex<std::collections::HashSet<String>>,
    /// account id -> deadline (ms) until which a close candidate that
    /// hasn't confirmed "home" yet keeps being re-checked before it is
    /// declared closed. The launcher/home window can lag a couple seconds
    /// behind the game window closing, and closing too early turned a
    /// legit home into a permanent closed.
    pub home_retry_deadline: Mutex<HashMap<String, i64>>,

    pub csrf_cache: Mutex<HashMap<String, (String, i64)>>,
    pub ticket_cache: Mutex<HashMap<String, (String, i64)>>,
    pub last_launch_ts: Mutex<i64>,
    pub launch_lock: tokio::sync::Mutex<()>,
    /// account id -> flag the UI can set to abandon an in-flight launch.
    pub launch_cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,

    pub login_cancel: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,

    /// Serializes every state-mutating instance operation: sync, kill-all,
    /// kill-home, wipe. Concurrent callers (Sync button, Kill Roblox button,
    /// close-tray, watchdog) queue on this instead of racing each other over
    /// account_pids/watched_accounts/home_accounts. Previously named sync_lock
    /// but never actually acquired anywhere — sync and kill could run
    /// concurrently and leave the maps inconsistent.
    pub ops_lock: tokio::sync::Mutex<()>,
    /// Last account -> PID map written to instances.json, so the mirror is
    /// only rewritten when tracking actually changed (the watch loop calls
    /// into it once a second).
    pub persisted_instances: Mutex<Option<Vec<(String, u32)>>>,
}

impl AppState {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            // connect_timeout only -- deliberately NOT a whole-request
            // timeout. A host that blackholes packets (firewall drop, dead
            // DNS) otherwise leaves a connect attempt hanging indefinitely,
            // and callers that aren't individually timeout-wrapped just stop.
            // A request timeout would cap the whole exchange including the
            // body, which would break the Chrome download in login.rs -- it
            // streams a several-hundred-MB zip through this same client.
            http: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("reqwest client"),
            http_no_redirect: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("reqwest client (no redirect)"),
            session_pass: Mutex::new(None),
            cached_key: Mutex::new(None),
            cached_legacy_key: Mutex::new(None),
            cached_launcher_path: Mutex::new(None),
            helper: tokio::sync::Mutex::new(None),
            helper_child: Mutex::new(None),
            helper_shutdown: AtomicBool::new(false),
            helper_swept: AtomicBool::new(false),
            helper_restarts: Mutex::new(Vec::new()),
            helper_next_attempt: Mutex::new(0),
            antiafk_on: AtomicBool::new(false),
            native_helper_path: Mutex::new(None),
            account_pids: Mutex::new(HashMap::new()),
            manual_priority: Mutex::new(HashMap::new()),
            watched_accounts: Mutex::new(HashMap::new()),
            miss_counts: Mutex::new(HashMap::new()),
            watch_handle: Mutex::new(None),
            auto_relaunch_history: Mutex::new(HashMap::new()),
            manual_kills: Mutex::new(std::collections::HashSet::new()),
            watch_pid_cache: Mutex::new(None),
            home_accounts: Mutex::new(std::collections::HashSet::new()),
            home_retry_deadline: Mutex::new(HashMap::new()),
            csrf_cache: Mutex::new(HashMap::new()),
            ticket_cache: Mutex::new(HashMap::new()),
            last_launch_ts: Mutex::new(0),
            launch_lock: tokio::sync::Mutex::new(()),
            launch_cancel: Mutex::new(HashMap::new()),
            login_cancel: Mutex::new(None),
            ops_lock: tokio::sync::Mutex::new(()),
            persisted_instances: Mutex::new(None),
        }
    }
}
