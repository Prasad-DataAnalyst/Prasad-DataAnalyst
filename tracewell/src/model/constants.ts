/** Product-wide constants. Format limits are the destination's documented limits, not tuning knobs. */

export const APP_NAME = 'Tracewell';

/** Excel's 1,048,576 rows minus the header row; beyond it data is delivered as CSV (TW-EXP-002). */
export const EXCEL_MAX_DATA_ROWS = 1_048_575;

/** Excel's maximum characters in one cell; longer text moves the column to a CSV side file. */
export const EXCEL_MAX_CELL_CHARS = 32_767;

/** Sniffing reads at most 1 MiB, so the first preview is fast for any file size. */
export const PREVIEW_MAX_BYTES = 1_048_576;

/** Largest row window one protocol call returns. */
export const ROW_WINDOW_MAX = 1000;

/** Rows per batch; jobs yield and check for cancellation between batches. */
export const BATCH_ROWS = 65_536;

/** A reason needs at least this many non-space characters (SAD section 9.2). */
export const MIN_REASON_LENGTH = 3;

/** The genesis `prev` hash of a project's audit chain is SHA-256(AUDIT_GENESIS_PREFIX + projectId). */
export const AUDIT_GENESIS_PREFIX = 'tracewell-audit-v1:';
