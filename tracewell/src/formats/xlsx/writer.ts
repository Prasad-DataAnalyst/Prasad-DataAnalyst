/**
 * The deterministic XLSX writer used by export (SAD section 10.1). The same book always gives the
 * same bytes: the document properties carry the creation time given by the caller (from the
 * injected clock), the ZIP has fixed entry times, and nothing depends on the machine.
 *
 * Cells are typed: numbers t="n", booleans t="b", text as inline strings, dates and times as serial
 * numbers with a date format. The header row is bold, can be frozen (pane at A2) and can carry an
 * autofilter over the data. The writer never writes formulas or merged cells (SAD section 12).
 */
import { writeZip } from '@tw/io';
import {
  APP_NAME,
  EXCEL_MAX_CELL_CHARS,
  EXCEL_MAX_DATA_ROWS,
  isDateCell,
  isDateTimeCell,
  utf8,
  type DateCell,
  type DateTimeCell,
  type JsonValue,
} from '@tw/model';
import { cellToSerial } from './dates';
import { formatCount, invalidArgument } from './errors';
import { columnName, formatCellRef, MAX_COLS } from './refs';
import type { XlsxColumnKind, XlsxWriteBook, XlsxWriteSheet, XlsxWriteValue } from './types';
import { xmlAttr, xmlText } from './xml';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Cell style indexes into cellXfs of STYLES_XML. */
const STYLE = { header: 1, integer: 2, date: 3, datetime: 4 } as const;

/** Format codes of the date styles; the reader recognises both as date formats. */
export const DATE_FORMAT_CODE = 'yyyy-mm-dd';
export const DATETIME_FORMAT_CODE = 'yyyy-mm-dd hh:mm:ss.000';

const STYLES_XML =
  `${XML_DECL}<styleSheet xmlns="${NS_MAIN}">` +
  `<numFmts count="2"><numFmt numFmtId="164" formatCode="${DATE_FORMAT_CODE}"/>` +
  `<numFmt numFmtId="165" formatCode="${DATETIME_FORMAT_CODE}"/></numFmts>` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
  '</styleSheet>';

const ROOT_RELS =
  `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="xl/workbook.xml"/>` +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" ' +
  'Target="docProps/core.xml"/>' +
  `<Relationship Id="rId3" Type="${REL_TYPE}/extended-properties" Target="docProps/app.xml"/>` +
  '</Relationships>';

const KINDS: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'date', 'datetime']);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHEET_NAME_FORBIDDEN = /[:\\/?*[\]]/;
const MAX_SHEET_NAME = 31;

// Column widths in Excel character units.
const MIN_WIDTH = 8;
const MAX_WIDTH = 60;
const WIDTH_PADDING = 2;
/** Room for the autofilter drop-down button in the header cell. */
const FILTER_BUTTON = 2;
/** Text above this many units is encoded in its own step, so no single string gets huge. */
const FLUSH_CHARS = 1 << 20;

// ---------------------------------------------------------------------------------------------
// Validation

function checkSheetName(name: unknown, seen: Set<string>): void {
  const valid =
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_SHEET_NAME &&
    !SHEET_NAME_FORBIDDEN.test(name) &&
    !name.startsWith("'") &&
    !name.endsWith("'") &&
    ![...name].some((ch) => ch.charCodeAt(0) < 0x20) &&
    name.toLowerCase() !== 'history';
  if (!valid) {
    throw invalidArgument(
      `"${String(name)}" is not a valid Excel sheet name: it must have 1 to 31 characters, none of : \\ / ? * [ ], ` +
        'no control characters, must not start or end with an apostrophe and must not be "History".',
      { sheet: String(name) },
    );
  }
  const key = name.toLowerCase();
  if (seen.has(key))
    throw invalidArgument(`The sheet name "${name}" is used twice (Excel ignores case).`, { sheet: name });
  seen.add(key);
}

function checkBook(book: XlsxWriteBook): void {
  if (book.sheets.length === 0) throw invalidArgument('A workbook needs at least one sheet.');
  const ms = ISO_UTC.test(book.created) ? Date.parse(book.created) : NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== book.created) {
    throw invalidArgument(
      `The creation time "${book.created}" is not an instant written as YYYY-MM-DDTHH:mm:ss.sssZ.`,
      {
        created: book.created,
      },
    );
  }
  const seen = new Set<string>();
  for (const sheet of book.sheets) checkSheetName(sheet.name, seen);
}

function checkColumns(sheet: XlsxWriteSheet): void {
  if (sheet.columns.length > MAX_COLS) {
    throw invalidArgument(
      `Sheet "${sheet.name}" has ${formatCount(sheet.columns.length)} columns; Excel holds at most ${formatCount(MAX_COLS)}.`,
    );
  }
  sheet.columns.forEach((col, i) => {
    if (!KINDS.has(col.kind)) {
      throw invalidArgument(`Column ${i + 1} of sheet "${sheet.name}" has the unknown kind "${String(col.kind)}".`);
    }
    checkText(col.header, sheet.name, 1, col.header);
    const w = col.width;
    if (w !== undefined && !(Number.isFinite(w) && w > 0 && w <= 255)) {
      throw invalidArgument(
        `Column "${col.header}" of sheet "${sheet.name}" has the width ${String(w)}; use more than 0 and at most 255.`,
      );
    }
  });
}

function checkText(text: string, sheet: string, row: number, column: string): void {
  if (text.length <= EXCEL_MAX_CELL_CHARS) return;
  throw invalidArgument(
    `Row ${formatCount(row)}, column "${column}" of sheet "${sheet}" holds ${formatCount(text.length)} characters; ` +
      `an Excel cell holds at most ${formatCount(EXCEL_MAX_CELL_CHARS)}.`,
    { sheet, row, column, length: text.length },
  );
}

function describe(v: XlsxWriteValue): string {
  if (typeof v === 'string') return 'text';
  if (typeof v === 'number') return Number.isFinite(v) ? 'a number' : `the non-finite number ${String(v)}`;
  if (typeof v === 'boolean') return 'a boolean';
  if (isDateCell(v)) return 'a date';
  if (isDateTimeCell(v)) return 'a date and time';
  return 'a value of an unknown type';
}

function mismatch(v: XlsxWriteValue, kind: XlsxColumnKind, sheet: string, row: number, column: string): Error {
  const detail: JsonValue = { sheet, row, column, kind };
  return invalidArgument(
    `Row ${formatCount(row)}, column "${column}" of sheet "${sheet}" is a ${kind} column but holds ${describe(v)}.`,
    detail,
  );
}

// ---------------------------------------------------------------------------------------------
// Cells

/** Canonical number text with an upper-case exponent, as spreadsheet programs write it. */
function numberText(n: number): string {
  return String(n).replace('e', 'E');
}

function inlineString(ref: string, text: string, style: string): string {
  const preserve = text !== text.trim() || /[\t\n\r]/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${style} t="inlineStr"><is><t${preserve}>${xmlText(text)}</t></is></c>`;
}

function serialCell(ref: string, v: DateCell | DateTimeCell, style: number): string {
  return `<c r="${ref}" s="${style}" t="n"><v>${numberText(cellToSerial(v))}</v></c>`;
}

interface CellOut {
  xml: string;
  /** Characters the value shows, for the column width. */
  chars: number;
}

function cellOut(v: Exclude<XlsxWriteValue, null>, kind: XlsxColumnKind, ref: string): CellOut | null {
  switch (kind) {
    case 'string':
      return typeof v === 'string' ? { xml: inlineString(ref, v, ''), chars: v.length } : null;
    case 'number':
    case 'integer': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      const text = numberText(v);
      const style = kind === 'integer' ? ` s="${STYLE.integer}"` : '';
      return { xml: `<c r="${ref}"${style} t="n"><v>${text}</v></c>`, chars: text.length };
    }
    case 'boolean':
      return typeof v === 'boolean' ? { xml: `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`, chars: 5 } : null;
    case 'date':
      return isDateCell(v) ? { xml: serialCell(ref, v, STYLE.date), chars: 10 } : null;
    case 'datetime':
      return isDateTimeCell(v) ? { xml: serialCell(ref, v, STYLE.datetime), chars: 23 } : null;
  }
}

// ---------------------------------------------------------------------------------------------
// Sheets

/** Builds a large UTF-8 document from many small strings without ever joining them into one. */
class Utf8Builder {
  #pending: string[] = [];
  #pendingChars = 0;
  readonly #chunks: Uint8Array[] = [];

  push(s: string): void {
    this.#pending.push(s);
    this.#pendingChars += s.length;
    if (this.#pendingChars >= FLUSH_CHARS) this.#flush();
  }

  #flush(): void {
    if (this.#pending.length === 0) return;
    this.#chunks.push(utf8(this.#pending.join('')));
    this.#pending = [];
    this.#pendingChars = 0;
  }

  /** The document: `prefix`, everything pushed, then `suffix`. */
  finish(prefix: string, suffix: string): Uint8Array {
    this.#flush();
    const parts = [utf8(prefix), ...this.#chunks, utf8(suffix)];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  }
}

interface SheetBody {
  builder: Utf8Builder;
  /** Rows written, the header included. */
  rows: number;
  /** The widest text in each column, in characters. */
  chars: number[];
}

function headerRow(sheet: XlsxWriteSheet, body: SheetBody): void {
  const cells = sheet.columns.map((col, c) => inlineString(formatCellRef(0, c), col.header, ` s="${STYLE.header}"`));
  body.builder.push(`<row r="1">${cells.join('')}</row>`);
  body.chars = sheet.columns.map((col) => col.header.length + (sheet.autoFilter ? FILTER_BUTTON : 0));
}

function dataRow(sheet: XlsxWriteSheet, values: readonly XlsxWriteValue[], r: number, body: SheetBody): void {
  if (!Array.isArray(values) || values.length !== sheet.columns.length) {
    throw invalidArgument(
      `Row ${formatCount(r + 1)} of sheet "${sheet.name}" has ${Array.isArray(values) ? values.length : 'no'} values ` +
        `for ${sheet.columns.length} columns.`,
      { sheet: sheet.name, row: r + 1 },
    );
  }
  let xml = `<row r="${r + 1}">`;
  values.forEach((v, c) => {
    if (v === null) return;
    const col = sheet.columns[c] as XlsxWriteSheet['columns'][number];
    if (typeof v === 'string') checkText(v, sheet.name, r + 1, col.header);
    const out = cellOut(v, col.kind, formatCellRef(r, c));
    if (out === null) throw mismatch(v, col.kind, sheet.name, r + 1, col.header);
    xml += out.xml;
    body.chars[c] = Math.max(body.chars[c] ?? 0, out.chars);
  });
  body.builder.push(`${xml}</row>`);
}

function sheetBody(sheet: XlsxWriteSheet): SheetBody {
  const body: SheetBody = { builder: new Utf8Builder(), rows: 1, chars: [] };
  headerRow(sheet, body);
  for (const values of sheet.rows) {
    if (body.rows > EXCEL_MAX_DATA_ROWS) {
      throw invalidArgument(
        `Sheet "${sheet.name}" has more than ${formatCount(EXCEL_MAX_DATA_ROWS)} data rows, the most Excel holds ` +
          'under a header row.',
        { sheet: sheet.name },
      );
    }
    dataRow(sheet, values, body.rows, body);
    body.rows += 1;
  }
  return body;
}

function widthText(sheet: XlsxWriteSheet, chars: readonly number[], c: number): string {
  const given = sheet.columns[c]?.width;
  const width = given ?? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, (chars[c] ?? 0) + WIDTH_PADDING));
  return String(Math.round(width * 100) / 100);
}

function colsXml(sheet: XlsxWriteSheet, chars: readonly number[]): string {
  if (sheet.columns.length === 0) return '';
  const cols = sheet.columns.map(
    (_, c) => `<col min="${c + 1}" max="${c + 1}" width="${widthText(sheet, chars, c)}" customWidth="1"/>`,
  );
  return `<cols>${cols.join('')}</cols>`;
}

function sheetViewXml(sheet: XlsxWriteSheet, selected: boolean): string {
  const tab = selected ? ' tabSelected="1"' : '';
  if (!sheet.freezeHeader) return `<sheetViews><sheetView${tab} workbookViewId="0"/></sheetViews>`;
  return (
    `<sheetViews><sheetView${tab} workbookViewId="0">` +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
  );
}

/** The used range: header and data across all columns; 'A1' for a sheet without columns. */
function usedRef(sheet: XlsxWriteSheet, rows: number): string | null {
  const cols = sheet.columns.length;
  return cols === 0 ? null : `A1:${columnName(cols - 1)}${rows}`;
}

interface WrittenSheet {
  data: Uint8Array;
  /** The autofilter range, for the workbook's _xlnm._FilterDatabase name; null without one. */
  filterRef: string | null;
}

function writeSheet(sheet: XlsxWriteSheet, index: number): WrittenSheet {
  checkColumns(sheet);
  const body = sheetBody(sheet);
  const ref = usedRef(sheet, body.rows);
  const filterRef = sheet.autoFilter ? ref : null;
  const prefix =
    `${XML_DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<dimension ref="${ref ?? 'A1'}"/>${sheetViewXml(sheet, index === 0)}<sheetFormatPr defaultRowHeight="15"/>` +
    `${colsXml(sheet, body.chars)}<sheetData>`;
  const suffix =
    `</sheetData>${filterRef === null ? '' : `<autoFilter ref="${filterRef}"/>`}` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
  return { data: body.builder.finish(prefix, suffix), filterRef };
}

// ---------------------------------------------------------------------------------------------
// Package parts

const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/** Metadata text: characters XML cannot carry become U+FFFD. */
function metadataText(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    const control = code < 0x20 && code !== 0x09 && code !== 0x0a;
    const nonCharacter = (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff;
    out += control || nonCharacter ? REPLACEMENT_CHARACTER : ch;
  }
  return xmlAttr(out);
}

/** W3CDTF without milliseconds, the form every spreadsheet program accepts. */
function w3cdtf(iso: string): string {
  return `${iso.slice(0, 19)}Z`;
}

function contentTypesXml(sheets: number): string {
  const sheetTypes = Array.from(
    { length: sheets },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ` +
      'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
  );
  return (
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheetTypes.join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>'
  );
}

function coreXml(book: XlsxWriteBook): string {
  const when = w3cdtf(book.created);
  const title = book.title === undefined ? '' : `<dc:title>${metadataText(book.title)}</dc:title>`;
  const creator = metadataText(book.creator);
  return (
    `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `${title}<dc:creator>${creator}</dc:creator><cp:lastModifiedBy>${creator}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified></cp:coreProperties>`
  );
}

function appXml(book: XlsxWriteBook): string {
  const names = book.sheets.map((s) => `<vt:lpstr>${xmlAttr(s.name)}</vt:lpstr>`).join('');
  const n = book.sheets.length;
  return (
    `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    `<Application>${APP_NAME}</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>` +
    '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>' +
    `<vt:variant><vt:i4>${n}</vt:i4></vt:variant></vt:vector></HeadingPairs>` +
    `<TitlesOfParts><vt:vector size="${n}" baseType="lpstr">${names}</vt:vector></TitlesOfParts>` +
    '<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged>' +
    '</Properties>'
  );
}

/** "'Data'!$A$1:$C$10": the absolute reference an autofilter's hidden defined name holds. */
function filterDatabaseRef(sheet: string, ref: string): string {
  const absolute = ref.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');
  return `'${sheet.replace(/'/g, "''")}'!${absolute}`;
}

function workbookXml(book: XlsxWriteBook, written: readonly WrittenSheet[]): string {
  const sheets = book.sheets.map((s, i) => `<sheet name="${xmlAttr(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`);
  const names = written.flatMap((w, i) =>
    w.filterRef === null
      ? []
      : [
          `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">` +
            `${xmlAttr(filterDatabaseRef((book.sheets[i] as XlsxWriteSheet).name, w.filterRef))}</definedName>`,
        ],
  );
  return (
    `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><workbookPr/>` +
    `<bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.join('')}</sheets>` +
    `${names.length === 0 ? '' : `<definedNames>${names.join('')}</definedNames>`}</workbook>`
  );
}

function workbookRelsXml(sheets: number): string {
  const rels = Array.from(
    { length: sheets },
    (_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_TYPE}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  );
  rels.push(`<Relationship Id="rId${sheets + 1}" Type="${REL_TYPE}/styles" Target="styles.xml"/>`);
  return `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
}

/**
 * Writes a workbook. The output is byte-identical for identical input.
 * Throws EngineError('INVALID_INPUT') for an invalid or duplicate sheet name, a creation time that
 * is not an IsoUtc instant, more than 16,384 columns or 1,048,575 data rows, a row whose length
 * differs from the columns, a value that does not match its column's kind, a non-finite number,
 * text over 32,767 characters, or a date before 1899-12-31, which Excel cannot store.
 */
export function writeXlsx(book: XlsxWriteBook): Uint8Array {
  checkBook(book);
  const written = book.sheets.map((sheet, i) => writeSheet(sheet, i));
  const n = book.sheets.length;
  return writeZip([
    { path: '[Content_Types].xml', data: utf8(contentTypesXml(n)) },
    { path: '_rels/.rels', data: utf8(ROOT_RELS) },
    { path: 'docProps/app.xml', data: utf8(appXml(book)) },
    { path: 'docProps/core.xml', data: utf8(coreXml(book)) },
    { path: 'xl/workbook.xml', data: utf8(workbookXml(book, written)) },
    { path: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRelsXml(n)) },
    { path: 'xl/styles.xml', data: utf8(STYLES_XML) },
    ...written.map((w, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, data: w.data })),
  ]);
}
