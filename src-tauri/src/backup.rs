// Encrypted full backup of accounts + groups + settings.
//
// Conceptually ported from the reference app's backup.js: a password-protected
// container (scrypt-derived key + AES-256-GCM payload) written as one JSON
// file, restorable here or on another machine. Everything is built on the
// crypto primitives this app already ships (crypto.rs) -- the only new
// dependency is the first-party file dialog plugin, which is what picks the
// save/open path.
//
// Accounts are carried in plaintext inside the container (the container's own
// password is the protection) and re-encrypted under the app's *current* key
// when restored, via storage::save_accounts. Restore is replace-semantics,
// like the reference app: it swaps accounts, groups and settings wholesale.
use crate::crypto;
use crate::state::AppState;
use serde_json::{json, Map, Value};
use sha2::Digest;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

const BACKUP_TYPE: &str = "multiroblox-backup";
const BACKUP_VERSION: u32 = 1;
const MIN_PASSWORD_LEN: usize = 6;

#[derive(serde::Serialize)]
struct Payload {
    accounts: Vec<Value>,
    packages: Vec<Value>,
    settings: Map<String, Value>,
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

// Loads everything a backup should carry. Cookies come out decrypted (the
// session key is held in memory at this point) and are re-encrypted on
// restore -- so a backup is readable even on another machine, unlike the raw
// on-disk files which are tied to this device's key.
fn collect_payload(state: &AppState) -> Result<Payload, String> {
    let _guard = crate::persistence::data_guard().map_err(|error| error.to_string())?;
    Ok(Payload {
        accounts: crate::storage::load_accounts_strict(state)?,
        packages: crate::jsonfile::read_array_checked(&crate::paths::packages_path()).map_err(|error| error.to_string())?,
        settings: crate::settings::try_load_settings().map_err(|error| error.to_string())?,
    })
}

fn build_container(payload: &Payload, password: &str) -> Result<Value, String> {
    let password = password.trim();
    if password.len() < MIN_PASSWORD_LEN {
        return Err(format!(
            "The backup password must be at least {} characters",
            MIN_PASSWORD_LEN
        ));
    }
    let mut salt_bytes = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut salt_bytes);
    let salt = hex::encode(salt_bytes);
    let key = crypto::derive_scrypt_key(password, &salt);
    let auth_hash = hex::encode(sha2::Sha256::digest(&key));

    let payload_json = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    let ct = crypto::encrypt_gcm(&payload_json, &key, "gs");
    Ok(json!({
        "version": BACKUP_VERSION,
        "type": BACKUP_TYPE,
        "encrypted": true,
        "createdAt": now_rfc3339(),
        "salt": salt,
        "authHash": auth_hash,
        "payload": ct,
    }))
}

// Constant-time compare so a wrong password doesn't leak how close it was.
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn open_container(container: &Value, password: &str) -> Result<Payload, String> {
    if container.get("type").and_then(|v| v.as_str()) != Some(BACKUP_TYPE) {
        return Err("This file is not a KNT Manager backup.".into());
    }
    if container.get("encrypted").and_then(|v| v.as_bool()) != Some(true) {
        return Err("This backup file is not encrypted.".into());
    }
    let salt = container
        .get("salt")
        .and_then(|v| v.as_str())
        .ok_or("This backup file is missing its salt (corrupt or not a backup).")?;
    let stored_hash = container
        .get("authHash")
        .and_then(|v| v.as_str())
        .ok_or("This backup file is missing its key hash (corrupt or not a backup).")?;
    let ct = container
        .get("payload")
        .and_then(|v| v.as_str())
        .ok_or("This backup file is missing its payload (corrupt or not a backup).")?;

    let key = crypto::derive_scrypt_key(password, salt);
    let computed = hex::encode(sha2::Sha256::digest(&key));
    if !constant_time_eq(&computed, stored_hash) {
        return Err("Incorrect backup password.".into());
    }
    let plain = crypto::decrypt_gcm(ct, &key, "gs")
        .ok_or("Could not decrypt the backup (corrupt file or wrong password).")?;
    let v: Value = serde_json::from_str(&plain)
        .map_err(|_| "The backup contents are unreadable (corrupt file).".to_string())?;
    let accounts = v
        .get("accounts")
        .and_then(|a| a.as_array())
        .cloned()
        .ok_or("The backup account list is missing or invalid; nothing was restored.")?;
    let packages = v
        .get("packages")
        .and_then(|a| a.as_array())
        .cloned()
        .ok_or("The backup group list is missing or invalid; nothing was restored.")?;
    let settings = v
        .get("settings")
        .and_then(|o| o.as_object())
        .cloned()
        .ok_or("The backup settings are missing or invalid; nothing was restored.")?;
    Ok(Payload {
        accounts,
        packages,
        settings,
    })
}

// Key material and derived values must never come back from a backup -- they
// belong to the *current* encryption setup, and restoring an old verifier or
// salt would orphan every cookie already stored under the active key.
fn sanitize_restored_settings(settings: &mut Map<String, Value>) {
    for k in [
        "customKey",
        "customKeyEnc",
        "keyVerifier",
        "kdfSalt",
        "_deviceKey",
        "encSetupDone",
    ] {
        settings.remove(k);
    }
}

fn preserve_local_encryption(restored: &mut Map<String, Value>, current: &Map<String, Value>) {
    sanitize_restored_settings(restored);
    for key in ["customKey", "customKeyEnc", "keyVerifier", "kdfSalt", "_deviceKey", "encSetupDone"] {
        if let Some(value) = current.get(key) {
            restored.insert(key.into(), value.clone());
        }
    }
}

// Backups read/write the decrypted account list, so they require an unlocked
// session in passphrase mode (same gate as every other data-touching command).
fn unlock_required(state: &AppState) -> Option<String> {
    if crate::encryption::passphrase_mode()
        && state.session_pass.lock().unwrap().is_none()
    {
        return Some(
            "Unlock the app (enter your encryption key) before creating or restoring a backup."
                .into(),
        );
    }
    None
}

fn file_path(file: tauri_plugin_dialog::FilePath) -> Option<std::path::PathBuf> {
    match file {
        tauri_plugin_dialog::FilePath::Path(p) => Some(p),
        tauri_plugin_dialog::FilePath::Url(_) => None,
    }
}

fn date_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d-%H%M").to_string()
}

pub async fn create_backup(app: &AppHandle, state: &AppState, password: String) -> Value {
    if let Some(err) = unlock_required(state) {
        return json!({ "ok": false, "error": err });
    }
    let payload = match collect_payload(state) {
        Ok(payload) => payload,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    let container = match build_container(&payload, &password) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": e }),
    };

    let (tx, rx) = oneshot::channel::<Option<tauri_plugin_dialog::FilePath>>();
    app.dialog()
        .file()
        .set_title("Save KNT Manager backup")
        .add_filter("KNT Manager backup", &["mrbackup"])
        .set_file_name(&format!("multiroblox-backup-{}.mrbackup", date_stamp()))
        .save_file(move |file| {
            let _ = tx.send(file);
        });
    let picked = match rx.await {
        Ok(p) => p,
        Err(_) => return json!({ "ok": false, "error": "Could not open the save dialog" }),
    };
    let Some(file) = picked else {
        return json!({ "ok": false, "canceled": true });
    };
    let Some(path) = file_path(file) else {
        return json!({ "ok": false, "error": "Could not resolve the chosen path" });
    };

    let body = serde_json::to_string_pretty(&container).unwrap_or_else(|_| "{}".into());
    // Clone for the blocking closure; `path` is still needed below for the log.
    let path_for_write = path.clone();
    let write = tokio::task::spawn_blocking(move || crate::jsonfile::write_atomic(&path_for_write, &body)).await;
    let count = payload.accounts.len();
    match write {
        Ok(Ok(())) => {
            crate::native::emit_log(
                app,
                "ok",
                "system",
                &format!("Backup saved with {} account(s)", count),
                Some(json!({ "path": path.display().to_string(), "count": count })),
            );
            json!({ "ok": true, "path": path.display().to_string(), "count": count })
        }
        Ok(Err(e)) => json!({ "ok": false, "error": format!("Could not write the backup file: {}", e) }),
        Err(e) => json!({ "ok": false, "error": format!("Could not write the backup file: {}", e) }),
    }
}

// ── automatic backups (managed folder, same container format) ───────────────
// Auto-backups reuse the exact same build_container/open_container format as
// manual backups, so any backup -- manual or automatic -- restores through the
// same code path and is interchangeable. They differ only in where they're
// written (a fixed app-data subfolder, no dialog) and in that the app itself
// holds the password (see ensure_auto_password) so it can run unattended.

pub fn auto_backup_dir() -> std::path::PathBuf {
    crate::paths::app_data_dir().join("backups")
}

fn stamp_seconds() -> String {
    chrono::Local::now().format("%Y-%m-%d-%H%M%S").to_string()
}

// Unambiguous alphabet (no 0/O, 1/I/l) so a printed password survives being
// retyped on another machine.
fn generate_password() -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    (0..24)
        .map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char)
        .collect()
}

// Returns the auto-backup password, generating and persisting a fresh strong
// one on first use. It lives in settings so the app can create automatic
// backups unattended; the UI shows it so the user can write it down for
// restoring on another machine.
pub fn ensure_auto_password() -> Value {
    let Ok(_guard) = crate::persistence::data_guard() else { return json!({ "ok": false, "error": "Storage recovery is required" }); };
    let mut s = crate::settings::load_settings();
    let mut ab = s
        .get("autoBackup")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let existing = ab
        .get("password")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let pw = match existing {
        Some(p) => p,
        None => {
            let p = generate_password();
            ab.insert("password".into(), Value::String(p.clone()));
            s.insert("autoBackup".into(), Value::Object(ab));
            if let Err(error) = crate::settings::try_save_settings(&s) { return json!({ "ok": false, "error": error.to_string() }); }
            p
        }
    };
    json!({ "ok": true, "password": pw })
}

fn prune_old(dir: std::path::PathBuf, keep: usize) -> usize {
    let mut files: Vec<std::path::PathBuf> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "mrbackup").unwrap_or(false))
            .collect(),
        Err(_) => return 0,
    };
    if files.len() <= keep {
        return 0;
    }
    files.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    let mut removed = 0;
    while files.len() > keep {
        if let Some(oldest) = files.first() {
            if std::fs::remove_file(oldest).is_ok() {
                removed += 1;
            }
        }
        files.remove(0);
    }
    removed
}

pub async fn auto_create_backup(app: &AppHandle, state: &AppState, password: &str, keep: i64) -> Value {
    if let Some(err) = unlock_required(state) {
        return json!({ "ok": false, "error": err });
    }
    let payload = match collect_payload(state) {
        Ok(payload) => payload,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    let container = match build_container(&payload, password) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let dir = auto_backup_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return json!({ "ok": false, "error": format!("Could not create the backups folder: {}", e) });
    }
    // Unique file name: second-resolution stamp, bumped with a suffix on the
    // (rare) same-second collision.
    let mut path = dir.join(format!("multiroblox-backup-{}.mrbackup", stamp_seconds()));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("multiroblox-backup-{}-{}.mrbackup", stamp_seconds(), n));
        n += 1;
    }

    let body = serde_json::to_string_pretty(&container).unwrap_or_else(|_| "{}".into());
    let path_for_write = path.clone();
    let write = tokio::task::spawn_blocking(move || crate::jsonfile::write_atomic(&path_for_write, &body)).await;
    let count = payload.accounts.len();
    match write {
        Ok(Ok(())) => {
            let pruned = prune_old(dir, keep.max(1) as usize);
            crate::native::emit_log(
                app,
                "ok",
                "system",
                &format!("Automatic backup saved with {} account(s)", count),
                Some(json!({ "path": path.display().to_string(), "count": count, "pruned": pruned })),
            );
            json!({ "ok": true, "path": path.display().to_string(), "count": count, "pruned": pruned })
        }
        Ok(Err(e)) => json!({ "ok": false, "error": format!("Could not write the backup file: {}", e) }),
        Err(e) => json!({ "ok": false, "error": format!("Could not write the backup file: {}", e) }),
    }
}

fn created_epoch(v: &Value) -> Option<i64> {
    v.get("createdAtMs")
        .and_then(|c| c.as_i64())
}

pub fn list_backups() -> Value {
    let dir = auto_backup_dir();
    let mut items: Vec<Value> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x != "mrbackup").unwrap_or(true) {
                continue;
            }
            let name = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            let mtime = std::fs::metadata(&p)
                .and_then(|m| m.modified())
                .ok()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0));
            // createdAt lives in the container header (unencrypted) -- best-effort.
            let mut created_ms = None;
            let mut created = None;
            if let Ok(text) = std::fs::read_to_string(&p) {
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    if let Some(c) = v.get("createdAt").and_then(|c| c.as_str()) {
                        created = Some(c.to_string());
                        created_ms = chrono::DateTime::parse_from_rfc3339(c).ok().map(|dt| dt.timestamp_millis());
                    }
                }
            }
            items.push(json!({
                "name": name,
                "path": p.display().to_string(),
                "size": size,
                "createdAt": created,
                "createdAtMs": created_ms.unwrap_or(mtime.unwrap_or(0)),
            }));
        }
    }
    items.sort_by(|a, b| created_epoch(b).cmp(&created_epoch(a)));
    Value::Array(items)
}

pub fn delete_backup(name: &str) -> Value {
    let dir = auto_backup_dir();
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || !name.ends_with(".mrbackup")
    {
        return json!({ "ok": false, "error": "Invalid backup name" });
    }
    let path = dir.join(name);
    // Defense in depth: the resolved file must stay inside the backups folder.
    if let (Ok(canon_dir), Ok(canon_path)) = (dir.canonicalize(), path.canonicalize()) {
        if !canon_path.starts_with(&canon_dir) {
            return json!({ "ok": false, "error": "Invalid backup name" });
        }
    }
    match std::fs::remove_file(&path) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": format!("Could not delete the backup: {}", e) }),
    }
}

// Keep the full restore under the same lock as rekey and account mutations.
// No guard crosses an await or a file dialog.
fn apply_payload(state: &AppState, payload: &mut Payload) -> Result<(), String> {
    let _guard = crate::persistence::data_guard().map_err(|error| error.to_string())?;
    if let Some(error) = unlock_required(state) { return Err(error); }
    crate::record_crypto::decrypt_strict(&payload.accounts, |text| Some(text.into()))?;
    let accounts = crate::record_crypto::encrypt_verified(&payload.accounts,
        |text| crate::encryption::encrypt_field(state, text),
        |ciphertext| crate::encryption::decrypt_field(state, ciphertext))?;
    preserve_local_encryption(&mut payload.settings, &crate::settings::try_load_settings().map_err(|error| error.to_string())?);
    crate::file_transaction::commit(&crate::paths::app_data_dir(), vec![
        ("accounts.json", serde_json::to_string_pretty(&accounts).map_err(|error| error.to_string())?),
        ("packages.json", serde_json::to_string_pretty(&payload.packages).map_err(|error| error.to_string())?),
        ("settings.json", serde_json::to_string_pretty(&payload.settings).map_err(|error| error.to_string())?),
    ]).map_err(|error| error.to_string())
}

// Core restore used by both the dialog picker and the automatic-backup history.
pub async fn do_restore(app: &AppHandle, state: &AppState, path: &std::path::Path, password: &str) -> Value {
    // Clone for the blocking closure; `path` is still needed below for the log.
    let path_for_read = path.to_path_buf();
    let read = tokio::task::spawn_blocking(move || std::fs::read_to_string(&path_for_read)).await;
    let text = match read {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => return json!({ "ok": false, "error": format!("Could not read the backup file: {}", e) }),
        Err(_) => return json!({ "ok": false, "error": "Could not read the backup file" }),
    };
    let container: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => {
            return json!({ "ok": false, "error": "The selected file is not a valid KNT Manager backup." })
        }
    };
    let mut payload = match open_container(&container, password) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    sanitize_restored_settings(&mut payload.settings);

    let restored = apply_payload(state, &mut payload);
    if let Err(error) = restored {
        return json!({ "ok": false, "error": error });
    }

    // Drop bookkeeping for accounts that no longer exist after the restore so
    // the watch loop and kill commands stop pointing at removed instances.
    let kept: std::collections::HashSet<String> = payload
        .accounts
        .iter()
        .filter_map(|a| a.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    let stale: Vec<String> = state
        .account_pids
        .lock()
        .unwrap()
        .keys()
        .filter(|id| !kept.contains(*id))
        .cloned()
        .collect();
    for id in &stale {
        crate::native::clear_manual_priority(state, id);
        state.watched_accounts.lock().unwrap().remove(id);
        state.miss_counts.lock().unwrap().remove(id);
        state.account_pids.lock().unwrap().remove(id);
        let _ = app.emit("roblox:closed", id.clone());
    }

    let count = payload.accounts.len();
    crate::native::emit_log(
        app,
        "ok",
        "system",
        &format!("Backup restored with {} account(s)", count),
        Some(json!({ "path": path.display().to_string(), "count": count })),
    );
    json!({ "ok": true, "count": count })
}

// Manual restore: the user picks a file (any .mrbackup/.json, wherever it is),
// then the shared do_restore does the work.
pub async fn restore_backup(app: &AppHandle, state: &AppState, password: String) -> Value {
    if let Some(err) = unlock_required(state) {
        return json!({ "ok": false, "error": err });
    }

    let (tx, rx) = oneshot::channel::<Option<tauri_plugin_dialog::FilePath>>();
    app.dialog()
        .file()
        .set_title("Select a KNT Manager backup to restore")
        .add_filter("KNT Manager backup", &["mrbackup", "json"])
        .pick_file(move |file| {
            let _ = tx.send(file);
        });
    let picked = match rx.await {
        Ok(p) => p,
        Err(_) => return json!({ "ok": false, "error": "Could not open the file dialog" }),
    };
    let Some(file) = picked else {
        return json!({ "ok": false, "canceled": true });
    };
    let Some(path) = file_path(file) else {
        return json!({ "ok": false, "error": "Could not resolve the chosen path" });
    };
    do_restore(app, state, &path, &password).await
}

// Restore a specific automatic backup from its managed-folder path (history
// list), using the app-held password -- no dialog.
pub async fn restore_backup_path(app: &AppHandle, state: &AppState, path: String, password: String) -> Value {
    if let Some(err) = unlock_required(state) {
        return json!({ "ok": false, "error": err });
    }
    do_restore(app, state, &std::path::PathBuf::from(path), &password).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_encrypted_payloads_are_rejected_instead_of_restored_as_empty_lists() {
        let password = "test-backup-password";
        let salt = "test-backup-salt";
        let key = crypto::derive_scrypt_key(password, salt);
        for payload in [json!({"packages":[],"settings":{}}), json!({"accounts":[],"packages":null,"settings":{}}), json!({"accounts":[],"packages":[],"settings":[]})] {
            let container = json!({"type": BACKUP_TYPE, "version":BACKUP_VERSION, "encrypted":true, "salt":salt,
                "authHash":hex::encode(sha2::Sha256::digest(key)),
                "payload":crypto::encrypt_gcm(&serde_json::to_string(&payload).unwrap(), &key, "gs")});
            assert!(open_container(&container,password).is_err());
        }
    }

    #[test]
    fn current_backup_format_still_opens_and_rejects_a_wrong_password() {
        let payload = Payload { accounts: vec![json!({"cookie":"fake-cookie","password":"fake-password"})], packages: vec![], settings: Map::new() };
        let container = build_container(&payload, "backup-password").unwrap();
        let opened = open_container(&container, "backup-password").unwrap();
        assert_eq!(opened.accounts,payload.accounts);
        assert!(open_container(&container, "wrong-password").is_err());
    }

    #[test]
    fn restore_keeps_passphrase_ciphertext_readable_after_settings_reload() {
        let current = json!({ "keyVerifier": "local-verifier", "kdfSalt": "local-salt", "encSetupDone": true });
        let key = crypto::derive_scrypt_key("local-password", "local-salt");
        let ciphertext = crypto::encrypt_gcm("session-secret", &key, "gs");
        let mut restored = json!({ "keyVerifier": "foreign-verifier", "kdfSalt": "foreign-salt", "language": "pt" }).as_object().unwrap().clone();
        preserve_local_encryption(&mut restored, current.as_object().unwrap());
        let reloaded: Map<String, Value> = serde_json::from_str(&serde_json::to_string(&restored).unwrap()).unwrap();
        let key_after_restart = crypto::derive_scrypt_key("local-password", reloaded["kdfSalt"].as_str().unwrap());
        assert_eq!(crypto::decrypt_gcm(&ciphertext, &key_after_restart, "gs").as_deref(), Some("session-secret"));
        assert_eq!(reloaded["keyVerifier"], "local-verifier");
        assert_eq!(reloaded["language"], "pt");
    }

    #[test]
    fn restore_keeps_local_device_key_and_rejects_foreign_passphrase_metadata() {
        let current = json!({ "_deviceKey": "local-device-key", "encSetupDone": true });
        let mut restored = json!({ "_deviceKey": "foreign-key", "customKey": "foreign-password", "keyVerifier": "foreign-verifier", "kdfSalt": "foreign-salt", "fpsCap": 60 }).as_object().unwrap().clone();
        preserve_local_encryption(&mut restored, current.as_object().unwrap());
        assert_eq!(restored["_deviceKey"], "local-device-key");
        assert!(!restored.contains_key("customKey"));
        assert!(!restored.contains_key("keyVerifier"));
        assert!(!restored.contains_key("kdfSalt"));
        assert_eq!(restored["fpsCap"], 60);
    }
}
