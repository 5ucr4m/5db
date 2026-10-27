use serde::Serialize;

/// Error shape returned to the frontend. Postgres errors keep their
/// diagnostic fields so the editor can point at the failing position.
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// 1-based character offset into the submitted SQL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<u32>,
}

impl AppError {
    pub fn msg(message: impl Into<String>) -> Self {
        AppError {
            message: message.into(),
            ..Default::default()
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub type AppResult<T> = Result<T, AppError>;

impl From<tokio_postgres::Error> for AppError {
    fn from(e: tokio_postgres::Error) -> Self {
        if let Some(db) = e.as_db_error() {
            let position = match db.position() {
                Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p),
                _ => None,
            };
            return AppError {
                message: db.message().to_string(),
                code: Some(db.code().code().to_string()),
                detail: db.detail().map(str::to_string),
                hint: db.hint().map(str::to_string),
                position,
            };
        }
        // Walk the source chain: "error connecting to server" alone is useless.
        let mut message = e.to_string();
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            let text = s.to_string();
            if !message.contains(&text) {
                message = format!("{message}: {text}");
            }
            src = s.source();
        }
        AppError::msg(message)
    }
}

impl From<redis::RedisError> for AppError {
    fn from(e: redis::RedisError) -> Self {
        AppError {
            message: e.to_string(),
            code: e.code().map(str::to_string),
            ..Default::default()
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::msg(format!("local storage: {e}"))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::msg(format!("invalid request: {e}"))
    }
}

impl From<native_tls::Error> for AppError {
    fn from(e: native_tls::Error) -> Self {
        AppError::msg(format!("tls: {e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::msg(e.to_string())
    }
}
