/**
 * Internal error helpers for the CSV adapter. Every failure says what happened and how to fix it
 * (UI-07); counts are formatted without Intl so messages read the same on every machine.
 */
import { EngineError, type JsonValue } from '@tw/model';

/** 1234567 -> '1,234,567'. */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** '1 field' / '3 fields'. */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : pluralForm}`;
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

/** The same message and fix as EngineError.from() gives an AbortError, so every cancel reads alike. */
export function cancelled(): EngineError {
  return new EngineError('CANCELLED', 'The operation was cancelled.', 'Start the operation again when you are ready.');
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}
