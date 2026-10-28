use std::sync::{Arc, Mutex};

/// Keep account file I/O and password-based encryption off the IPC/event loop.
/// The lock covers the entire read/modify/write operation, inside the worker:
/// making commands async must not introduce lost updates between those commands.
pub async fn run<T, F>(lock: Arc<Mutex<()>>, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| {
            "Account worker lock was poisoned; restart the application before retrying.".to_string()
        })?;
        operation()
    })
    .await
    .map_err(|error| format!("Account worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test(flavor = "current_thread")]
    async fn executes_blocking_work_outside_the_calling_thread() {
        let caller = std::thread::current().id();
        let worker = run(Arc::new(Mutex::new(())), || Ok(std::thread::current().id()))
            .await
            .unwrap();
        assert_ne!(worker, caller);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn serializes_entire_read_modify_write_operations() {
        let lock = Arc::new(Mutex::new(()));
        let persisted = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let mut jobs = Vec::new();
        for _ in 0..8 {
            let (lock, persisted, active) = (lock.clone(), persisted.clone(), active.clone());
            jobs.push(tokio::spawn(run(lock, move || {
                assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                let before = persisted.load(Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(5));
                persisted.store(before + 1, Ordering::SeqCst);
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            })));
        }
        for job in jobs {
            job.await.unwrap().unwrap();
        }
        assert_eq!(persisted.load(Ordering::SeqCst), 8);
    }

    #[tokio::test]
    async fn preserves_storage_errors() {
        let result = run::<(), _>(Arc::new(Mutex::new(())), || {
            Err("accounts.json: Access is denied (os error 5)".to_string())
        })
        .await;
        assert_eq!(
            result.unwrap_err(),
            "accounts.json: Access is denied (os error 5)"
        );
    }

    #[tokio::test]
    async fn reports_worker_panics_and_refuses_a_poisoned_lock() {
        let lock = Arc::new(Mutex::new(()));
        let result = run::<(), _>(lock.clone(), || panic!("simulated worker failure")).await;
        assert!(result.unwrap_err().starts_with("Account worker failed:"));
        let result = run(lock, || Ok(())).await;
        assert!(result.unwrap_err().contains("poisoned"));
    }
}
