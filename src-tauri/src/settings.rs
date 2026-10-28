use crate::paths::settings_path;
use serde_json::{Map, Value};

// Encryption metadata is never reset after an unreadable settings file.
// Rekey now commits metadata and ciphertext together through a journal.
pub fn load_settings() -> Map<String, Value> {
    try_load_settings().expect("Settings could not be read; original files were preserved")
}

pub fn try_load_settings() -> std::io::Result<Map<String, Value>> {
    let _guard = crate::persistence::data_guard()?;
    crate::jsonfile::read_object_checked(&settings_path())
}

pub fn try_save_settings(s: &Map<String, Value>) -> std::io::Result<()> {
    let _guard = crate::persistence::data_guard()?;
    crate::jsonfile::read_object_checked(&settings_path())?;
    let json = serde_json::to_string_pretty(s)?;
    crate::jsonfile::write_atomic(&settings_path(), &json)
}

pub fn get_str(s: &Map<String, Value>, key: &str) -> Option<String> {
    s.get(key).and_then(|v| v.as_str()).map(|v| v.to_string())
}
