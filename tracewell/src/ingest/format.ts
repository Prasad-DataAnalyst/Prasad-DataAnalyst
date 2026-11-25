/**
 * Source format detection from the first bytes and the file name. Content wins over the extension;
 * the extension only raises confidence or breaks a tie between CSV and TSV.
 */
import { decodeAll, sniffEncoding } from '@tw/io';
import { detection, type Detection, type Importer, type SourceFormat } from '@tw/model';
import { csvImporter } from '@tw/formats-csv';
import { flatgeobufImporter } from '@tw/formats-flatgeobuf';
import { geojsonImporter } from '@tw/formats-geojson';
import { kmlImporter } from '@tw/formats-kml';
import { jsonImporter } from '@tw/formats-json';
import { parquetImporter } from '@tw/formats-parquet';
import { xlsxImporter } from '@tw/formats-xlsx';

/** Enough of the file to see past a BOM, leading whitespace and the first line. */
export const FORMAT_SNIFF_BYTES = 65_536;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const PARQUET_MAGIC = [0x50, 0x41, 0x52, 0x31];
/** "fgb" and major version 3: the start of a FlatGeobuf file. */
const FLATGEOBUF_MAGIC = [0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62];
/** An OLE compound file: the container of Excel 97-2003 workbooks (.xls). */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** GeoJSON object types; one of them as the top-level "type" marks a JSON file as GeoJSON. */
const GEOJSON_TYPES: ReadonlySet<string> = new Set([
  'FeatureCollection',
  'Feature',
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);
const WORKBOOK_ENTRY = new TextEncoder().encode('xl/workbook');

/** The name of a ZIP archive's first entry, from its local header. */
function firstZipEntry(head: Uint8Array): string {
  if (head.length < 30) return '';
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const length = view.getUint16(26, true);
  return new TextDecoder().decode(head.subarray(30, Math.min(head.length, 30 + length)));
}

/** XML whose root element is kml, after any declaration, processing instructions and comments. */
const KML_ROOT =
  /^(?:[ \t\r\n]*(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->))*[ \t\r\n]*<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?kml[ \t\r\n/>]/;

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/** The index of the quote closing the string that opens at `start`, or -1 when the text ends first. */
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

/**
 * The value of the top-level object's "type" member when it is a string within `text`, else null.
 * Members of nested objects (a record's own "type", say) are skipped.
 */
function topLevelType(text: string): string | null {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      if (end < 0) return null;
      if (depth === 1 && text.slice(i, end + 1) === '"type"') {
        const value = /^\s*:\s*"([^"\\]*)"/.exec(text.slice(end + 1, end + 64));
        if (value !== null) return value[1] ?? null;
      }
      i = end;
    } else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return null;
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
    if (firstZipEntry(head).toLowerCase().endsWith('.kml') || ext === 'kmz') {
      return detection('kml', 'high', 'zip-kml', 'The file is a ZIP archive holding a KML document (KMZ).');
    }
    return detection(
      'xlsx',
      ext === 'xlsx' ? 'medium' : 'low',
      'zip-magic',
      'The file is a ZIP archive; it is read as an Excel workbook because no other ZIP-based format is supported.',
    );
  }

  if (startsWith(head, OLE_MAGIC)) {
    return detection(
      'xlsx',
      ext === 'xls' ? 'high' : 'medium',
      'ole-workbook',
      'The file is an OLE compound file, the container of Excel 97-2003 workbooks (.xls).',
    );
  }

  if (startsWith(head, FLATGEOBUF_MAGIC)) {
    return detection('flatgeobuf', 'high', 'flatgeobuf-magic', 'The file starts with the FlatGeobuf marker fgb.');
  }

  if (startsWith(head, PARQUET_MAGIC)) {
    return detection('parquet', 'high', 'parquet-magic', 'The file starts with the Parquet marker PAR1.');
  }

  const sample = head.subarray(0, Math.min(head.length, FORMAT_SNIFF_BYTES));
  const { bomLength, value: encoding } = sniffEncoding(sample);
  const text = decodeAll(sample, encoding, bomLength).replace(/^\uFEFF/, '');
  const first = text.trimStart().charAt(0);

  if (first === '<') {
    if (KML_ROOT.test(text)) {
      return detection('kml', 'high', 'kml-root', 'The file is XML whose root element is kml.');
    }
    if (ext === 'kml') return detection('kml', 'medium', 'extension', 'The file is XML with the .kml extension.');
  }

  if (first === '{' || first === '[') {
    if (ext === 'geojson') {
      return detection('geojson', 'high', 'json-start', 'The file starts with JSON and has the .geojson extension.');
    }
    if (first === '{' && GEOJSON_TYPES.has(topLevelType(text.trimStart()) ?? '')) {
      return detection(
        'geojson',
        ext === 'json' ? 'high' : 'medium',
        'geojson-type',
        'The file is a JSON object with a GeoJSON "type" member, so it is read as GeoJSON.',
      );
    }
    const known = ext === 'json' || ext === 'jsonl' || ext === 'ndjson';
    return detection(
      'json',
      known ? 'high' : 'medium',
      'json-start',
      known
        ? `The file starts with JSON and has the .${ext} extension.`
        : 'The file starts with JSON and holds no GeoJSON object type, so it is read as JSON records.',
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
    case 'json':
      return jsonImporter;
    case 'parquet':
      return parquetImporter;
    case 'flatgeobuf':
      return flatgeobufImporter;
    case 'kml':
      return kmlImporter;
  }
}
