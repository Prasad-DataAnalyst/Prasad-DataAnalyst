/**
 * Legacy .xls workbooks (BIFF8 in an OLE compound file). The fixtures are XLSX fixtures saved by
 * LibreOffice as Excel 97-2003 workbooks, so both readers must give the same workbook.
 */
import { describe, expect, it } from 'vitest';
import { fixtureBytes, type FixtureName } from '@tw/fixtures';
import { openWorkbook } from './index';

const PAIRS: [FixtureName, FixtureName][] = [
  ['xls_merged_two_row_header_units.xls', 'xlsx_merged_two_row_header_units.xlsx'],
  ['xls_date1904.xls', 'xlsx_date1904.xlsx'],
];

const FREE = 0xffffffff;
const END = 0xfffffffe;

/** A minimal version 3 compound file holding one stream (at least 4 KiB, so not in the mini stream). */
function compoundFile(streamName: string, data: Uint8Array, o: { loop?: boolean } = {}): Uint8Array {
  const body = new Uint8Array(Math.max(4096, Math.ceil(data.length / 512) * 512));
  body.set(data);
  const dataSectors = body.length / 512;
  const out = new Uint8Array(512 * (3 + dataSectors));
  const view = new DataView(out.buffer);
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].forEach((b, i) => (out[i] = b));
  view.setUint16(0x18, 0x3e, true);
  view.setUint16(0x1a, 3, true);
  view.setUint16(0x1c, 0xfffe, true);
  view.setUint16(0x1e, 9, true);
  view.setUint16(0x20, 6, true);
  view.setUint32(0x2c, 1, true);
  view.setUint32(0x30, 1, true);
  view.setUint32(0x38, 4096, true);
  view.setUint32(0x3c, END, true);
  view.setUint32(0x44, END, true);
  for (let i = 0; i < 109; i++) view.setUint32(0x4c + i * 4, i === 0 ? 0 : FREE, true);
  // Sector 0: the FAT. Sector 1: the directory. Sectors 2 on: the stream.
  const fat = 512;
  for (let i = 0; i < 128; i++) view.setUint32(fat + i * 4, FREE, true);
  view.setUint32(fat, 0xfffffffd, true);
  view.setUint32(fat + 4, END, true);
  for (let i = 0; i < dataSectors; i++) {
    const next = i === dataSectors - 1 ? END : 2 + i + 1;
    view.setUint32(fat + (2 + i) * 4, o.loop === true && i === dataSectors - 1 ? 2 : next, true);
  }
  const entry = (n: number, name: string, type: number, start: number, size: number) => {
    const at = 1024 + n * 128;
    for (let i = 0; i < name.length; i++) view.setUint16(at + i * 2, name.charCodeAt(i), true);
    view.setUint16(at + 0x40, (name.length + 1) * 2, true);
    out[at + 0x42] = type;
    for (const off of [0x44, 0x48, 0x4c]) view.setUint32(at + off, FREE, true);
    view.setUint32(at + 0x74, start, true);
    view.setUint32(at + 0x78, size, true);
  };
  entry(0, 'Root Entry', 5, END, 0);
  view.setUint32(1024 + 0x4c, 1, true);
  entry(1, streamName, 2, 2, body.length);
  out.set(body, 512 * 3);
  return out;
}

/** BIFF records: [type, data] pairs. */
function biff(...records: [number, number[]][]): Uint8Array {
  const bytes: number[] = [];
  for (const [type, data] of records) bytes.push(type & 0xff, type >> 8, data.length & 0xff, data.length >> 8, ...data);
  return new Uint8Array(bytes);
}

describe('legacy .xls workbooks', () => {
  it.each(PAIRS)('%s reads as %s does', (xls, xlsx) => {
    const legacy = openWorkbook(fixtureBytes(xls));
    const modern = openWorkbook(fixtureBytes(xlsx));
    expect(legacy.sheets).toEqual(modern.sheets);
    expect(legacy.date1904).toBe(modern.date1904);
    const cells = (s: ReturnType<typeof legacy.readSheet>) =>
      s.rows.map((r) => [r.r, r.cells.map((c) => ({ c: c.c, v: c.v, isDate: c.isDate, formula: c.formula }))]);
    for (const { name } of modern.sheets) {
      const a = legacy.readSheet(name);
      const b = modern.readSheet(name);
      expect({ dimension: a.dimension, merges: a.merges, frozen: a.frozen }).toEqual({
        dimension: b.dimension,
        merges: b.merges,
        frozen: b.frozen,
      });
      expect(cells(a)).toEqual(cells(b));
    }
  });

  it('refuses older workbooks, encrypted ones and other Office documents, saying what they are', () => {
    const cases: [Uint8Array, RegExp][] = [
      [compoundFile('Book', new Uint8Array(16)), /Excel 5\.0\/95/],
      [compoundFile('WordDocument', new Uint8Array(16)), /not an Excel workbook/],
      [compoundFile('EncryptionInfo', new Uint8Array(16)), /password-protected/],
      [compoundFile('Workbook', biff([0x0809, [0x00, 0x05, 0x05, 0x00]])), /before Excel 97/],
      [
        compoundFile('Workbook', biff([0x0809, [0x00, 0x06, 0x05, 0x00]], [0x002f, [0, 0]])),
        /protected with a password/,
      ],
    ];
    for (const [bytes, message] of cases) {
      expect(() => openWorkbook(bytes)).toThrow(message);
      expect(() => openWorkbook(bytes)).toThrow(expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' }) as Error);
    }
  });

  it('reports a damaged file instead of looping or reading past its end', () => {
    const looping = compoundFile('Workbook', biff([0x0809, [0x00, 0x06, 0x05, 0x00]]), { loop: true });
    expect(() => openWorkbook(looping)).toThrow(expect.objectContaining({ code: 'PARSE_FAILED' }) as Error);
    const whole = fixtureBytes('xls_date1904.xls');
    expect(() => openWorkbook(whole.subarray(0, 1536))).toThrow(
      expect.objectContaining({ code: 'PARSE_FAILED' }) as Error,
    );
  });
});
