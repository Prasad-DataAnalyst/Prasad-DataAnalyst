/**
 * Source format detection from the first bytes and the file name. Content wins over the extension;
 * the extension only raises confidence or breaks a tie between CSV and TSV.
 */
import { decodeAll, sniffEncoding } from '@tw/io';
import { detection, type Detection, type Importer, type SourceFormat } from '@tw/model';
import { csvImporter } from '@tw/formats-csv';
import { geojsonImporter } from '@tw/formats-geojson';
import { xlsxImporter } from '@tw/formats-xlsx';

/** Enough of the file to see past a BOM, leading whitespace and the first line. */
export const FORMAT_SNIFF_BYTES = 65_536;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const WORKBOOK_ENTRY = new TextEncoder().encode('xl/workbook');

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

export function detectFormat(head: Uint8Array, fileName: string): Detection<SourceFormat> {
  const ext = extensionOf(fileName);

  if (startsWith(head, ZIP_MAGIC)) {
    if (contains(head, WORKBOOK_ENTRY)) {
      return detection('xlsx', 'high', 'zip-workbook', 'The file is a ZIP archive holding an Excel workbook.');
    }
    return detection(
      'xlsx',
      ext === 'xlsx' ? 'medium' : 'low',
      'zip-magic',
      'The file is a ZIP archive; it is read as an Excel workbook because no other ZIP-based format is supported.',
    );
  }

  const sample = head.subarray(0, Math.min(head.length, FORMAT_SNIFF_BYTES));
  const { bomLength, value: encoding } = sniffEncoding(sample);
  const text = decodeAll(sample, encoding, bomLength).replace(/^\uFEFF/, '');
  const first = text.trimStart().charAt(0);

  if (first === '{' || first === '[') {
    const known = ext === 'geojson' || ext === 'json';
    return detection(
      'geojson',
      known ? 'high' : 'medium',
      'json-start',
      known
        ? `The file starts with JSON and has the .${ext} extension.`
        : 'The file starts with JSON, so it is read as GeoJSON.',
    );
  }

  if (ext === 'tsv' || ext === 'tab') {
    return detection('tsv', 'high', 'extension', `The file has the .${ext} extension.`);
  }
  if (ext === 'csv') return detection('csv', 'high', 'extension', 'The file has the .csv extension.');

  const line = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = line.split('\t').length - 1;
  const others = Math.max(line.split(',').length, line.split(';').length, line.split('|').length) - 1;
  if (tabs > others) {
    return detection('tsv', 'medium', 'tab-count', 'The first line is separated by tabs, so the file is read as TSV.');
  }
  return detection(
    'csv',
    'medium',
    'text-default',
    ext === ''
      ? 'The file is text without an extension, so it is read as delimited text (CSV).'
      : `The file is text with the .${ext} extension, so it is read as delimited text (CSV).`,
  );
}

export function importerFor(format: SourceFormat): Importer {
  switch (format) {
    case 'csv':
    case 'tsv':
      return csvImporter;
    case 'xlsx':
      return xlsxImporter;
    case 'geojson':
      return geojsonImporter;
  }
}
