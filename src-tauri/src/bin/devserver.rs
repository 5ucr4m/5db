//! Development bridge: exposes the exact same RPC surface over HTTP so the UI
//! can be exercised in a regular browser (`pnpm dev:web`). Never shipped.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use fivedb_lib::rpc::{dispatch, AppState};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;

#[derive(Deserialize)]
struct Req {
    method: String,
    #[serde(default)]
    params: Value,
}

async fn handle(State(state): State<Arc<AppState>>, Json(req): Json<Req>) -> Json<Value> {
    match dispatch(&state, &req.method, req.params).await {
        Ok(data) => Json(json!({ "ok": true, "data": data })),
        Err(err) => Json(json!({ "ok": false, "error": err })),
    }
}

#[tokio::main]
async fn main() {
    let dir = std::env::var("FIVEDB_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("5db-dev"));
    let state = Arc::new(AppState::new(dir.clone()).expect("open store"));
    let app = Router::new().route("/rpc", post(handle).get(|| async { "5db dev bridge" })).layer(CorsLayer::permissive()).with_state(state);
    let addr = std::env::var("FIVEDB_DEV_ADDR").unwrap_or_else(|_| "127.0.0.1:1430".into());
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    println!("5db dev bridge on http://{addr} (data: {})", dir.display());
    axum::serve(listener, app).await.expect("serve");
}
