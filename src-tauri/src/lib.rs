pub mod error;
pub mod pg;
pub mod rds;
pub mod rpc;
pub mod ssh;
pub mod store;

use std::sync::Arc;

use serde_json::Value;
use tauri::Manager;

use crate::error::AppError;
use crate::rpc::AppState;

#[tauri::command]
async fn rpc(state: tauri::State<'_, Arc<AppState>>, method: String, params: Value) -> Result<Value, AppError> {
    rpc::dispatch(&state, &method, params).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Reopens the window where it was left, at the size it was left.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let state = AppState::new(dir).map_err(|e| e.message)?;
            app.manage(Arc::new(state));
            // Debug builds only: run a script inside the real webview so the IPC
            // bridge can be smoke-tested end to end (see scripts/native-smoke.sh).
            #[cfg(debug_assertions)]
            if let Ok(script) = std::env::var("FIVEDB_SMOKE_JS") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.eval(&script);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
