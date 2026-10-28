// Port of main.js's key-session logic (getEncryptionKey/getLegacyKey/
// encryptField/decryptField/passphraseMode). Ciphertext tags (gs:/gcm:/cbc:/
// safe:) are unchanged so records written by the Electron build keep
// decrypting here. New writes use "safe2:" (plain DPAPI, no Local State
// dependency) instead of Electron's Chromium-flavoured "safe:" -- see
// crypto.rs for why.
use crate::crypto;
use crate::paths::local_state_path;
use crate::settings::{get_str, load_settings};
use crate::state::AppState;
use rand::RngCore;
use serde_json::Value;
use tauri::Manager;

const VERIFY_TOKEN: &str = crate::key_change::VERIFY_TOKEN;

pub fn passphrase_mode() -> bool {
    let s = load_settings();
    let has_verifier = s
        .get("keyVerifier")
        .and_then(|v| v.as_str())
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    let has_key_enc = s
        .get("customKeyEnc")
        .and_then(|v| v.as_str())
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    let has_key = s
        .get("customKey")
        .and_then(|v| v.as_str())
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    has_verifier || has_key_enc || has_key
}

fn current_salt() -> String {
    get_str(&load_settings(), "kdfSalt").unwrap_or_else(|| crypto::LEGACY_SALT.to_string())
}

pub fn make_verifier(pass: &str) -> String {
    let key = crypto::derive_scrypt_key(pass, &current_salt());
    crypto::encrypt_gcm(VERIFY_TOKEN, &key, "gs")
}

pub fn unlock_session(state: &AppState, pass: &str) -> bool {
    let Ok(_guard) = crate::persistence::data_guard() else { return false; };
    if pass.is_empty() {
        return false;
    }
    let s = load_settings();
    let Some(verifier) = s.get("keyVerifier").and_then(|value| value.as_str()) else {
        return false;
    };
    let salt = s.get("kdfSalt").and_then(|value| value.as_str()).unwrap_or(crypto::LEGACY_SALT);
    let Some(key) = crypto::verified_scrypt_key(pass, salt, verifier, VERIFY_TOKEN) else {
        return false;
    };
    *state.session_pass.lock().unwrap() = Some(pass.to_string());
    *state.cached_legacy_key.lock().unwrap() = None;
    *state.cached_key.lock().unwrap() = Some(key);
    true
}

fn get_or_create_device_key() -> Option<[u8; 32]> {
    if let Some(key) = get_existing_device_key() { return Some(key); }
    let mut s = load_settings();
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    s.insert("_deviceKey".into(), Value::String(hex::encode(key)));
    crate::settings::try_save_settings(&s).ok()?;
    Some(key)
}

fn get_existing_device_key() -> Option<[u8; 32]> {
    let settings = load_settings();
    let text = settings.get("_deviceKey")?.as_str()?;
    hex::decode(text).ok()?.try_into().ok()
}

fn safe_storage_ready() -> bool {
    cfg!(windows)
}

pub fn get_encryption_key(state: &AppState) -> Option<[u8; 32]> {
    if let Some(k) = *state.cached_key.lock().unwrap() {
        return Some(k);
    }
    let session_pass = state.session_pass.lock().unwrap().clone();
    if let Some(pass) = session_pass {
        let k = crypto::derive_scrypt_key(&pass, &current_salt());
        *state.cached_key.lock().unwrap() = Some(k);
        return Some(k);
    }
    if !passphrase_mode() {
        let k = get_existing_device_key()?;
        *state.cached_key.lock().unwrap() = Some(k);
        return Some(k);
    }
    None // locked
}

pub fn get_legacy_key(state: &AppState) -> Option<[u8; 32]> {
    if let Some(k) = *state.cached_legacy_key.lock().unwrap() {
        return Some(k);
    }
    let session_pass = state.session_pass.lock().unwrap().clone();
    if let Some(pass) = session_pass {
        let k = crypto::derive_legacy_key(&pass);
        *state.cached_legacy_key.lock().unwrap() = Some(k);
        return Some(k);
    }
    if !passphrase_mode() {
        let k = get_existing_device_key()?;
        *state.cached_legacy_key.lock().unwrap() = Some(k);
        return Some(k);
    }
    None
}

/// Pre-derives the unlocked passphrase key off the async runtime's blocking
/// pool so the first decrypt hits the cache instead of blocking on a
/// ~340ms scrypt derive. No-op when locked or machine-bound.
pub fn prewarm_key(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || {
            let Ok(_guard) = crate::persistence::data_guard() else { return; };
            let state = app.state::<AppState>();
            if state.session_pass.lock().unwrap().is_some() { let _ = get_encryption_key(&state); }
        }).await;
    });
}

pub fn is_encrypted(v: &str) -> bool {
    v.starts_with("safe2:")
        || v.starts_with("safe:")
        || v.starts_with("gs:")
        || v.starts_with("gcm:")
        || v.starts_with("cbc:")
}

pub fn encrypt_field(state: &AppState, plaintext: &str) -> Result<String, String> {
    let _guard = crate::persistence::data_guard().map_err(|error| error.to_string())?;
    let session_pass = state.session_pass.lock().unwrap().clone();
    if session_pass.is_some() {
        let key = get_encryption_key(state).ok_or("locked")?;
        return Ok(crypto::encrypt_gcm(plaintext, &key, "gs"));
    }
    if passphrase_mode() {
        return Err("locked".into());
    }
    if safe_storage_ready() {
        if let Some(enc) = crypto::encrypt_safe2(plaintext) {
            return Ok(enc);
        }
    }
    // A read/decrypt never invents a replacement for a lost device key. Only
    // this explicit encryption path may create and persist a new one.
    let key = get_encryption_key(state).or_else(|| {
        let key = get_or_create_device_key()?;
        *state.cached_key.lock().unwrap() = Some(key);
        Some(key)
    }).ok_or("Could not persist the device encryption key")?;
    Ok(crypto::encrypt_gcm(plaintext, &key, "gs"))
}

pub fn decrypt_field(state: &AppState, ct: &str) -> Option<String> {
    let _guard = crate::persistence::data_guard().ok()?;
    if ct.is_empty() {
        return None;
    }
    if ct.starts_with("safe2:") {
        return crypto::decrypt_safe2(ct);
    }
    if ct.starts_with("safe:") {
        let body = ct.strip_prefix("safe:")?;
        return crypto::decrypt_electron_safe_storage(body, &local_state_path());
    }
    if ct.starts_with("gs:") {
        return crypto::decrypt_gcm(ct, &get_encryption_key(state)?, "gs");
    }
    if ct.starts_with("gcm:") {
        return crypto::decrypt_gcm(ct, &get_legacy_key(state)?, "gcm");
    }
    if ct.starts_with("cbc:") {
        return crypto::decrypt_cbc(ct, &get_legacy_key(state)?);
    }
    Some(ct.to_string())
}

/// Runs once at startup: migrate legacy customKey/customKeyEnc formats to the
/// verifier model. Unlike the old Electron build's per-boot session cache,
/// this app asks for the passphrase on every launch (writeSessionKey was
/// already disabled in the source main.js).
pub fn init_encryption(state: &AppState) {
    let Ok(_guard) = crate::persistence::data_guard() else { return; };
    let s = load_settings();
    if s.get("keyVerifier").and_then(|v| v.as_str()).is_none() {
        let mut legacy: Option<String> = None;
        if let Some(enc) = s.get("customKeyEnc").and_then(|v| v.as_str()) {
            if !enc.is_empty() {
                // customKeyEnc was written via Electron's safeStorage.encryptString directly
                // (same Chromium os_crypt scheme as the account "safe:" cookies, just without
                // the tag prefix) -- reuse the same Local-State-backed reader, not raw DPAPI.
                legacy = crypto::decrypt_electron_safe_storage(enc, &local_state_path());
            }
        }
        if legacy.is_none() {
            if let Some(k) = s.get("customKey").and_then(|v| v.as_str()) {
                if !k.trim().is_empty() {
                    legacy = Some(k.trim().to_string());
                }
            }
        }
        if let Some(pass) = legacy {
            let mut rest = s.clone();
            rest.remove("customKey");
            rest.remove("customKeyEnc");
            rest.insert("keyVerifier".into(), Value::String(make_verifier(&pass)));
            if crate::settings::try_save_settings(&rest).is_ok() {
                *state.session_pass.lock().unwrap() = Some(pass);
            }
        }
    }
}

pub fn set_key(state: &AppState, pass: Option<String>) -> Result<(), String> {
    let _guard = crate::persistence::data_guard().map_err(|error| error.to_string())?;
    if passphrase_mode() && state.session_pass.lock().unwrap().is_none() {
        return Err("Unlock the app with the current password before changing its encryption".into());
    }
    let settings = crate::settings::try_load_settings().map_err(|error| error.to_string())?;
    let accounts = crate::jsonfile::read_array_checked(&crate::paths::accounts_path()).map_err(|error| error.to_string())?;
    let history = crate::jsonfile::read_array_checked(&crate::paths::genhistory_path()).map_err(|error| error.to_string())?;
    let plan = crate::key_change::prepare(&settings, &accounts, &history, pass.as_deref().unwrap_or_default(), |ciphertext| decrypt_field(state, ciphertext))?;
    plan.commit(&crate::paths::app_data_dir())?;
    // The durable commit is complete. Only now expose the new session/key.
    *state.session_pass.lock().unwrap() = plan.pass;
    *state.cached_key.lock().unwrap() = Some(plan.key);
    *state.cached_legacy_key.lock().unwrap() = None;
    Ok(())
}
