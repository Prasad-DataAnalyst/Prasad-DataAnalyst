/**
 * Read-back (SAD section 10.3): each data file is opened with the product readers, which are a
 * separate code path from the writers, re-typed from the manifest's column types, and compared
 * with the output view by row count, header, per-column digests and format-specific structure.
 */
import { tokenizeAll } from '@tw/formats-csv';
import { FGB_COLUMN, readFlatGeobuf, type FgbCrs, type FgbReadValue } from '@tw/formats-flatgeobuf';
import {
  GPKG_APPLICATION_ID,
  GPKG_USER_VERSION,
  envelopeOf,
  gpkgFeatures,
  gpkgTypeName,
  namedRows,
  readGeoPackage,
  readGpkgGeometry,
  type GpkgFile,
  type GpkgSrs,
  type SqlValue,
} from '@tw/formats-geopackage';
import { readGeoJsonAll } from '@tw/formats-geojson';
import { readKml } from '@tw/formats-kml';
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
  type Geometry,
  type RawField,
  type ValidationCheck,
} from '@tw/model';
import { columnDigest } from '@tw/table';
import { GPKG_TABLE, gpkgColumnType } from './geopackage';
import { parseHeader } from './profiles';
import type { ExpectedShape } from './shape';
import { SHAPE, geometryOfRecord } from './shapefile';
import { ShapefileFormatError, readDbf, readShp, readShx } from './shapefile-reader';
import { restoreFormula, retypeText } from './values';

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

function readCsv(
  bytes: Uint8Array,
  expected: ExpectedShape,
  file: string,
  o: { neutralized?: boolean } = {},
): ValidationCheck[] {
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
  const restore = (text: string, col: ExportColumn) =>
    o.neutralized === true && col.type === 'string' ? restoreFormula(text) : text;
  const values = expected.columns.map((col, j) =>
    data.map((r) => retypeText(restore(r.fields[j] ?? '', col), col.type)),
  );
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
// KML

export interface KmlReadOptions {
  /** The name the Document must have: the dataset's. */
  documentName: string;
  /** The digest of the rows' geometries, in the form a reader takes back from KML. */
  geometrySha256: string;
}

const KML_NAMESPACE = 'http://www.opengis.net/kml/2.2';

function readKmlFile(bytes: Uint8Array, expected: ExpectedShape, file: string, o: KmlReadOptions): ValidationCheck[] {
  let doc;
  try {
    doc = readKml(bytes);
  } catch (e) {
    return [check('RB-OPEN', false, `The file does not parse as KML: ${messageOf(e)}.`, file)];
  }
  const checks: ValidationCheck[] = [check('RB-OPEN', true, 'The file parses as KML.', file)];
  const headers = expected.columns.map((c) => c.header);
  const problems: string[] = [];
  if (doc.root !== 'kml' || doc.namespace !== KML_NAMESPACE) problems.push('the root is not a KML 2.2 kml element');
  if (doc.documents !== 1) problems.push(`it has ${doc.documents} Document elements instead of one`);
  if (doc.name !== o.documentName) problems.push('the Document is not named after the dataset');
  if (doc.placemarks.length !== expected.rowCount) {
    problems.push(`it has ${doc.placemarks.length} placemarks instead of ${expected.rowCount}`);
  }
  const misnamed = doc.placemarks.filter(
    (p) =>
      !headerSame(
        p.data.map(([n]) => n),
        headers,
      ),
  ).length;
  if (misnamed > 0) problems.push(`${misnamed} placemarks do not hold the columns in order`);
  const doubled = doc.placemarks.filter((p) => p.geometries > 1).length;
  if (doubled > 0) problems.push(`${doubled} placemarks have more than one geometry`);
  checks.push(
    problems.length === 0
      ? check(
          'RB-KML-STRUCTURE',
          true,
          'A KML 2.2 document with one placemark per row, each holding the columns as extended data and at most one geometry.',
          file,
        )
      : check('RB-KML-STRUCTURE', false, `KML structure problems: ${problems.join('; ')}.`, file),
  );
  const keys = doc.placemarks[0]?.data.map(([n]) => n) ?? [];
  checks.push(
    doc.placemarks.length === 0 || headerSame(keys, headers)
      ? check('RB-HEADER', true, 'Every placemark holds the columns with the expected names and units, in order.', file)
      : check(
          'RB-HEADER',
          false,
          `The placemark data are ${JSON.stringify(keys)} instead of ${JSON.stringify(headers)}.`,
          file,
        ),
  );
  checks.push(rowsCheck(doc.placemarks.length, expected.rowCount, file));
  const values = expected.columns.map((col, j) =>
    doc.placemarks.map((p) => retypeText(p.data[j]?.[1] ?? '', col.type)),
  );
  checks.push(valuesCheck(expected.columns, values, file));
  const shapes: CellValue[] = doc.placemarks.map((p) => (p.geometry === null ? null : { geometry: p.geometry }));
  checks.push(
    columnDigest(shapes) === o.geometrySha256
      ? check('RB-KML-GEOMETRY', true, "Every placemark's geometry matches its row's, coordinate for coordinate.", file)
      : check('RB-KML-GEOMETRY', false, 'The placemark geometries differ from the geometries of the rows.', file),
  );
  return checks;
}

// ---------------------------------------------------------------------------------------------
// Shapefile

/** The files of a Shapefile, as the package names them; undefined for one that is missing. */
export interface ShapefileParts {
  shp: Uint8Array | undefined;
  shx: Uint8Array | undefined;
  dbf: Uint8Array | undefined;
  prj: Uint8Array | undefined;
  cpg: Uint8Array | undefined;
  fields: Uint8Array | undefined;
}

export interface ShapefileReadOptions {
  /** The .prj text the data's CRS has. */
  prj: string;
  /** The shape type of every record that has a shape. */
  shapeType: number;
  /** The digest of the rows' geometries, in the form a reader makes of the shapes. */
  geometrySha256: string;
}

function retypeDbf(text: string | null, type: ExportColumn['type']): CellValue | undefined {
  if (text === null) return null;
  switch (type) {
    case 'boolean':
      return /^[TtYy]$/.test(text) ? true : /^[FfNn]$/.test(text) ? false : text === '?' ? null : undefined;
    case 'date': {
      const m = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
      return m === null ? undefined : { date: `${m[1]}-${m[2]}-${m[3]}` };
    }
    default:
      return retypeText(text, type);
  }
}

/** The .dbf field type a column's values are written in. */
function dbfType(type: ExportColumn['type']): string {
  return type === 'integer' || type === 'number' ? 'N' : type === 'boolean' ? 'L' : type === 'date' ? 'D' : 'C';
}

function sameBox(a: readonly (number | null)[], b: readonly (number | null)[]): boolean {
  return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

function readShapefile(parts: ShapefileParts, expected: ExpectedShape, o: ShapefileReadOptions): ValidationCheck[] {
  const file = 'data.shp';
  const missing = (['shp', 'shx', 'dbf', 'prj', 'cpg', 'fields'] as const).filter((k) => parts[k] === undefined);
  if (missing.length > 0) {
    const names = missing.map((k) => (k === 'fields' ? 'data.fields.csv' : `data.${k}`));
    return [check('RB-OPEN', false, `The Shapefile is incomplete: ${names.join(', ')} missing.`, file)];
  }
  const p = parts as Required<{ [K in keyof ShapefileParts]: Uint8Array }>;
  let shp;
  let shx;
  let dbf;
  let mapping: string[][];
  let where = 'data.shp';
  try {
    shp = readShp(p.shp);
    where = 'data.shx';
    shx = readShx(p.shx);
    where = 'data.dbf';
    dbf = readDbf(p.dbf);
    where = 'data.fields.csv';
    mapping = tokenizeAll(new TextDecoder('utf-8', { fatal: true }).decode(p.fields), {
      delimiter: ',',
      quote: '"',
    }).map((r) => r.fields);
  } catch (e) {
    const why = e instanceof ShapefileFormatError || e instanceof Error ? e.message : String(e);
    return [check('RB-OPEN', false, `The Shapefile does not parse: ${where}: ${why}.`, file)];
  }
  const checks: ValidationCheck[] = [check('RB-OPEN', true, 'The .shp, .shx, .dbf and field list parse.', file)];

  const problems: string[] = [];
  const type = (n: number) => `shape type ${n}`;
  if (shp.fileCode !== 9994 || shx.fileCode !== 9994) problems.push('a file code is not 9994');
  if (shp.version !== 1000) problems.push(`the version is ${shp.version}, not 1000`);
  if (shp.words * 2 !== p.shp.length) problems.push('the .shp length in its header is not its size');
  if (shx.words * 2 !== p.shx.length) problems.push('the .shx length in its header is not its size');
  if (shp.shapeType !== o.shapeType || shx.shapeType !== o.shapeType) {
    problems.push(`the files are of ${type(shp.shapeType)}, not ${type(o.shapeType)}`);
  }
  if (shx.entries.length !== shp.records.length) {
    problems.push(`the index has ${shx.entries.length} entries for ${shp.records.length} records`);
  }
  // Running bounds, folded as the writer folds them, so a large file needs no copy of its points.
  const bounds = (points: number[][], k: number): [number, number] => {
    let range: [number, number] = [Infinity, -Infinity];
    for (const q of points) range = [Math.min(range[0], q[k] as number), Math.max(range[1], q[k] as number)];
    return range;
  };
  let all: [number, number, number, number] | null = null;
  let heights: [number, number] | null = null;
  shp.records.forEach((r, i) => {
    if (r.number !== i + 1) problems.push(`record ${i + 1} is numbered ${r.number}`);
    const entry = shx.entries[i];
    if (entry !== undefined && (entry.offset !== r.offset || entry.words !== r.words)) {
      problems.push(`index entry ${i + 1} does not point at record ${i + 1}`);
    }
    if (r.shapeType !== SHAPE.null && r.shapeType !== o.shapeType) {
      problems.push(`record ${i + 1} is of ${type(r.shapeType)}`);
    }
    const own = r.record?.parts.flat() ?? [];
    if (own.length === 0) return;
    const [x0, x1] = bounds(own, 0);
    const [y0, y1] = bounds(own, 1);
    if (r.box !== null && !sameBox(r.box, [x0, y0, x1, y1])) {
      problems.push(`record ${i + 1} states a box that does not bound its points`);
    }
    all =
      all === null
        ? [x0, y0, x1, y1]
        : [Math.min(all[0], x0), Math.min(all[1], y0), Math.max(all[2], x1), Math.max(all[3], y1)];
    if (own[0]?.length === 3) {
      const [z0, z1] = bounds(own, 2);
      heights = heights === null ? [z0, z1] : [Math.min(heights[0], z0), Math.max(heights[1], z1)];
    }
  });
  if (!sameBox(shp.box, all ?? [0, 0, 0, 0])) problems.push('the header box does not bound the shapes');
  if (!sameBox(shp.zRange, heights ?? [0, 0])) problems.push('the header height range does not span the shapes');
  if (dbf.records !== shp.records.length) {
    problems.push(`the .dbf has ${dbf.records} records for ${shp.records.length} shapes`);
  }
  if (dbf.deleted > 0) problems.push(`${dbf.deleted} .dbf records are marked deleted`);
  if (!dbf.endMarker) problems.push('the .dbf does not end with 0x1A');
  const [head, ...rows] = mapping;
  if (head?.join(',') !== 'field,name,unit,type')
    problems.push('data.fields.csv does not start with field,name,unit,type');
  const names = dbf.fields.map((f) => f.name);
  if (rows.map((r) => r[0]).join('\u0000') !== names.join('\u0000')) {
    problems.push('the field names of data.fields.csv are not those of the .dbf');
  }
  expected.columns.forEach((col, j) => {
    const f = dbf.fields[j];
    if (f !== undefined && f.type !== dbfType(col.type)) problems.push(`field ${f.name} is of type ${f.type}`);
  });
  const prj = new TextDecoder().decode(p.prj);
  if (prj !== o.prj) problems.push('the .prj does not describe the coordinate reference system of the data');
  if (new TextDecoder().decode(p.cpg) !== 'UTF-8') problems.push('the .cpg does not declare UTF-8');
  checks.push(
    problems.length === 0
      ? check(
          'RB-SHP-STRUCTURE',
          true,
          `${shp.records.length} records of ${type(o.shapeType)} indexed by the .shx, as many .dbf records, boxes that bound the shapes, the .prj of the data's coordinate reference system and a UTF-8 .cpg.`,
          file,
        )
      : check('RB-SHP-STRUCTURE', false, `Shapefile structure problems: ${problems.slice(0, 5).join('; ')}.`, file),
  );
  const headers = rows.map((r) => ((r[2] ?? '') === '' ? (r[1] ?? '') : `${r[1] ?? ''} [${r[2] ?? ''}]`));
  checks.push(headerCheck(expected.columns, headers, 'data.fields.csv'));
  checks.push(rowsCheck(dbf.records, expected.rowCount, 'data.dbf'));
  const values = expected.columns.map((col, j) => dbf.rows.map((r) => retypeDbf(r[j] ?? null, col.type)));
  checks.push(valuesCheck(expected.columns, values, 'data.dbf'));
  const shapes: CellValue[] = shp.records.map((r) => {
    const g = geometryOfRecord(r.record, o.shapeType);
    return g === null ? null : { geometry: g };
  });
  checks.push(
    columnDigest(shapes) === o.geometrySha256 && shapes.length === expected.rowCount
      ? check('RB-SHP-GEOMETRY', true, "Every shape matches its row's geometry, coordinate for coordinate.", file)
      : check('RB-SHP-GEOMETRY', false, 'The shapes differ from the geometries of the rows.', file),
  );
  return checks;
}

// ---------------------------------------------------------------------------------------------
// FlatGeobuf

export interface FlatGeobufReadOptions {
  /** The name the header must have: the dataset's. */
  name: string;
  /** The geometry type the header must state: one every feature has, or Unknown for a mix. */
  geometryType: number;
  hasZ: boolean;
  crs: FgbCrs | null;
  /** The digest of the rows' geometries, in the form a reader takes back from FlatGeobuf. */
  geometrySha256: string;
}

const GEOMETRY_NAMES = [
  'Unknown',
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
  'GeometryCollection',
];

/** The FlatGeobuf column type a column's values are written in. */
function fgbType(type: ExportColumn['type']): number {
  switch (type) {
    case 'integer':
      return FGB_COLUMN.Long;
    case 'number':
      return FGB_COLUMN.Double;
    case 'boolean':
      return FGB_COLUMN.Bool;
    case 'date':
    case 'datetime':
      return FGB_COLUMN.DateTime;
    case 'geometry':
      return FGB_COLUMN.Json;
    case 'string':
      return FGB_COLUMN.String;
  }
}

function retypeFgb(v: FgbReadValue, type: ExportColumn['type']): CellValue | undefined {
  if (v === null) return null;
  switch (type) {
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
    case 'number':
      return typeof v === 'number' ? v : undefined;
    case 'boolean':
      return typeof v === 'boolean' ? v : undefined;
    default:
      return typeof v === 'string' ? retypeText(v, type) : undefined;
  }
}

/** Every x and y of a geometry, as the envelope is folded. */
function eachXy(g: Geometry, visit: (x: number, y: number) => void): void {
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') visit(c[0], c[1] as number);
    else for (const item of c) walk(item);
  };
  if (g.type === 'GeometryCollection') for (const m of g.geometries) eachXy(m, visit);
  else walk(g.coordinates);
}

function readFlatGeobufFile(
  bytes: Uint8Array,
  expected: ExpectedShape,
  file: string,
  o: FlatGeobufReadOptions,
): ValidationCheck[] {
  let doc;
  try {
    doc = readFlatGeobuf(bytes);
  } catch (e) {
    return [check('RB-OPEN', false, `The file does not parse as FlatGeobuf: ${messageOf(e)}.`, file)];
  }
  const checks: ValidationCheck[] = [check('RB-OPEN', true, 'The file parses as FlatGeobuf.', file)];
  const h = doc.header;
  const problems: string[] = [];
  const typeName = (n: number) => GEOMETRY_NAMES[n] ?? `type ${n}`;
  if (h.name !== o.name) problems.push('the header is not named after the dataset');
  if (h.featuresCount !== BigInt(doc.features.length)) {
    problems.push(`the header counts ${h.featuresCount} features and the file holds ${doc.features.length}`);
  }
  if (h.indexNodeSize !== 0) problems.push('the header declares a spatial index, which would reorder the rows');
  if (h.geometryType !== o.geometryType) {
    problems.push(`the header states ${typeName(h.geometryType)} geometries, not ${typeName(o.geometryType)}`);
  }
  if (h.hasZ !== o.hasZ) problems.push(o.hasZ ? 'the header does not declare heights' : 'the header declares heights');
  if (h.hasM || h.hasT || h.hasTM) problems.push('the header declares measures or times, which the data has none of');
  const crs = h.crs;
  if (o.crs === null ? crs !== null : crs?.org !== o.crs.org || crs.code !== o.crs.code || crs.name !== o.crs.name) {
    problems.push('the header does not record the coordinate reference system of the data by its EPSG code');
  }
  expected.columns.forEach((col, j) => {
    const c = h.columns[j];
    if (c !== undefined && c.type !== fgbType(col.type)) problems.push(`the column ${c.name} is of type ${c.type}`);
  });
  let box: number[] | null = null;
  let mistyped = 0;
  for (const f of doc.features) {
    if (f.geometry === null) continue;
    if (h.geometryType !== 0 && f.geometry.type !== typeName(h.geometryType)) mistyped++;
    eachXy(f.geometry, (x, y) => {
      box =
        box === null
          ? [x, y, x, y]
          : [
              Math.min(box[0] as number, x),
              Math.min(box[1] as number, y),
              Math.max(box[2] as number, x),
              Math.max(box[3] as number, y),
            ];
    });
  }
  if (mistyped > 0) problems.push(`${mistyped} features are not of the type the header states`);
  if (box === null ? h.envelope !== null : h.envelope === null || !sameBox(h.envelope, box)) {
    problems.push('the header envelope does not bound the geometries');
  }
  checks.push(
    problems.length === 0
      ? check(
          'RB-FGB-STRUCTURE',
          true,
          `A FlatGeobuf 3 file with ${doc.features.length} features in row order, no spatial index, typed columns, an envelope that bounds the geometries and the EPSG code of the data.`,
          file,
        )
      : check('RB-FGB-STRUCTURE', false, `FlatGeobuf structure problems: ${problems.slice(0, 5).join('; ')}.`, file),
  );
  checks.push(
    headerCheck(
      expected.columns,
      h.columns.map((c) => c.name),
      file,
    ),
  );
  checks.push(rowsCheck(doc.features.length, expected.rowCount, file));
  const values = expected.columns.map((col, j) =>
    doc.features.map((f) => retypeFgb(f.properties[j] ?? null, col.type)),
  );
  checks.push(valuesCheck(expected.columns, values, file));
  const shapes: CellValue[] = doc.features.map((f) => (f.geometry === null ? null : { geometry: f.geometry }));
  checks.push(
    columnDigest(shapes) === o.geometrySha256 && shapes.length === expected.rowCount
      ? check('RB-FGB-GEOMETRY', true, "Every feature's geometry matches its row's, coordinate for coordinate.", file)
      : check('RB-FGB-GEOMETRY', false, 'The feature geometries differ from the geometries of the rows.', file),
  );
  return checks;
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

// ---------------------------------------------------------------------------------------------
// GeoPackage

export interface GeoPackageReadOptions {
  /** The name gpkg_contents must give the layer: the dataset's. */
  identifier: string;
  /** The time gpkg_contents must give as the layer's last change: the export's. */
  lastChange: string;
  /** The row gpkg_spatial_ref_sys must hold for the data. */
  srs: GpkgSrs | null;
  fid: string;
  geom: string;
  /** The type gpkg_geometry_columns must state, and every geometry have unless it is GEOMETRY. */
  geometryType: string;
  z: 0 | 1 | 2;
  /** The digest of the rows' geometries, in the form a reader takes back from a GeoPackage. */
  geometrySha256: string;
}

function retypeGpkg(v: SqlValue, type: ExportColumn['type']): CellValue | undefined {
  if (v === null) return null;
  switch (type) {
    case 'integer':
      return typeof v === 'bigint' && v >= -(2n ** 53n) + 1n && v <= 2n ** 53n - 1n ? Number(v) : undefined;
    case 'number':
      return typeof v === 'number' ? v : undefined;
    case 'boolean':
      return v === 0n ? false : v === 1n ? true : undefined;
    default:
      return typeof v === 'string' ? retypeText(v, type) : undefined;
  }
}

function readGeoPackageFile(
  bytes: Uint8Array,
  expected: ExpectedShape,
  file: string,
  o: GeoPackageReadOptions,
): ValidationCheck[] {
  let gpkg: GpkgFile;
  try {
    gpkg = readGeoPackage(bytes);
  } catch (e) {
    return [check('RB-OPEN', false, `The file does not open as a GeoPackage: ${messageOf(e)}.`, file)];
  }
  const checks: ValidationCheck[] = [check('RB-OPEN', true, 'The file opens as an SQLite database.', file)];
  const problems: string[] = [];
  if (gpkg.applicationId !== GPKG_APPLICATION_ID) problems.push('the database is not marked as a GeoPackage');
  if (gpkg.userVersion !== GPKG_USER_VERSION)
    problems.push(`the database states version ${gpkg.userVersion}, not 10200`);
  const systems = new Map(gpkg.srs.map((s) => [s.id, s]));
  for (const id of [-1, 0, 4326]) if (!systems.has(id)) problems.push(`gpkg_spatial_ref_sys has no row ${id}`);
  const srs = o.srs === null ? undefined : systems.get(o.srs.id);
  if (
    o.srs === null ||
    srs === undefined ||
    srs.organization !== 'EPSG' ||
    srs.code !== o.srs.code ||
    srs.definition !== o.srs.definition
  ) {
    problems.push('gpkg_spatial_ref_sys does not describe the coordinate reference system of the data');
  }
  const layer = gpkg.layers.length === 1 ? gpkg.layers[0] : undefined;
  if (layer === undefined) {
    problems.push(`gpkg_contents lists ${gpkg.layers.length} tables, not one`);
    return [
      ...checks,
      check('RB-GPKG-STRUCTURE', false, `GeoPackage structure problems: ${problems.join('; ')}.`, file),
    ];
  }
  const srsId = o.srs?.id ?? null;
  if (layer.table !== GPKG_TABLE || layer.dataType !== 'features')
    problems.push('gpkg_contents does not list the feature table');
  if (layer.identifier !== o.identifier) problems.push('the layer is not named after the dataset');
  if (layer.lastChange !== o.lastChange) problems.push('the last change of the layer is not the time of the export');
  if (layer.srsId !== srsId) problems.push('gpkg_contents does not give the layer the system of the data');
  const g = layer.geometry;
  if (g === null || g.column !== o.geom || g.type !== o.geometryType || g.srsId !== srsId || g.z !== o.z || g.m !== 0) {
    problems.push('gpkg_geometry_columns does not describe the geometry column as written');
  }
  const [fid, geom, ...fields] = layer.columns;
  if (fid === undefined || !fid.rowid || fid.name !== o.fid)
    problems.push(`the first column is not the feature ID "${o.fid}"`);
  if (geom === undefined || geom.name !== o.geom || geom.type !== o.geometryType) {
    problems.push(`the second column is not the geometry column "${o.geom}" of type ${o.geometryType}`);
  }
  expected.columns.forEach((col, j) => {
    const c = fields[j];
    if (c !== undefined && c.type !== gpkgColumnType(col.type))
      problems.push(`the field ${c.name} is declared ${c.type}`);
  });
  const values: (CellValue | undefined)[][] = expected.columns.map(() => []);
  const shapes: CellValue[] = [];
  let count = 0;
  let outOfOrder = 0;
  let otherSystem = 0;
  let mistyped = 0;
  let misboxed = 0;
  let box: number[] | null = null;
  try {
    for (const f of gpkgFeatures(gpkg, layer)) {
      count++;
      if (f.fid !== BigInt(count)) outOfOrder++;
      expected.columns.forEach((col, j) => values[j]?.push(retypeGpkg(f.values[j] ?? null, col.type)));
      if (f.blob === null) {
        shapes.push(null);
        continue;
      }
      const read = readGpkgGeometry(f.blob);
      if (read.srsId !== srsId) otherSystem++;
      if (o.geometryType !== 'GEOMETRY' && gpkgTypeName(read.geometry.type) !== o.geometryType) mistyped++;
      const env = envelopeOf(read.geometry);
      const fits =
        read.empty === (env === null) &&
        (read.envelope === null
          ? env === null || read.geometry.type === 'Point'
          : env !== null && sameBox(read.envelope, env));
      if (!fits) misboxed++;
      if (env !== null) {
        box =
          box === null
            ? [env[0], env[2], env[1], env[3]]
            : [
                Math.min(box[0] as number, env[0]),
                Math.min(box[1] as number, env[2]),
                Math.max(box[2] as number, env[1]),
                Math.max(box[3] as number, env[3]),
              ];
      }
      shapes.push({ geometry: read.geometry });
    }
  } catch (e) {
    problems.push(`the features do not read: ${messageOf(e)}`);
  }
  if (outOfOrder > 0) problems.push('the feature IDs are not 1, 2, 3… in row order');
  if (otherSystem > 0) problems.push(`${otherSystem} geometries name another system`);
  if (mistyped > 0) problems.push(`${mistyped} geometries are not of the type the layer states`);
  if (misboxed > 0) problems.push(`${misboxed} geometries carry an envelope or empty flag that does not fit them`);
  if (!sameBox(layer.extent, box ?? [null, null, null, null]))
    problems.push('the extent of the layer does not bound its geometries');
  const sequence = [...namedRows(gpkg, 'sqlite_sequence')];
  const counted =
    sequence.length === 1 && sequence[0]?.get('name') === GPKG_TABLE && sequence[0]?.get('seq') === BigInt(count);
  if (count > 0 ? !counted : sequence.length > 0) problems.push('sqlite_sequence does not hold the last feature ID');
  checks.push(
    problems.length === 0
      ? check(
          'RB-GPKG-STRUCTURE',
          true,
          `A GeoPackage 1.2 with one layer of ${count} features in row order, typed fields, the system of the data by its EPSG code and Well-Known Text, and an extent that bounds the geometries.`,
          file,
        )
      : check('RB-GPKG-STRUCTURE', false, `GeoPackage structure problems: ${problems.slice(0, 5).join('; ')}.`, file),
  );
  checks.push(
    headerCheck(
      expected.columns,
      fields.map((c) => c.name),
      file,
    ),
  );
  checks.push(rowsCheck(count, expected.rowCount, file));
  checks.push(valuesCheck(expected.columns, values, file));
  checks.push(
    columnDigest(shapes) === o.geometrySha256 && shapes.length === expected.rowCount
      ? check('RB-GPKG-GEOMETRY', true, "Every feature's geometry matches its row's, coordinate for coordinate.", file)
      : check('RB-GPKG-GEOMETRY', false, 'The feature geometries differ from the geometries of the rows.', file),
  );
  return checks;
}

export const readBack: {
  csv(bytes: Uint8Array, expected: ExpectedShape, file: string, o?: { neutralized?: boolean }): ValidationCheck[];
  parquet(bytes: Uint8Array, expected: ExpectedShape, file: string): Promise<ValidationCheck[]>;
  xlsx(
    bytes: Uint8Array,
    expected: ExpectedShape,
    file: string,
    o: { expectData: boolean; expectedLogRows: number },
  ): ValidationCheck[];
  geojson(bytes: Uint8Array, expected: ExpectedShape, file: string, o: GeoJsonReadOptions): ValidationCheck[];
  shapefile(parts: ShapefileParts, expected: ExpectedShape, o: ShapefileReadOptions): ValidationCheck[];
  kml(bytes: Uint8Array, expected: ExpectedShape, file: string, o: KmlReadOptions): ValidationCheck[];
  flatgeobuf(bytes: Uint8Array, expected: ExpectedShape, file: string, o: FlatGeobufReadOptions): ValidationCheck[];
  geopackage(bytes: Uint8Array, expected: ExpectedShape, file: string, o: GeoPackageReadOptions): ValidationCheck[];
  package(zip: Uint8Array, manifest: ExportManifest): ValidationCheck[];
} = Object.freeze({
  csv: readCsv,
  parquet: readParquetFile,
  xlsx: readXlsx,
  geojson: readGeoJson,
  shapefile: readShapefile,
  kml: readKmlFile,
  flatgeobuf: readFlatGeobufFile,
  geopackage: readGeoPackageFile,
  package: readPackage,
});
