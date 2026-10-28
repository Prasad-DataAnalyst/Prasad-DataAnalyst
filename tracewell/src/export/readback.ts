/**
 * Read-back (SAD section 10.3): each data file is opened with the product readers, which are a
 * separate code path from the writers, re-typed from the manifest's column types, and compared
 * with the output view by row count, header, per-column digests and format-specific structure.
 */
import { tokenizeAll } from '@tw/formats-csv';
import { readGeoJsonAll } from '@tw/formats-geojson';
import { PARQUET_TYPES, readParquet } from '@tw/formats-parquet';
import { openWorkbook, type XlsxSheet } from '@tw/formats-xlsx';
import { parseChecksumsFile, readZip, sha256Hex } from '@tw/io';
import {
  isDateCell,
  isDateTimeCell,
  schemas,
  type CellValue,
  type ColumnId,
  type ExportColumn,
  type ExportManifest,
  type RawField,
  type ValidationCheck,
} from '@tw/model';
import { columnDigest } from '@tw/table';
import { parseHeader } from './profiles';
import type { ExpectedShape } from './shape';
import { retypeText } from './values';

type CheckId = ValidationCheck['id'];

function check(id: CheckId, ok: boolean, detail: string, file?: string): ValidationCheck {
  return file === undefined ? { id, ok, detail } : { id, ok, detail, file };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Compares re-typed columns with the expected digests; undefined marks a value that did not re-type. */
function valuesCheck(columns: ExportColumn[], values: (CellValue | undefined)[][], file: string): ValidationCheck {
  const bad: string[] = [];
  columns.forEach((col, j) => {
    const vs = values[j] ?? [];
    if (vs.some((v) => v === undefined) || columnDigest(vs as CellValue[]) !== col.sha256) bad.push(col.header);
  });
  return bad.length === 0
    ? check('RB-VALUES', true, `All ${columns.length} columns match the output view exactly.`, file)
    : check('RB-VALUES', false, `These columns differ from the output view: ${bad.join(', ')}.`, file);
}

function headerCheck(expected: ExportColumn[], actual: string[], file: string): ValidationCheck {
  const want = expected.map((c) => c.header);
  const ok =
    actual.length === want.length &&
    actual.every((h, i) => {
      const a = parseHeader(h);
      const col = expected[i] as ExportColumn;
      return h === want[i] && a.name === col.name && a.unit === col.unit;
    });
  return ok
    ? check('RB-HEADER', true, 'One header row with the expected names, order and units.', file)
    : check('RB-HEADER', false, `The header reads ${JSON.stringify(actual)} instead of ${JSON.stringify(want)}.`, file);
}

function rowsCheck(actual: number, expected: number, file: string): ValidationCheck {
  return actual === expected
    ? check('RB-ROWS', true, `${actual} data rows, as in the output view.`, file)
    : check('RB-ROWS', false, `The file holds ${actual} data rows; the output view has ${expected}.`, file);
}

// ---------------------------------------------------------------------------------------------
// CSV

function readCsv(bytes: Uint8Array, expected: ExpectedShape, file: string): ValidationCheck[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (e) {
    return [check('RB-OPEN', false, `The file is not valid UTF-8: ${messageOf(e)}`, file)];
  }
  const checks: ValidationCheck[] = [];
  const hasBom = text.startsWith('﻿');
  let records;
  try {
    records = tokenizeAll(hasBom ? text.slice(1) : text, { delimiter: ',', quote: '"' });
  } catch (e) {
    return [check('RB-OPEN', false, `The file does not parse as CSV: ${messageOf(e)}`, file)];
  }
  checks.push(check('RB-OPEN', true, 'The file parses as RFC 4180 CSV.', file));
  const [head, ...data] = records;
  const width = head?.fields.length ?? 0;
  const ragged = data.filter((r) => r.fields.length !== width).length;
  checks.push(
    !hasBom && ragged === 0
      ? check(
          'RB-CSV-ENCODING',
          true,
          'UTF-8 without a byte-order mark; every row has the same number of fields.',
          file,
        )
      : check(
          'RB-CSV-ENCODING',
          false,
          [
            hasBom ? 'The file starts with a byte-order mark.' : '',
            ragged > 0 ? `${ragged} rows have a different number of fields.` : '',
          ]
            .filter((s) => s !== '')
            .join(' '),
          file,
        ),
  );
  checks.push(headerCheck(expected.columns, head?.fields ?? [], file));
  checks.push(rowsCheck(data.length, expected.rowCount, file));
  const values = expected.columns.map((col, j) => data.map((r) => retypeText(r.fields[j] ?? '', col.type)));
  checks.push(valuesCheck(expected.columns, values, file));
  return checks;
}

// ---------------------------------------------------------------------------------------------
// Parquet

/** Whether a value read from Parquet is a cell of the column's logical type. */
function fitsType(v: CellValue | undefined, type: ExportColumn['type']): boolean {
  if (v === null) return true;
  if (v === undefined) return false;
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number';
    case 'integer':
      return typeof v === 'number' && Number.isSafeInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'date':
      return typeof v === 'object' && 'date' in v;
    case 'datetime':
      return typeof v === 'object' && 'datetime' in v;
    case 'geometry':
      return typeof v === 'object' && 'geometry' in v;
  }
}

async function readParquetFile(bytes: Uint8Array, expected: ExpectedShape, file: string): Promise<ValidationCheck[]> {
  let table;
  try {
    table = await readParquet(bytes);
  } catch (e) {
    return [check('RB-OPEN', false, `The file does not open as Apache Parquet: ${messageOf(e)}`, file)];
  }
  const checks: ValidationCheck[] = [check('RB-OPEN', true, 'The file opens as Apache Parquet.', file)];
  const wrong = expected.columns.flatMap((col, j) => {
    const got = table.columns[j];
    const want = PARQUET_TYPES[col.type];
    if (got === undefined || (got.physical === want.physical && want.annotations.includes(got.annotation))) return [];
    return [`${col.header} is ${got.physical}${got.annotation === null ? '' : ` ${got.annotation}`}`];
  });
  checks.push(
    wrong.length === 0
      ? check('RB-PARQUET-TYPES', true, 'Every column has the Parquet type of its logical type.', file)
      : check('RB-PARQUET-TYPES', false, `These columns have the wrong Parquet type: ${wrong.join('; ')}.`, file),
  );
  checks.push(
    headerCheck(
      expected.columns,
      table.columns.map((c) => c.name),
      file,
    ),
  );
  checks.push(rowsCheck(table.rowCount, expected.rowCount, file));
  const values = expected.columns.map((col, j) =>
    (table.values[j] ?? []).map((v) => (fitsType(v, col.type) ? v : undefined)),
  );
  checks.push(valuesCheck(expected.columns, values, file));
  return checks;
}

// ---------------------------------------------------------------------------------------------
// XLSX

function retypeXlsx(v: RawField, type: ExportColumn['type']): CellValue | undefined {
  if (v === null) return null;
  switch (type) {
    case 'integer':
    case 'number':
      return typeof v === 'number' ? v : undefined;
    case 'boolean':
      return typeof v === 'boolean' ? v : undefined;
    case 'date':
      return isDateCell(v)
        ? v
        : isDateTimeCell(v) && v.datetime.endsWith('T00:00:00.000Z')
          ? { date: v.datetime.slice(0, 10) }
          : undefined;
    case 'datetime':
      return isDateTimeCell(v) ? v : isDateCell(v) ? { datetime: `${v.date}T00:00:00.000Z` } : undefined;
    case 'string':
      return typeof v === 'string' ? v : undefined;
    case 'geometry':
      return typeof v === 'string' ? retypeText(v, 'geometry') : undefined;
  }
}

/** Data rows as dense arrays: rows without cells are omitted by the reader and come back empty. */
function denseRows(
  sheet: XlsxSheet,
  width: number,
): { rows: RawField[][]; cellTypes: (string | null)[][]; dates: boolean[][]; extra: number } {
  const last = sheet.rows.reduce((m, r) => Math.max(m, r.r), 0);
  const rows: RawField[][] = [];
  const cellTypes: (string | null)[][] = [];
  const dates: boolean[][] = [];
  for (let r = 1; r <= last; r++) {
    rows.push(new Array<RawField>(width).fill(null));
    cellTypes.push(new Array<string | null>(width).fill(null));
    dates.push(new Array<boolean>(width).fill(false));
  }
  let extra = 0;
  for (const row of sheet.rows) {
    if (row.r === 0) continue;
    for (const cell of row.cells) {
      if (cell.c >= width) {
        extra++;
        continue;
      }
      (rows[row.r - 1] as RawField[])[cell.c] = cell.v;
      (cellTypes[row.r - 1] as (string | null)[])[cell.c] = cell.t;
      (dates[row.r - 1] as boolean[])[cell.c] = cell.isDate;
    }
  }
  return { rows, cellTypes, dates, extra };
}

function readXlsx(
  bytes: Uint8Array,
  expected: ExpectedShape,
  file: string,
  o: { expectData: boolean; expectedLogRows: number },
): ValidationCheck[] {
  let book;
  try {
    book = openWorkbook(bytes);
  } catch (e) {
    return [check('RB-OPEN', false, `The workbook does not open: ${messageOf(e)}`, file)];
  }
  const checks: ValidationCheck[] = [check('RB-OPEN', true, 'The workbook opens.', file)];
  const names = book.sheets.map((s) => s.name);
  const required = [...(o.expectData ? ['Data'] : []), 'Report', 'Log'];
  const problems: string[] = required.filter((n) => !names.includes(n)).map((n) => `the ${n} sheet is missing`);

  if (names.includes('Log')) {
    const log = book.readSheet('Log');
    const logRows = log.rows.filter((r) => r.r > 0).length;
    if (logRows !== o.expectedLogRows)
      problems.push(`the Log sheet has ${logRows} entries instead of ${o.expectedLogRows}`);
  }

  if (o.expectData && names.includes('Data')) {
    const sheet = book.readSheet('Data');
    const width = expected.columns.length;
    if (sheet.frozen === null || sheet.frozen.r !== 1 || sheet.frozen.c !== 0)
      problems.push('the header is not frozen at A2');
    const f = sheet.autoFilter;
    if (f === null || f.s.r !== 0 || f.s.c !== 0 || f.e.c !== width - 1 || f.e.r !== expected.rowCount) {
      problems.push('the filter does not cover the header and every data row');
    }
    if (sheet.merges.length > 0) problems.push(`the Data sheet has ${sheet.merges.length} merged ranges`);

    const header =
      sheet.rows.find((r) => r.r === 0)?.cells.map((c) => (typeof c.v === 'string' ? c.v : String(c.v))) ?? [];
    checks.push(headerCheck(expected.columns, header, file));
    const dense = denseRows(sheet, width);
    const dataRows = Math.max(dense.rows.length, 0);
    checks.push(rowsCheck(dataRows <= expected.rowCount ? expected.rowCount : dataRows, expected.rowCount, file));
    if (dense.extra > 0) problems.push(`${dense.extra} cells lie outside the data columns`);

    const typeProblems: string[] = [];
    expected.columns.forEach((col, j) => {
      const numeric = col.type === 'number' || col.type === 'integer';
      const date = col.type === 'date' || col.type === 'datetime';
      dense.rows.forEach((row, i) => {
        const v = row[j];
        if (v === null || v === undefined) return;
        const t = dense.cellTypes[i]?.[j];
        if (numeric && (t !== 'n' || typeof v !== 'number')) typeProblems.push(`${col.header} row ${i + 2}`);
        if (date && dense.dates[i]?.[j] !== true) typeProblems.push(`${col.header} row ${i + 2}`);
      });
    });
    checks.push(
      typeProblems.length === 0
        ? check('RB-XLSX-TYPES', true, 'Numbers are stored as numbers and dates carry date formats.', file)
        : check(
            'RB-XLSX-TYPES',
            false,
            `Cells with the wrong storage type: ${typeProblems.slice(0, 5).join(', ')}${typeProblems.length > 5 ? ', …' : ''}.`,
            file,
          ),
    );
    const padded = Array.from(
      { length: expected.rowCount },
      (_, i) => dense.rows[i] ?? new Array<RawField>(width).fill(null),
    );
    const values = expected.columns.map((col, j) => padded.map((row) => retypeXlsx(row[j] ?? null, col.type)));
    checks.push(valuesCheck(expected.columns, values, file));
  }
  checks.push(
    problems.length === 0
      ? check(
          'RB-XLSX-STRUCTURE',
          true,
          `Sheets ${required.join(', ')} present${o.expectData ? '; header frozen at A2; filter over the data; no merged cells' : ''}.`,
          file,
        )
      : check('RB-XLSX-STRUCTURE', false, `Workbook structure problems: ${problems.join('; ')}.`, file),
  );
  return checks;
}

// ---------------------------------------------------------------------------------------------
// GeoJSON

export interface GeoJsonReadOptions {
  geometryFrom: 'column' | 'latlon';
  /** The geometry column, when geometries come from one. */
  geometryColumn?: ColumnId;
  latHeader?: string;
  lonHeader?: string;
}

function retypeProperty(v: unknown, type: ExportColumn['type']): CellValue | undefined {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'integer':
    case 'number':
      return typeof v === 'number' ? v : undefined;
    case 'boolean':
      return typeof v === 'boolean' ? v : undefined;
    case 'string':
      return typeof v === 'string' ? v : undefined;
    default:
      return typeof v === 'string' ? retypeText(v, type) : undefined;
  }
}

function readGeoJson(
  bytes: Uint8Array,
  expected: ExpectedShape,
  file: string,
  o: GeoJsonReadOptions,
): ValidationCheck[] {
  let doc;
  let raw: unknown;
  try {
    doc = readGeoJsonAll(bytes);
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    return [check('RB-OPEN', false, `The file does not parse as GeoJSON: ${messageOf(e)}`, file)];
  }
  const checks: ValidationCheck[] = [check('RB-OPEN', true, 'The file parses as GeoJSON.', file)];
  const problems: string[] = [];
  const top = raw as { type?: unknown; crs?: unknown };
  if (top.type !== 'FeatureCollection') problems.push('the top level is not a FeatureCollection');
  if (top.crs !== undefined) problems.push('it has a crs member, which RFC 7946 removed');
  if (doc.features.length !== expected.rowCount)
    problems.push(`it has ${doc.features.length} features instead of ${expected.rowCount}`);

  const geometryCol = o.geometryFrom === 'column' ? expected.columns.find((c) => c.id === o.geometryColumn) : undefined;
  const props = expected.columns.filter((c) => c !== geometryCol);
  if (geometryCol !== undefined) {
    const geoms: CellValue[] = doc.features.map((f) =>
      f.geometry === null ? null : { geometry: f.geometry as never },
    );
    if (columnDigest(geoms) !== geometryCol.sha256)
      problems.push('the geometries or their coordinate order differ from the source');
  } else if (o.latHeader !== undefined && o.lonHeader !== undefined) {
    const lat = o.latHeader;
    const lon = o.lonHeader;
    const swapped = doc.features.filter((f) => {
      const y = f.properties[lat];
      const x = f.properties[lon];
      if (typeof x !== 'number' || typeof y !== 'number') return f.geometry !== null;
      const g = f.geometry as { type?: string; coordinates?: unknown } | null;
      const c = g?.coordinates as number[] | undefined;
      return g?.type !== 'Point' || c?.[0] !== x || c[1] !== y;
    }).length;
    if (swapped > 0) problems.push(`${swapped} points do not match their longitude/latitude columns in lon, lat order`);
  }
  checks.push(
    problems.length === 0
      ? check(
          'RB-GEOJSON-STRUCTURE',
          true,
          'An RFC 7946 FeatureCollection with one feature per row, no crs member and coordinates in the source order.',
          file,
        )
      : check('RB-GEOJSON-STRUCTURE', false, `GeoJSON structure problems: ${problems.join('; ')}.`, file),
  );

  const first = doc.features[0]?.properties ?? {};
  const keys = Object.keys(first);
  checks.push(
    doc.features.length === 0 ||
      headerSame(
        keys,
        props.map((c) => c.header),
      )
      ? check('RB-HEADER', true, 'Every property is present with the expected name and unit.', file)
      : check(
          'RB-HEADER',
          false,
          `The properties are ${JSON.stringify(keys)} instead of ${JSON.stringify(props.map((c) => c.header))}.`,
          file,
        ),
  );
  checks.push(rowsCheck(doc.features.length, expected.rowCount, file));
  const values = props.map((col) => doc.features.map((f) => retypeProperty(f.properties[col.header], col.type)));
  checks.push(valuesCheck(props, values, file));
  return checks;
}

function headerSame(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---------------------------------------------------------------------------------------------
// Package

function readPackage(zip: Uint8Array, manifest: ExportManifest): ValidationCheck[] {
  let reader;
  try {
    reader = readZip(zip);
  } catch (e) {
    return [check('RB-PKG-CHECKSUMS', false, `The package does not open: ${messageOf(e)}`)];
  }
  const checks: ValidationCheck[] = [];
  const problems: string[] = [];
  try {
    const sums = parseChecksumsFile(reader.readText('CHECKSUMS.sha256'));
    const listed = new Set(sums.map((s) => s.path));
    for (const s of sums) {
      if (!reader.has(s.path)) problems.push(`${s.path} is listed but missing`);
      else if (sha256Hex(reader.read(s.path)) !== s.sha256) problems.push(`${s.path} does not match its checksum`);
    }
    for (const p of reader.paths()) if (p !== 'CHECKSUMS.sha256' && !listed.has(p)) problems.push(`${p} is not listed`);
  } catch (e) {
    problems.push(`CHECKSUMS.sha256 cannot be read: ${messageOf(e)}`);
  }
  checks.push(
    problems.length === 0
      ? check('RB-PKG-CHECKSUMS', true, 'Every package entry matches CHECKSUMS.sha256 (sha256sum -c compatible).')
      : check('RB-PKG-CHECKSUMS', false, `Checksum problems: ${problems.join('; ')}.`),
  );

  const contents: string[] = [];
  try {
    const parsed = schemas.exportManifest.safeParse(JSON.parse(reader.readText('manifest.json')));
    if (!parsed.success)
      contents.push(`manifest.json does not validate (${parsed.error.issues[0]?.message ?? 'invalid'})`);
  } catch (e) {
    contents.push(`manifest.json cannot be read: ${messageOf(e)}`);
  }
  try {
    const readme = reader.readText('README.txt');
    for (const s of manifest.sources)
      if (!readme.includes(s.fileId)) contents.push(`the README does not list ${s.name} and its SHA-256`);
    for (const r of manifest.rulePacks)
      if (!readme.includes(`${r.id} ${r.version}`)) contents.push(`the README does not list the rule pack ${r.id}`);
    if (!readme.includes('OPEN WARNINGS')) contents.push('the README does not list the open warnings');
  } catch (e) {
    contents.push(`README.txt cannot be read: ${messageOf(e)}`);
  }
  for (const f of manifest.files) if (!reader.has(f.path)) contents.push(`${f.path} is missing`);
  checks.push(
    contents.length === 0
      ? check(
          'RB-PKG-CONTENTS',
          true,
          'The manifest validates and the README lists every source with its checksum, the rule packs and the open warnings.',
        )
      : check('RB-PKG-CONTENTS', false, `Package contents problems: ${contents.join('; ')}.`),
  );
  return checks;
}

export const readBack: {
  csv(bytes: Uint8Array, expected: ExpectedShape, file: string): ValidationCheck[];
  parquet(bytes: Uint8Array, expected: ExpectedShape, file: string): Promise<ValidationCheck[]>;
  xlsx(
    bytes: Uint8Array,
    expected: ExpectedShape,
    file: string,
    o: { expectData: boolean; expectedLogRows: number },
  ): ValidationCheck[];
  geojson(bytes: Uint8Array, expected: ExpectedShape, file: string, o: GeoJsonReadOptions): ValidationCheck[];
  package(zip: Uint8Array, manifest: ExportManifest): ValidationCheck[];
} = Object.freeze({
  csv: readCsv,
  parquet: readParquetFile,
  xlsx: readXlsx,
  geojson: readGeoJson,
  package: readPackage,
});
