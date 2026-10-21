/**
 * Named CSV/TSV fixtures for this module's tests, each with what the adapter must find in it.
 *
 * They carry the names of the messy-file library entries whose problem they reproduce. The
 * library itself (fixtures/messy) belongs to the fixtures module, which this module does not
 * depend on, so these copies keep the tests self-contained; library.test.ts checks the library. Bytes are built in code because the repository normalises
 * text files to LF: BOMs, CRLF, lone CRs, UTF-16 and windows-1252 bytes would not survive as files.
 * Non-ASCII characters are written as escapes so this source stays plain ASCII.
 */
import type { Confidence, ImportNoteCode, JsonValue, SourceFormat } from '@tw/model';

export type SampleName =
  | 'csv_quoted_newlines_ragged.csv'
  | 'csv_semicolon_decimalcomma_cp1252.csv'
  | 'csv_title_rows_units_in_header.csv'
  | 'tsv_utf16le_bom.tsv'
  | 'csv_pipe_delimited.csv'
  | 'csv_utf8_bom_crlf.csv';

export type DetectionKey =
  'encoding' | 'delimiter' | 'quote' | 'skipLines' | 'headerRows' | 'decimalSeparator' | 'thousandsSeparator';

export interface SampleExpectation {
  format: SourceFormat;
  bomLength: number;
  /** Value and confidence of each detection csvImporter.sniff makes. */
  detections: Record<DetectionKey, { value: JsonValue; confidence: Confidence }>;
  header: string[][];
  /** Data rows read by csvImporter.read. */
  rowCount: number;
  /** Physical line of every record, header included, as the tokenizer reports it. */
  recordLines?: number[];
  /** Lines of the rows reported as ragged (TW-IMP-001), in order. */
  raggedLines: number[];
  /** Note codes of csvImporter.sniff, in order. */
  sniffNotes: ImportNoteCode[];
}

export interface Sample {
  name: SampleName;
  bytes: Uint8Array;
  expected: SampleExpectation;
}

const DEGREE = '\u00b0';
const CUBED = '\u00b3';
const U_UMLAUT = '\u00fc';
const O_SLASH = '\u00f8';
const A_RING = '\u00c5';
const E_ACUTE = '\u00e9';

function utf8(text: string, bom = false): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

/** Only characters whose windows-1252 byte equals their code point (ASCII and U+00A0-U+00FF). */
function windows1252(text: string): Uint8Array {
  return Uint8Array.from(text, (ch) => {
    const code = ch.charCodeAt(0);
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) return code;
    throw new Error(`U+${code.toString(16)} is not in the simple windows-1252 range used by the samples.`);
  });
}

function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out.set([0xff, 0xfe]);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[2 + i * 2] = code & 0xff;
    out[3 + i * 2] = code >> 8;
  }
  return out;
}

const high = (value: JsonValue): { value: JsonValue; confidence: Confidence } => ({ value, confidence: 'high' });

/**
 * Quoted LF, CRLF and lone-CR line breaks, an escaped quote, a quoted delimiter, an empty quoted
 * field, an empty final field, a short row (line 5), a long row (line 9) and no final line break.
 */
const QUOTED_NEWLINES_RAGGED: Sample = {
  name: 'csv_quoted_newlines_ragged.csv',
  bytes: utf8(
    [
      'well_id,comment,rate_bopd,status\n', // line 1
      'W-001,"Choke changed\nafter test",1250.5,active\n', // lines 2-3
      'W-002,"He said ""shut in""",0,shut-in\n', // line 4
      'W-003,"short, row",980\n', // line 5: 3 fields
      'W-004,"multi\r\nline\r\ncomment",1100,active\r\n', // lines 6-8
      'W-005,extra,1200,active,unexpected\n', // line 9: 5 fields
      'W-006,"",1300,active\n', // line 10
      'W-007,"trailing\n",1400,\n', // lines 11-12
      'W-008,plain,1500,active\n', // line 13
      'W-009,plain,1510,active\n', // line 14
      'W-010,plain,1520,active\n', // line 15
      'W-011,"a\rb",1530,active\n', // lines 16-17
      'W-012,last,1540,active', // line 18, no line break
    ].join(''),
  ),
  expected: {
    format: 'csv',
    bomLength: 0,
    detections: {
      encoding: high('utf-8'),
      // 11 of the 13 lines have the 4 fields; the two ragged rows keep it from 'high'.
      delimiter: { value: ',', confidence: 'medium' },
      quote: high('"'),
      skipLines: high(0),
      headerRows: high(1),
      decimalSeparator: high('.'),
      thousandsSeparator: high(''),
    },
    header: [['well_id', 'comment', 'rate_bopd', 'status']],
    rowCount: 12,
    recordLines: [1, 2, 4, 5, 6, 9, 10, 11, 13, 14, 15, 16, 18],
    raggedLines: [5, 9],
    sniffNotes: ['TW-IMP-001', 'TW-IMP-001'],
  },
};

/** A European export: windows-1252 (degree sign, cubed, umlauts), semicolons, decimal commas, CRLF. */
const SEMICOLON_DECIMALCOMMA_CP1252: Sample = {
  name: 'csv_semicolon_decimalcomma_cp1252.csv',
  bytes: windows1252(
    [
      `Well;Date;Temperature ${DEGREE}C;Pressure bar;Gas volume m${CUBED};Operator\r\n`,
      `A-01;01.03.2026;12,5;101,3;1.234,50;M${U_UMLAUT}ller\r\n`,
      `A-01;02.03.2026;12,8;100,9;1.198,25;M${U_UMLAUT}ller\r\n`,
      `A-02;01.03.2026;-3,2;98,4;987,00;S${O_SLASH}ren\r\n`,
      `A-02;02.03.2026;0,0;97,1;1.002,75;S${O_SLASH}ren\r\n`,
      `B-01;01.03.2026;18,1;110,0;2.345,10;${A_RING}gren\r\n`,
      `B-01;02.03.2026;17,9;109,6;2.298,40;${A_RING}gren\r\n`,
    ].join(''),
  ),
  expected: {
    format: 'csv',
    bomLength: 0,
    detections: {
      encoding: { value: 'windows-1252', confidence: 'low' },
      delimiter: high(';'),
      quote: high('"'),
      skipLines: high(0),
      headerRows: high(1),
      decimalSeparator: high(','),
      thousandsSeparator: high('.'),
    },
    header: [['Well', 'Date', `Temperature ${DEGREE}C`, 'Pressure bar', `Gas volume m${CUBED}`, 'Operator']],
    rowCount: 6,
    raggedLines: [],
    sniffNotes: ['TW-IMP-004'],
  },
};

/**
 * Two title lines and a blank line above the header, and a units row under it. The library file
 * writes its units inside the header names; this copy also covers the separate units row.
 */
const TITLE_ROWS_UNITS_IN_HEADER: Sample = {
  name: 'csv_title_rows_units_in_header.csv',
  bytes: utf8(
    [
      'North Basin daily production report\n',
      'Exported from SCADA, 2026-03-05 06:00\n',
      '\n',
      'Well,Date,Oil rate,Gas rate,Tubing pressure\n',
      ',,bbl/d,Mscf/d,psia\n',
      'NB-01,2026-03-01,1250,3400,1850.5\n',
      'NB-01,2026-03-02,1238,3388,1849.0\n',
      'NB-01,2026-03-03,1241,3392,1848.2\n',
      'NB-02,2026-03-01,860,2100,1620.4\n',
      'NB-02,2026-03-02,855,2093,1619.9\n',
      'NB-02,2026-03-03,851,2090,1618.7\n',
      'NB-03,2026-03-01,0,0,1503.1\n',
      'NB-03,2026-03-02,0,0,1503.0\n',
    ].join(''),
  ),
  expected: {
    format: 'csv',
    bomLength: 0,
    detections: {
      encoding: high('utf-8'),
      delimiter: high(','),
      quote: high('"'),
      skipLines: high(3),
      headerRows: high(2),
      decimalSeparator: high('.'),
      thousandsSeparator: high(''),
    },
    header: [
      ['Well', 'Date', 'Oil rate', 'Gas rate', 'Tubing pressure'],
      ['', '', 'bbl/d', 'Mscf/d', 'psia'],
    ],
    rowCount: 8,
    raggedLines: [],
    sniffNotes: ['TW-IMP-003'],
  },
};

/** UTF-16 little-endian with a byte-order mark, tab-separated, CRLF. */
const TSV_UTF16LE_BOM: Sample = {
  name: 'tsv_utf16le_bom.tsv',
  bytes: utf16le(
    [
      'Well\tDate\tWater cut %\tChoke size /64\tComment\r\n',
      'W-1\t2026-03-01\t12.5\t32\tStable\r\n',
      'W-1\t2026-03-02\t12.9\t32\tStable\r\n',
      `W-2\t2026-03-01\t48.1\t40\tSand at ${O_SLASH}len separator\r\n`,
      'W-2\t2026-03-02\t47.6\t40\tShut in for 2 h\r\n',
      'W-3\t2026-03-01\t5.0\t24\t\r\n',
    ].join(''),
  ),
  expected: {
    format: 'tsv',
    bomLength: 2,
    detections: {
      encoding: high('utf-16le'),
      delimiter: high('\t'),
      quote: high('"'),
      skipLines: high(0),
      headerRows: high(1),
      decimalSeparator: high('.'),
      thousandsSeparator: high(''),
    },
    header: [['Well', 'Date', 'Water cut %', 'Choke size /64', 'Comment']],
    rowCount: 5,
    raggedLines: [],
    sniffNotes: [],
  },
};

/** Pipe-separated, with unquoted commas in every data line (in text and as thousands separators). */
const PIPE_DELIMITED: Sample = {
  name: 'csv_pipe_delimited.csv',
  bytes: utf8(
    [
      'well|field|block|oil_rate|gas_rate\n',
      'W-101|North Sea|Block 7, Area B|1,250.5|3,400.0\n',
      'W-102|North Sea|Block 7, Area C|1,180.0|3,215.5\n',
      'W-103|Gulf Coast|Block 12, Area A|2,045.2|5,010.8\n',
      'W-104|Gulf Coast|Block 12, Area D|1,998.7|4,987.1\n',
    ].join(''),
  ),
  expected: {
    format: 'csv',
    bomLength: 0,
    detections: {
      encoding: high('utf-8'),
      delimiter: high('|'),
      quote: high('"'),
      skipLines: high(0),
      headerRows: high(1),
      decimalSeparator: high('.'),
      thousandsSeparator: high(','),
    },
    header: [['well', 'field', 'block', 'oil_rate', 'gas_rate']],
    rowCount: 4,
    raggedLines: [],
    sniffNotes: [],
  },
};

/** UTF-8 with a byte-order mark and CRLF line breaks; a degree sign in the header. */
const UTF8_BOM_CRLF: Sample = {
  name: 'csv_utf8_bom_crlf.csv',
  bytes: utf8(
    [
      `well,date,temperature [${DEGREE}C],pressure [kPa],comment\r\n`,
      'A-1,2026-01-01,12.5,101.3,"Ok, stable"\r\n',
      `A-1,2026-01-02,12.7,101.1,Caf${E_ACUTE} visit\r\n`,
      'A-2,2026-01-01,-4.0,99.8,\r\n',
      'A-2,2026-01-02,-3.6,99.9,Frost on gauge\r\n',
    ].join(''),
    true,
  ),
  expected: {
    format: 'csv',
    bomLength: 3,
    detections: {
      encoding: high('utf-8'),
      delimiter: high(','),
      quote: high('"'),
      skipLines: high(0),
      headerRows: high(1),
      decimalSeparator: high('.'),
      thousandsSeparator: high(''),
    },
    header: [['well', 'date', `temperature [${DEGREE}C]`, 'pressure [kPa]', 'comment']],
    rowCount: 4,
    raggedLines: [],
    sniffNotes: [],
  },
};

export const SAMPLES: Readonly<Record<SampleName, Sample>> = {
  'csv_quoted_newlines_ragged.csv': QUOTED_NEWLINES_RAGGED,
  'csv_semicolon_decimalcomma_cp1252.csv': SEMICOLON_DECIMALCOMMA_CP1252,
  'csv_title_rows_units_in_header.csv': TITLE_ROWS_UNITS_IN_HEADER,
  'tsv_utf16le_bom.tsv': TSV_UTF16LE_BOM,
  'csv_pipe_delimited.csv': PIPE_DELIMITED,
  'csv_utf8_bom_crlf.csv': UTF8_BOM_CRLF,
};

export const SAMPLE_NAMES = Object.keys(SAMPLES) as SampleName[];

/** Decodes a sample's text the way its expectation says it is encoded (for tokenizer tests). */
export function sampleText(name: SampleName): string {
  const { bytes, expected } = SAMPLES[name];
  const encoding = expected.detections.encoding.value as string;
  return new TextDecoder(encoding === 'windows-1252' ? 'latin1' : encoding).decode(bytes.subarray(expected.bomLength));
}
