/**
 * Null markers and below-detection-limit text. Both keep their raw text (SAD section 7.2); this
 * file only decides which texts they are.
 */
import { detection, type Detection, type RawField } from '@tw/model';
import { parseNumber } from './numbers';

/** Markers recognised by default, in the order the product spec lists them. */
export const DEFAULT_NULL_MARKERS: readonly string[] = Object.freeze([
  '',
  'NA',
  'N/A',
  '#N/A',
  'NULL',
  'null',
  '-',
  '-999.25',
  '-9999',
]);

/**
 * Numeric sentinels (the LAS null value and its common cousin) are also real numbers, so a single
 * occurrence is read as data; from this many occurrences on they are adopted as markers, assumed.
 */
const SENTINEL_MIN_COUNT = 2;
const SENTINELS: readonly number[] = [-999.25, -9999];

/** The default markers that are not numbers: matched on their exact (trimmed) text. */
export const TEXT_NULL_MARKERS: ReadonlySet<string> = new Set(
  DEFAULT_NULL_MARKERS.filter((m) => parseNumber(m, '.', '') === null),
);

/** A number written with either decimal separator, as sentinels appear in both kinds of file. */
function anyLocaleNumber(text: string): number | null {
  return parseNumber(text, '.', '') ?? parseNumber(text, ',', '');
}

function numericValue(raw: RawField, decimal: '.' | ','): number | null {
  if (typeof raw === 'number') return raw;
  return typeof raw === 'string' ? parseNumber(raw, decimal, '') : null;
}

/**
 * The marker in `markers` that `raw` stands for, or undefined. Text markers match the trimmed
 * text exactly; a marker that is a number also matches the same number written differently
 * ('-999.250', or a native -999.25 from a spreadsheet).
 */
export function matchNullMarker(raw: RawField, markers: readonly string[], decimal: '.' | ','): string | undefined {
  if (raw === null || typeof raw === 'boolean' || typeof raw === 'object') return undefined;
  const text = typeof raw === 'string' ? raw.trim() : undefined;
  if (text !== undefined && markers.includes(text)) return text;
  const value = numericValue(raw, decimal);
  if (value === null) return undefined;
  return markers.find((m) => m !== '' && parseNumber(m, '.', '') === value);
}

/** The default marker a raw field is a candidate for, before frequency is considered. */
function candidateMarker(raw: RawField): string | undefined {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (TEXT_NULL_MARKERS.has(text)) return text;
    const value = anyLocaleNumber(text);
    return value !== null && SENTINELS.includes(value) ? String(value) : undefined;
  }
  return typeof raw === 'number' && SENTINELS.includes(raw) ? String(raw) : undefined;
}

interface Tally {
  marker: string;
  count: number;
  first: number;
}

function tallyMarkers(values: RawField[]): Tally[] {
  const tallies = new Map<string, Tally>();
  values.forEach((raw, index) => {
    const marker = candidateMarker(raw);
    if (marker === undefined) return;
    const tally = tallies.get(marker) ?? { marker, count: 0, first: index };
    tally.count++;
    tallies.set(marker, tally);
  });
  // Most frequent first, then in order of first appearance, so the list reads as the data does.
  return [...tallies.values()].sort((a, b) => b.count - a.count || a.first - b.first);
}

function isSentinel(marker: string): boolean {
  return marker !== '' && SENTINELS.includes(Number(marker));
}

function describe(t: Tally): string {
  return `${t.marker === '' ? 'empty text' : `'${t.marker}'`} (${t.count}×)`;
}

/**
 * The null markers a column uses. Text markers are adopted on sight; numeric sentinels only when
 * they occur at least twice, and then the detection is assumed because they could be real values.
 */
export function detectNullMarkers(values: RawField[]): Detection<string[]> {
  const adopted = tallyMarkers(values).filter((t) => !isSentinel(t.marker) || t.count >= SENTINEL_MIN_COUNT);
  const markers = adopted.map((t) => t.marker);
  if (adopted.length === 0) return detection(markers, 'high', 'marker-list', 'No null markers found in the sample.');
  const sentinels = adopted.filter((t) => isSentinel(t.marker));
  const found = `Found ${adopted.map(describe).join(', ')} in the sample.`;
  if (sentinels.length === 0) return detection(markers, 'high', 'marker-list', found);
  const assumed = `${sentinels.map((t) => t.marker).join(' and ')} repeat and are assumed to mean "no value".`;
  return detection(markers, 'medium', 'sentinel-frequency', `${found} ${assumed}`);
}

/** Below-detection-limit text is defined in the model so the rules read it the same way. */
export { isBelowDetectionLimit } from '@tw/model';
