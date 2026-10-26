/**
 * The committed messy-file library (SAD section 13.2) read by this module: the workbooks the golden
 * tests import. Their expectations are dataset-level, so these tests check what the reader is
 * responsible for: the dataset detections and their confidence, the flattened header that detect
 * reads names and units from, the data rows and the import notes. Cell-level reader details are
 * covered by reader.test.ts on the module's own workbooks.
 */
import { describe, expect, it } from 'vitest';
import { fixtureBytes, fixtureExpectation, fixtureSource, FIXTURE_NAMES, type FixtureName } from '@tw/fixtures';
import type { RawField } from '@tw/model';
import { readAll } from './__fixtures__';
import { detectTables, openWorkbook, xlsxImporter, type XlsxCell, type XlsxSheet } from './index';
import { parseCellRef } from './refs';

const WORKBOOKS = FIXTURE_NAMES.filter((name) => name.endsWith('.xlsx'));
const DATASET_DETECTIONS = ['sheet', 'date1904', 'skipLines', 'headerRows'] as const;

function cellAt(sheet: XlsxSheet, ref: string): XlsxCell | undefined {
  const at = parseCellRef(ref);
  if (at === null) throw new Error(`bad ref ${ref}`);
  return sheet.rows.find((row) => row.r === at.r)?.cells.find((cell) => cell.c === at.c);
}

function sheetOf(name: FixtureName): XlsxSheet {
  const book = openWorkbook(fixtureBytes(name));
  const expected = fixtureExpectation(name).detections.sheet;
  if (expected === undefined) throw new Error(`${name} names no sheet`);
  return book.readSheet(expected);
}

describe.each(WORKBOOKS)('%s from the library', (name) => {
  const expected = fixtureExpectation(name);

  it('gives the dataset detections and confidences of its expectation', async () => {
    const sniff = await xlsxImporter.sniff(fixtureSource(name));
    for (const key of DATASET_DETECTIONS) {
      expect(sniff.detections[key]?.value, key).toEqual(expected.detections[key]);
      expect(sniff.detections[key]?.confidence, key).toBe(expected.confidence[key]);
    }
  });

  it('flattens a header from which every expected column name and unit can be read', async () => {
    const sniff = await xlsxImporter.sniff(fixtureSource(name));
    const header = sniff.header[0] ?? [];
    expect(sniff.header).toHaveLength(1);
    expect(header).toHaveLength(expected.columns.length);
    expected.columns.forEach((column, i) => {
      const text = header[i] ?? '';
      expect(text.startsWith(column.name), text).toBe(true);
      if (column.unit !== null) expect(text, text).toContain(column.unit);
    });
  });

  it('reads the expected number of data rows and emits the expected notes', async () => {
    const src = fixtureSource(name);
    const out = await readAll(src, (await xlsxImporter.sniff(src)).options);
    const rows = out.batches.flatMap((b) => b.rows);
    expect(rows).toHaveLength(expected.rowCount);
    expect(rows.every((r) => r.fields.length === expected.columns.length)).toBe(true);
    expect([...new Set(out.notes.map((n) => n.code))].sort()).toEqual(expected.notes ?? []);
  });
});

describe('library workbooks in detail', () => {
  it('xlsx_hidden_sheets_formulas.xlsx: lists hidden sheets, skips them and gives cached formula values', () => {
    const book = openWorkbook(fixtureBytes('xlsx_hidden_sheets_formulas.xlsx'));
    expect(book.sheets).toEqual([
      { name: 'Config', state: 'hidden' },
      { name: 'Production', state: 'visible' },
      { name: 'Notes', state: 'veryHidden' },
    ]);
    const cells = book.readSheet('Production').rows.flatMap((row) => row.cells);
    const formulas = cells.filter((cell) => cell.formula);
    expect(formulas.length).toBeGreaterThan(0);
    expect(formulas.filter((cell) => typeof cell.v === 'number').length).toBeGreaterThan(0);
    expect(formulas.filter((cell) => cell.t === 'e').map((cell) => cell.v)).toEqual([{ error: '#DIV/0!' }]);
  });

  it('xlsx_date1904.xlsx: converts serials of the 1904 system', () => {
    const book = openWorkbook(fixtureBytes('xlsx_date1904.xlsx'));
    expect(book.date1904).toBe(true);
    expect(cellAt(sheetOf('xlsx_date1904.xlsx'), 'B2')).toMatchObject({ v: { date: '2026-01-31' }, isDate: true });
  });

  it('xlsx_text_and_serial_dates.xlsx: gives date cells for serials and keeps text dates as text', () => {
    const sheet = sheetOf('xlsx_text_and_serial_dates.xlsx');
    expect(cellAt(sheet, 'B2')?.v).toEqual({ date: '2026-03-02' });
    expect(cellAt(sheet, 'C2')?.v).toEqual({ datetime: '2026-03-02T07:30:00.000Z' });
    expect(cellAt(sheet, 'B5')).toMatchObject({ t: 's', v: '2026-03-03', isDate: false });
    expect(cellAt(sheet, 'E2')).toMatchObject({ t: 's', v: '15/01/2026' });
    // A plain number under a date header stays a number; detect decides whether it is a serial.
    expect(cellAt(sheet, 'D2')).toMatchObject({ t: 'n', v: 45292, isDate: false });
  });

  it("xlsx_numbers_as_text.xlsx: keeps numeric text in t='s' cells as strings", () => {
    const sheet = sheetOf('xlsx_numbers_as_text.xlsx');
    const text: [string, RawField][] = [
      ['A2', '0042'],
      ['C2', '1234.5'],
      ['D3', '305.1'],
    ];
    for (const [ref, v] of text) expect(cellAt(sheet, ref), ref).toMatchObject({ t: 's', v });
    expect(cellAt(sheet, 'D2')).toMatchObject({ t: 'n', v: 210.4 });
  });

  it('xlsx_merged_two_row_header_units.xlsx: skips the title and joins the header with its units', () => {
    const [table, ...rest] = detectTables(sheetOf('xlsx_merged_two_row_header_units.xlsx'));
    const columns = fixtureExpectation('xlsx_merged_two_row_header_units.xlsx').columns;
    expect(rest).toEqual([]);
    expect(table?.headerRows).toEqual([1, 3]);
    expect(table?.flattenedHeader).toEqual(columns.map((c) => (c.unit === null ? c.name : `${c.name} [${c.unit}]`)));
    expect(table?.notes.map((n) => n.code)).toEqual(['TW-IMP-003']);
  });

  it('xlsx_two_tables_one_sheet.xlsx: finds both tables and names the second in TW-IMP-002', () => {
    const tables = detectTables(sheetOf('xlsx_two_tables_one_sheet.xlsx'));
    expect(tables).toHaveLength(2);
    const note = tables[1]?.notes.find((n) => n.code === 'TW-IMP-002');
    expect(note?.detail).toEqual({ sheet: 'Summary', range: 'A11:C15' });
    expect(note?.message).toContain('A11:C15');
  });
});
