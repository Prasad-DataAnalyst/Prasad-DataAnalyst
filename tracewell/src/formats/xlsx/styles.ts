/**
 * The part of the stylesheet (xl/styles.xml) the reader needs: for each cell style (the index in a
 * cell's s attribute) its number format code and whether that format shows a date or a time.
 */
import { builtInFormatCode, dateFormatKind, type DateFormatKind } from './numfmt';
import { attr, parseXml } from './xml';

export interface CellFormat {
  /** The format code; null for General. */
  numFmt: string | null;
  dateKind: DateFormatKind | null;
}

const GENERAL: CellFormat = { numFmt: null, dateKind: null };

export class StyleTable {
  readonly #formats: readonly CellFormat[];

  constructor(formats: readonly CellFormat[]) {
    this.#formats = formats;
  }

  /** The format of a cell style; General for a style the stylesheet does not define. */
  format(styleIndex: number): CellFormat {
    return this.#formats[styleIndex] ?? GENERAL;
  }

  static readonly empty = new StyleTable([]);
}

function cellFormat(numFmtId: number, custom: ReadonlyMap<number, string>): CellFormat {
  const code = custom.get(numFmtId) ?? builtInFormatCode(numFmtId);
  const numFmt = code === null || code.toLowerCase() === 'general' ? null : code;
  return { numFmt, dateKind: dateFormatKind(numFmtId, numFmt) };
}

function intAttr(value: string | undefined): number {
  const n = Number(value ?? '0');
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export function parseStyles(bytes: Uint8Array, part: string): StyleTable {
  const custom = new Map<number, string>();
  const xfFormatIds: number[] = [];
  let inCellXfs = false;
  parseXml(bytes, part, {
    open(name, attrs) {
      if (name === 'numFmt') {
        const code = attr(attrs, 'formatCode');
        if (code !== undefined) custom.set(intAttr(attr(attrs, 'numFmtId')), code);
      } else if (name === 'cellXfs') {
        inCellXfs = true;
      } else if (name === 'xf' && inCellXfs) {
        xfFormatIds.push(intAttr(attr(attrs, 'numFmtId')));
      }
    },
    close(name) {
      if (name === 'cellXfs') inCellXfs = false;
    },
  });
  // numFmts come before cellXfs in the schema, but a lenient producer may reverse them.
  return new StyleTable(xfFormatIds.map((id) => cellFormat(id, custom)));
}
