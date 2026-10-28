/**
 * Internal error helpers for the JSON adapter. Every failure says what happened and how to fix it
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

const BROKEN_JSON_FIX =
  'Open the file in a text editor, correct the JSON (or export it again from the system that wrote it), ' +
  'then import the new copy.';

/** The bytes are not well-formed JSON. */
export function brokenJson(message: string, detail?: JsonValue): EngineError {
  return new EngineError('PARSE_FAILED', `The JSON file is not valid JSON: ${message}`, BROKEN_JSON_FIX, detail);
}

const NOT_RECORDS_FIX =
  'Import an array of objects, one object per line (JSON Lines), or an object whose member holds an array of ' +
  'objects. Each object becomes a row and each of its keys a column.';

/** Well-formed JSON that holds no records this adapter reads. */
export function notRecords(message: string, detail?: JsonValue): EngineError {
  return new EngineError('FORMAT_UNSUPPORTED', message, NOT_RECORDS_FIX, detail);
}

/** The same message and fix as EngineError.from() gives an AbortError, so every cancel reads alike. */
export function cancelled(): EngineError {
  return new EngineError('CANCELLED', 'The operation was cancelled.', 'Start the operation again when you are ready.');
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}
