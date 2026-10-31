// @ts-check
/**
 * Writes the text fixtures of the messy-file library (CSV, TSV, GeoJSON and JSON) with exact bytes:
 * encodings, byte-order marks and line endings are chosen per file, never left to the platform.
 * The Parquet fixture is written here too, by hyparquet-writer, whose output depends only on the
 * values given. Then writes SHA256SUMS over every fixture, the XLSX files included.
 *
 * Usage: node fixtures/generators/gen-text-fixtures.mjs [--out <dir>] [--no-sums]
 *   --out <dir>  write into <dir> instead of fixtures/messy
 *   --no-sums    do not write SHA256SUMS (used when only the text files are compared)
 *
 * Run make_xlsx_fixtures.py first: SHA256SUMS covers the XLSX files too. Each data value below is
 * chosen so that a fixture breaks exactly what fixtures/README.md says it breaks; the expected
 * results in fixtures/messy/<name>.expected.json depend on these values.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { ALL_FIXTURES, hampelFlags, isEntryScript, longestRun, mulberry32, noise } from './shared.mjs';

const DEFAULT_OUT = fileURLToPath(new URL('../messy/', import.meta.url));

/**
 * @typedef {{ name: string; bytes: Uint8Array }} FixtureFile
 * @typedef {'\n' | '\r\n'} Eol
 */

// ---------------------------------------------------------------------------------------------
// Encodings

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];

/** @param {string} text */
function utf8(text) {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

/** @param {string} text */
function utf8WithBom(text) {
  return concat([new Uint8Array(UTF8_BOM), utf8(text)]);
}

/** @param {string} text */
function utf16leWithBom(text) {
  return concat([new Uint8Array(UTF16LE_BOM), new Uint8Array(Buffer.from(text, 'utf16le'))]);
}

/** The windows-1252 bytes 0x80-0x9F that differ from Latin-1, by code point. */
const CP1252_HIGH = new Map([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

/**
 * windows-1252 bytes of `text`. Throws on a character the code page cannot hold, so a typo in
 * the data cannot silently become '?'.
 * @param {string} text
 */
function windows1252(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const byte = code < 0x80 || (code >= 0xa0 && code <= 0xff) ? code : CP1252_HIGH.get(code);
    if (byte === undefined) throw new Error(`U+${code.toString(16)} has no windows-1252 byte.`);
    out[i] = byte;
  }
  return out;
}

/** @param {Uint8Array[]} parts */
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Offset of the first well-formed UTF-8 multi-byte sequence, or -1. A windows-1252 fixture must
 * have none, or a UTF-8 sniffer could take part of it for UTF-8 text.
 * @param {Uint8Array} bytes
 */
export function firstUtf8MultiByte(bytes) {
  for (let i = 0; i < bytes.length; i++) {
    const lead = bytes[i] ?? 0;
    const length =
      lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    if (length === 0 || i + length > bytes.length) continue;
    let ok = true;
    for (let k = 1; k < length; k++) ok &&= ((bytes[i + k] ?? 0) & 0xc0) === 0x80;
    if (ok) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Delimited text

/**
 * One record. A field is quoted only when it must be: it holds the delimiter, a quote or a line
 * break. Embedded quotes are doubled (RFC 4180).
 * @param {readonly string[]} fields
 * @param {string} delimiter
 */
function record(fields, delimiter) {
  return fields
    .map((f) => (f.includes(delimiter) || /["\r\n]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f))
    .join(delimiter);
}

/**
 * @param {readonly (readonly string[])[]} rows header first
 * @param {{ delimiter?: string; eol?: Eol; finalEol?: boolean; preamble?: readonly string[] }} [o]
 */
function delimited(rows, o = {}) {
  const { delimiter = ',', eol = '\n', finalEol = true, preamble = [] } = o;
  const lines = [...preamble, ...rows.map((r) => record(r, delimiter))];
  return lines.join(eol) + (finalEol ? eol : '');
}

/** @param {number} x @param {number} digits */
function fixed(x, digits) {
  const text = x.toFixed(digits);
  if (/^-0\.?0*$/.test(text)) throw new Error(`${x} would be written as negative zero.`);
  return text;
}

/**
 * A number written with a point, rewritten with a decimal comma and '.' digit grouping, as a
 * German spreadsheet writes it: '12450.5' becomes '12.450,5'.
 * @param {string} text
 */
function germanText(text) {
  const [whole = '', fraction] = text.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return fraction === undefined ? grouped : `${grouped},${fraction}`;
}

/**
 * 'YYYY-MM-DD' of the day `offset` days after `start` ('YYYY-MM-DD').
 * @param {string} start
 * @param {number} offset
 */
function addDays(start, offset) {
  const [y = 0, m = 1, d = 1] = start.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

/**
 * ISO instant `hours` after `start`, in whole seconds with 'Z'.
 * @param {string} start
 * @param {number} hours
 */
function addHours(start, hours) {
  return new Date(Date.parse(start) + hours * 3_600_000).toISOString().replace('.000Z', 'Z');
}

// ---------------------------------------------------------------------------------------------
// Measured series

/**
 * A slot that repeats slot `from` (a re-sent or double-posted record), times `factor`, plus `offset`.
 * @typedef {{ from: number; factor?: number; offset?: number }} Copy
 */

/**
 * A measured series as text with `digits` decimals: `base` plus uniform noise, one value per slot
 * in the order the time-series rules read them (by time, then file order). Where the strict Hampel
 * test flags a slot that was not planted, the noise of its window is halved and the series is
 * checked again, so the only spikes are those a fixture plants on purpose. `planted` maps a slot
 * to its exact value (a spike, or one member of a flat run); `copies` maps a slot to the slot it
 * repeats.
 * @param {{ base: readonly number[]; amplitude: number; digits: number; rand: () => number;
 *   planted?: ReadonlyMap<number, number>; copies?: ReadonlyMap<number, Copy> }} spec
 * @returns {string[]}
 */
function quietSeries({ base, amplitude, digits, rand, planted = new Map(), copies = new Map() }) {
  const eps = base.map(() => noise(rand, amplitude));
  const render = () => {
    const text = base.map((b, i) => fixed(planted.get(i) ?? b + (eps[i] ?? 0), digits));
    for (const [i, c] of copies) text[i] = fixed(Number(text[c.from]) * (c.factor ?? 1) + (c.offset ?? 0), digits);
    return text;
  };
  for (let round = 0; round < 64; round++) {
    const text = render();
    const stray = hampelFlags(text.map(Number), true).filter((i) => !planted.has(i));
    if (stray.length === 0) return text;
    // A flag can come from the neighbours (a tight cluster makes the MAD tiny), so the whole
    // window is damped; a smooth base alone is never flagged.
    for (const i of stray) for (let j = i - 3; j <= i + 3; j++) if (j in eps) eps[j] = (eps[j] ?? 0) / 2;
  }
  const start = fixed(base[0] ?? 0, digits);
  throw new Error(`The series starting near ${start} did not settle: give it a finer resolution or less noise.`);
}

/**
 * Copies for the slots that repeat their predecessor, which `slots` lists twice in a row.
 * @param {readonly unknown[]} slots
 * @param {(i: number) => Omit<Copy, 'from'>} [change]
 * @returns {Map<number, Copy>}
 */
function repeats(slots, change = () => ({})) {
  /** @type {Map<number, Copy>} */
  const copies = new Map();
  slots.forEach((slot, i) => {
    if (i > 0 && slot === slots[i - 1]) copies.set(i, { from: i - 1, ...change(i) });
  });
  return copies;
}

/** Runs of identical values this long happen by chance; rule TW-TIME-006 starts at 6. */
const MAX_STRAY_RUN = 3;

/**
 * @typedef {{ id: number; time: number; measures: number[]; spikes?: string[]; flat?: Record<string, number> }}
 *   SeriesExpectation spikes as 'group|time|column index'; flat maps 'group|column index' to its run length
 */

/**
 * Checks assembled data rows the way the time-series rules read them: per group, sorted by time
 * and then file order. Each measure column must have exactly the listed spikes under both the
 * documented and the strict Hampel test, and no run of identical values longer than MAX_STRAY_RUN
 * except the listed flat runs. Times must sort as text (ISO 8601 in one format).
 * @param {string} name
 * @param {readonly (readonly string[])[]} rows
 * @param {SeriesExpectation} o
 */
function assertSeries(name, rows, { id, time, measures, spikes = [], flat = {} }) {
  /** @type {Map<string, (readonly string[])[]>} */
  const groups = new Map();
  for (const row of rows) {
    const key = row[id] ?? '';
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const [group, list] of groups) {
    // Array.prototype.sort is stable, so equal times keep their file order.
    const sorted = [...list].sort((a, b) => compareText(a[time] ?? '', b[time] ?? ''));
    for (const col of measures)
      assertColumn(`${name} ${group} column ${col}`, sorted, col, { group, time, spikes, flat });
  }
}

/**
 * @param {string} label
 * @param {readonly (readonly string[])[]} sorted
 * @param {number} col
 * @param {{ group: string; time: number; spikes: string[]; flat: Record<string, number> }} o
 */
function assertColumn(label, sorted, col, { group, time, spikes, flat }) {
  const values = sorted.map((r) => Number(r[col]));
  const expected = sorted.flatMap((r, i) => (spikes.includes(`${group}|${r[time]}|${col}`) ? [i] : []));
  for (const strict of [false, true]) {
    const got = hampelFlags(values, strict);
    if (got.join() !== expected.join()) {
      throw new Error(`${label}: spikes at [${got}] (strict ${strict}), expected [${expected}].`);
    }
  }
  const run = longestRun(values);
  const wanted = flat[`${group}|${col}`];
  if (wanted === undefined ? run > MAX_STRAY_RUN : run !== wanted) throw new Error(`${label}: longest run ${run}.`);
}

/**
 * Code-unit order, which is time order for ISO 8601 text in one format (localeCompare is not).
 * @param {string} a
 * @param {string} b
 */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** @param {number} n */
function range(n) {
  return Array.from({ length: n }, (_, i) => i);
}

// ---------------------------------------------------------------------------------------------
// CSV and TSV fixtures

const GOLDEN_WELLS = [
  { id: 'NS-A01', lat: 57.48213, lon: 1.73542, p: 1862, t: 183.4, oil: 2450, gor: 1.18, wc: 12 },
  { id: 'NS-A02', lat: 57.49105, lon: 1.75018, p: 2104, t: 187.1, oil: 3120, gor: 1.32, wc: 8.5 },
  { id: 'NS-B03', lat: 57.52871, lon: 1.69934, p: 1627, t: 179.6, oil: 1980, gor: 1.05, wc: 21 },
];

const GOLDEN_HEADER = [
  'well_id',
  'date',
  'latitude',
  'longitude',
  'Pressure (psia)',
  'Temperature (degF)',
  'Oil (bbl/d)',
  'Gas (Mscf/d)',
  'Water cut (%)',
];

/** NS-A02's reading for 15 January (day 45) was sent twice; the second one corrects the pressure. */
const GOLDEN_RESENT = { well: 'NS-A02', day: 45, pressureOffset: 0.4 };

/**
 * The five measured series of one well, one value per slot. A day listed twice in `slots` is the
 * re-sent reading: the same values, the pressure corrected.
 * @param {(typeof GOLDEN_WELLS)[number]} w
 * @param {readonly number[]} slots day numbers
 * @param {() => number} rand
 */
function goldenSeries(w, slots, rand) {
  const oil = slots.map((d) => w.oil * (1 - 0.0015 * d));
  const same = repeats(slots);
  const corrected = repeats(slots, () => ({ offset: GOLDEN_RESENT.pressureOffset }));
  return [
    quietSeries({ base: slots.map((d) => w.p - 0.85 * d), amplitude: 4, digits: 1, rand, copies: corrected }),
    quietSeries({ base: slots.map((d) => w.t - 0.01 * d), amplitude: 0.6, digits: 2, rand, copies: same }),
    quietSeries({ base: oil, amplitude: 25, digits: 1, rand, copies: same }),
    quietSeries({ base: oil.map((q) => q * w.gor), amplitude: 20, digits: 1, rand, copies: same }),
    quietSeries({ base: slots.map((d) => w.wc + 0.04 * d), amplitude: 0.3, digits: 2, rand, copies: same }),
  ];
}

/** @param {(typeof GOLDEN_WELLS)[number]} w @param {readonly number[]} days */
function goldenSlots(w, days) {
  return days.flatMap((d) => (w.id === GOLDEN_RESENT.well && d === GOLDEN_RESENT.day ? [d, d] : [d]));
}

/** The reference daily report: 3 wells x 90 days, plus one re-sent reading (duplicate key). */
function goldenCsv() {
  const rand = mulberry32(20_260_101);
  const days = range(90);
  const slots = GOLDEN_WELLS.map((w) => goldenSlots(w, days));
  const series = GOLDEN_WELLS.map((w, k) => goldenSeries(w, slots[k] ?? [], rand));
  const next = GOLDEN_WELLS.map(() => 0);
  const rows = [GOLDEN_HEADER];
  for (const day of days) {
    const date = `${addDays('2025-12-01', day)}T06:00:00`;
    GOLDEN_WELLS.forEach((w, k) => {
      // Every slot of this day becomes a row: two for the re-sent reading.
      while (slots[k]?.[next[k] ?? 0] === day) {
        const i = next[k] ?? 0;
        rows.push([w.id, date, String(w.lat), String(w.lon), ...(series[k] ?? []).map((s) => at(s, i))]);
        next[k] = i + 1;
      }
    });
  }
  assertSeries('golden', rows.slice(1), { id: 0, time: 1, measures: [4, 5, 6, 7, 8] });
  return { name: 'csv_well_daily_golden.csv', bytes: utf8(delimited(rows)) };
}

/** A German export: windows-1252, semicolons, decimal commas, '.' digit grouping, CRLF. */
function semicolonCp1252Csv() {
  const rand = mulberry32(49);
  const header = ['Well_ID', 'Datum', 'Temperatur (°C)', 'Druck (barg)', 'Förderrate (m³/d)', 'Gas (Sm³/d)'];
  /** @type {Record<string, string>} */
  const remarks = {
    'DE-07 2026-01-08': 'Filterwechsel, Kosten 350 €',
    'DE-12 2026-01-11': 'Probe für Labor genommen',
    'DE-07 2026-01-14': 'Druckabfall nach Wartung',
  };
  const wells = [
    { id: 'DE-07', t: 78.4, p: 45.3, q: 182.5, gas: 12450.5 },
    { id: 'DE-12', t: 81.2, p: 52.8, q: 210.4, gas: 14820.0 },
  ];
  const days = range(10);
  const series = wells.map((w) => [
    quietSeries({ base: days.map((d) => w.t + 0.08 * d), amplitude: 0.5, digits: 2, rand }),
    quietSeries({ base: days.map((d) => w.p - 0.12 * d), amplitude: 0.3, digits: 1, rand }),
    quietSeries({ base: days.map((d) => w.q - 0.4 * d), amplitude: 1.5, digits: 1, rand }),
    quietSeries({ base: days.map((d) => w.gas - 5 * d), amplitude: 60, digits: 1, rand }),
  ]);
  const rows = [[...header, 'Bemerkung']];
  for (const day of days) {
    const iso = addDays('2026-01-06', day);
    const [y, m, d] = iso.split('-');
    wells.forEach((w, k) => {
      const values = (series[k] ?? []).map((s) => germanText(at(s, day)));
      rows.push([w.id, `${d}.${m}.${y}`, ...values, remarks[`${w.id} ${iso}`] ?? 'Normalbetrieb']);
    });
  }
  const bytes = windows1252(delimited(rows, { delimiter: ';', eol: '\r\n' }));
  if (firstUtf8MultiByte(bytes) >= 0) throw new Error('The windows-1252 fixture contains a UTF-8 sequence.');
  return { name: 'csv_semicolon_decimalcomma_cp1252.csv', bytes };
}

/** LNG cargo deliveries: UTF-8 with a byte-order mark, CRLF, non-Latin-1 letters, a quoted comma. */
function utf8BomCrlfCsv() {
  const header = [
    'cargo_id',
    'vessel',
    'discharge_port',
    'arrival',
    'Volume (m3)',
    'Energy (MMBtu)',
    'Density (kg/m3)',
    'Temperature (°C)',
  ];
  const cargoes = [
    ['Ærøy Spirit', 'Zeebrugge', '2026-03-02T14:30:00Z', '154230', '3481972', '452.6', '-161.4'],
    ['São Gonçalo', 'Świnoujście', '2026-03-04T06:15:00Z', '160480', '3640086', '455.1', '-161.2'],
    ['Côte Bleue', 'Gate, Rotterdam', '2026-03-05T22:40:00Z', '147905', '3333779', '449.8', '-160.9'],
    ['Łódź Star', 'Klaipėda', '2026-03-07T09:05:00Z', '138760', '3128553', '451.3', '-161.6'],
    ['Ísafjörður', 'Dunkerque', '2026-03-09T17:50:00Z', '171215', '3887493', '458.2', '-161.1'],
    ['Mære Gas', 'Montoir-de-Bretagne', '2026-03-11T03:25:00Z', '165340', '3741644', '454.0', '-161.3'],
    ['Šibenik LNG', 'Krk', '2026-03-12T11:10:00Z', '142118', '3207403', '450.7', '-160.8'],
    ['Øresund Pearl', 'Revithoussa', '2026-03-14T19:45:00Z', '158902', '3601808', '456.4', '-161.5'],
    ['Ærøy Spirit', 'Świnoujście', '2026-03-16T08:00:00Z', '153877', '3474006', '452.9', '-161.4'],
    ['Čakovec Dawn', 'Zeebrugge', '2026-03-18T13:35:00Z', '149660', '3374833', '451.8', '-161.0'],
    ['Côte Bleue', 'Dunkerque', '2026-03-20T21:20:00Z', '148020', '3336371', '450.2', '-160.9'],
    ['São Gonçalo', 'Gate, Rotterdam', '2026-03-23T05:55:00Z', '160115', '3631807', '455.4', '-161.2'],
  ];
  const rows = [header, ...cargoes.map((c, i) => [`LNG-2026-${String(i + 1).padStart(3, '0')}`, ...c])];
  return { name: 'csv_utf8_bom_crlf.csv', bytes: utf8WithBom(delimited(rows, { eol: '\r\n' })) };
}

/** Gas chromatograph results as Excel's "Unicode text": UTF-16LE with a byte-order mark, tabs, CRLF. */
function utf16TabTsv() {
  const header = [
    'sample_id',
    'sampled_at',
    'analyst',
    'C1 (mol%)',
    'C2 (mol%)',
    'C3 (mol%)',
    'CO2 (mol%)',
    'N2 (mol%)',
    'H2S (ppm)',
  ];
  const samples = [
    ['2026-02-03', 'Ødegård', '88.42', '6.15', '2.31', '1.84', '1.12', '4.2'],
    ['2026-02-03', 'Łukasz Nowak', '87.95', '6.38', '2.47', '1.91', '1.18', '4.6'],
    ['2026-02-05', 'Αλέξης Παππάς', '89.10', '5.92', '2.12', '1.70', '1.05', '3.9'],
    ['2026-02-06', 'Zoë Martin', '88.76', '6.04', '2.25', '1.79', '1.09', '4.1'],
    ['2026-02-09', 'Søren Ahl', '86.83', '6.81', '2.73', '2.18', '1.31', '5.8'],
    ['2026-02-10', 'Ødegård', '87.40', '6.55', '2.58', '2.02', '1.24', '5.2'],
    ['2026-02-12', 'Αλέξης Παππάς', '88.05', '6.29', '2.40', '1.88', '1.16', '4.4'],
    ['2026-02-13', 'Łukasz Nowak', '89.32', '5.80', '2.05', '1.66', '1.02', '3.7'],
    ['2026-02-16', 'Zoë Martin', '88.61', '6.10', '2.29', '1.81', '1.11', '4.3'],
    ['2026-02-17', 'Søren Ahl', '87.18', '6.67', '2.64', '2.09', '1.27', '5.5'],
  ];
  const rows = [header, ...samples.map((s, i) => [`GC-26-${String(101 + i).padStart(4, '0')}`, ...s])];
  return { name: 'tsv_utf16le_bom.tsv', bytes: utf16leWithBom(delimited(rows, { delimiter: '\t', eol: '\r\n' })) };
}

/** A report export: three title lines above the header, units written in four different ways. */
function titleRowsCsv() {
  const preamble = [
    'Field Alpha - production well tests',
    'Exported 2026-02-10 from the well test database',
    'Separator: SEP-1',
  ];
  const header = [
    'well_id',
    'test_date',
    'Pressure (psia)',
    'T [°F]',
    'gas_rate_kg_h',
    'Depth ft',
    'Oil (bbl/d)',
    'Comments',
  ];
  const rows = [
    header,
    ['W-01', '2025-11-05', '1832.4', '184.2', '5210.5', '8450', '2210.4', 'routine test'],
    ['W-02', '2025-11-06', '1647.9', '178.6', '4388.0', '7920', '1876.3', 'routine test'],
    ['W-01', '2025-12-04', '1810.7', '183.9', '5122.8', '8450', '2174.9', 'after choke change'],
    ['W-02', '2025-12-05', '1631.2', '178.1', '4301.6', '7920', '1849.0', 'sand observed in sample'],
    ['W-01', '2026-01-06', '1789.5', '183.5', '5040.3', '8450', '2139.6', 'routine test'],
    ['W-02', '2026-01-07', '1612.8', '177.4', '4219.9', '7920', '1815.2', 'meter recalibrated'],
    ['W-01', '2026-02-03', '1770.1', '183.0', '4968.7', '8450', '2108.1', 'routine test'],
    ['W-02', '2026-02-04', '1598.3', '177.0', '4150.2', '7920', '1790.7', 'routine test'],
  ];
  return { name: 'csv_title_rows_units_in_header.csv', bytes: utf8(delimited(rows, { preamble })) };
}

/** One well, 16 days; null markers in the pressure column and a lone -9999 in the oil column. */
function nullMarkersCsv() {
  const header = ['well_id', 'date', 'Pressure (psia)', 'Temperature (degF)', 'Oil (bbl/d)', 'Gas (Mscf/d)'];
  const pressure = [
    '1512.4',
    '-999.25',
    '1509.8',
    '1508.1',
    'N/A',
    '1505.9',
    '-999.25',
    '1503.2',
    '',
    '1500.7',
    '1499.5',
    'N/A',
    '1497.0',
    '-999.25',
    '1494.8',
    '1493.6',
  ];
  const temperature = [
    '176.2',
    '176.0',
    '176.3',
    '175.9',
    '175.8',
    '176.1',
    '175.7',
    '175.6',
    '175.9',
    '175.5',
    '175.4',
    '175.7',
    '175.3',
    '175.2',
    '175.5',
    '175.1',
  ];
  const oil = [
    '1210.5',
    '1208.2',
    '1207.9',
    '1205.1',
    '1204.6',
    '1202.3',
    '1201.8',
    '-9999',
    '1198.4',
    '1197.0',
    '1195.6',
    '1194.9',
    '1192.2',
    '1191.7',
    '1189.3',
    '1188.0',
  ];
  const gas = [
    '1452.6',
    '1449.8',
    '1449.5',
    '1446.1',
    '1445.5',
    '1442.8',
    '1442.2',
    '1440.4',
    '1438.1',
    '1436.4',
    '1434.7',
    '1433.9',
    '1430.6',
    '1430.0',
    '1427.2',
    '1425.6',
  ];
  const rows = [header];
  for (let day = 0; day < 16; day++) {
    rows.push([
      'NS-C04',
      addDays('2026-01-01', day),
      at(pressure, day),
      at(temperature, day),
      at(oil, day),
      at(gas, day),
    ]);
  }
  return { name: 'csv_null_markers.csv', bytes: utf8(delimited(rows)) };
}

/** @param {readonly string[]} list @param {number} i */
function at(list, i) {
  const value = list[i];
  if (value === undefined) throw new Error(`No value at index ${i}.`);
  return value;
}

/** Work orders: quoted line breaks (LF and CRLF), doubled quotes, one short and one long row. */
function quotedNewlinesRaggedCsv() {
  const rows = [
    ['wo_id', 'well', 'opened', 'priority', 'description', 'Downtime (h)'],
    ['WO-1001', 'NS-A01', '2026-01-03', 'high', 'Replace choke insert; erosion found\non bean, see photo set 3', '6.5'],
    ['WO-1002', 'NS-A02', '2026-01-04', 'low', 'Routine greasing', '1.0'],
    ['WO-1003', 'NS-B03', '2026-01-06', 'medium', 'Operator noted "hissing" at flowline flange', '2.5'],
    [
      'WO-1004',
      'NS-A01',
      '2026-01-07',
      'high',
      'ESD valve failed to close.\r\nRetested OK after solenoid swap.',
      '8.0',
    ],
    ['WO-1005', 'NS-B03', '2026-01-09', 'low', 'Insulation check'],
    ['WO-1006', 'NS-A02', '2026-01-10', 'medium', 'Multi-step job:\n- isolate\n- drain\n- replace gasket', '3.0'],
    ['WO-1007', 'NS-A01', '2026-01-12', 'low', 'Paint touch-up', '0.5', 'extra-note'],
    ['WO-1008', 'NS-B03', '2026-01-13', 'high', 'Leak "as reported" by night shift', '12.0'],
    ['WO-1009', 'NS-A02', '2026-01-15', 'medium', 'Comma, inside, quoted text', '4.0'],
    ['WO-1010', 'NS-A01', '2026-01-16', 'low', 'Visual inspection', '0.5'],
  ];
  return { name: 'csv_quoted_newlines_ragged.csv', bytes: utf8(delimited(rows)) };
}

/**
 * 'post' is the hour the historian posted twice in a row; 'resend' the hour whose correction was
 * re-sent at the end of the file with the flow scaled by `factor`.
 */
const METERS = [
  { id: 'FM-101', flow: 1254300, p: 6820, t: 41.3, post: 3, resend: 5, factor: 1.0004 },
  { id: 'FM-102', flow: 986400, p: 6655, t: 39.8, post: 7, resend: 9, factor: 0.9996 },
];

/**
 * @param {(typeof METERS)[number]} m
 * @param {readonly number[]} slots hours by time; a repeated hour is the double post or the correction
 * @param {() => number} rand
 */
function meterSeries(m, slots, rand) {
  const same = repeats(slots);
  const corrected = repeats(slots, (i) => (slots[i] === m.resend ? { factor: m.factor } : {}));
  const flow = slots.map((h) => m.flow + 1500 * Math.sin((2 * Math.PI * h) / 12));
  return [
    quietSeries({ base: flow, amplitude: 900, digits: 1, rand, copies: corrected }),
    quietSeries({ base: slots.map((h) => m.p - 1.5 * h), amplitude: 6, digits: 1, rand, copies: same }),
    quietSeries({ base: slots.map((h) => m.t + 0.05 * h), amplitude: 0.4, digits: 2, rand, copies: same }),
  ];
}

/** Hourly meter data: two double-posted rows and two re-sent corrections appended at the end. */
function duplicatesCsv() {
  const rand = mulberry32(77);
  const hours = range(12);
  const slots = METERS.map((m) => hours.flatMap((h) => (h === m.post || h === m.resend ? [h, h] : [h])));
  const series = METERS.map((m, k) => meterSeries(m, slots[k] ?? [], rand));
  const rows = [['meter_id', 'timestamp', 'Flow (Sm3/d)', 'Pressure (kPa)', 'Temperature (degC)']];
  /** @type {string[][]} */
  const resent = [];
  for (const hour of hours) {
    METERS.forEach((m, k) => {
      (slots[k] ?? []).forEach((h, i) => {
        if (h !== hour) return;
        const row = [m.id, addHours('2026-03-10T00:00:00Z', h), ...(series[k] ?? []).map((s) => at(s, i))];
        const isCorrection = h === m.resend && slots[k]?.[i - 1] === h;
        (isCorrection ? resent : rows).push(row);
      });
    });
  }
  rows.push(...resent);
  assertSeries('duplicates', rows.slice(1), { id: 0, time: 1, measures: [2, 3, 4] });
  return { name: 'csv_duplicates_rows_and_keys.csv', bytes: utf8(delimited(rows)) };
}

/** Five date columns: ambiguous d/m, resolved m/d, mixed formats, y/m/d slashes, naive datetimes. */
function datesCsv() {
  const header = ['event', 'reported', 'inspected', 'logged', 'shipped', 'started'];
  const events = [
    'Pump inspection',
    'Valve service',
    'Meter proving',
    'Pig launch',
    'Pig receipt',
    'Flare check',
    'Tank gauging',
    'Sampling',
    'ESD test',
    'Gas detector test',
  ];
  const inspected = [
    '02/03/2026',
    '02/05/2026',
    '02/09/2026',
    '02/13/2026',
    '02/14/2026',
    '02/16/2026',
    '02/18/2026',
    '02/20/2026',
    '02/23/2026',
    '02/25/2026',
  ];
  const started = ['08:15', '09:40', '07:05', '13:30', '16:45', '10:20', '11:55', '14:10', '06:50', '15:25'];
  const rows = [header];
  for (let i = 0; i < 10; i++) {
    const day = String(i + 1).padStart(2, '0');
    const logged = i === 2 ? '3 Feb 2026' : i === 6 ? 'Feb 7 2026' : `2026-02-${day}`;
    const shipped = `2026/02/${String(i + 2).padStart(2, '0')}`;
    rows.push([at(events, i), `${day}/02/2026`, at(inspected, i), logged, shipped, `2026-02-${day} ${at(started, i)}`]);
  }
  return { name: 'csv_dates_ambiguous_and_mixed.csv', bytes: utf8(delimited(rows)) };
}

/** Lab results: identifiers with leading zeros and below-detection-limit text in numeric columns. */
function leadingZeroNdlCsv() {
  const rows = [
    ['sample_id', 'batch', 'sampled', 'Benzene (ppm)', 'H2S (ppm)', 'Sulfur (wt%)'],
    ['0012', '00451', '2026-02-02', '0.8', '3.1', '0.42'],
    ['0013', '00451', '2026-02-03', '<0.5', '2.7', '0.38'],
    ['0014', '00451', '2026-02-04', '1.2', '<1', '0.45'],
    ['0015', '00451', '2026-02-05', 'ND', '4.2', '0.51'],
    ['0016', '00451', '2026-02-06', '0.9', '3.8', '0.47'],
    ['0017', '00452', '2026-02-09', '<0.5', '2.9', '0.36'],
    ['0018', '00452', '2026-02-10', '1.1', '3.3', '0.44'],
    ['0019', '00452', '2026-02-11', '0.7', '4.0', '0.49'],
    ['0020', '00452', '2026-02-12', '1.4', '3.6', '0.41'],
    ['0021', '00452', '2026-02-13', '0.6', '2.8', '0.39'],
  ];
  return { name: 'csv_leading_zero_ids_ndl.csv', bytes: utf8(delimited(rows)) };
}

/** Gulf of Mexico well locations: two swapped pairs and two typos outside the valid range. */
function latLonCsv() {
  const rows = [
    ['well_id', 'Area', 'Latitude', 'Longitude', 'Water depth (ft)'],
    ['GM-001', 'Area A', '28.1432', '-91.2875', '85.3'],
    ['GM-002', 'Area A', '28.2109', '-91.4021', '92.7'],
    ['GM-003', 'Area A', '28.0876', '-91.6630', '101.4'],
    ['GM-004', 'Area B', '-92.4410', '28.7351', '64.0'],
    ['GM-005', 'Area B', '28.6625', '-92.7184', '58.9'],
    ['GM-006', 'Area B', '128.3307', '-93.6612', '120.6'],
    ['GM-007', 'Area C', '27.8841', '-93.9057', '188.2'],
    ['GM-008', 'Area C', '27.7519', '-94.0533', '214.5'],
    ['GM-009', 'Area C', '-94.1026', '27.9184', '176.8'],
    ['GM-010', 'Area D', '27.6203', '-94.6118', '256.1'],
    ['GM-011', 'Area D', '28.0554', '-193.4471', '149.3'],
    ['GM-012', 'Area D', '27.5338', '-94.8292', '271.9'],
  ];
  return { name: 'csv_latlon_swapped_out_of_range.csv', bytes: utf8(delimited(rows)) };
}

const SCADA_START = '2026-04-01T00:00:00Z';

/** Hourly SCADA data for two assets with gaps, a duplicate, a flatline, spikes and rows out of order. */
function timeSeriesCsv() {
  const rand = mulberry32(3_141);
  const rows = [['asset_id', 'timestamp', 'Pressure (barg)', 'Flow (m3/h)', 'Temperature (degC)']];
  rows.push(...assetSeries('P-101', rand, { missing: [10, 14], duplicate: 30, flat: [20, 27], tempSpike: 38 }));
  rows.push(...assetSeries('P-102', rand, { missing: [25, 28], swap: 40, pressureSpike: 16 }));
  assertSeries('time series', rows.slice(1), {
    id: 0,
    time: 1,
    measures: [2, 3, 4],
    spikes: [`P-101|${addHours(SCADA_START, 38)}|4`, `P-102|${addHours(SCADA_START, 16)}|2`],
    flat: { 'P-101|3': 8 },
  });
  return { name: 'csv_timeseries_gaps_dups_flatline_spike.csv', bytes: utf8(delimited(rows)) };
}

/**
 * @typedef {{ missing: [number, number]; duplicate?: number; flat?: [number, number]; tempSpike?: number;
 *   swap?: number; pressureSpike?: number }} SeriesFaults
 */

/**
 * The present hours' index of each planted hour, mapped to its exact value.
 * @param {readonly number[]} hours
 * @param {(hour: number) => number | undefined} plant
 */
function plantedAt(hours, plant) {
  /** @type {Map<number, number>} */
  const planted = new Map();
  hours.forEach((hour, i) => {
    const value = plant(hour);
    if (value !== undefined) planted.set(i, value);
  });
  return planted;
}

/** The logger's second record for the duplicated hour: slightly different readings. */
const SECOND_RECORD = [{ offset: 0.04 }, { offset: 0.3 }, { offset: -0.05 }];

/**
 * @param {string} id
 * @param {() => number} rand
 * @param {SeriesFaults} f
 */
function assetSeries(id, rand, f) {
  const slots = range(48)
    .filter((h) => h < f.missing[0] || h > f.missing[1])
    .flatMap((h) => (h === f.duplicate ? [h, h] : [h]));
  /** @param {number} h */
  const wave = (h) => Math.sin((2 * Math.PI * h) / 24);
  /** @param {number} h */
  const inFlat = (h) => f.flat !== undefined && h >= f.flat[0] && h <= f.flat[1];
  /** @param {number} col */
  const second = (col) => repeats(slots, () => SECOND_RECORD[col] ?? {});
  const pressure = quietSeries({
    base: slots.map((h) => 32 + 0.5 * wave(h)),
    amplitude: 0.15,
    digits: 2,
    rand,
    copies: second(0),
    planted: plantedAt(slots, (h) => (h === f.pressureSpike ? 32 + 0.5 * wave(h) + 9 : undefined)),
  });
  const flow = quietSeries({
    base: slots.map((h) => 150 + 2 * wave(h)),
    amplitude: 0.8,
    digits: 2,
    rand,
    copies: second(1),
    planted: plantedAt(slots, (h) => (inFlat(h) ? 149.5 : undefined)),
  });
  const temperature = quietSeries({
    base: slots.map((h) => 61 + 1.5 * wave(h)),
    amplitude: 0.3,
    digits: 2,
    rand,
    copies: second(2),
    planted: plantedAt(slots, (h) => (h === f.tempSpike ? 61 + 1.5 * wave(h) + 24 : undefined)),
  });
  const rows = slots.map((h, i) => [id, addHours(SCADA_START, h), at(pressure, i), at(flow, i), at(temperature, i)]);
  if (f.swap !== undefined) swapWithNext(rows, f.swap);
  return rows;
}

/**
 * Writes the row for `hour` after the row for `hour + 1`.
 * @param {string[][]} rows
 * @param {number} hour
 */
function swapWithNext(rows, hour) {
  const ts = addHours(SCADA_START, hour);
  const i = rows.findIndex((r) => r[1] === ts);
  const [a, b] = [rows[i], rows[i + 1]];
  if (i < 0 || a === undefined || b === undefined) throw new Error(`No rows to swap at hour ${hour}.`);
  rows[i] = b;
  rows[i + 1] = a;
}

/** Units written inside the cells, mixed within a column, and a numeric column with no unit at all. */
function mixedUnitsCsv() {
  const rows = [
    ['well_id', 'date', 'Pressure', 'Temperature', 'Choke size'],
    ['W-1', '2026-02-02', '1205.3 psia', '182 degF', '32'],
    ['W-2', '2026-02-02', '1310.5 psia', '176 °F', '28'],
    ['W-1', '2026-02-03', '1198.7 psia', '181 degF', '32'],
    ['W-2', '2026-02-03', '8310 kPa', '84 degC', '28'],
    ['W-1', '2026-02-04', '83.1 bar', '83 °C', '34'],
    ['W-2', '2026-02-04', '90.2 bar', '175 degF', '30'],
    ['W-1', '2026-02-05', '1190.2 psia', '180 degF', '34'],
    ['W-2', '2026-02-05', '1302.8 psia', '176 degF', '30'],
  ];
  return { name: 'csv_mixed_units_in_cells.csv', bytes: utf8(delimited(rows)) };
}

/** A legacy well master export: pipes, commas inside unquoted fields, no line break at the end. */
function pipeCsv() {
  const rows = [
    ['well_id', 'Well name', 'Operator', 'Spud date', 'TD (ft)', 'KB elevation (ft)', 'Status'],
    ['TX-1001', 'Mesa Verde 1H', 'Alder Basin Energy, Inc.', '2019-04-12', '14250', '2875.4', 'Producing'],
    ['TX-1002', 'Mesa Verde 2H', 'Alder Basin Energy, Inc.', '2019-06-03', '14810', '2879.1', 'Producing'],
    ['TX-1003', 'Coyote Draw 4', 'Brindle Creek Operating, LLC', '2020-01-22', '11320', '3011.7', 'Shut-in'],
    ['TX-1004', 'Coyote Draw 5', 'Brindle Creek Operating, LLC', '2020-03-15', '11475', '3008.2', 'Producing'],
    ['TX-1005', 'Salt Flat 7', 'Cobalt Flats Upstream', '2021-08-09', '9875', '2650.0', 'Plugged and abandoned'],
    ['TX-1006', 'Salt Flat 8', 'Cobalt Flats Upstream', '2021-10-30', '10020', '2655.6', 'Drilling'],
    ['TX-1007', 'Red Bluff 12', 'Alder Basin Energy, Inc.', '2022-05-17', '15420', '2902.3', 'Producing'],
    ['TX-1008', 'Red Bluff 14', 'Alder Basin Energy, Inc.', '2022-07-04', '15130', '2898.9', 'Temporarily abandoned'],
  ];
  return { name: 'csv_pipe_delimited.csv', bytes: utf8(delimited(rows, { delimiter: '|', finalEol: false })) };
}

/** One test per well; five values break physics, two look odd but are possible. */
function physicalImpossibleCsv() {
  const rows = [
    [
      'well_id',
      'test_date',
      'Pressure (psia)',
      'Temperature (degC)',
      'Oil (bbl/d)',
      'Gas (Mscf/d)',
      'Water cut (%)',
      'WHP (psig)',
    ],
    ['PI-01', '2026-02-02', '1845.2', '78.4', '1520.6', '1810.2', '14.20', '420.5'],
    ['PI-02', '2026-02-02', '-5.0', '77.9', '1488.1', '1795.4', '15.10', '415.2'],
    ['PI-03', '2026-02-03', '1902.7', '-300.0', '1610.3', '1902.8', '12.80', '431.9'],
    ['PI-04', '2026-02-03', '1876.4', '-10.0', '1575.9', '1850.1', '13.60', '428.7'],
    ['PI-05', '2026-02-04', '1799.3', '76.5', '-12.5', '1702.6', '18.40', '402.3'],
    ['PI-06', '2026-02-04', '1811.8', '79.1', '1498.4', '1766.0', '104.20', '409.8'],
    ['PI-07', '2026-02-05', '1858.0', '80.2', '1533.7', '1820.9', '-0.50', '-3.2'],
    ['PI-08', '2026-02-05', '1832.6', '78.8', '1547.2', '1833.3', '16.90', '418.4'],
    ['PI-09', '2026-02-06', '1867.9', '77.4', '1561.0', '1845.7', '15.70', '424.6'],
    ['PI-10', '2026-02-06', '1821.4', '79.6', '1529.8', '1812.5', '17.30', '412.1'],
  ];
  return { name: 'csv_physical_impossible.csv', bytes: utf8(delimited(rows)) };
}

// ---------------------------------------------------------------------------------------------
// GeoJSON fixtures

/** @param {unknown} doc */
function geojson(doc) {
  return utf8(`${JSON.stringify(doc, null, 2)}\n`);
}

/** @param {Record<string, unknown>} properties @param {unknown} geometry */
function feature(properties, geometry) {
  return { type: 'Feature', properties, geometry };
}

/** @param {number} lon @param {number} lat */
function point(lon, lat) {
  return { type: 'Point', coordinates: [lon, lat] };
}

function wellsWgs84() {
  const wells = [
    ['NS-W01', 'Alfa Øst', 'producing', '2014-03-11', 3520.5, 91.2, 1.8901, 58.4412],
    ['NS-W02', 'Alfa Øst', 'producing', '2014-07-02', 3612.0, 91.8, 1.8957, 58.4436],
    ['NS-W03', 'Alfa Øst', 'injector', '2015-01-19', 3388.4, 92.1, 1.8823, 58.4398],
    ['NS-W04', 'Bravo Sør', 'producing', '2016-05-27', 4105.7, 108.6, 2.1145, 58.2051],
    ['NS-W05', 'Bravo Sør', 'plugged', '2016-09-14', 3950.2, 109.3, 2.1201, 58.2087],
    ['NS-W06', 'Bravo Sør', 'producing', '2017-02-08', 4210.9, 107.9, 2.1088, 58.2016],
    ['NS-W07', 'Charlie Nord', 'producing', '2018-06-21', 2875.3, 76.4, 1.6542, 58.712],
    ['NS-W08', 'Charlie Nord', 'injector', '2018-11-03', 2990.8, 77.0, 1.6611, 58.7159],
    ['NS-W09', 'Charlie Nord', 'producing', '2019-04-16', 3044.1, 75.8, 1.6487, 58.7093],
    ['NS-W10', 'Charlie Nord', 'suspended', '2020-08-30', 2930.6, 76.9, 1.6575, 58.7181],
  ];
  const features = wells.map(([id, platform, status, spud, td, depth, lon, lat]) =>
    feature(
      { well_id: id, platform, status, spud_date: spud, 'TD (m)': td, 'Water depth (m)': depth },
      point(Number(lon), Number(lat)),
    ),
  );
  return { name: 'geojson_wells_points_wgs84.geojson', bytes: geojson({ type: 'FeatureCollection', features }) };
}

function legacyCrs27700() {
  const wells = [
    ['UK-ON-01', 'Kimmeridge Bay', 12.4, 391820.5, 79410.0],
    ['UK-ON-02', 'Wareham', 18.9, 392505.0, 87230.5],
    ['UK-ON-03', 'Arne', 7.6, 397640.0, 88115.0],
    ['UK-ON-04', 'Furzey Island', 4.1, 401110.5, 87390.0],
    ['UK-ON-05', 'Goathorn', 6.3, 401870.0, 85780.5],
    ['UK-ON-06', 'Bestwall', 9.8, 393725.0, 87845.0],
  ];
  const features = wells.map(([id, site, elevation, e, n]) =>
    feature({ well_id: id, site, 'Elevation (m)': elevation }, { type: 'Point', coordinates: [e, n] }),
  );
  const crs = { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::27700' } };
  const doc = { type: 'FeatureCollection', name: 'onshore_wells_bng', crs, features };
  return { name: 'geojson_legacy_crs_27700.geojson', bytes: geojson(doc) };
}

/**
 * A closed square ring around (lon, lat) with half-width d, counter-clockwise.
 * @param {number} lon
 * @param {number} lat
 * @param {number} d
 */
function square(lon, lat, d) {
  return [
    [lon - d, lat - d],
    [lon + d, lat - d],
    [lon + d, lat + d],
    [lon - d, lat + d],
    [lon - d, lat - d],
  ];
}

function invalidGeometries() {
  const items = [
    ['well', 'valid point', point(1.7501, 57.4802)],
    [
      'lease',
      'ring not closed',
      {
        type: 'Polygon',
        coordinates: [
          square(1.8, 57.5, 0.01)
            .slice(0, 4)
            .concat([[1.795, 57.49]]),
        ],
      },
    ],
    [
      'platform',
      'valid polygon with a hole',
      { type: 'Polygon', coordinates: [square(1.9, 57.6, 0.02), square(1.9, 57.6, 0.005).reverse()] },
    ],
    [
      'lease',
      'ring with three positions',
      {
        type: 'Polygon',
        coordinates: [
          [
            [2.0, 57.7],
            [2.01, 57.7],
            [2.0, 57.7],
          ],
        ],
      },
    ],
    [
      'pipeline',
      'valid line',
      {
        type: 'LineString',
        coordinates: [
          [1.75, 57.48],
          [1.82, 57.52],
          [1.9, 57.6],
        ],
      },
    ],
    [
      'exclusion zone',
      'bow-tie ring crosses itself',
      {
        type: 'Polygon',
        coordinates: [
          [
            [2.1, 57.8],
            [2.12, 57.82],
            [2.12, 57.8],
            [2.1, 57.82],
            [2.1, 57.8],
          ],
        ],
      },
    ],
    ['pipeline', 'line with one position', { type: 'LineString', coordinates: [[1.76, 57.49]] }],
    ['well', 'longitude is null', { type: 'Point', coordinates: [null, 57.1] }],
    [
      'lease',
      'valid multipolygon',
      { type: 'MultiPolygon', coordinates: [[square(2.2, 57.9, 0.01)], [square(2.25, 57.9, 0.01)]] },
    ],
    ['lease', 'multipolygon without coordinates', { type: 'MultiPolygon', coordinates: [] }],
    ['well', 'geometry missing', null],
    ['exclusion zone', 'unknown geometry type', { type: 'Circle', coordinates: [1.8, 57.5], radius: 500 }],
  ];
  const features = items.map(([kind, note, geometry], i) =>
    feature({ asset_id: `A-${String(i + 1).padStart(2, '0')}`, kind, note }, geometry),
  );
  return { name: 'geojson_invalid_geometries.geojson', bytes: geojson({ type: 'FeatureCollection', features }) };
}

function swappedLonLat() {
  const wells = [
    ['WA-01', 72.4, 115.6214, -20.1132, false],
    ['WA-02', 74.9, 115.6588, -20.0871, false],
    ['WA-03', 81.3, 115.7402, -20.2245, true],
    ['WA-04', 69.8, 115.5931, -20.0419, false],
    ['WA-05', 88.0, 115.8117, -20.3306, false],
    ['WA-06', 92.6, 115.8743, -20.4012, true],
    ['WA-07', 77.1, 115.6995, -20.1658, false],
    ['WA-08', 85.5, 115.7826, -20.2871, false],
    ['WA-09', 96.2, 115.931, -20.4655, true],
    ['WA-10', 79.7, 115.7208, -20.198, false],
  ];
  const features = wells.map(([id, depth, lon, lat, swapped]) =>
    feature(
      { well_id: id, 'Water depth (m)': depth },
      swapped ? point(Number(lat), Number(lon)) : point(Number(lon), Number(lat)),
    ),
  );
  return { name: 'geojson_swapped_lonlat.geojson', bytes: geojson({ type: 'FeatureCollection', features }) };
}

function mixedGeometryNested() {
  const op = (/** @type {string} */ name, /** @type {number} */ share) => ({ name, share });
  const assets = [
    ['MX-01', 'well', op('Alder Basin Energy', 0.6), ['subsea', 'gas'], 45.5, '2015-06-01', true, point(1.81, 57.51)],
    [
      'MX-02',
      'pipeline',
      op('Alder Basin Energy', 0.6),
      ['export'],
      310,
      '2012-09-15',
      true,
      {
        type: 'LineString',
        coordinates: [
          [1.81, 57.51],
          [1.95, 57.6],
          [2.3, 57.75],
        ],
      },
    ],
    [
      'MX-03',
      'platform',
      op('Brindle Creek Operating', 1),
      ['manned', 'oil'],
      120,
      '2009-03-20',
      true,
      { type: 'Polygon', coordinates: [square(1.95, 57.6, 0.002)] },
    ],
    [
      'MX-04',
      'well cluster',
      op('Brindle Creek Operating', 1),
      ['subsea'],
      'pending',
      '2024-11-05',
      false,
      {
        type: 'MultiPoint',
        coordinates: [
          [2.01, 57.62],
          [2.02, 57.63],
        ],
      },
    ],
    [
      'MX-05',
      'flowlines',
      op('Cobalt Flats Upstream', 0.35),
      [],
      60.25,
      '2018-02-12',
      true,
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [2.01, 57.62],
            [1.95, 57.6],
          ],
          [
            [2.02, 57.63],
            [1.95, 57.6],
          ],
        ],
      },
    ],
    [
      'MX-06',
      'field',
      op('Cobalt Flats Upstream', 0.35),
      ['gas', 'condensate'],
      250,
      '2011-07-30',
      true,
      { type: 'MultiPolygon', coordinates: [[square(2.4, 57.8, 0.05)], [square(2.6, 57.85, 0.04)]] },
    ],
    [
      'MX-07',
      'facility',
      op('Alder Basin Energy', 0.6),
      ['onshore'],
      400,
      null,
      true,
      {
        type: 'GeometryCollection',
        geometries: [
          point(-2.1, 57.2),
          {
            type: 'LineString',
            coordinates: [
              [-2.1, 57.2],
              [-2.05, 57.22],
            ],
          },
        ],
      },
    ],
    [
      'MX-08',
      'well',
      op('Brindle Creek Operating', 1),
      ['subsea', 'oil'],
      38.75,
      '2021-04-18',
      false,
      point(2.03, 57.64),
    ],
  ];
  const features = assets.map(([id, type, operator, tags, capacity, commissioned, active, geometry]) => {
    /** @type {Record<string, unknown>} */
    const props = { asset_id: id, asset_type: type, operator, tags, 'Capacity (MMscf/d)': capacity };
    // MX-07 has no commissioning date in the source system: the key is absent, not null.
    if (commissioned !== null) props['commissioned'] = commissioned;
    props['active'] = active;
    return feature(props, geometry);
  });
  return {
    name: 'geojson_mixed_geometry_nested_props.geojson',
    bytes: geojson({ type: 'FeatureCollection', features }),
  };
}

// ---------------------------------------------------------------------------------------------
// JSON and Parquet

/**
 * A reporting system's API response saved to disk: the well tests sit under "data", next to
 * paging members that are not rows. One record lacks the water cut key, one holds it as null, a
 * key first appears in the fifth record, the choke settings are nested objects, and one water cut
 * is over 100 %.
 */
function jsonApiWrapper() {
  const choke = (/** @type {number} */ size) => ({ size, unit: '64ths' });
  const data = [
    {
      well_id: 'NS-B01',
      test_date: '2026-03-02',
      'Oil rate (bbl/d)': 1250.5,
      'Water cut (%)': 12.5,
      choke: choke(32),
      flowing: true,
    },
    {
      well_id: 'NS-B02',
      test_date: '2026-03-02',
      'Oil rate (bbl/d)': 980,
      'Water cut (%)': 30.25,
      choke: choke(28),
      flowing: true,
    },
    {
      well_id: 'NS-B03',
      test_date: '2026-03-03',
      'Oil rate (bbl/d)': 0,
      'Water cut (%)': null,
      choke: null,
      flowing: false,
    },
    { well_id: 'NS-B04', test_date: '2026-03-03', 'Oil rate (bbl/d)': 1105.75, choke: choke(30), flowing: true },
    {
      well_id: 'NS-B05',
      test_date: '2026-03-04',
      'Oil rate (bbl/d)': 1430,
      'Water cut (%)': 8,
      choke: choke(36),
      flowing: true,
      comment: 'after workover',
    },
    {
      well_id: 'NS-B06',
      test_date: '2026-03-05',
      'Oil rate (bbl/d)': 1010.5,
      'Water cut (%)': 140,
      choke: choke(30),
      flowing: true,
    },
  ];
  const doc = { status: 'ok', count: data.length, data, next: null };
  return { name: 'json_api_wrapper_nested.json', bytes: utf8(`${JSON.stringify(doc, null, 2)}\n`) };
}

/**
 * Well tests exported as JSON Lines with CRLF line endings: a blank line between two records, the
 * -999.25 null marker as a number, and a "notes" key that first appears in the sixth record.
 */
function jsonLinesWellTests() {
  const records = [
    { well_id: 'WT-01', start: '2026-02-01T06:00:00Z', 'Gas rate (MMscf/d)': 12.4, 'Separator pressure (psig)': 850 },
    { well_id: 'WT-02', start: '2026-02-01T18:00:00Z', 'Gas rate (MMscf/d)': 11.95, 'Separator pressure (psig)': 842 },
    { well_id: 'WT-03', start: '2026-02-02T06:00:00Z', 'Gas rate (MMscf/d)': 13.1, 'Separator pressure (psig)': 861 },
    null,
    {
      well_id: 'WT-04',
      start: '2026-02-02T18:00:00Z',
      'Gas rate (MMscf/d)': -999.25,
      'Separator pressure (psig)': 838,
    },
    { well_id: 'WT-05', start: '2026-02-03T06:00:00Z', 'Gas rate (MMscf/d)': 12.75, 'Separator pressure (psig)': 855 },
    {
      well_id: 'WT-06',
      start: '2026-02-03T18:00:00Z',
      'Gas rate (MMscf/d)': 12.2,
      'Separator pressure (psig)': 849,
      notes: 'choke changed to 40/64',
    },
    { well_id: 'WT-07', start: '2026-02-04T06:00:00Z', 'Gas rate (MMscf/d)': 12.6, 'Separator pressure (psig)': 851 },
  ];
  const text = records.map((r) => (r === null ? '' : JSON.stringify(r))).join('\r\n');
  return { name: 'jsonl_well_tests_crlf.jsonl', bytes: utf8(`${text}\r\n`) };
}

/**
 * Daily well data as a data platform writes Parquet: typed columns (text, DATE, TIMESTAMP in
 * microseconds marked UTC, DOUBLE, INT64, BOOLEAN), nulls, and units in the column names.
 */
function parquetWellDaily() {
  const days = range(8);
  const wells = ['NS-C01', 'NS-C02'];
  const rows = days.map((i) => ({
    well: /** @type {string} */ (wells[i % 2]),
    day: 20_513 + Math.floor(i / 2),
    at: BigInt(Date.parse('2026-03-01T06:00:00Z') + Math.floor(i / 2) * 86_400_000 + (i % 2) * 60_000) * 1000n,
    rate: i === 5 ? null : 900 + i * 12.5,
    choke: BigInt(28 + (i % 3) * 4),
    shutIn: i === 6,
    remark: i === 6 ? 'shut in for survey' : null,
  }));
  /** @param {string} name @param {string} type @param {string | undefined} converted */
  const column = (name, type, converted) => ({
    name,
    type,
    repetition_type: 'OPTIONAL',
    ...(converted === undefined ? {} : { converted_type: converted }),
  });
  const schema = [
    { name: 'root', num_children: 7 },
    column('well_id', 'BYTE_ARRAY', 'UTF8'),
    column('day', 'INT32', 'DATE'),
    column('recorded_at', 'INT64', 'TIMESTAMP_MICROS'),
    column('Oil rate (bbl/d)', 'DOUBLE', undefined),
    column('choke_64ths', 'INT64', undefined),
    column('shut_in', 'BOOLEAN', undefined),
    column('remark', 'BYTE_ARRAY', 'UTF8'),
  ];
  const buffer = parquetWriteBuffer({
    columnData: [
      { name: 'well_id', data: rows.map((r) => r.well) },
      { name: 'day', data: rows.map((r) => r.day) },
      { name: 'recorded_at', data: rows.map((r) => r.at) },
      { name: 'Oil rate (bbl/d)', data: rows.map((r) => r.rate) },
      { name: 'choke_64ths', data: rows.map((r) => r.choke) },
      { name: 'shut_in', data: rows.map((r) => r.shutIn) },
      { name: 'remark', data: rows.map((r) => r.remark) },
    ],
    schema: /** @type {never} */ (schema),
  });
  return { name: 'parquet_well_daily_typed.parquet', bytes: new Uint8Array(buffer) };
}

// ---------------------------------------------------------------------------------------------
// Output

/** @returns {FixtureFile[]} */
export function buildTextFixtures() {
  return [
    goldenCsv(),
    semicolonCp1252Csv(),
    utf8BomCrlfCsv(),
    utf16TabTsv(),
    titleRowsCsv(),
    nullMarkersCsv(),
    quotedNewlinesRaggedCsv(),
    duplicatesCsv(),
    datesCsv(),
    leadingZeroNdlCsv(),
    latLonCsv(),
    timeSeriesCsv(),
    mixedUnitsCsv(),
    pipeCsv(),
    physicalImpossibleCsv(),
    wellsWgs84(),
    legacyCrs27700(),
    invalidGeometries(),
    swappedLonLat(),
    mixedGeometryNested(),
    jsonApiWrapper(),
    jsonLinesWellTests(),
    parquetWellDaily(),
  ];
}

/**
 * '<hex>  <name>' lines in name order, the format of GNU sha256sum.
 * @param {string} dir
 */
function sumsFile(dir) {
  const missing = ALL_FIXTURES.filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) {
    throw new Error(`Cannot write SHA256SUMS: missing ${missing.join(', ')}. Run make_xlsx_fixtures.py first.`);
  }
  return [...ALL_FIXTURES]
    .sort()
    .map((name) => `${fileSha256(join(dir, name))}  ${name}\n`)
    .join('');
}

/** @param {string} path */
function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, sums: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1] !== undefined) options.out = String(argv[++i]);
    else if (arg === '--no-sums') options.sums = false;
    else throw new Error(`unknown option "${arg}". Usage: gen-text-fixtures.mjs [--out <dir>] [--no-sums]`);
  }
  return options;
}

function main() {
  const { out, sums } = parseArgs(process.argv.slice(2));
  mkdirSync(out, { recursive: true });
  const files = buildTextFixtures();
  for (const { name, bytes } of files) writeFileSync(join(out, name), bytes);
  if (sums) writeFileSync(join(out, 'SHA256SUMS'), sumsFile(out));
  console.log(
    `gen-text-fixtures: ${files.length} text fixtures written to ${out}${sums ? ', SHA256SUMS updated' : ''}`,
  );
}

if (isEntryScript(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`gen-text-fixtures: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
