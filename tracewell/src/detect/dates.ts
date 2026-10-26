/**
 * Date and datetime text: the formats detection recognises, and parsing into canonical cells.
 * All arithmetic is in UTC, so results never depend on the machine's time zone.
 */
import type { DateCell, DateFormat, DateTimeCell, TimezoneMode } from '@tw/model';

/** Whether a text names a time zone: none, UTC ('Z', 'UTC', 'GMT') or a numeric offset. */
export type ZoneKind = 'none' | 'utc' | 'offset';

interface TimeOfDay {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  /** Minutes east of UTC; null when the text names no zone. */
  offsetMinutes: number | null;
  zone: ZoneKind;
}

/** The pieces of a date text as written, before day/month order is decided. */
export interface DateParts {
  family: 'iso' | 'ymd-slash' | 'day-month';
  year: number;
  /** For 'day-month', the first and second numbers as written; otherwise month and day. */
  first: number;
  second: number;
  time: TimeOfDay | null;
}

const MAX_DATE_TEXT = 48;

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/su;
const YMD_SLASH = /^(\d{4})([/.])(\d{1,2})\2(\d{1,2})(.*)$/su;
const DAY_MONTH = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})(.*)$/su;

const TIME =
  /^(?:T|\s+)(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:\s*([AaPp])[Mm])?\s*(Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?$/su;

/** Days from 1899-12-30 (Excel serial 0 in the 1900 system, after its 1900 leap-year bug) to 1970-01-01. */
const EXCEL_EPOCH_OFFSET_DAYS = 25569;
const MS_PER_DAY = 86_400_000;
/** Serial of 9999-12-31, the last day Excel can show. */
export const EXCEL_MAX_SERIAL = 2_958_465;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function isValidDay(year: number, month: number, day: number): boolean {
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function parseOffset(zone: string | undefined): { zone: ZoneKind; offsetMinutes: number | null } | null {
  if (zone === undefined) return { zone: 'none', offsetMinutes: null };
  const upper = zone.toUpperCase();
  if (upper === 'Z' || upper === 'UTC' || upper === 'GMT') return { zone: 'utc', offsetMinutes: 0 };
  const digits = zone.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length > 2 ? Number(digits.slice(2)) : 0;
  if (hours > 14 || minutes > 59) return null;
  const sign = zone.startsWith('-') ? -1 : 1;
  return { zone: 'offset', offsetMinutes: sign * (hours * 60 + minutes) };
}

/** Converts a 12-hour clock reading; null for an hour that a 12-hour clock cannot show. */
function to24Hour(hour: number, meridiem: string | undefined): number | null {
  if (meridiem === undefined) return hour;
  if (hour < 1 || hour > 12) return null;
  const pm = meridiem.toUpperCase() === 'P';
  return (hour % 12) + (pm ? 12 : 0);
}

/** Parses what follows the date: nothing, or a time of day with an optional zone. */
function parseTimeSuffix(rest: string): TimeOfDay | null | undefined {
  if (rest.trim() === '') return null;
  const m = TIME.exec(rest);
  if (m === null) return undefined;
  const hour = to24Hour(Number(m[1]), m[5]);
  const minute = Number(m[2]);
  const second = m[3] === undefined ? 0 : Number(m[3]);
  const millisecond = m[4] === undefined ? 0 : Number(m[4].slice(0, 3).padEnd(3, '0'));
  const offset = parseOffset(m[6]);
  // No 24:00 and no leap seconds: Date and every engine's timestamp type refuse both.
  if (hour === null || hour > 23 || minute > 59 || second > 59 || offset === null) return undefined;
  return { hour, minute, second, millisecond, ...offset };
}

function partsFrom(
  family: DateParts['family'],
  year: string | undefined,
  first: string | undefined,
  second: string | undefined,
  rest: string | undefined,
): DateParts | null {
  const time = parseTimeSuffix(rest ?? '');
  if (time === undefined) return null;
  return { family, year: Number(year), first: Number(first), second: Number(second), time };
}

/** Splits a date text into its written parts, or null when it is not one of the known layouts. */
export function dateParts(text: string): DateParts | null {
  const t = text.trim();
  if (t.length > MAX_DATE_TEXT) return null;
  const iso = ISO_DATE.exec(t);
  if (iso !== null) return partsFrom('iso', iso[1], iso[2], iso[3], iso[4]);
  const ymd = YMD_SLASH.exec(t);
  if (ymd !== null) return partsFrom('ymd-slash', ymd[1], ymd[3], ymd[4], ymd[5]);
  const dm = DAY_MONTH.exec(t);
  if (dm !== null) return partsFrom('day-month', dm[4], dm[1], dm[3], dm[5]);
  return null;
}

/** Month and day of the parts under a format, or null when the parts do not fit that format. */
export function monthDay(p: DateParts, f: DateFormat): { month: number; day: number } | null {
  const wanted: DateParts['family'] = f === 'dmy' || f === 'mdy' ? 'day-month' : f === 'iso' ? 'iso' : 'ymd-slash';
  if (f === 'excel-serial' || p.family !== wanted) return null;
  const [month, day] = f === 'dmy' ? [p.second, p.first] : [p.first, p.second];
  return isValidDay(p.year, month, day) ? { month, day } : null;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function dateText(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Milliseconds since the epoch; setUTCFullYear avoids Date.UTC mapping years 0–99 to 1900–1999. */
function utcMillis(year: number, month: number, day: number, t: TimeOfDay | null): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(t?.hour ?? 0, t?.minute ?? 0, t?.second ?? 0, t?.millisecond ?? 0);
  return d.getTime() - (t?.offsetMinutes ?? 0) * 60_000;
}

/** The canonical datetime text of an instant, or null outside years 0001–9999. */
export function isoFromMillis(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return /^\d{4}-/.test(iso) && !iso.startsWith('0000') ? iso : null;
}

/** Excel 1900-system serial to epoch milliseconds; null for serial 60 (the non-existent 1900-02-29). */
export function excelSerialToMillis(serial: number): number | null {
  if (!Number.isFinite(serial) || serial < 1 || serial >= EXCEL_MAX_SERIAL + 1 || Math.floor(serial) === 60)
    return null;
  // Serials before 60 sit before Excel's phantom leap day, so they are one day further from the epoch.
  const days = serial < 60 ? serial - EXCEL_EPOCH_OFFSET_DAYS + 1 : serial - EXCEL_EPOCH_OFFSET_DAYS;
  return Math.round(days * MS_PER_DAY);
}

function serialFromText(text: string): number | null {
  const t = text.trim();
  return /^\d+(?:\.\d+)?$/.test(t) ? Number(t) : null;
}

function isMidnight(t: TimeOfDay | null): boolean {
  return t === null || (t.hour === 0 && t.minute === 0 && t.second === 0 && t.millisecond === 0 && t.zone === 'none');
}

/**
 * Reads a calendar date written in format `f`. A time part is accepted only when it is a bare
 * midnight, which is how many tools write dates; any other time means the value is a datetime.
 */
export function parseDate(text: string, f: DateFormat): DateCell | null {
  if (f === 'excel-serial') {
    const serial = serialFromText(text);
    if (serial === null || !Number.isInteger(serial)) return null;
    const ms = excelSerialToMillis(serial);
    const iso = ms === null ? null : isoFromMillis(ms);
    return iso === null ? null : { date: iso.slice(0, 10) };
  }
  const parts = dateParts(text);
  const md = parts === null ? null : monthDay(parts, f);
  if (parts === null || md === null || !isMidnight(parts.time)) return null;
  return { date: dateText(parts.year, md.month, md.day) };
}

/**
 * Reads an instant written in format `f`. An explicit zone is always honoured. A value without
 * one is read as UTC in every mode: the column's mode records whether that was assumed
 * (rule TW-TIME-004), and a user confirming UTC for a naive column must not make it unreadable.
 * A date without a time is midnight.
 */
export function parseDateTime(text: string, f: DateFormat, tz: TimezoneMode): DateTimeCell | null {
  // Every mode reads naive values as UTC (see above); the parameter keeps the call sites explicit.
  void tz;
  if (f === 'excel-serial') {
    const serial = serialFromText(text);
    const ms = serial === null ? null : excelSerialToMillis(serial);
    const iso = ms === null ? null : isoFromMillis(ms);
    return iso === null ? null : { datetime: iso };
  }
  const parts = dateParts(text);
  const md = parts === null ? null : monthDay(parts, f);
  if (parts === null || md === null) return null;
  const iso = isoFromMillis(utcMillis(parts.year, md.month, md.day, parts.time));
  return iso === null ? null : { datetime: iso };
}
