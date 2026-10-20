/**
 * Internal error helpers for the io module. Every failure says what happened and how to fix it
 * (UI-07); byte counts are formatted without Intl so messages are the same on every machine.
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

/** A method was called on an object that is already finished, such as a closed sink. */
export function misuse(message: string): EngineError {
  return new EngineError(
    'INTERNAL',
    message,
    'Create a new object for each piece of output; finished hashes and closed sinks cannot be reused.',
  );
}

/** The same message and fix as EngineError.from() gives an AbortError, so every cancel reads alike. */
export function cancelled(): EngineError {
  return new EngineError('CANCELLED', 'The operation was cancelled.', 'Start the operation again when you are ready.');
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelled();
}
