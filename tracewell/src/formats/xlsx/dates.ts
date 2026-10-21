/**
 * Excel serial dates. A serial counts days, with the time of day as the fraction, from an epoch:
 *   - the 1900 system (the default): serial 1 is 1900-01-01, and serial 60 is 1900-02-29, a day
 *     that never existed, kept by Excel for compatibility with Lotus 1-2-3. Serials from 61 on are
 *     therefore days since 1899-12-30, serials below 60 days since 1899-12-31, and 60 itself is read
 *     as 1900-02-28 (the same convention as openpyxl, the Python oracle);
 *   - the 1904 system (old Mac workbooks, workbookPr date1904): days since 1904-01-01.
 * Times are rounded to the millisecond, the precision of DateTimeCell (SAD section 9.4).
 */
import { EngineError, isDateCell, isDateTimeCell, type DateCell, type DateTimeCell } from '@tw/model';
import { invalidArgument } from './errors';
import type { DateFormatKind } from './numfmt';

const MS_PER_DAY = 86_400_000;
/** Days from each epoch to 1970-01-01. */
const DAYS_1899_12_30 = 25_569;
const DAYS_1899_12_31 = 25_568;
const DAYS_1904_01_01 = 24_107;
/** The first serial after the phantom 1900-02-29. */
const FIRST_REAL_MARCH_1900 = 61;
/** 9999-12-31T23:59:59.999Z, the last instant a DateTimeCell can hold. */
const MAX_UNIX_MS = 253_402_300_799_999;
/** 0001-01-01T00:00:00.000Z, the first instant a DateTimeCell can hold. */
const MIN_UNIX_MS = -62_135_596_800_000;

/** Milliseconds since 1970 of a serial, or null when it lies outside 1899-12-31 .. 9999-12-31. */
function serialToUnixMs(serial: number, date1904: boolean): number | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  let day = Math.floor(serial);
  let ms = Math.round((serial - day) * MS_PER_DAY);
  if (ms === MS_PER_DAY) {
    day += 1;
    ms = 0;
  }
  const epoch = date1904 ? DAYS_1904_01_01 : day < 60 ? DAYS_1899_12_31 : DAYS_1899_12_30;
  const unixMs = (day - epoch) * MS_PER_DAY + ms;
  return unixMs <= MAX_UNIX_MS ? unixMs : null;
}

function dateCellAt(unixMs: number): DateCell {
  return { date: new Date(unixMs).toISOString().slice(0, 10) };
}

function dateTimeCellAt(unixMs: number): DateTimeCell {
  return { datetime: new Date(unixMs).toISOString() };
}

/**
 * The date of a serial: a whole serial gives a DateCell, anything else a DateTimeCell rounded to
 * the millisecond. Throws EngineError('INVALID_INPUT') for a serial that is negative, not finite,
 * or after 9999-12-31.
 */
export function serialToCell(serial: number, date1904: boolean): DateCell | DateTimeCell {
  const unixMs = serialToUnixMs(serial, date1904);
  if (unixMs === null) {
    throw invalidArgument(`The serial ${String(serial)} is not an Excel date between 1900 and 9999.`, {
      serial: String(serial),
    });
  }
  return Number.isInteger(serial) ? dateCellAt(unixMs) : dateTimeCellAt(unixMs);
}

/**
 * The value of a date-formatted number as the reader returns it: a format that shows a time always
 * gives a DateTimeCell, so a column of timestamps does not turn into dates at midnight. Null when
 * the serial is outside the range Excel can show as a date.
 */
export function serialToDateValue(
  serial: number,
  date1904: boolean,
  kind: DateFormatKind,
): DateCell | DateTimeCell | null {
  const unixMs = serialToUnixMs(serial, date1904);
  if (unixMs === null) return null;
  return kind === 'date' && Number.isInteger(serial) ? dateCellAt(unixMs) : dateTimeCellAt(unixMs);
}

function unixMsOf(v: DateCell | DateTimeCell): number | null {
  if (isDateCell(v)) {
    const ms = Date.parse(`${v.date}T00:00:00.000Z`);
    return Number.isNaN(ms) || dateCellAt(ms).date !== v.date ? null : ms;
  }
  if (isDateTimeCell(v)) {
    const ms = Date.parse(v.datetime);
    return Number.isNaN(ms) || dateTimeCellAt(ms).datetime !== v.datetime ? null : ms;
  }
  return null;
}

/**
 * The 1900-system serial of a date or instant; the inverse of serialToCell for every value from
 * 1899-12-31 on. Throws EngineError('INVALID_INPUT') for a value that is not a real date or
 * instant, or that falls before 1899-12-31, which Excel cannot store.
 */
export function cellToSerial(v: DateCell | DateTimeCell): number {
  const unixMs = unixMsOf(v);
  if (unixMs === null) {
    throw invalidArgument('The value is not a date (YYYY-MM-DD) or an instant (YYYY-MM-DDTHH:mm:ss.sssZ).');
  }
  const unixDays = Math.floor(unixMs / MS_PER_DAY);
  const msOfDay = unixMs - unixDays * MS_PER_DAY;
  let day = unixDays + DAYS_1899_12_30;
  if (day < FIRST_REAL_MARCH_1900) day -= 1;
  if (day < 0) {
    const text = isDateCell(v) ? v.date : (v as DateTimeCell).datetime;
    throw new EngineError(
      'INVALID_INPUT',
      `Excel cannot store ${text}: its dates start on 1900-01-01.`,
      'Export this data with the CSV profile, which keeps every date, or exclude the rows dated before 1900.',
      { value: text },
    );
  }
  return day + msOfDay / MS_PER_DAY;
}

/** 'YYYY-MM-DD', optionally followed by a time with seconds, fraction and zone. */
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
/** A time of day alone, as ISO 8601 allows for t="d" cells. */
const ISO_TIME = /^T?(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/;

/** Milliseconds east of UTC in a zone designator such as '+02:00'; 0 for 'Z' or none. */
function zoneOffsetMs(zone: string | undefined): number {
  if (zone === undefined || zone === 'Z') return 0;
  const digits = zone.replace(':', '');
  const minutes = Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5));
  return (digits.startsWith('-') ? -1 : 1) * minutes * 60_000;
}

interface ParsedIso {
  unixMs: number;
  hasTime: boolean;
}

function parseClock(hh: string, mm: string, ss: string | undefined, fraction: string | undefined): number | null {
  const [h, m, s] = [Number(hh), Number(mm), Number(ss ?? '0')];
  if (h > 23 || m > 59 || s > 59) return null;
  const ms = Math.round(Number(`0${fraction ?? ''}`) * 1000);
  return ((h * 60 + m) * 60 + s) * 1000 + ms;
}

function parseIso(text: string): ParsedIso | null {
  const time = ISO_TIME.exec(text);
  if (time !== null) {
    const clock = parseClock(time[1] ?? '', time[2] ?? '', time[3], time[4]);
    return clock === null ? null : { unixMs: -DAYS_1899_12_31 * MS_PER_DAY + clock, hasTime: true };
  }
  const m = ISO_DATE_TIME.exec(text);
  if (m === null) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const midnight = unixMsOf({ date });
  if (midnight === null) return null;
  if (m[4] === undefined) return { unixMs: midnight, hasTime: false };
  const clock = parseClock(m[4], m[5] ?? '', m[6], m[7]);
  if (clock === null) return null;
  return { unixMs: midnight + clock - zoneOffsetMs(m[8]), hasTime: true };
}

/**
 * The value of a t="d" cell, whose text is an ISO 8601 date, date-time or time. A time without a
 * zone is read as UTC. Null when the text is not such a value or falls outside 0001..9999.
 */
export function isoToDateValue(text: string, kind: DateFormatKind | null): DateCell | DateTimeCell | null {
  const parsed = parseIso(text.trim());
  if (parsed === null || parsed.unixMs > MAX_UNIX_MS || parsed.unixMs < MIN_UNIX_MS) return null;
  const midnight = parsed.unixMs % MS_PER_DAY === 0;
  const asDate = kind === 'datetime' ? false : !parsed.hasTime || (kind === 'date' && midnight);
  return asDate ? dateCellAt(parsed.unixMs) : dateTimeCellAt(parsed.unixMs);
}
