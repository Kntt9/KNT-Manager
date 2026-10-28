//! Recoverable changes to related JSON files. The journal contains only their
//! on-disk representations, never the decrypted migration records or passwords.
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, io, path::Path};

const JOURNAL: &str = "storage-transaction.json";
const ALLOWED: &[&str] = &[
    "settings.json",
    "accounts.json",
    "genhistory.json",
    "packages.json",
];

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    committed: bool,
    entries: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    file: String,
    before: Option<String>,
    after: String,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn validate_json(file: &str, text: &str) -> io::Result<()> {
    let value: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))?;
    if (file == "settings.json" && value.is_object())
        || (file != "settings.json" && value.is_array())
    {
        Ok(())
    } else {
        Err(invalid(format!(
            "Invalid JSON structure in {file}; original data was preserved"
        )))
    }
}

fn validate(journal: &Journal) -> io::Result<()> {
    if journal.version != 1 || journal.entries.is_empty() || journal.entries.len() > ALLOWED.len() {
        return Err(invalid(
            "Invalid storage transaction; keep the recovery file and restart",
        ));
    }
    let mut seen = HashSet::new();
    for entry in &journal.entries {
        if !ALLOWED.contains(&entry.file.as_str()) || !seen.insert(&entry.file) {
            return Err(invalid("Invalid or duplicate file in storage transaction"));
        }
        validate_json(&entry.file, &entry.after)?;
        if let Some(before) = &entry.before {
            validate_json(&entry.file, before)?;
        }
    }
    Ok(())
}

fn write_journal(root: &Path, journal: &Journal) -> io::Result<()> {
    let text = serde_json::to_string(journal)?;
    crate::jsonfile::write_atomic(&root.join(JOURNAL), &text)
}

fn apply(root: &Path, journal: &Journal, after: bool) -> io::Result<()> {
    for entry in journal.entries.iter().rev() {
        let path = root.join(&entry.file);
        let contents = if after {
            Some(&entry.after)
        } else {
            entry.before.as_ref()
        };
        if let Some(contents) = contents {
            crate::jsonfile::write_atomic(&path, contents)?;
        } else {
            match std::fs::remove_file(&path) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

/// Must run under the data lock, before any application reads. A pending
/// transaction restores the previous complete set; a committed one completes
/// the new set. A malformed/unrecoverable journal stops access, never resets it.
pub fn recover(root: &Path) -> io::Result<()> {
    let path = root.join(JOURNAL);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let journal: Journal = serde_json::from_str(&text)?;
    validate(&journal)?;
    apply(root, &journal, journal.committed)?;
    std::fs::remove_file(path)
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Step {
    Prepared,
    Replaced(usize),
    Committed,
}

/// The caller holds the data lock over preparation, commit and cache publication.
pub fn commit(root: &Path, files: Vec<(&str, String)>) -> io::Result<()> {
    commit_with_hook(root, files, |_| Ok(()))
}

fn commit_with_hook(
    root: &Path,
    files: Vec<(&str, String)>,
    mut hook: impl FnMut(Step) -> io::Result<()>,
) -> io::Result<()> {
    recover(root)?;
    let mut journal = Journal {
        version: 1,
        committed: false,
        entries: Vec::new(),
    };
    for (file, after) in files {
        if !ALLOWED.contains(&file) {
            return Err(invalid("Invalid transaction destination"));
        }
        let before = match std::fs::read_to_string(root.join(file)) {
            Ok(text) => Some(text),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        journal.entries.push(Entry {
            file: file.into(),
            before,
            after,
        });
    }
    validate(&journal)?;
    write_journal(root, &journal)?;
    let result = (|| {
        hook(Step::Prepared)?;
        for (index, entry) in journal.entries.iter().enumerate() {
            crate::jsonfile::write_atomic(&root.join(&entry.file), &entry.after)?;
            hook(Step::Replaced(index))?;
        }
        journal.committed = true;
        write_journal(root, &journal)
    })();
    if let Err(error) = result {
        // The durable journal remains pending unless its final atomic replace
        // succeeded. Recover based on that file, never the in-memory phase.
        if let Err(recovery) = recover(root) {
            return Err(io::Error::other(format!("Save failed ({error}); recovery also failed ({recovery}). Keep storage-transaction.json and restart; do not edit the data files.")));
        }
        return Err(error);
    }
    hook(Step::Committed)?;
    // If cleanup is temporarily denied, the committed journal is replayed
    // before the next read/write. The data is already complete and usable.
    let _ = std::fs::remove_file(root.join(JOURNAL));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scratch() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("knt-txn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    fn seed(root: &Path) {
        std::fs::write(root.join("settings.json"), r#"{"keyVerifier":"old"}"#).unwrap();
        std::fs::write(
            root.join("accounts.json"),
            r#"[{"cookie":"old-ciphertext"}]"#,
        )
        .unwrap();
    }
    fn changes() -> Vec<(&'static str, String)> {
        vec![
            ("settings.json", r#"{"keyVerifier":"new"}"#.into()),
            ("accounts.json", r#"[{"cookie":"new-ciphertext"}]"#.into()),
            ("genhistory.json", "[]".into()),
        ]
    }
    fn assert_old(root: &Path) {
        assert!(std::fs::read_to_string(root.join("settings.json"))
            .unwrap()
            .contains("old"));
        assert!(std::fs::read_to_string(root.join("accounts.json"))
            .unwrap()
            .contains("old-ciphertext"));
        assert!(!root.join("genhistory.json").exists());
        assert!(!root.join(JOURNAL).exists());
    }
    #[test]
    fn commits_all_related_files() {
        let root = scratch();
        seed(&root);
        commit(&root, changes()).unwrap();
        assert!(std::fs::read_to_string(root.join("settings.json"))
            .unwrap()
            .contains("new"));
        assert!(std::fs::read_to_string(root.join("accounts.json"))
            .unwrap()
            .contains("new-ciphertext"));
        assert_eq!(
            std::fs::read_to_string(root.join("genhistory.json")).unwrap(),
            "[]"
        );
        assert!(!root.join(JOURNAL).exists());
    }
    #[test]
    fn write_errors_at_each_pending_step_restore_the_entire_old_set() {
        for fail in [
            Step::Prepared,
            Step::Replaced(0),
            Step::Replaced(1),
            Step::Replaced(2),
        ] {
            let root = scratch();
            seed(&root);
            let error = commit_with_hook(&root, changes(), |step| {
                if step == fail {
                    Err(io::Error::other("injected disk failure"))
                } else {
                    Ok(())
                }
            });
            assert!(error.is_err());
            assert_old(&root);
        }
    }
    #[test]
    fn restart_after_interruption_at_every_stage_recovers_a_complete_set() {
        for stop in [
            Step::Prepared,
            Step::Replaced(0),
            Step::Replaced(1),
            Step::Replaced(2),
            Step::Committed,
        ] {
            let root = scratch();
            seed(&root);
            let interrupted = std::panic::catch_unwind(|| {
                commit_with_hook(&root, changes(), |step| {
                    if step == stop {
                        panic!("simulated process interruption");
                    }
                    Ok(())
                })
            });
            assert!(interrupted.is_err());
            assert!(root.join(JOURNAL).exists());
            recover(&root).unwrap();
            recover(&root).unwrap();
            if stop == Step::Committed {
                assert!(std::fs::read_to_string(root.join("settings.json"))
                    .unwrap()
                    .contains("new"));
                assert!(std::fs::read_to_string(root.join("accounts.json"))
                    .unwrap()
                    .contains("new-ciphertext"));
            } else {
                assert_old(&root);
            }
        }
    }
    #[test]
    fn invalid_originals_or_new_data_are_never_replaced() {
        let root = scratch();
        seed(&root);
        std::fs::write(root.join("accounts.json"), "truncated").unwrap();
        assert!(commit(&root, changes()).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("accounts.json")).unwrap(),
            "truncated"
        );
        assert!(commit(&root, vec![("../outside.json", "[]".into())]).is_err());
        assert!(commit(&root, vec![("settings.json", "[]".into())]).is_err());
        assert!(!root.join(JOURNAL).exists());
    }
    #[test]
    fn malformed_journal_is_kept_and_stops_recovery() {
        let root = scratch();
        seed(&root);
        std::fs::write(root.join(JOURNAL), r#"{"version":1,"committed":false,"entries":[{"file":"../outside.json","before":null,"after":"[]"}]}"#).unwrap();
        assert!(recover(&root).is_err());
        assert!(root.join(JOURNAL).exists());
        assert!(commit(&root, changes()).is_err());
        assert!(std::fs::read_to_string(root.join("settings.json"))
            .unwrap()
            .contains("old"));
    }

    #[test]
    fn failed_rollback_keeps_the_journal_until_the_blocked_destination_can_be_recovered() {
        let root = scratch();
        seed(&root);
        let result = commit_with_hook(&root, changes(), |step| {
            if step == Step::Replaced(0) {
                std::fs::remove_file(root.join("accounts.json"))?;
                std::fs::create_dir(root.join("accounts.json"))?;
                return Err(io::Error::other("injected destination failure"));
            }
            Ok(())
        });
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("recovery also failed"));
        assert!(root.join(JOURNAL).exists());
        assert!(commit(&root, changes()).is_err());
        std::fs::remove_dir(root.join("accounts.json")).unwrap();
        recover(&root).unwrap();
        assert_old(&root);
    }
}
