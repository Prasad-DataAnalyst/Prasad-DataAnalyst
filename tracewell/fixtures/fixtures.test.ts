/**
 * Checks the messy-file library itself: every fixture is present, unchanged and byte-exact, every
 * expected file has the FixtureExpectation shape, and the expectations agree with the files and
 * with the counting conventions of fixtures/README.md.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseChecksumsFile, readZip, sha256Hex } from '@tw/io';
import {
  FIXTURE_NAMES,
  FIXTURES_DIR,
  fixtureBytes,
  fixtureExpectation,
  fixturePath,
  fixtureSource,
  type FixtureExpectation,
  type FixtureName,
} from './index';

const GEN_LARGE = fileURLToPath(new URL('./generators/gen-large-csv.mjs', import.meta.url));

const byFormat = (ext: string): FixtureName[] => FIXTURE_NAMES.filter((n) => n.endsWith(ext));
const XLSX = byFormat('.xlsx');
const DELIMITED = FIXTURE_NAMES.filter((n) => n.endsWith('.csv') || n.endsWith('.tsv'));
const GEOJSON = byFormat('.geojson');

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// The FixtureExpectation shape, as a schema local to this test (independent of the loader's check)

const NOTE_CODE = z.enum(['TW-IMP-001', 'TW-IMP-002', 'TW-IMP-003', 'TW-IMP-004']);
const DETECTION_KEY = z.enum([
  'encoding',
  'delimiter',
  'decimalSeparator',
  'skipLines',
  'headerRows',
  'sheet',
  'date1904',
  'crs',
]);
const LINE = z.number().int().positive();

const expectationSchema = z
  .object({
    file: z.enum(FIXTURE_NAMES as [FixtureName, ...FixtureName[]]),
    format: z.enum(['csv', 'tsv', 'xlsx', 'geojson', 'json', 'parquet']),
    detections: z
      .object({
        encoding: z.enum(['utf-8', 'utf-16le', 'utf-16be', 'windows-1252']),
        delimiter: z.enum([',', ';', '\t', '|']),
        decimalSeparator: z.enum(['.', ',']),
        skipLines: z.number().int().nonnegative(),
        headerRows: z.number().int().positive(),
        sheet: z.string().min(1),
        date1904: z.boolean(),
        crs: z.string().regex(/^(?:OGC:CRS84|EPSG:\d+)$/),
      })
      .partial()
      .strict(),
    confidence: z.partialRecord(DETECTION_KEY, z.enum(['high', 'medium', 'low'])),
    rowCount: z.number().int().positive(),
    columns: z
      .array(
        z
          .object({
            name: z.string().min(1),
            type: z.enum(['string', 'integer', 'number', 'boolean', 'date', 'datetime', 'geometry']),
            unit: z.string().min(1).nullable(),
            role: z.enum([
              'measure',
              'id',
              'time',
              'latitude',
              'longitude',
              'easting',
              'northing',
              'geometry',
              'unit',
              'text',
            ]),
            assumed: z
              .array(z.enum(['dateFormat', 'decimalSeparator', 'nullMarkers', 'role', 'timezone', 'type', 'unit']))
              .min(1)
              .optional(),
          })
          .strict(),
      )
      .min(1),
    issues: z.record(z.string().regex(/^TW-(?:DQ|UNIT|TIME|GEO|IMP)-\d{3}$/), z.number().int().positive()),
    notes: z.array(NOTE_CODE),
    locators: z
      .object({ rows: z.array(LINE), notes: z.partialRecord(NOTE_CODE, z.array(LINE)).optional() })
      .strict()
      .optional(),
    workingDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

function rawExpectation(name: FixtureName): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.expected.json`), 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// The library and its checksums

describe('the messy-file library', () => {
  it('lists 31 distinct fixtures', () => {
    expect(new Set(FIXTURE_NAMES).size).toBe(31);
    expect(DELIMITED).toHaveLength(15);
    expect(XLSX).toHaveLength(6);
    expect(GEOJSON).toHaveLength(5);
  });

  it('holds exactly the fixtures, their expected files and SHA256SUMS', () => {
    const wanted = ['SHA256SUMS', ...FIXTURE_NAMES, ...FIXTURE_NAMES.map((n) => `${n}.expected.json`)];
    expect(readdirSync(FIXTURES_DIR).sort()).toEqual(wanted.sort());
  });

  it('has a SHA256SUMS entry for every fixture and nothing else', () => {
    const sums = parseChecksumsFile(readFileSync(join(FIXTURES_DIR, 'SHA256SUMS'), 'utf8'));
    expect(sums.map((e) => e.path).sort()).toEqual([...FIXTURE_NAMES].sort());
  });

  // Guards against line-ending normalisation by git or an editor, and against accidental edits.
  it.each(FIXTURE_NAMES)('%s matches SHA256SUMS', (name) => {
    const sums = parseChecksumsFile(readFileSync(join(FIXTURES_DIR, 'SHA256SUMS'), 'utf8'));
    expect(sha256Hex(fixtureBytes(name))).toBe(sums.find((e) => e.path === name)?.sha256);
  });
});

describe('the loader', () => {
  it('gives absolute paths inside fixtures/messy', () => {
    expect(isAbsolute(FIXTURES_DIR)).toBe(true);
    for (const name of FIXTURE_NAMES) expect(relative(FIXTURES_DIR, fixturePath(name))).toBe(name);
  });

  it('returns a fresh copy of the bytes on every call', () => {
    const first = fixtureBytes('csv_pipe_delimited.csv');
    first.fill(0);
    const second = fixtureBytes('csv_pipe_delimited.csv');
    expect(second[0]).toBe('w'.charCodeAt(0));
    expect(second.byteOffset).toBe(0);
    expect(second.byteLength).toBe(second.buffer.byteLength);
  });

  it('offers a ByteSource named after the fixture', async () => {
    const source = fixtureSource('tsv_utf16le_bom.tsv');
    expect(source.name).toBe('tsv_utf16le_bom.tsv');
    expect(source.size).toBe(fixtureBytes('tsv_utf16le_bom.tsv').byteLength);
    expect([...(await source.slice(0, 2))]).toEqual([0xff, 0xfe]);
    const chunks: Uint8Array[] = [];
    for await (const chunk of source.stream()) chunks.push(chunk);
    expect(chunks.reduce((n, c) => n + c.byteLength, 0)).toBe(source.size);
  });

  it('refuses a name that is not a fixture', () => {
    const bogus = 'not_a_fixture.csv' as FixtureName;
    expect(() => fixturePath(bogus)).toThrow(/not a fixture/);
    expect(() => fixtureExpectation(bogus)).toThrow(/not a fixture/);
  });
});

// ---------------------------------------------------------------------------------------------
// Expected files

describe('expected files', () => {
  it.each(FIXTURE_NAMES)('%s.expected.json matches the FixtureExpectation shape', (name) => {
    const parsed = expectationSchema.parse(rawExpectation(name));
    expect(parsed.file).toBe(name);
    expect(fixtureExpectation(name)).toEqual(parsed);
  });

  it.each(FIXTURE_NAMES)('%s: the format follows the file extension', (name) => {
    const extension = name.slice(name.lastIndexOf('.') + 1);
    // JSON Lines files are JSON records in the 'lines' layout; a legacy .xls is read as an Excel workbook.
    const format = extension === 'jsonl' ? 'json' : extension === 'xls' ? 'xlsx' : extension;
    expect(fixtureExpectation(name).format).toBe(format);
  });

  it.each(FIXTURE_NAMES)('%s: the expectation follows the README conventions', (name) => {
    expect(conventionProblems(fixtureExpectation(name))).toEqual([]);
  });
});

const DETECTIONS_BY_FORMAT: Record<FixtureExpectation['format'], string[]> = {
  csv: ['encoding', 'delimiter', 'decimalSeparator', 'skipLines', 'headerRows'],
  tsv: ['encoding', 'delimiter', 'decimalSeparator', 'skipLines', 'headerRows'],
  xlsx: ['sheet', 'date1904', 'skipLines', 'headerRows'],
  geojson: ['encoding', 'crs'],
  json: ['encoding'],
  parquet: [],
};

/** Rules flagging rows across the whole dataset: their count can never exceed the row count. */
const DATASET_ROW_RULES = ['TW-DQ-002', 'TW-DQ-003', 'TW-TIME-001', 'TW-TIME-002', 'TW-TIME-003', 'TW-IMP-001'];
const GEO_ROW_RULES = ['TW-GEO-001', 'TW-GEO-002', 'TW-GEO-003', 'TW-GEO-006'];
/** Rules raised once per dataset. */
const DATASET_RULES = ['TW-IMP-002', 'TW-IMP-003', 'TW-IMP-004', 'TW-IMP-005', 'TW-GEO-004'];

function expectedDetections(e: FixtureExpectation): string[] {
  const keys = [...DETECTIONS_BY_FORMAT[e.format]];
  const roles = new Set(e.columns.map((c) => c.role));
  if ((e.format === 'csv' || e.format === 'tsv') && roles.has('latitude') && roles.has('longitude')) keys.push('crs');
  return keys;
}

function assumedCount(e: FixtureExpectation, detection: string, type?: string): number {
  return e.columns.filter((c) => c.assumed?.includes(detection) && (type === undefined || c.type === type)).length;
}

/** The README's rules that tie detections, columns and issue counts together. */
function conventionProblems(e: FixtureExpectation): string[] {
  const problems: string[] = [];
  const issue = (rule: string): number => e.issues[rule] ?? 0;
  const check = (ok: boolean, message: string): void => {
    if (!ok) problems.push(message);
  };
  check(Object.keys(e.detections).sort().join() === expectedDetections(e).sort().join(), 'detections for the format');
  const anyAssumed = Object.values(e.confidence).some((c) => c !== 'high') || e.columns.some((c) => c.assumed);
  check(issue('TW-IMP-005') === (anyAssumed ? 1 : 0), 'TW-IMP-005 exactly when something is assumed');
  check(
    issue('TW-IMP-004') === (e.confidence.encoding !== undefined && e.confidence.encoding !== 'high' ? 1 : 0),
    'TW-IMP-004',
  );
  check(
    issue('TW-TIME-004') === assumedCount(e, 'timezone', 'datetime'),
    'TW-TIME-004 per datetime column with assumed zone',
  );
  check(assumedCount(e, 'timezone') === assumedCount(e, 'timezone', 'datetime'), 'time zones only on datetime columns');
  check(issue('TW-TIME-005') === assumedCount(e, 'dateFormat'), 'TW-TIME-005 per column with assumed day/month order');
  const unitless = e.columns.filter((c) => c.role === 'measure' && c.unit === null).length;
  check(issue('TW-UNIT-001') === unitless, 'TW-UNIT-001 per measure column without a unit');
  for (const code of ['TW-IMP-001', 'TW-IMP-002', 'TW-IMP-003', 'TW-IMP-004'] as const) {
    check((e.notes ?? []).includes(code) === issue(code) > 0, `${code} note and issue go together`);
  }
  for (const rule of [...DATASET_ROW_RULES, ...GEO_ROW_RULES])
    check(issue(rule) <= e.rowCount, `${rule} within the rows`);
  for (const rule of DATASET_RULES) check(issue(rule) <= 1, `${rule} at most once`);
  check(
    e.format === 'geojson' || issue('TW-GEO-001') + issue('TW-GEO-006') === 0,
    'geometry rules need a geometry column',
  );
  check(new Set(e.columns.map((c) => c.name)).size === e.columns.length, 'unique column names');
  check(
    e.columns.findIndex((c) => c.role === 'geometry') === (e.format === 'geojson' ? e.columns.length - 1 : -1),
    'geometry column last, GeoJSON only',
  );
  check(e.locators === undefined || e.locators.rows.length === e.rowCount, 'a locator for every row');
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Bytes of the text fixtures

/** Splits text into records the RFC 4180 way: 1-based start line and field count of each. */
function scanRecords(text: string, delimiter: string): { line: number; fields: number }[] {
  const records: { line: number; fields: number }[] = [];
  let line = 1;
  let quoted = false;
  let current: { line: number; fields: number } | null = null;
  for (const ch of text) {
    current ??= { line, fields: 1 };
    if (ch === '"') quoted = !quoted;
    else if (ch === delimiter && !quoted) current.fields++;
    else if (ch === '\n') {
      line++;
      if (!quoted) {
        records.push(current);
        current = null;
      }
    }
  }
  if (current !== null) records.push(current);
  return records;
}

function decodedText(name: FixtureName, encoding: string): string {
  // TextDecoder drops a leading byte-order mark, as the readers do.
  return new TextDecoder(encoding).decode(fixtureBytes(name));
}

/** Data records after the lines above the header and the header itself. */
function dataRecords(name: FixtureName): { line: number; fields: number }[] {
  const { detections } = fixtureExpectation(name);
  const records = scanRecords(decodedText(name, detections.encoding ?? 'utf-8'), detections.delimiter ?? ',');
  return records.slice((detections.skipLines ?? 0) + (detections.headerRows ?? 1));
}

describe('text fixture bytes', () => {
  it('csv_utf8_bom_crlf.csv starts with a UTF-8 byte-order mark and ends every line with CRLF', () => {
    const bytes = fixtureBytes('csv_utf8_bom_crlf.csv');
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).toContain('\r\n');
    expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
  });

  it('tsv_utf16le_bom.tsv starts with FF FE', () => {
    expect([...fixtureBytes('tsv_utf16le_bom.tsv').subarray(0, 2)]).toEqual([0xff, 0xfe]);
  });

  it('csv_semicolon_decimalcomma_cp1252.csv holds 0xB0 (degree sign) and no UTF-8 multi-byte sequence', () => {
    const bytes = fixtureBytes('csv_semicolon_decimalcomma_cp1252.csv');
    expect(bytes.includes(0xb0)).toBe(true);
    expect(bytes.includes(0x80)).toBe(true);
    const latin1 = Buffer.from(bytes).toString('latin1');
    expect(latin1).not.toMatch(/[\xc2-\xdf][\x80-\xbf]|[\xe0-\xef][\x80-\xbf]{2}|[\xf0-\xf4][\x80-\xbf]{3}/);
  });

  it('csv_pipe_delimited.csv has no line break after its last row', () => {
    expect(fixtureBytes('csv_pipe_delimited.csv').at(-1)).not.toBe(0x0a);
  });

  it.each(DELIMITED)('%s has as many data records as its expected rowCount', (name) => {
    expect(dataRecords(name)).toHaveLength(fixtureExpectation(name).rowCount);
  });

  it.each(GEOJSON)('%s has as many features as its expected rowCount', (name) => {
    const doc = JSON.parse(decodedText(name, 'utf-8')) as { features: unknown[] };
    expect(doc.features).toHaveLength(fixtureExpectation(name).rowCount);
  });

  it('csv_quoted_newlines_ragged.csv: records start on the expected lines and the ragged ones are noted', () => {
    const records = dataRecords('csv_quoted_newlines_ragged.csv');
    const { locators, columns } = fixtureExpectation('csv_quoted_newlines_ragged.csv');
    expect(records.map((r) => r.line)).toEqual(locators?.rows);
    const ragged = records.filter((r) => r.fields !== columns.length).map((r) => r.line);
    expect(ragged).toEqual(locators?.notes?.['TW-IMP-001']);
  });

  it('csv_title_rows_units_in_header.csv: data starts on line 5, after three title lines and the header', () => {
    const records = dataRecords('csv_title_rows_units_in_header.csv');
    expect(records.map((r) => r.line)).toEqual(fixtureExpectation('csv_title_rows_units_in_header.csv').locators?.rows);
    expect(records[0]?.line).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------------
// XLSX structure

function workbookXml(name: FixtureName): string {
  return readZip(fixtureBytes(name)).readText('xl/workbook.xml');
}

function sheetXmls(name: FixtureName): string[] {
  const zip = readZip(fixtureBytes(name));
  return zip
    .paths()
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .map((p) => zip.readText(p));
}

/** The XML of the worksheet with this name, found through the workbook's relationships. */
function sheetXml(name: FixtureName, sheet: string): string {
  const zip = readZip(fixtureBytes(name));
  const id = new RegExp(`<sheet [^>]*name="${sheet}"[^>]*r:id="([^"]+)"`).exec(zip.readText('xl/workbook.xml'))?.[1];
  const rels = zip.readText('xl/_rels/workbook.xml.rels');
  const target =
    new RegExp(`<Relationship [^>]*Id="${id}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ??
    new RegExp(`<Relationship [^>]*Target="([^"]+)"[^>]*Id="${id}"`).exec(rels)?.[1];
  if (target === undefined) throw new Error(`No worksheet named ${sheet} in ${name}.`);
  return zip.readText(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
}

describe('XLSX fixtures', () => {
  it.each(XLSX)('%s opens with readZip and contains xl/workbook.xml', (name) => {
    expect(readZip(fixtureBytes(name)).has('xl/workbook.xml')).toBe(true);
  });

  it('xlsx_hidden_sheets_formulas.xlsx holds formulas with cached values, one of them #DIV/0!', () => {
    const xml = sheetXmls('xlsx_hidden_sheets_formulas.xlsx').join('');
    expect(xml).toMatch(/<f[^>]*>[^<]+<\/f>\s*<v>[^<]+<\/v>/);
    expect(xml).toMatch(/<c [^>]*t="e"[^>]*>\s*<f[^>]*>[^<]+<\/f>\s*<v>#DIV\/0!<\/v>/);
  });

  it('xlsx_hidden_sheets_formulas.xlsx has a hidden first sheet, then the data sheet and a very hidden sheet', () => {
    const states = [
      ...workbookXml('xlsx_hidden_sheets_formulas.xlsx').matchAll(/<sheet name="([^"]+)"[^>]* state="([^"]+)"/g),
    ];
    expect(states.map((m) => [m[1], m[2]])).toEqual([
      ['Config', 'hidden'],
      ['Production', 'visible'],
      ['Notes', 'veryHidden'],
    ]);
  });

  it('xlsx_date1904.xlsx has date1904="1" and Daily!B2 = 44591, which is 2026-01-31 in the 1904 system', () => {
    expect(workbookXml('xlsx_date1904.xlsx')).toMatch(/<workbookPr[^>]* date1904="1"/);
    expect(sheetXml('xlsx_date1904.xlsx', 'Daily')).toMatch(/<c r="B2"[^>]*><v>44591<\/v>/);
    expect((Date.UTC(2026, 0, 31) - Date.UTC(1904, 0, 1)) / 86_400_000).toBe(44591);
  });

  it('xlsx_merged_two_row_header_units.xlsx merges the title and the two header rows', () => {
    const refs = [...sheetXml('xlsx_merged_two_row_header_units.xlsx', 'Report').matchAll(/<mergeCell ref="([^"]+)"/g)];
    expect(refs.map((m) => m[1]).sort()).toEqual(['A1:H1', 'A2:A3', 'B2:B3', 'C2:D2', 'E2:F2', 'G2:G3', 'H2:H3']);
  });

  it('xlsx_numbers_as_text.xlsx stores the oil rates as shared strings', () => {
    expect(sheetXml('xlsx_numbers_as_text.xlsx', 'Wells')).toMatch(/<c r="C2"[^>]* t="s"/);
  });

  it('xlsx_two_tables_one_sheet.xlsx has a second table starting at A11 after two empty rows', () => {
    const xml = sheetXml('xlsx_two_tables_one_sheet.xlsx', 'Summary');
    expect(xml).toMatch(/<c r="A11"/);
    expect(xml).not.toMatch(/<c r="[A-Z]+(?:9|10)"/);
  });

  it.each(XLSX)('%s was saved by the producer the README names', (name) => {
    const app = readZip(fixtureBytes(name)).readText('docProps/app.xml');
    const resaved = !['xlsx_two_tables_one_sheet.xlsx', 'xlsx_date1904.xlsx'].includes(name);
    expect(app.includes('LibreOffice')).toBe(resaved);
  });
});

// ---------------------------------------------------------------------------------------------
// Generator determinism (slow: run with TW_SLOW=1)

describe.skipIf(process.env['TW_SLOW'] !== '1')('gen-large-csv.mjs, 1,000,000 rows (slow)', () => {
  it('gives the same SHA-256 for the same seed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-large-csv-'));
    try {
      const hashes = ['a.csv', 'b.csv'].map((file) => {
        const out = join(dir, file);
        const args = [GEN_LARGE, '--rows', '1000000', '--seed', '42', '--out', out];
        const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 240_000 });
        expect(run.status, run.stderr).toBe(0);
        return sha256OfFile(out);
      });
      expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(hashes[1]).toBe(hashes[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
