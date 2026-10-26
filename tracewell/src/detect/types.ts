/**
 * Logical type inference from sample values (SAD section 7.2). Each value is classified on its
 * own, then the column takes the type every value fits (high confidence) or that at least 80 %
 * fit (medium, assumed: the rest keep their raw text and raise TW-DQ-004).
 */
import {
  detection,
  isDateCell,
  isDateTimeCell,
  type DateFormat,
  type Detection,
  type LogicalType,
  type RawField,
  type TimezoneMode,
} from '@tw/model';
import { dateParts, monthDay, type DateParts } from './dates';
import { isBelowDetectionLimit, TEXT_NULL_MARKERS } from './markers';
import { hasLeadingZero, isIntegerText, parseNumber } from './numbers';
import type { DetectOptions } from './options';

/** Share of sample values that must fit a type for it to be adopted as an assumption. */
export const MAJORITY_SHARE = 0.8;

export interface TypeInference {
  type: Detection<LogicalType>;
  dateFormat?: Detection<DateFormat>;
  timezone?: Detection<TimezoneMode>;
}

type Kind =
  | { k: 'skip' }
  | { k: 'fail' }
  | { k: 'int' }
  | { k: 'num' }
  | { k: 'identifier' }
  | { k: 'bool' }
  | { k: 'date-native' }
  | { k: 'datetime-native' }
  | { k: 'date-text'; parts: DateParts }
  | { k: 'json' }
  | { k: 'text' };

const BOOLEAN_WORDS: ReadonlySet<string> = new Set(['true', 'false', 'yes', 'no']);

/** Text that is a JSON object or array: nested GeoJSON properties arrive this way. */
function isJsonText(t: string): boolean {
  const object = t.startsWith('{') && t.endsWith('}');
  const array = t.startsWith('[') && t.endsWith(']');
  if (!object && !array) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function classifyNumberText(t: string, o: DetectOptions): Kind | null {
  const n = parseNumber(t, o.decimalSeparator, o.thousandsSeparator);
  if (n === null) return null;
  if (hasLeadingZero(t, o.decimalSeparator)) return { k: 'identifier' };
  if (!isIntegerText(t, o.decimalSeparator)) return { k: 'num' };
  // Digits beyond 2^53 cannot be stored exactly as numbers, so such columns are identifiers.
  return Number.isSafeInteger(n) ? { k: 'int' } : { k: 'identifier' };
}

function classifyText(raw: string, o: DetectOptions): Kind {
  const t = raw.trim();
  if (t === '' || TEXT_NULL_MARKERS.has(t) || isBelowDetectionLimit(t)) return { k: 'skip' };
  const numeric = classifyNumberText(t, o);
  if (numeric !== null) return numeric;
  if (BOOLEAN_WORDS.has(t.toLowerCase())) return { k: 'bool' };
  const parts = dateParts(t);
  if (parts !== null) return { k: 'date-text', parts };
  return isJsonText(t) ? { k: 'json' } : { k: 'text' };
}

function classify(raw: RawField, o: DetectOptions): Kind {
  if (raw === null) return { k: 'skip' };
  if (typeof raw === 'string') return classifyText(raw, o);
  if (typeof raw === 'boolean') return { k: 'bool' };
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? { k: 'int' } : { k: 'num' };
  if (isDateCell(raw)) return { k: 'date-native' };
  if (isDateTimeCell(raw)) return { k: 'datetime-native' };
  // A spreadsheet error cell ('#DIV/0!') fits no type; it is kept as raw text.
  return { k: 'fail' };
}

function count(kinds: Kind[], ...wanted: Kind['k'][]): number {
  return kinds.filter((x) => wanted.includes(x.k)).length;
}

interface DateAnalysis {
  valid: number;
  type: 'date' | 'datetime';
  dateFormat: Detection<DateFormat>;
  timezone?: Detection<TimezoneMode>;
}

const FAMILY_ORDER: DateParts['family'][] = ['iso', 'ymd-slash', 'day-month'];

function chooseFamily(texts: DateParts[]): DateParts['family'] {
  const tally = (f: DateParts['family']): number => texts.filter((p) => p.family === f).length;
  // Ties go to the earlier, less ambiguous family.
  return FAMILY_ORDER.reduce((best, f) => (tally(f) > tally(best) ? f : best), 'iso');
}

function validUnder(parts: DateParts[], f: DateFormat): number {
  return parts.filter((p) => monthDay(p, f) !== null).length;
}

/** Day/month order: a value above 12 decides it; without one, day-first is assumed. */
function resolveDayMonth(parts: DateParts[]): Detection<DateFormat> {
  const firstOver = parts.find((p) => p.first > 12);
  const secondOver = parts.find((p) => p.second > 12);
  const shown = (p: DateParts): string => `${p.first}/${p.second}/${p.year}`;
  if (firstOver !== undefined && secondOver === undefined)
    return detection<DateFormat>(
      'dmy',
      'high',
      'day-above-12',
      `The first number exceeds 12 (${shown(firstOver)}), so it is the day.`,
    );
  if (secondOver !== undefined && firstOver === undefined)
    return detection<DateFormat>(
      'mdy',
      'high',
      'day-above-12',
      `The second number exceeds 12 (${shown(secondOver)}), so it is the day.`,
    );
  if (firstOver === undefined || secondOver === undefined)
    return detection<DateFormat>(
      'dmy',
      'low',
      'day-first-default',
      'No day above 12 in the sample, so day/month order cannot be told; day first is assumed.',
      'default',
    );
  const dmy = validUnder(parts, 'dmy');
  const mdy = validUnder(parts, 'mdy');
  const format: DateFormat = mdy > dmy ? 'mdy' : 'dmy';
  return detection(
    format,
    'medium',
    'day-month-majority',
    `Values exceed 12 in both positions; ${format} fits ${Math.max(dmy, mdy)} of ${parts.length}.`,
  );
}

function formatFor(family: DateParts['family'], parts: DateParts[], natives: number): Detection<DateFormat> {
  if (family === 'day-month') return resolveDayMonth(parts);
  if (family === 'ymd-slash')
    return detection<DateFormat>('ymd-slash', 'high', 'value-pattern', 'Dates are written year/month/day.');
  const evidence =
    parts.length > 0
      ? 'Dates are written in ISO 8601 (year-month-day).'
      : `The source stores ${natives} values as dates.`;
  return detection<DateFormat>('iso', 'high', parts.length > 0 ? 'value-pattern' : 'native-cells', evidence);
}

function timezoneFor(zones: ('none' | 'utc' | 'offset')[]): Detection<TimezoneMode> {
  const naive = zones.filter((z) => z === 'none').length;
  if (naive === 0 && zones.length > 0 && zones.every((z) => z === 'utc'))
    return detection<TimezoneMode>('utc', 'high', 'explicit-zone', 'Every time carries Z (UTC).');
  if (naive === 0 && zones.length > 0)
    return detection<TimezoneMode>('offset', 'high', 'explicit-zone', 'Every time carries a UTC offset.');
  return detection<TimezoneMode>(
    'naive-assumed-utc',
    'low',
    'no-zone',
    `${naive} of ${zones.length} times name no time zone; they are read as UTC.`,
    'default',
  );
}

function analyseDates(kinds: Kind[]): DateAnalysis {
  const dateNatives = count(kinds, 'date-native');
  const timeNatives = count(kinds, 'datetime-native');
  const texts = kinds.flatMap((x) => (x.k === 'date-text' ? [x.parts] : []));
  const family = chooseFamily(texts);
  const inFamily = texts.filter((p) => p.family === family);
  const dateFormat = formatFor(family, inFamily, dateNatives + timeNatives);
  const valid = inFamily.filter((p) => monthDay(p, dateFormat.value) !== null);
  const timed = valid.filter((p) => p.time !== null);
  const type = timeNatives > 0 || timed.length > 0 ? 'datetime' : 'date';
  const analysis: DateAnalysis = { valid: dateNatives + timeNatives + valid.length, type, dateFormat };
  if (type === 'datetime') {
    // Spreadsheet datetimes have no zone, so they count as naive.
    const zones = [...timed.map((p) => p.time?.zone ?? 'none'), ...Array<'none'>(timeNatives).fill('none')];
    analysis.timezone = timezoneFor(zones);
  }
  return analysis;
}

const TYPE_LABEL: Record<LogicalType, string> = {
  string: 'text',
  integer: 'whole numbers',
  number: 'numbers',
  boolean: 'booleans',
  date: 'dates',
  datetime: 'date-times',
  geometry: 'geometries',
};

function typeDetection(type: LogicalType, fits: number, total: number): Detection<LogicalType> {
  const all = fits === total;
  const evidence = all
    ? `All ${total} non-empty sample values read as ${TYPE_LABEL[type]}.`
    : `${fits} of ${total} non-empty sample values read as ${TYPE_LABEL[type]}; the others keep their text.`;
  return detection(type, all ? 'high' : 'medium', all ? 'value-pattern' : 'value-majority', evidence);
}

function withDates(type: Detection<LogicalType>, dates: DateAnalysis): TypeInference {
  const result: TypeInference = { type, dateFormat: dates.dateFormat };
  if (dates.timezone !== undefined) result.timezone = dates.timezone;
  return result;
}

function majority(kinds: Kind[], dates: DateAnalysis): TypeInference | null {
  const total = kinds.length;
  const numeric = count(kinds, 'int', 'num');
  const numericType: LogicalType = count(kinds, 'num') > 0 ? 'number' : 'integer';
  const candidates: [LogicalType, number][] = [
    [numericType, numeric],
    ['boolean', count(kinds, 'bool')],
    [dates.type, dates.valid],
  ];
  const [type, fits] = candidates.reduce((best, c) => (c[1] > best[1] ? c : best));
  if (fits === 0 || fits / total < MAJORITY_SHARE) return null;
  const det = typeDetection(type, fits, total);
  return type === 'date' || type === 'datetime' ? withDates(det, dates) : { type: det };
}

/**
 * Infers a column's logical type from its sample values. Empty text, the default null markers and
 * below-detection-limit text are left out: they say nothing about the type of the other values.
 */
export function inferType(values: RawField[], o: DetectOptions): TypeInference {
  const kinds = values.map((v) => classify(v, o)).filter((x) => x.k !== 'skip');
  const total = kinds.length;
  if (total === 0)
    return {
      type: detection<LogicalType>(
        'string',
        'low',
        'empty-sample',
        'The sample has no values; text is assumed.',
        'default',
      ),
    };
  if (count(kinds, 'identifier') > 0)
    return {
      type: detection<LogicalType>(
        'string',
        'high',
        'identifier-text',
        'Numbers with leading zeros or more than 15 digits are identifiers, kept as text.',
      ),
    };
  const numeric = count(kinds, 'int', 'num');
  if (numeric === total) return { type: typeDetection(count(kinds, 'num') > 0 ? 'number' : 'integer', total, total) };
  if (count(kinds, 'bool') === total) return { type: typeDetection('boolean', total, total) };
  const dates = analyseDates(kinds);
  if (dates.valid === total) return withDates(typeDetection(dates.type, total, total), dates);
  const assumed = majority(kinds, dates);
  if (assumed !== null) return assumed;
  if (count(kinds, 'json') === total)
    return {
      type: detection<LogicalType>('string', 'medium', 'json-text', 'Values are nested JSON, kept as JSON text.'),
    };
  return { type: detection<LogicalType>('string', 'high', 'value-pattern', 'Values are free text.') };
}
