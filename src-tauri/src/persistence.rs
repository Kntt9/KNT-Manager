//! One lock for the full read/modify/write cycle, including native and backup
//! paths. Reentrant only on the owning thread; no guard may cross an await.
use std::{
    cell::Cell,
    io,
    sync::{Mutex, MutexGuard},
};

static DATA_LOCK: Mutex<()> = Mutex::new(());
thread_local! { static DEPTH: Cell<usize> = const { Cell::new(0) }; }

pub struct Guard {
    _lock: Option<MutexGuard<'static, ()>>,
}
impl Drop for Guard {
    fn drop(&mut self) {
        DEPTH.with(|depth| depth.set(depth.get() - 1));
    }
}

pub fn data_guard() -> io::Result<Guard> {
    let nested = DEPTH.with(|depth| depth.get() != 0);
    let lock = if nested {
        None
    } else {
        Some(DATA_LOCK.lock().map_err(|_| {
            io::Error::other("Storage worker stopped unexpectedly. Restart the app before saving.")
        })?)
    };
    DEPTH.with(|depth| depth.set(depth.get() + 1));
    let guard = Guard { _lock: lock };
    if !nested {
        crate::file_transaction::recover(&crate::paths::app_data_dir())?;
    }
    Ok(guard)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_calls_and_concurrent_read_modify_write_are_serialized() {
        let counter = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let counter = counter.clone();
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        let _outer = data_guard().unwrap();
                        let _inner = data_guard().unwrap();
                        let value = counter.load(std::sync::atomic::Ordering::Relaxed);
                        std::thread::yield_now();
                        counter.store(value + 1, std::sync::atomic::Ordering::Relaxed);
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(counter.load(std::sync::atomic::Ordering::Relaxed), 160);
    }
}
