/**
 * Internal error helpers for the XLSX adapter. Every failure says what happened and how to fix it
 * (UI-07); counts are formatted without Intl so messages read the same on every machine.
 */
import { EngineError, type JsonValue } from '@tw/model';

/** 1234567 -> '1,234,567'. */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A caller passed an argument that no correct program passes; the fix points at the code. */
export function invalidArgument(message: string, detail?: JsonValue): EngineError {
  return new EngineError(
    'INVALID_INPUT',
    message,
    'Correct the value passed to the function; this is a defect in the calling code, not in the data.',
    detail,
  );
}

const DAMAGED_FIX =
  'Open the file in Excel or LibreOffice and save it again as an Excel workbook (.xlsx), then import the new copy.';

/** The workbook's content cannot be read: broken XML, a missing part or an impossible value. */
export function damagedWorkbook(message: string, detail?: JsonValue): EngineError {
  return new EngineError('PARSE_FAILED', `The workbook cannot be read: ${message}`, DAMAGED_FIX, detail);
}

export function notAWorkbook(message: string, fix: string, detail?: JsonValue): EngineError {
  return new EngineError('FORMAT_UNSUPPORTED', message, fix, detail);
}

/** The same message and fix as EngineError.from() gives an AbortError, so every cancel reads alike. */
export function cancelled(): EngineError {
  return new EngineError('CANCELLED', 'The operation was cancelled.', 'Start the operation again when you are ready.');
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}
