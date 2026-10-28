//! Field transformations shared by account storage and key migration.
use serde_json::{Map, Value};
const FIELDS: [&str; 2] = ["cookie", "password"];
const UNREADABLE: &str = "_unreadableFields";

/// UI can show a failed field as unavailable without destroying its ciphertext
/// when an unrelated label, last-used timestamp or trash state is saved.
pub fn decrypt_for_display(
    mut record: Value,
    mut decrypt: impl FnMut(&str) -> Option<String>,
) -> Value {
    let mut preserved = Map::new();
    for field in FIELDS {
        if let Some(text) = record
            .get(field)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            match decrypt(text) {
                Some(plain) => record[field] = Value::String(plain),
                None => {
                    preserved.insert(field.into(), Value::String(text.into()));
                    record[field] = Value::String(String::new());
                    if field == "cookie" {
                        record["_cookieInvalid"] = Value::Bool(true);
                    }
                }
            }
        }
    }
    if !preserved.is_empty() {
        record[UNREADABLE] = Value::Object(preserved);
    }
    record
}

pub fn restore_unreadable(mut record: Value) -> Value {
    let preserved = record
        .as_object_mut()
        .and_then(|object| object.remove(UNREADABLE));
    if let Some(Value::Object(fields)) = preserved {
        for field in FIELDS {
            if record
                .get(field)
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                if let Some(Value::String(ciphertext)) = fields.get(field) {
                    record[field] = Value::String(ciphertext.clone());
                }
            }
        }
    }
    record
}

/// Rekey and portable backups require every sensitive field, including passwords
/// and trashed/history entries. Any failure aborts before any write is prepared.
pub fn decrypt_strict(
    records: &[Value],
    mut decrypt: impl FnMut(&str) -> Option<String>,
) -> Result<Vec<Value>, String> {
    let mut result = Vec::with_capacity(records.len());
    for (index, original) in records.iter().enumerate() {
        if !original.is_object() || original.get(UNREADABLE).is_some() {
            return Err(format!(
                "Record {} is unreadable; no data was changed",
                index + 1
            ));
        }
        let mut record = original.clone();
        for field in FIELDS {
            match original.get(field) {
                Some(Value::String(text)) if !text.is_empty() => {
                    record[field] = Value::String(decrypt(text).ok_or_else(|| {
                        format!(
                            "Could not decrypt {field} in record {}; no data was changed",
                            index + 1
                        )
                    })?);
                }
                None | Some(Value::Null) | Some(Value::String(_)) => (),
                _ => {
                    return Err(format!(
                        "Invalid {field} in record {}; no data was changed",
                        index + 1
                    ))
                }
            }
        }
        result.push(record);
    }
    Ok(result)
}

pub fn encrypt_verified(
    records: &[Value],
    mut encrypt: impl FnMut(&str) -> Result<String, String>,
    mut verify: impl FnMut(&str) -> Option<String>,
) -> Result<Vec<Value>, String> {
    let mut result = Vec::with_capacity(records.len());
    for original in records {
        let mut record = original.clone();
        for field in FIELDS {
            if let Some(text) = original
                .get(field)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                let ciphertext = encrypt(text)?;
                if verify(&ciphertext).as_deref() != Some(text) {
                    return Err(format!(
                        "Verification of the new encrypted {field} failed; no data was changed"
                    ));
                }
                record[field] = Value::String(ciphertext);
            }
        }
        result.push(record);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn saving_other_fields_preserves_failed_cookie_and_password_exactly() {
        let original = json!({"id":"a", "cookie":"gs:broken-cookie", "password":"cbc:broken-password", "trashed":true});
        let mut display = decrypt_for_display(original.clone(), |_| None);
        assert_eq!(display["cookie"], "");
        assert_eq!(display["password"], "");
        display["label"] = json!("new label");
        let saved = restore_unreadable(display);
        assert_eq!(saved["cookie"], original["cookie"]);
        assert_eq!(saved["password"], original["password"]);
        assert_eq!(saved["label"], "new label");
        assert!(saved.get(UNREADABLE).is_none());
    }
    #[test]
    fn explicit_replacement_wins_over_preserved_failed_field() {
        let mut display = decrypt_for_display(
            json!({"cookie":"gs:broken", "password":"cbc:broken"}),
            |_| None,
        );
        display["cookie"] = json!("new-cookie");
        let saved = restore_unreadable(display);
        assert_eq!(saved["cookie"], "new-cookie");
        assert_eq!(saved["password"], "cbc:broken");
    }
    #[test]
    fn rekey_refuses_password_failure_even_if_cookie_is_valid() {
        let records = vec![json!({"cookie":"good", "password":"broken", "trashed":true})];
        assert!(
            decrypt_strict(&records, |text| (text == "good").then(|| "cookie".into())).is_err()
        );
        assert!(decrypt_strict(&[json!({"cookie":42})], |_| Some("bad".into())).is_err());
    }
    #[test]
    fn all_sensitive_fields_round_trip_with_real_crypto_and_keep_metadata() {
        let old_key = crate::crypto::derive_scrypt_key("old-password", "old-salt");
        let new_key = crate::crypto::derive_scrypt_key("new-password", "new-salt");
        let original = vec![
            json!({"id":"a","trashed":true,"cookie":crate::crypto::encrypt_gcm("secret-cookie", &old_key, "gs"), "password":crate::crypto::encrypt_gcm("secret-password", &old_key, "gs")}),
        ];
        let plain = decrypt_strict(&original, |ct| {
            crate::crypto::decrypt_gcm(ct, &old_key, "gs")
        })
        .unwrap();
        let encrypted = encrypt_verified(
            &plain,
            |text| Ok(crate::crypto::encrypt_gcm(text, &new_key, "gs")),
            |ct| crate::crypto::decrypt_gcm(ct, &new_key, "gs"),
        )
        .unwrap();
        assert_eq!(
            decrypt_strict(&encrypted, |ct| crate::crypto::decrypt_gcm(
                ct, &new_key, "gs"
            ))
            .unwrap(),
            plain
        );
        assert!(crate::crypto::decrypt_gcm(
            encrypted[0]["cookie"].as_str().unwrap(),
            &old_key,
            "gs"
        )
        .is_none());
        assert_eq!(encrypted[0]["id"], "a");
        assert_eq!(encrypted[0]["trashed"], true);
        assert!(!serde_json::to_string(&encrypted)
            .unwrap()
            .contains("secret-cookie"));
    }
    #[test]
    fn failed_new_key_verification_returns_no_replacement_records() {
        let records = vec![json!({"cookie":"secret", "password":"password"})];
        assert!(encrypt_verified(&records, |_| Ok("ciphertext".into()), |_| None).is_err());
        assert_eq!(records[0]["cookie"], "secret");
    }
}
