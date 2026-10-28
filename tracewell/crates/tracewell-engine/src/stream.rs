//! Query results read batch by batch, as they are consumed. DuckDB's materialized results would
//! hold a whole scan in the engine's own memory, outside the limit DuckDB keeps to; streamed, a
//! scan of any size needs only the batch in hand.

use crate::error::{EngineError, Result};
use duckdb::Connection;
use duckdb::arrow::record_batch::RecordBatch;
use std::panic::{AssertUnwindSafe, catch_unwind};

/// Runs `sql` and hands each result batch to `f` in order. The driver reports a failure after
/// the first batch by panicking; that is caught here and returned as an error, so a failed scan
/// ends its job instead of leaving it running.
pub fn each_batch(
    conn: &Connection,
    sql: &str,
    mut f: impl FnMut(RecordBatch) -> Result<()>,
) -> Result<()> {
    let mut stmt = conn.prepare(sql)?;
    let stream = stmt.stream_arrow([])?;
    let outcome = catch_unwind(AssertUnwindSafe(move || -> Result<()> {
        for batch in stream {
            f(batch)?;
        }
        Ok(())
    }));
    match outcome {
        Ok(result) => result,
        Err(panic) => {
            let why = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "the query stopped".into());
            Err(EngineError::internal(format!(
                "Reading a query result failed: {why}"
            )))
        }
    }
}
