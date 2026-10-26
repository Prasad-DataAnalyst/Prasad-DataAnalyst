/**
 * Internal error helpers for the GeoJSON adapter. Every failure says what happened and how to fix
 * it (UI-07); counts are formatted without Intl so messages read the same on every machine.
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
  'Open the file in a text editor or GIS tool, correct the JSON (or export the layer again as GeoJSON), ' +
  'then import the new copy.';

/** The bytes are not well-formed JSON. */
export function brokenJson(message: string, detail?: JsonValue): EngineError {
  return new EngineError('PARSE_FAILED', `The GeoJSON file is not valid JSON: ${message}`, BROKEN_JSON_FIX, detail);
}

const NOT_GEOJSON_FIX =
  'Import a GeoJSON FeatureCollection, a single Feature or a single Geometry object. Other JSON files can be ' +
  'converted to GeoJSON in a GIS tool first.';

/** Well-formed JSON that is not a GeoJSON object this adapter reads. */
export function notGeoJson(message: string, detail?: JsonValue): EngineError {
  return new EngineError('FORMAT_UNSUPPORTED', message, NOT_GEOJSON_FIX, detail);
}

/** The same message and fix as EngineError.from() gives an AbortError, so every cancel reads alike. */
export function cancelled(): EngineError {
  return new EngineError('CANCELLED', 'The operation was cancelled.', 'Start the operation again when you are ready.');
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}
