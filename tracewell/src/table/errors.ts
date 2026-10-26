/** Internal error helpers for the table module. Every failure says what happened and how to fix it. */
import { EngineError, type JsonValue } from '@tw/model';

const CALLER_FIX = 'Correct the value passed to the function; this is a defect in the calling code, not in the data.';

/** A caller passed an argument that no correct program passes. */
export function invalidArgument(message: string, detail?: JsonValue): EngineError {
  return new EngineError('INVALID_INPUT', message, CALLER_FIX, detail);
}

/** A column or row the caller named does not exist. */
export function notFound(message: string, detail?: JsonValue): EngineError {
  return new EngineError('NOT_FOUND', message, 'Refer only to columns and rows that exist in the dataset.', detail);
}

/** A method was called on an object that is already finished. */
export function misuse(message: string): EngineError {
  return new EngineError(
    'INTERNAL',
    message,
    'Create a new builder for each table; a finished builder cannot be reused.',
  );
}

/** 1234567 -> '1,234,567', without Intl so messages are the same on every machine. */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
