/**
 * Opening a workbook: the ZIP is read in memory under a decompressed-size guard (SAD section 12),
 * then the workbook part gives the sheets and the date system. The shared strings and styles are
 * parsed once, when the first sheet is read; each sheet is parsed when it is asked for.
 */
import { readZip, type ZipReader } from '@tw/io';
import { EngineError } from '@tw/model';
import { damagedWorkbook, notAWorkbook } from './errors';
import { isRelType, Package, type Relationship } from './package';
import { parseSharedStrings } from './shared-strings';
import { parseSheet } from './sheet';
import { parseStyles, StyleTable } from './styles';
import type { SheetState, XlsxSheet, XlsxWorkbook } from './types';
import { attr, parseXml, xmlBool } from './xml';

/** Default cap on the decompressed size of all parts together. */
export const DEFAULT_MAX_INFLATED_BYTES = 512 * 1024 * 1024;

const SAVE_AS_XLSX_FIX =
  'Open the file in Excel or LibreOffice and save it as an Excel workbook (.xlsx) without a password, ' +
  'then import the new copy.';

/** The signature of an OLE compound file: legacy .xls, and password-protected .xlsx. */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

interface SheetEntry {
  name: string;
  state: SheetState;
  relId: string;
}

interface WorkbookPart {
  sheets: SheetEntry[];
  date1904: boolean;
}

function isOleFile(bytes: Uint8Array): boolean {
  return OLE_SIGNATURE.every((b, i) => bytes[i] === b);
}

function openZip(bytes: Uint8Array, maxInflatedBytes: number): ZipReader {
  if (isOleFile(bytes)) {
    throw notAWorkbook(
      'The file is a legacy Excel workbook (.xls) or a password-protected workbook, which cannot be read.',
      SAVE_AS_XLSX_FIX,
    );
  }
  try {
    return readZip(bytes, { maxInflatedBytes });
  } catch (e) {
    if (e instanceof EngineError && e.code === 'FORMAT_UNSUPPORTED') {
      throw notAWorkbook(`The file is not an Excel workbook (.xlsx): ${e.message}`, SAVE_AS_XLSX_FIX, e.detail);
    }
    throw e;
  }
}

function sheetState(value: string | undefined): SheetState {
  return value === 'hidden' || value === 'veryHidden' ? value : 'visible';
}

function parseWorkbookPart(bytes: Uint8Array, part: string): WorkbookPart {
  const sheets: SheetEntry[] = [];
  let date1904 = false;
  parseXml(bytes, part, {
    open(name, attrs) {
      if (name === 'workbookPr') {
        date1904 = xmlBool(attr(attrs, 'date1904')) ?? false;
      } else if (name === 'sheet') {
        const sheetName = attr(attrs, 'name');
        const relId = attr(attrs, 'id');
        if (sheetName === undefined || relId === undefined) {
          throw damagedWorkbook('a sheet in the workbook part has no name or no relationship.', { part });
        }
        sheets.push({ name: sheetName, state: sheetState(attr(attrs, 'state')), relId });
      }
    },
  });
  return { sheets, date1904 };
}

/** The workbook part named by the package relationships, or the conventional path. */
function findWorkbookPart(pkg: Package): string {
  const officeDocument = [...pkg.relationships('').values()].find((rel) => isRelType(rel, 'officeDocument'));
  const part = officeDocument?.target ?? 'xl/workbook.xml';
  const found = pkg.find(part);
  if (found === null) {
    throw notAWorkbook(
      'The file is a ZIP archive but not an Excel workbook: it has no workbook part.',
      'Check that the file is an Excel workbook (.xlsx); other ZIP-based files, such as .docx, cannot be imported here.',
      { part },
    );
  }
  return found;
}

class Workbook implements XlsxWorkbook {
  readonly sheets: { name: string; state: SheetState }[];
  readonly date1904: boolean;
  readonly #pkg: Package;
  readonly #entries: SheetEntry[];
  readonly #rels: Map<string, Relationship>;
  #sharedStrings: readonly string[] | null = null;
  #styles: StyleTable | null = null;

  constructor(pkg: Package, part: string) {
    const book = parseWorkbookPart(pkg.read(part), part);
    this.#pkg = pkg;
    this.#entries = book.sheets;
    this.#rels = pkg.relationships(part);
    this.date1904 = book.date1904;
    this.sheets = book.sheets.map(({ name, state }) => ({ name, state }));
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
    const rel = this.#rels.get(entry.relId);
    if (rel === undefined) throw damagedWorkbook(`the sheet "${name}" has no part.`, { sheet: name });
    // Chart sheets and dialog sheets are sheets of the workbook but hold no cells.
    if (rel.external || !isRelType(rel, 'worksheet')) {
      return { name, state: entry.state, dimension: 'A1', merges: [], frozen: null, autoFilter: null, rows: [] };
    }
    return parseSheet(this.#pkg.read(rel.target), rel.target, {
      name,
      state: entry.state,
      date1904: this.date1904,
      sharedStrings: this.#loadSharedStrings(),
      styles: this.#loadStyles(),
    });
  }

  #partOf(kind: string): string | null {
    const rel = [...this.#rels.values()].find((r) => !r.external && isRelType(r, kind));
    return rel === undefined ? null : this.#pkg.find(rel.target);
  }

  #loadSharedStrings(): readonly string[] {
    if (this.#sharedStrings === null) {
      const part = this.#partOf('sharedStrings');
      this.#sharedStrings = part === null ? [] : parseSharedStrings(this.#pkg.read(part), part);
    }
    return this.#sharedStrings;
  }

  #loadStyles(): StyleTable {
    if (this.#styles === null) {
      const part = this.#partOf('styles');
      this.#styles = part === null ? StyleTable.empty : parseStyles(this.#pkg.read(part), part);
    }
    return this.#styles;
  }
}

/**
 * Opens an XLSX workbook held in memory. Throws EngineError('FORMAT_UNSUPPORTED') when the bytes
 * are not an XLSX workbook (another ZIP file, a legacy .xls, a password-protected file),
 * EngineError('PARSE_FAILED') when a part is missing or not well-formed, and the ZIP reader's
 * EngineError when the archive is damaged or would expand beyond `maxInflatedBytes` (512 MB).
 */
export function openWorkbook(bytes: Uint8Array, o: { maxInflatedBytes?: number } = {}): XlsxWorkbook {
  const zip = openZip(bytes, o.maxInflatedBytes ?? DEFAULT_MAX_INFLATED_BYTES);
  const pkg = new Package(zip);
  return new Workbook(pkg, findWorkbookPart(pkg));
}
