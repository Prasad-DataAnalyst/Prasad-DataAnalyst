/**
 * Per-column value parsers: raw reader fields to typed cells under a column plan. A value that
 * does not fit is reported with its raw text, never dropped (SAD section 7.2).
 */
import {
  isDateCell,
  isDateTimeCell,
  rawToText,
  type CellValue,
  type ColumnPlan,
  type DateFormat,
  type RawField,
  type TimezoneMode,
} from '@tw/model';
import { excelSerialToMillis, isoFromMillis, parseDate, parseDateTime } from './dates';
import { matchNullMarker } from './markers';
import { parseNumber } from './numbers';
import type { DetectOptions } from './options';

export type ParseResult = { ok: true; value: CellValue; nullMarker?: string } | { ok: false; raw: string };

type Convert = (raw: Exclude<RawField, null>) => CellValue | undefined;

const TRUE_WORDS: ReadonlySet<string> = new Set(['true', 'yes', 'y', 't', '1']);
const FALSE_WORDS: ReadonlySet<string> = new Set(['false', 'no', 'n', 'f', '0']);

interface NumberSettings {
  decimal: '.' | ',';
  thousands: string;
}

function toNumber(raw: Exclude<RawField, null>, s: NumberSettings): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  return parseNumber(raw, s.decimal, s.thousands) ?? undefined;
}

function toInteger(raw: Exclude<RawField, null>, s: NumberSettings): number | undefined {
  const n = toNumber(raw, s);
  return n !== undefined && Number.isSafeInteger(n) ? n : undefined;
}

function toBoolean(raw: Exclude<RawField, null>): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (raw === 1 || raw === 0) return raw === 1;
  if (typeof raw !== 'string') return undefined;
  const word = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  return FALSE_WORDS.has(word) ? false : undefined;
}

function serialDate(serial: number, withTime: boolean): CellValue | undefined {
  if (!withTime && !Number.isInteger(serial)) return undefined;
  const ms = excelSerialToMillis(serial);
  const iso = ms === null ? null : isoFromMillis(ms);
  if (iso === null) return undefined;
  return withTime ? { datetime: iso } : { date: iso.slice(0, 10) };
}

function toDate(raw: Exclude<RawField, null>, f: DateFormat): CellValue | undefined {
  if (isDateCell(raw)) return raw;
  // A spreadsheet datetime at midnight is a date written with a zero time.
  if (isDateTimeCell(raw))
    return raw.datetime.endsWith('T00:00:00.000Z') ? { date: raw.datetime.slice(0, 10) } : undefined;
  if (typeof raw === 'number') return f === 'excel-serial' ? serialDate(raw, false) : undefined;
  return typeof raw === 'string' ? (parseDate(raw, f) ?? undefined) : undefined;
}

function toDateTime(raw: Exclude<RawField, null>, f: DateFormat, tz: TimezoneMode): CellValue | undefined {
  if (isDateTimeCell(raw)) return raw;
  if (isDateCell(raw)) return { datetime: `${raw.date}T00:00:00.000Z` };
  if (typeof raw === 'number') return f === 'excel-serial' ? serialDate(raw, true) : undefined;
  return typeof raw === 'string' ? (parseDateTime(raw, f, tz) ?? undefined) : undefined;
}

/** Text cells keep their text as written; other fields become their canonical text. Error cells fit no type. */
function toText(raw: Exclude<RawField, null>): string | undefined {
  if (typeof raw === 'object' && !isDateCell(raw) && !isDateTimeCell(raw)) return undefined;
  return rawToText(raw);
}

function converterFor(plan: ColumnPlan, o: DetectOptions): Convert {
  const numbers: NumberSettings = {
    decimal: plan.decimalSeparator?.value ?? o.decimalSeparator,
    thousands: o.thousandsSeparator,
  };
  const format = plan.dateFormat?.value ?? 'iso';
  const tz = plan.timezone?.value ?? 'naive-assumed-utc';
  switch (plan.type.value) {
    case 'string':
      return toText;
    case 'integer':
      return (raw) => toInteger(raw, numbers);
    case 'number':
      return (raw) => toNumber(raw, numbers);
    case 'boolean':
      return toBoolean;
    case 'date':
      return (raw) => toDate(raw, format);
    case 'datetime':
      return (raw) => toDateTime(raw, format, tz);
    case 'geometry':
      // Geometries come from RawRow.geometry, never from a field; a field here does not fit.
      return () => undefined;
  }
}

/**
 * A parser for one column. Empty fields are null. A field matching one of the column's null
 * markers is null and names the marker (rule TW-DQ-006); empty text is simply missing and names
 * none. Anything else that does not fit the type comes back as { ok: false, raw }.
 */
export function makeParser(plan: ColumnPlan, o: DetectOptions): (raw: RawField) => ParseResult {
  const convert = converterFor(plan, o);
  const markers = plan.nullMarkers.value;
  const decimal = plan.decimalSeparator?.value ?? o.decimalSeparator;
  return (raw) => {
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return { ok: true, value: null };
    const marker = matchNullMarker(raw, markers, decimal);
    if (marker !== undefined) return { ok: true, value: null, nullMarker: marker };
    const value = convert(raw);
    return value === undefined ? { ok: false, raw: rawToText(raw) } : { ok: true, value };
  };
}
