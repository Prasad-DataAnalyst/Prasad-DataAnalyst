//! Engine errors as the protocol carries them: a code, what happened, and how to fix it (UI-07).

use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct EngineError {
    pub code: &'static str,
    pub message: String,
    pub fix: String,
}

impl EngineError {
    pub fn new(code: &'static str, message: impl Into<String>, fix: impl Into<String>) -> Self {
        EngineError {
            code,
            message: message.into(),
            fix: fix.into(),
        }
    }

    pub fn invalid(message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self::new("INVALID_INPUT", message, fix)
    }

    pub fn not_found(message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self::new("NOT_FOUND", message, fix)
    }

    /// A protocol method or input this engine does not handle yet; the TypeScript engine does.
    pub fn unsupported(what: impl Into<String>) -> Self {
        Self::new(
            "PROTOCOL_MISMATCH",
            format!("The native engine does not support {} yet.", what.into()),
            "Use the Lite engine for this operation until the native engine reaches parity (see docs/benchmarks.md).",
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(
            "INTERNAL",
            message,
            "Try the operation again. If it fails again, save the project and report the steps that led to this error.",
        )
    }

    pub fn to_json(&self) -> Value {
        json!({ "code": self.code, "message": self.message, "fix": self.fix })
    }
}

impl From<duckdb::Error> for EngineError {
    fn from(e: duckdb::Error) -> Self {
        EngineError::internal(format!("The data engine reported: {e}"))
    }
}

impl From<std::io::Error> for EngineError {
    fn from(e: std::io::Error) -> Self {
        EngineError::new(
            "NOT_FOUND",
            format!("A file could not be read or written: {e}"),
            "Check that the file exists and can be read.",
        )
    }
}

pub type Result<T> = std::result::Result<T, EngineError>;
