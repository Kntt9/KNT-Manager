//! Prepare and verify the entire new encrypted dataset without changing disk or
//! the live session. Publication happens only after the recoverable commit.
use crate::{crypto, record_crypto};
use rand::RngCore;
use serde_json::{Map, Value};

pub const VERIFY_TOKEN: &str = "multiroblox-verify-v1";
pub struct Prepared {
    pub settings: Map<String, Value>,
    pub accounts: Vec<Value>,
    pub history: Vec<Value>,
    pub key: [u8; 32],
    pub pass: Option<String>,
}

pub fn prepare(
    settings: &Map<String, Value>,
    accounts: &[Value],
    history: &[Value],
    pass: &str,
    mut decrypt_old: impl FnMut(&str) -> Option<String>,
) -> Result<Prepared, String> {
    let accounts = record_crypto::decrypt_strict(accounts, &mut decrypt_old)?;
    let history = record_crypto::decrypt_strict(history, &mut decrypt_old)?;
    let pass = pass.trim();
    let mut settings = settings.clone();
    for field in [
        "customKey",
        "customKeyEnc",
        "keyVerifier",
        "kdfSalt",
        "_deviceKey",
    ] {
        settings.remove(field);
    }
    settings.insert("encSetupDone".into(), Value::Bool(true));
    let mut random = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut random);
    let key = if pass.is_empty() {
        settings.insert("_deviceKey".into(), Value::String(hex::encode(random)));
        random
    } else {
        let salt = hex::encode(&random[..16]);
        let derived = crypto::derive_scrypt_key(pass, &salt);
        let verifier = crypto::encrypt_gcm(VERIFY_TOKEN, &derived, "gs");
        // Independently derive from the password and persisted metadata before
        // accepting the key; this also verifies the restart/unlock contract.
        if crypto::verified_scrypt_key(pass, &salt, &verifier, VERIFY_TOKEN) != Some(derived) {
            return Err("Could not verify the new password; no data was changed".into());
        }
        settings.insert("kdfSalt".into(), Value::String(salt));
        settings.insert("keyVerifier".into(), Value::String(verifier));
        derived
    };
    let encrypt = |text: &str| -> Result<String, String> {
        if pass.is_empty() {
            if let Some(ciphertext) = crypto::encrypt_safe2(text) {
                return Ok(ciphertext);
            }
        }
        Ok(crypto::encrypt_gcm(text, &key, "gs"))
    };
    let verify = |ciphertext: &str| {
        if ciphertext.starts_with("safe2:") {
            crypto::decrypt_safe2(ciphertext)
        } else {
            crypto::decrypt_gcm(ciphertext, &key, "gs")
        }
    };
    let mut accounts = record_crypto::encrypt_verified(&accounts, encrypt, verify)?;
    for account in &mut accounts {
        account["_enc"] = Value::Bool(true);
    }
    let history = record_crypto::encrypt_verified(&history, encrypt, verify)?;
    Ok(Prepared {
        settings,
        accounts,
        history,
        key,
        pass: (!pass.is_empty()).then(|| pass.into()),
    })
}

impl Prepared {
    pub fn commit(&self, root: &std::path::Path) -> Result<(), String> {
        crate::file_transaction::commit(
            root,
            vec![
                (
                    "accounts.json",
                    serde_json::to_string_pretty(&self.accounts)
                        .map_err(|error| error.to_string())?,
                ),
                (
                    "genhistory.json",
                    serde_json::to_string_pretty(&self.history)
                        .map_err(|error| error.to_string())?,
                ),
                (
                    "settings.json",
                    serde_json::to_string_pretty(&self.settings)
                        .map_err(|error| error.to_string())?,
                ),
            ],
        )
        .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn changing_password_preserves_accounts_passwords_trash_and_history_after_reload() {
        let root = std::env::temp_dir().join(format!("knt-rekey-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let old_key = crypto::derive_scrypt_key("old-password", "old-salt");
        let old_settings = json!({"keyVerifier":crypto::encrypt_gcm(VERIFY_TOKEN, &old_key, "gs"),"kdfSalt":"old-salt","language":"pt"});
        let accounts = vec![
            json!({"id":"a","cookie":crypto::encrypt_gcm("cookie", &old_key,"gs"),"password":crypto::encrypt_gcm("account-password", &old_key,"gs"),"trashed":true}),
        ];
        let history = vec![
            json!({"cookie":crypto::encrypt_gcm("history-cookie", &old_key,"gs"),"password":crypto::encrypt_gcm("history-password", &old_key,"gs")}),
        ];
        for (file, value) in [
            ("settings.json", old_settings.clone()),
            ("accounts.json", json!(accounts)),
            ("genhistory.json", json!(history)),
        ] {
            std::fs::write(root.join(file), serde_json::to_string(&value).unwrap()).unwrap();
        }
        let plan = prepare(
            old_settings.as_object().unwrap(),
            &accounts,
            &history,
            "new-password",
            |ct| crypto::decrypt_gcm(ct, &old_key, "gs"),
        )
        .unwrap();
        // Preparation alone never publishes metadata or changes any file.
        assert!(std::fs::read_to_string(root.join("settings.json"))
            .unwrap()
            .contains("old-salt"));
        plan.commit(&root).unwrap();
        let settings = crate::jsonfile::read_object_checked(&root.join("settings.json")).unwrap();
        let verifier = settings["keyVerifier"].as_str().unwrap();
        let salt = settings["kdfSalt"].as_str().unwrap();
        let new_key =
            crypto::verified_scrypt_key("new-password", salt, verifier, VERIFY_TOKEN).unwrap();
        assert!(
            crypto::verified_scrypt_key("old-password", salt, verifier, VERIFY_TOKEN).is_none()
        );
        assert_eq!(settings["language"], "pt");
        let accounts = crate::jsonfile::read_array_checked(&root.join("accounts.json")).unwrap();
        let plain =
            record_crypto::decrypt_strict(&accounts, |ct| crypto::decrypt_gcm(ct, &new_key, "gs"))
                .unwrap();
        assert_eq!(plain[0]["cookie"], "cookie");
        assert_eq!(plain[0]["password"], "account-password");
        assert_eq!(plain[0]["trashed"], true);
        let history = crate::jsonfile::read_array_checked(&root.join("genhistory.json")).unwrap();
        let plain =
            record_crypto::decrypt_strict(&history, |ct| crypto::decrypt_gcm(ct, &new_key, "gs"))
                .unwrap();
        assert_eq!(plain[0]["cookie"], "history-cookie");
        assert_eq!(plain[0]["password"], "history-password");
        assert!(!root.join("storage-transaction.json").exists());
    }
    #[test]
    fn disabling_password_verifies_device_protected_fields_and_removes_passphrase_metadata() {
        let settings =
            json!({"keyVerifier":"old","kdfSalt":"old-salt","customKey":"legacy","fpsCap":60});
        let records = vec![json!({"cookie":"cookie","password":"password"})];
        let plan = prepare(
            settings.as_object().unwrap(),
            &records,
            &records,
            "",
            |text| Some(text.into()),
        )
        .unwrap();
        assert!(plan.pass.is_none());
        for field in ["keyVerifier", "kdfSalt", "customKey", "customKeyEnc"] {
            assert!(plan.settings.get(field).is_none());
        }
        assert_eq!(plan.settings["fpsCap"], 60);
        let plain = record_crypto::decrypt_strict(&plan.accounts, |ct| {
            if ct.starts_with("safe2:") {
                crypto::decrypt_safe2(ct)
            } else {
                crypto::decrypt_gcm(ct, &plan.key, "gs")
            }
        })
        .unwrap();
        assert_eq!(plain[0]["cookie"], "cookie");
        assert_eq!(plain[0]["password"], "password");
    }
    #[test]
    fn unreadable_history_or_password_aborts_before_producing_a_new_key_plan() {
        let settings = json!({"keyVerifier":"old","kdfSalt":"old-salt"});
        let original = settings.clone();
        assert!(prepare(
            settings.as_object().unwrap(),
            &[json!({"cookie":"good","password":"bad"})],
            &[],
            "new-password",
            |ct| (ct == "good").then(|| "cookie".into())
        )
        .is_err());
        assert!(prepare(
            settings.as_object().unwrap(),
            &[],
            &[json!({"password":"bad"})],
            "new-password",
            |_| None
        )
        .is_err());
        assert_eq!(settings, original);
    }

    #[test]
    fn commit_io_failure_leaves_the_old_password_and_ciphertext_usable() {
        let root = std::env::temp_dir().join(format!("knt-rekey-failure-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let old_key = crypto::derive_scrypt_key("old-password", "old-salt");
        let settings = json!({"keyVerifier":crypto::encrypt_gcm(VERIFY_TOKEN,&old_key,"gs"),"kdfSalt":"old-salt"});
        let accounts = vec![json!({"cookie":crypto::encrypt_gcm("fake-cookie",&old_key,"gs")})];
        let settings_text = serde_json::to_string(&settings).unwrap();
        let accounts_text = serde_json::to_string(&accounts).unwrap();
        std::fs::write(root.join("settings.json"), &settings_text).unwrap();
        std::fs::write(root.join("accounts.json"), &accounts_text).unwrap();
        std::fs::create_dir(root.join("genhistory.json")).unwrap();
        let plan = prepare(
            settings.as_object().unwrap(),
            &accounts,
            &[],
            "new-password",
            |ct| crypto::decrypt_gcm(ct, &old_key, "gs"),
        )
        .unwrap();
        assert!(plan.commit(&root).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("settings.json")).unwrap(),
            settings_text
        );
        assert_eq!(
            std::fs::read_to_string(root.join("accounts.json")).unwrap(),
            accounts_text
        );
        assert!(crypto::verified_scrypt_key(
            "old-password",
            "old-salt",
            settings["keyVerifier"].as_str().unwrap(),
            VERIFY_TOKEN
        )
        .is_some());
        assert_eq!(
            crypto::decrypt_gcm(accounts[0]["cookie"].as_str().unwrap(), &old_key, "gs").as_deref(),
            Some("fake-cookie")
        );
    }
}
