/**
 * Test-only helpers of the XLSX adapter: the module's named workbooks (made by make_fixtures.py
 * with openpyxl and re-saved by LibreOffice), their expectation files, the committed messy-file
 * library when the fixtures module has delivered it, and builders for hand-written workbooks and
 * in-memory sheets that exercise what the two producers never write.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bytesSource, writeZip } from '@tw/io';
import { utf8, type ByteSource, type ImportNote, type RawBatch, type RawField, type FormatOptions } from '@tw/model';
import { xlsxImporter } from '../importer';
import { parseRange } from '../refs';
import type { CellRange, XlsxCell, XlsxSheet } from '../types';

const HERE = fileURLToPath(new URL('./', import.meta.url));

export const XLSX_FIXTURES = [
  'xlsx_merged_two_row_header_units.xlsx',
  'xlsx_text_and_serial_dates.xlsx',
  'xlsx_two_tables_one_sheet.xlsx',
  'xlsx_date1904.xlsx',
  'xlsx_hidden_sheets_formulas.xlsx',
  'xlsx_numbers_as_text.xlsx',
] as const;

export type XlsxFixture = (typeof XLSX_FIXTURES)[number];

function bytesOf(path: string): Uint8Array {
  const buffer = readFileSync(path);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export function fixtureBytes(name: XlsxFixture): Uint8Array {
  return bytesOf(`${HERE}${name}`);
}

export function fixtureSource(name: XlsxFixture): ByteSource {
  return bytesSource(fixtureBytes(name), name);
}

/** The module's expectation for a named workbook: `<name without .xlsx>.expected.json`. */
export function fixtureExpectation<T>(name: XlsxFixture): T {
  return JSON.parse(readFileSync(`${HERE}${name.replace(/\.xlsx$/, '')}.expected.json`, 'utf8')) as T;
}

// ---------------------------------------------------------------------------------------------
// The committed messy-file library (fixtures/messy), owned by the fixtures module.

export const MESSY_DIR = fileURLToPath(new URL('../../../../fixtures/messy/', import.meta.url));

/** The library's workbook of this name, or null until the fixtures module has delivered it. */
export function libraryBytes(name: XlsxFixture): Uint8Array | null {
  const path = `${MESSY_DIR}${name}`;
  return existsSync(path) ? bytesOf(path) : null;
}

export function libraryExpectation(name: XlsxFixture): Record<string, unknown> | null {
  const base = name.replace(/\.xlsx$/, '');
  const path = [`${MESSY_DIR}${name}.expected.json`, `${MESSY_DIR}${base}.expected.json`].find((p) => existsSync(p));
  return path === undefined ? null : (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------------------------
// Hand-written workbooks

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export interface HandSheet {
  name: string;
  state?: 'visible' | 'hidden' | 'veryHidden';
  /** The worksheet's inner XML, or a whole part when it starts with an XML declaration, a DOCTYPE or <worksheet>. */
  xml: string;
  /** A chart sheet: listed in the workbook, without cells. */
  chart?: boolean;
}

export interface HandBook {
  sheets: HandSheet[];
  sharedStrings?: string[] | string;
  /** The <styleSheet> inner XML. */
  styles?: string;
  date1904?: boolean;
}

function worksheetPart(xml: string): string {
  return /^<(\?xml|!DOCTYPE|(\w+:)?worksheet)/.test(xml.trimStart())
    ? xml
    : `<worksheet xmlns="${MAIN}" xmlns:r="${REL}">${xml}</worksheet>`;
}

function sharedStringsPart(strings: string[] | string): string {
  const items = typeof strings === 'string' ? strings : strings.map((s) => `<si><t xml:space="preserve">${s}</t></si>`).join('');
  return `<sst xmlns="${MAIN}">${items}</sst>`;
}

/** A minimal XLSX package with the given sheets, shared strings and styles. */
export function handWorkbook(book: HandBook): Uint8Array {
  const sheets = book.sheets
    .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`)
    .join('');
  const rels = book.sheets.map((s, i) =>
    s.chart
      ? `<Relationship Id="rId${i + 1}" Type="${REL}/chartsheet" Target="chartsheets/sheet${i + 1}.xml"/>`
      : `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  );
  const n = book.sheets.length;
  if (book.sharedStrings !== undefined) {
    rels.push(`<Relationship Id="rId${n + 1}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`);
  }
  if (book.styles !== undefined) rels.push(`<Relationship Id="rId${n + 2}" Type="${REL}/styles" Target="styles.xml"/>`);
  const entries = [
    {
      path: '_rels/.rels',
      data: utf8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="/xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      path: 'xl/workbook.xml',
      data: utf8(
        `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><workbookPr${book.date1904 ? ' date1904="1"' : ''}/>` +
          `<sheets>${sheets}</sheets></workbook>`,
      ),
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      data: utf8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`),
    },
    ...book.sheets.map((s, i) => ({
      path: s.chart ? `xl/chartsheets/sheet${i + 1}.xml` : `xl/worksheets/sheet${i + 1}.xml`,
      data: utf8(s.chart ? `<chartsheet xmlns="${MAIN}"/>` : worksheetPart(s.xml)),
    })),
  ];
  if (book.sharedStrings !== undefined) {
    entries.push({ path: 'xl/sharedStrings.xml', data: utf8(sharedStringsPart(book.sharedStrings)) });
  }
  if (book.styles !== undefined) {
    entries.push({ path: 'xl/styles.xml', data: utf8(`<styleSheet xmlns="${MAIN}">${book.styles}</styleSheet>`) });
  }
  return writeZip(entries);
}

/** A one-sheet workbook from the sheet's <sheetData> rows (and anything after them). */
export function oneSheet(sheetXml: string, extra: Omit<HandBook, 'sheets'> = {}): Uint8Array {
  return handWorkbook({ ...extra, sheets: [{ name: 'Sheet1', xml: sheetXml }] });
}

// ---------------------------------------------------------------------------------------------
// In-memory sheets for layout tests

/**
 * An XlsxSheet from a grid of values (rows from row 0, columns from column A; undefined and null
 * leave the cell empty) and merged ranges in A1 form.
 */
export function sheetOf(grid: (RawField | undefined)[][], merges: string[] = [], name = 'Sheet1'): XlsxSheet {
  const rows = grid
    .map((values, r) => ({
      r,
      cells: values.flatMap((v, c): XlsxCell[] =>
        v === undefined || v === null
          ? []
          : [{ c, t: typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : 's', v, numFmt: null, isDate: false, formula: false }],
      ),
    }))
    .filter((row) => row.cells.length > 0);
  return {
    name,
    state: 'visible',
    dimension: 'A1',
    merges: merges.map((m) => parseRange(m) as CellRange),
    frozen: null,
    autoFilter: null,
    rows,
  };
}

// ---------------------------------------------------------------------------------------------
// Running the importer

export interface ReadOutcome {
  batches: RawBatch[];
  notes: ImportNote[];
  bytes: number;
}

export async function readAll(
  src: ByteSource,
  options: FormatOptions,
  signal = new AbortController().signal,
): Promise<ReadOutcome> {
  const outcome: ReadOutcome = { batches: [], notes: [], bytes: 0 };
  const ctx = {
    signal,
    onBytes: (n: number) => {
      outcome.bytes += n;
    },
    note: (n: ImportNote) => {
      outcome.notes.push(n);
    },
  };
  for await (const batch of xlsxImporter.read(src, options, ctx)) outcome.batches.push(batch);
  return outcome;
}
