/**
 * Legacy Excel workbooks (.xls, Excel 97-2003): BIFF8 records in the "Workbook" stream of an OLE
 * compound file, read into the same workbook model as XLSX, so layout detection and the importer
 * treat both alike. The globals give the sheets, the date system, the number formats and the shared
 * strings; each sheet's records give its cells, merged ranges and frozen pane. Formulas keep their
 * cached results and are never evaluated. Excel 5.0/95 files and encrypted ones are refused with
 * what to do instead.
 */
import { EngineError, type RawField } from '@tw/model';
import { CompoundFile } from './cfb';
import { serialToDateValue } from './dates';
import { damagedWorkbook, notAWorkbook } from './errors';
import { builtInFormatCode, dateFormatKind, type DateFormatKind } from './numfmt';
import { formatRange } from './refs';
import type { CellRange, SheetState, XlsxCell, XlsxCellType, XlsxRow, XlsxSheet, XlsxWorkbook } from './types';

const BOF = 0x0809;
const EOF = 0x000a;
const CONTINUE = 0x003c;
const FILEPASS = 0x002f;
const DATEMODE = 0x0022;
const FORMAT = 0x041e;
const XF = 0x00e0;
const BOUNDSHEET = 0x0085;
const SST = 0x00fc;
const LABELSST = 0x00fd;
const LABEL = 0x0204;
const NUMBER = 0x0203;
const RK = 0x027e;
const MULRK = 0x00bd;
const BOOLERR = 0x0205;
const FORMULA = 0x0006;
const STRING = 0x0207;
const MERGEDCELLS = 0x00e5;
const WINDOW2 = 0x023e;
const PANE = 0x0041;

const BIFF8 = 0x0600;

/** BIFF error codes and the text Excel shows for them. */
const ERRORS: Readonly<Record<number, string>> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
  0x2b: '#GETTING_DATA',
};

const RESAVE_FIX =
  'Open the file in Excel or LibreOffice and save it as an Excel workbook (.xlsx), then import the new copy.';

interface BiffRecord {
  type: number;
  offset: number;
  data: Uint8Array;
  /** The data of the CONTINUE records that follow, which belong to this record. */
  continues: Uint8Array[];
}

function u16(b: Uint8Array, at: number): number {
  if (at + 2 > b.length) throw damagedWorkbook('a record is shorter than its content.');
  return (b[at] as number) | ((b[at + 1] as number) << 8);
}

function u32(b: Uint8Array, at: number): number {
  return (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;
}

function f64(b: Uint8Array, at: number): number {
  if (at + 8 > b.length) throw damagedWorkbook('a record is shorter than its content.');
  return new DataView(b.buffer, b.byteOffset + at, 8).getFloat64(0, true);
}

/** The records from `from`, each with its CONTINUE records. */
function* records(stream: Uint8Array, from: number): Generator<BiffRecord> {
  let at = from;
  while (at + 4 <= stream.length) {
    const type = u16(stream, at);
    const end = at + 4 + u16(stream, at + 2);
    if (end > stream.length) throw damagedWorkbook(`the record at byte ${at} of the workbook runs past its end.`);
    const record: BiffRecord = { type, offset: at, data: stream.subarray(at + 4, end), continues: [] };
    at = end;
    while (at + 4 <= stream.length && u16(stream, at) === CONTINUE) {
      const next = at + 4 + u16(stream, at + 2);
      if (next > stream.length) throw damagedWorkbook(`the record at byte ${at} of the workbook runs past its end.`);
      record.continues.push(stream.subarray(at + 4, next));
      at = next;
    }
    yield record;
  }
}

/** Reads across a record and its CONTINUE records, as the shared strings need. */
class Segments {
  readonly #segs: Uint8Array[];
  #i = 0;
  #pos = 0;

  constructor(record: BiffRecord, start = 0) {
    this.#segs = [record.data, ...record.continues];
    this.#pos = start;
  }

  #current(): Uint8Array {
    while (this.#i < this.#segs.length && this.#pos >= (this.#segs[this.#i] as Uint8Array).length) {
      this.#i++;
      this.#pos = 0;
    }
    const seg = this.#segs[this.#i];
    if (seg === undefined) throw damagedWorkbook('a record ends in the middle of a value.');
    return seg;
  }

  u8(): number {
    const seg = this.#current();
    return seg[this.#pos++] as number;
  }

  u16(): number {
    return this.u8() | (this.u8() << 8);
  }

  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }

  skip(n: number): void {
    let left = n;
    while (left > 0) {
      const seg = this.#current();
      const take = Math.min(left, seg.length - this.#pos);
      this.#pos += take;
      left -= take;
    }
  }

  /** `cch` characters; where they cross into a CONTINUE record, its first byte says their width again. */
  chars(cch: number, high: boolean): string {
    const units: number[] = [];
    let wide = high;
    while (units.length < cch) {
      let seg = this.#segs[this.#i];
      if (seg === undefined || this.#pos >= seg.length) {
        this.#i++;
        this.#pos = 0;
        seg = this.#segs[this.#i];
        if (seg === undefined) throw damagedWorkbook('a string runs past the end of its record.');
        wide = ((seg[this.#pos++] as number) & 1) === 1;
      }
      while (units.length < cch && this.#pos + (wide ? 2 : 1) <= seg.length) {
        units.push(wide ? u16(seg, this.#pos) : (seg[this.#pos] as number));
        this.#pos += wide ? 2 : 1;
      }
    }
    let out = '';
    for (let i = 0; i < units.length; i += 4096) out += String.fromCharCode(...units.slice(i, i + 4096));
    return out;
  }

  /** XLUnicodeRichExtendedString: the text, without its formatting runs and phonetic data. */
  richString(): string {
    const cch = this.u16();
    const flags = this.u8();
    const runs = (flags & 0x08) !== 0 ? this.u16() : 0;
    const ext = (flags & 0x04) !== 0 ? this.u32() : 0;
    const text = this.chars(cch, (flags & 0x01) !== 0);
    this.skip(runs * 4 + ext);
    return text;
  }
}

/** XLUnicodeString (a 16-bit length) or ShortXLUnicodeString (an 8-bit one) inside one record. */
function simpleString(data: Uint8Array, at: number, shortLength = false): string {
  const cch = shortLength ? (data[at] as number) : u16(data, at);
  const flagsAt = at + (shortLength ? 1 : 2);
  const wide = ((data[flagsAt] as number) & 0x01) !== 0;
  const record: BiffRecord = { type: 0, offset: 0, data, continues: [] };
  return new Segments(record, flagsAt + 1).chars(cch, wide);
}

/** RkNumber: a 30-bit integer or the top 30 bits of a double, optionally divided by 100. */
function rkValue(rk: number): number {
  let value: number;
  if ((rk & 0x02) !== 0) value = rk >> 2;
  else {
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(4, (rk & 0xfffffffc) >>> 0, true);
    value = view.getFloat64(0, true);
  }
  return (rk & 0x01) !== 0 ? value / 100 : value;
}

interface SheetEntry {
  name: string;
  state: SheetState;
  offset: number;
  worksheet: boolean;
}

interface CellFormat {
  numFmt: string | null;
  dateKind: DateFormatKind | null;
}

class LegacyWorkbook implements XlsxWorkbook {
  readonly sheets: { name: string; state: SheetState }[];
  readonly date1904: boolean;
  readonly #stream: Uint8Array;
  readonly #entries: SheetEntry[];
  readonly #strings: string[];
  readonly #formats: CellFormat[];

  constructor(stream: Uint8Array) {
    this.#stream = stream;
    const custom = new Map<number, string>();
    const xfFormats: number[] = [];
    const entries: SheetEntry[] = [];
    let strings: string[] = [];
    let date1904 = false;
    let first = true;
    for (const r of records(stream, 0)) {
      if (first) {
        first = false;
        if (r.type !== BOF || u16(r.data, 0) !== BIFF8) {
          throw notAWorkbook(
            'The file is an Excel workbook from before Excel 97 (BIFF5 or older), which cannot be read.',
            RESAVE_FIX,
          );
        }
        continue;
      }
      if (r.type === EOF) break;
      switch (r.type) {
        case FILEPASS:
          throw notAWorkbook(
            'The workbook is protected with a password, so it cannot be read.',
            RESAVE_FIX.replace('(.xlsx)', '(.xlsx) without a password'),
          );
        case DATEMODE:
          date1904 = u16(r.data, 0) === 1;
          break;
        case FORMAT:
          custom.set(u16(r.data, 0), simpleString(r.data, 2));
          break;
        case XF:
          xfFormats.push(u16(r.data, 2));
          break;
        case BOUNDSHEET: {
          const visibility = (r.data[4] as number) & 0x03;
          entries.push({
            name: simpleString(r.data, 6, true),
            state: visibility === 1 ? 'hidden' : visibility === 2 ? 'veryHidden' : 'visible',
            offset: u32(r.data, 0),
            worksheet: r.data[5] === 0,
          });
          break;
        }
        case SST: {
          const seg = new Segments(r, 8);
          const unique = u32(r.data, 4);
          strings = [];
          for (let i = 0; i < unique; i++) strings.push(seg.richString());
          break;
        }
      }
    }
    this.date1904 = date1904;
    this.#entries = entries;
    this.#strings = strings;
    this.#formats = xfFormats.map((id) => {
      const code = custom.get(id) ?? builtInFormatCode(id);
      const numFmt = code === null || code.toLowerCase() === 'general' ? null : code;
      return { numFmt, dateKind: dateFormatKind(id, numFmt) };
    });
    this.sheets = entries.map(({ name, state }) => ({ name, state }));
  }

  readSheet(name: string): XlsxSheet {
    const entry = this.#entries.find((s) => s.name === name);
    if (entry === undefined) {
      throw new EngineError(
        'NOT_FOUND',
        `The workbook has no sheet named "${name}".`,
        `Choose one of the workbook's sheets: ${this.sheets.map((s) => `"${s.name}"`).join(', ')}.`,
        { sheet: name },
      );
    }
    const empty = { name, state: entry.state, dimension: 'A1', merges: [], frozen: null, autoFilter: null, rows: [] };
    // Chart sheets and macro sheets are sheets of the workbook but hold no cells.
    if (!entry.worksheet) return empty;
    if (entry.offset >= this.#stream.length)
      throw damagedWorkbook(`the sheet "${name}" starts past the end of the file.`);
    return this.#parseSheet(entry, empty);
  }

  #format(ixfe: number): CellFormat {
    return this.#formats[ixfe] ?? { numFmt: null, dateKind: null };
  }

  #parseSheet(entry: SheetEntry, base: XlsxSheet): XlsxSheet {
    const cells = new Map<number, Map<number, XlsxCell>>();
    const merges: CellRange[] = [];
    let frozenFlag = false;
    let pane: { r: number; c: number } | null = null;
    let pending: { r: number; c: number } | null = null;
    let depth = 0;

    const put = (r: number, cell: XlsxCell) => {
      let row = cells.get(r);
      if (row === undefined) cells.set(r, (row = new Map()));
      row.set(cell.c, cell);
    };
    const number = (r: number, c: number, ixfe: number, n: number, formula: boolean) => {
      const f = this.#format(ixfe);
      const date = f.dateKind === null ? null : serialToDateValue(n, this.date1904, f.dateKind);
      put(r, { c, t: 'n', v: date ?? n, numFmt: f.numFmt, isDate: date !== null, formula });
    };
    const other = (r: number, c: number, ixfe: number, t: XlsxCellType, v: RawField, formula: boolean) => {
      put(r, { c, t, v, numFmt: this.#format(ixfe).numFmt, isDate: false, formula });
    };

    for (const rec of records(this.#stream, entry.offset)) {
      const d = rec.data;
      if (rec.type === BOF) {
        depth++;
        continue;
      }
      if (rec.type === EOF) {
        depth--;
        if (depth <= 0) break;
        continue;
      }
      // Records of an embedded chart belong to the chart, not to the sheet.
      if (depth !== 1) continue;
      switch (rec.type) {
        case NUMBER:
          number(u16(d, 0), u16(d, 2), u16(d, 4), f64(d, 6), false);
          break;
        case RK:
          number(u16(d, 0), u16(d, 2), u16(d, 4), rkValue(u32(d, 6)), false);
          break;
        case MULRK: {
          const r = u16(d, 0);
          const first = u16(d, 2);
          const count = Math.floor((d.length - 6) / 6);
          for (let i = 0; i < count; i++) number(r, first + i, u16(d, 4 + i * 6), rkValue(u32(d, 6 + i * 6)), false);
          break;
        }
        case LABELSST: {
          const index = u32(d, 6);
          const text = this.#strings[index];
          if (text === undefined) {
            throw damagedWorkbook(
              `a cell of sheet "${entry.name}" refers to shared string ${index}, which the workbook does not have.`,
            );
          }
          other(u16(d, 0), u16(d, 2), u16(d, 4), 's', text, false);
          break;
        }
        case LABEL:
          other(u16(d, 0), u16(d, 2), u16(d, 4), 'str', simpleString(d, 6), false);
          break;
        case BOOLERR: {
          const value = d[6] as number;
          if (d[7] === 1) other(u16(d, 0), u16(d, 2), u16(d, 4), 'e', { error: ERRORS[value] ?? '#VALUE!' }, false);
          else other(u16(d, 0), u16(d, 2), u16(d, 4), 'b', value !== 0, false);
          break;
        }
        case FORMULA: {
          const [r, c, ixfe] = [u16(d, 0), u16(d, 2), u16(d, 4)];
          if (d[12] === 0xff && d[13] === 0xff) {
            // Not a number: a string (in the STRING record that follows), a boolean, an error or empty.
            const kind = d[6];
            if (kind === 0) pending = { r, c };
            if (kind === 1) other(r, c, ixfe, 'b', d[8] !== 0, true);
            else if (kind === 2) other(r, c, ixfe, 'e', { error: ERRORS[d[8] as number] ?? '#VALUE!' }, true);
            else other(r, c, ixfe, 'str', null, true);
          } else {
            number(r, c, ixfe, f64(d, 6), true);
          }
          break;
        }
        case STRING:
          // The text result of the formula just before it.
          if (pending !== null) {
            const cell = cells.get(pending.r)?.get(pending.c);
            if (cell !== undefined) cell.v = simpleString(d, 0);
            pending = null;
          }
          break;
        case MERGEDCELLS: {
          const count = u16(d, 0);
          for (let i = 0; i < count && 2 + i * 8 + 8 <= d.length; i++) {
            const at = 2 + i * 8;
            merges.push({ s: { r: u16(d, at), c: u16(d, at + 4) }, e: { r: u16(d, at + 2), c: u16(d, at + 6) } });
          }
          break;
        }
        case WINDOW2:
          frozenFlag = (u16(d, 0) & 0x0008) !== 0;
          break;
        case PANE:
          pane = { r: u16(d, 2), c: u16(d, 0) };
          break;
      }
    }

    const rows: XlsxRow[] = [...cells.keys()]
      .sort((a, b) => a - b)
      .map((r) => ({
        r,
        cells: [...(cells.get(r) as Map<number, XlsxCell>).values()]
          .filter((cell) => cell.v !== null || cell.formula)
          .sort((a, b) => a.c - b.c),
      }))
      .filter((row) => row.cells.length > 0);
    return {
      ...base,
      dimension: dimensionOf(rows),
      merges,
      frozen: frozenFlag && pane !== null && (pane.r > 0 || pane.c > 0) ? pane : null,
      rows,
    };
  }
}

/** The used range of the cells that hold a value; 'A1' for an empty sheet. */
function dimensionOf(rows: readonly XlsxRow[]): string {
  let range: CellRange | null = null;
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.v === null) continue;
      if (range === null) range = { s: { r: row.r, c: cell.c }, e: { r: row.r, c: cell.c } };
      range.s.r = Math.min(range.s.r, row.r);
      range.e.r = Math.max(range.e.r, row.r);
      range.s.c = Math.min(range.s.c, cell.c);
      range.e.c = Math.max(range.e.c, cell.c);
    }
  }
  return range === null ? 'A1' : formatRange(range);
}

/**
 * Opens a workbook in an OLE compound file: a legacy .xls is read; a password-protected .xlsx, an
 * Excel 5.0/95 workbook or another Office document is refused, saying what it is.
 */
export function openLegacyWorkbook(bytes: Uint8Array): XlsxWorkbook {
  const cfb = new CompoundFile(bytes);
  if (cfb.has('EncryptedPackage') || cfb.has('EncryptionInfo')) {
    throw notAWorkbook(
      'The file is a password-protected workbook, which cannot be read.',
      'Open the file in Excel or LibreOffice and save it as an Excel workbook (.xlsx) without a password, then import the new copy.',
    );
  }
  const stream = cfb.stream('Workbook');
  if (stream !== null) return new LegacyWorkbook(stream);
  if (cfb.has('Book')) {
    throw notAWorkbook('The file is an Excel 5.0/95 workbook, which is too old to be read.', RESAVE_FIX);
  }
  throw notAWorkbook(
    'The file is an Office 97-2003 document but not an Excel workbook (it may be a Word or PowerPoint file).',
    'Choose an Excel workbook (.xls or .xlsx), a CSV, GeoJSON, JSON or Parquet file.',
  );
}
