// The desktop interface owns its diagnostics; test builds need no console.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    mr_tauri_lib::run()
}
