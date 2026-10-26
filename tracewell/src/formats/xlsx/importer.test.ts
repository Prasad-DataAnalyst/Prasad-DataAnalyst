import { describe, expect, it } from 'vitest';
import { bytesSource } from '@tw/io';
import { BATCH_ROWS, EngineError, type FormatOptions, type XlsxOptions } from '@tw/model';
import { fixtureExpectation, fixtureSource, handWorkbook, oneSheet, readAll } from './__fixtures__';
import { writeXlsx, xlsxImporter } from './index';

function xlsxOptions(o: FormatOptions): XlsxOptions {
  if (o.format !== 'xlsx') throw new Error('not xlsx options');
  return o.xlsx;
}

async function rejection(promise: Promise<unknown>): Promise<EngineError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof EngineError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
}

describe('xlsxImporter.sniff', () => {
  it('offers the flattened header as one header row, with sheets, detections and a sample', async () => {
    const expected = fixtureExpectation<{ flattenedHeader: string[]; rowCount: number }>(
      'xlsx_merged_two_row_header_units.xlsx',
    );
    const sniff = await xlsxImporter.sniff(fixtureSource('xlsx_merged_two_row_header_units.xlsx'));
    expect(sniff.format).toBe('xlsx');
    expect(xlsxImporter.formats).toEqual(['xlsx']);
    expect(sniff.header).toEqual([expected.flattenedHeader]);
    expect(xlsxOptions(sniff.options)).toEqual({
      sheet: 'Well tests',
      tableIndex: 0,
      headerRowStart: 1,
      headerRowEnd: 3,
      dataStartRow: 4,
      firstCol: 0,
      lastCol: 5,
    });
    expect(sniff.sampleRows).toHaveLength(expected.rowCount);
    expect(sniff.sampleRows[0]).toEqual({
      srcLoc: 5,
      fields: ['A-01', { date: '2026-01-05' }, 2510.5, 2380, 182.5, 170],
    });
    expect(sniff.sheets).toEqual([
      { name: 'Well tests', state: 'visible', dimension: 'A1:F9', tables: [{ range: 'A2:F9', headerRows: 3 }] },
    ]);
    expect(sniff.notes.map((n) => n.code)).toEqual(['TW-IMP-003']);
    expect(sniff.detections['headerRows']).toMatchObject({
      value: 3,
      confidence: 'high',
      method: 'merged-or-units-header',
    });
    expect(sniff.detections['skipLines']).toMatchObject({ value: 1, confidence: 'high', assumed: false });
    expect(sniff.detections['sheet']).toMatchObject({ value: 'Well tests', confidence: 'high', assumed: false });
    expect(sniff.detections['date1904']).toMatchObject({ value: false, confidence: 'high' });
  });

  it('imports the first table and names the others in TW-IMP-002 rather than in an assumed detection', async () => {
    const sniff = await xlsxImporter.sniff(fixtureSource('xlsx_two_tables_one_sheet.xlsx'));
    expect(sniff.detections['tableIndex']).toMatchObject({ value: 0, assumed: false, method: 'first-table' });
    expect(sniff.detections['tableIndex']?.evidence).toContain('A12:C15');
    expect(sniff.detections['tableRange']).toMatchObject({ value: 'A3:D8' });
    expect(sniff.detections['skipLines']).toMatchObject({ value: 2, assumed: false });
    expect(sniff.notes.map((n) => [n.code, n.detail])).toEqual([['TW-IMP-002', { sheet: 'Report', range: 'A12:C15' }]]);
  });

  it('records the 1904 date system', async () => {
    const sniff = await xlsxImporter.sniff(fixtureSource('xlsx_date1904.xlsx'));
    expect(sniff.detections['date1904']?.value).toBe(true);
    expect(sniff.sampleRows[0]?.fields).toEqual([{ date: '2026-01-31' }, 10.5]);
  });

  it('falls back to a visible sheet without tables, and then to the first sheet', async () => {
    const noTables = handWorkbook({
      sheets: [
        {
          name: 'Hidden',
          state: 'hidden',
          xml: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row></sheetData>',
        },
        {
          name: 'Note',
          xml: '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Just a note</t></is></c></row></sheetData>',
        },
      ],
    });
    const sniff = await xlsxImporter.sniff(bytesSource(noTables, 'notes.xlsx'));
    expect(xlsxOptions(sniff.options)).toMatchObject({ sheet: 'Note', firstCol: 0, lastCol: -1 });
    expect(sniff.header).toEqual([]);
    expect(sniff.sampleRows).toEqual([]);
    expect(sniff.detections['tableIndex']).toMatchObject({ assumed: true, source: 'default' });
    expect(sniff.detections['skipLines']).toMatchObject({ assumed: true, source: 'default' });
    expect(sniff.detections['sheet']).toMatchObject({ value: 'Note', confidence: 'low', source: 'default' });

    const allHidden = handWorkbook({ sheets: [{ name: 'Only', state: 'hidden', xml: '<sheetData/>' }] });
    const fallback = await xlsxImporter.sniff(bytesSource(allHidden, 'hidden.xlsx'));
    expect(xlsxOptions(fallback.options).sheet).toBe('Only');
  });

  it('assumes the first sheet when several visible sheets hold a table', async () => {
    const table = (name: string) => ({
      name,
      columns: [
        { header: 'Well', kind: 'string' as const },
        { header: 'Oil [bbl/d]', kind: 'number' as const },
      ],
      rows: [
        ['A-01', 1],
        ['A-02', 2],
      ],
      freezeHeader: true,
      autoFilter: false,
    });
    const bytes = writeXlsx({
      sheets: [table('North'), table('South')],
      created: '2026-01-01T00:00:00.000Z',
      creator: 'Prasad (Prasad-DataAnalyst)',
    });
    const sniff = await xlsxImporter.sniff(bytesSource(bytes, 'two-sheets.xlsx'));
    expect(sniff.detections['sheet']).toMatchObject({
      value: 'North',
      confidence: 'medium',
      assumed: true,
      method: 'first-visible-sheet-with-table',
    });
    expect(sniff.detections['skipLines']).toMatchObject({ value: 0, confidence: 'high' });
    expect(sniff.sheets?.map((s) => s.tables)).toEqual([
      [{ range: 'A1:B3', headerRows: 1 }],
      [{ range: 'A1:B3', headerRows: 1 }],
    ]);
  });
});

describe('xlsxImporter.read', () => {
  it('reads the data rows of the sniffed table with sheet-row locators and notes', async () => {
    const src = fixtureSource('xlsx_merged_two_row_header_units.xlsx');
    const sniff = await xlsxImporter.sniff(src);
    const out = await readAll(src, sniff.options);
    const rows = out.batches.flatMap((b) => b.rows);
    expect(rows.map((r) => r.srcLoc)).toEqual([5, 6, 7, 8, 9]);
    expect(rows[4]?.fields).toEqual(['B-02', { date: '2026-01-09' }, 2050.75, 1902, 163.5, 155.25]);
    expect(out.notes.map((n) => n.code)).toEqual(['TW-IMP-003']);
    expect(out.bytes).toBe(src.size);
  });

  it('reads the second table when it is chosen, listing the first as not imported', async () => {
    const src = fixtureSource('xlsx_two_tables_one_sheet.xlsx');
    const options: FormatOptions = {
      format: 'xlsx',
      xlsx: {
        sheet: 'Report',
        tableIndex: 1,
        headerRowStart: 11,
        headerRowEnd: 11,
        dataStartRow: 12,
        firstCol: 0,
        lastCol: 2,
      },
    };
    const out = await readAll(src, options);
    const rows = out.batches.flatMap((b) => b.rows);
    expect(rows.map((r) => r.fields[0])).toEqual(['A-01', 'A-02', 'B-01']);
    expect(rows.map((r) => r.srcLoc)).toEqual([13, 14, 15]);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toMatchObject({ code: 'TW-IMP-002', detail: { sheet: 'Report', range: 'A3:D8' } });
    expect(out.notes[0]?.message).toContain('A12:C15 was imported');
  });

  it('reads formula results, booleans and error cells as raw fields', async () => {
    const src = fixtureSource('xlsx_hidden_sheets_formulas.xlsx');
    const out = await readAll(src, (await xlsxImporter.sniff(src)).options);
    const rows = out.batches.flatMap((b) => b.rows);
    expect(rows).toHaveLength(4);
    expect(rows[2]?.fields).toEqual(['A-03', 50, 0, 0, { error: '#DIV/0!' }, 'A-03-ok', false]);
  });

  it('repeats merged data values, skips blank rows and stops at the end of the table', async () => {
    const bytes = oneSheet(
      '<sheetData>' +
        '<row r="1"><c r="A1" t="inlineStr"><is><t>Well</t></is></c><c r="B1" t="inlineStr"><is><t>Oil</t></is></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>A</t></is></c><c r="B2"><v>1</v></c></row>' +
        '<row r="3"><c r="B3"><v>2</v></c></row>' +
        '<row r="4"><c r="A4" t="inlineStr"><is><t> </t></is></c></row>' +
        '<row r="5"><c r="A5" t="inlineStr"><is><t>B</t></is></c><c r="B5"><v>3</v></c></row>' +
        '<row r="9"><c r="A9" t="inlineStr"><is><t>Notes</t></is></c><c r="B9" t="inlineStr"><is><t>Other</t></is></c></row>' +
        '<row r="10"><c r="A10" t="inlineStr"><is><t>x</t></is></c><c r="B10" t="inlineStr"><is><t>y</t></is></c></row>' +
        '</sheetData><mergeCells count="1"><mergeCell ref="A2:A3"/></mergeCells>',
    );
    const src = bytesSource(bytes, 'merged.xlsx');
    const sniff = await xlsxImporter.sniff(src);
    const rows = (await readAll(src, sniff.options)).batches.flatMap((b) => b.rows);
    expect(rows).toEqual([
      { srcLoc: 2, fields: ['A', 1] },
      { srcLoc: 3, fields: ['A', 2] },
      { srcLoc: 5, fields: ['B', 3] },
    ]);
  });

  it('hands out rows in batches of BATCH_ROWS', async () => {
    const rows = Array.from({ length: BATCH_ROWS + 5 }, (_, i) => [i]);
    const bytes = writeXlsx({
      sheets: [
        { name: 'Big', columns: [{ header: 'n', kind: 'integer' }], rows, freezeHeader: true, autoFilter: true },
      ],
      created: '2026-10-21T00:00:00.000Z',
      creator: 'Prasad (Prasad-DataAnalyst)',
    });
    const src = bytesSource(bytes, 'big.xlsx');
    const out = await readAll(src, (await xlsxImporter.sniff(src)).options);
    expect(out.batches.map((b) => b.rows.length)).toEqual([BATCH_ROWS, 5]);
    expect(out.batches[1]?.rows[4]).toEqual({ srcLoc: BATCH_ROWS + 6, fields: [BATCH_ROWS + 4] });
  });

  it('stops with CANCELLED when the signal is aborted', async () => {
    const src = fixtureSource('xlsx_numbers_as_text.xlsx');
    const sniff = await xlsxImporter.sniff(src);
    const controller = new AbortController();
    controller.abort();
    const e = await rejection(readAll(src, sniff.options, controller.signal));
    expect(e.code).toBe('CANCELLED');
  });

  it('refuses options of another format or with impossible rows and columns', async () => {
    const src = fixtureSource('xlsx_numbers_as_text.xlsx');
    const csv = { format: 'csv', csv: {} } as unknown as FormatOptions;
    expect((await rejection(readAll(src, csv))).code).toBe('INVALID_INPUT');
    const bad: FormatOptions = {
      format: 'xlsx',
      xlsx: {
        sheet: 'IDs',
        tableIndex: 0,
        headerRowStart: 2,
        headerRowEnd: 1,
        dataStartRow: 3,
        firstCol: 0,
        lastCol: 2,
      },
    };
    expect((await rejection(readAll(src, bad))).code).toBe('INVALID_INPUT');
    const missing: FormatOptions = {
      format: 'xlsx',
      xlsx: {
        sheet: 'Nope',
        tableIndex: 0,
        headerRowStart: 0,
        headerRowEnd: 0,
        dataStartRow: 1,
        firstCol: 0,
        lastCol: 2,
      },
    };
    expect((await rejection(readAll(src, missing))).code).toBe('NOT_FOUND');
  });

  it('honours a header chosen by the user, including a units row', async () => {
    const src = fixtureSource('xlsx_merged_two_row_header_units.xlsx');
    const options: FormatOptions = {
      format: 'xlsx',
      xlsx: {
        sheet: 'Well tests',
        tableIndex: 0,
        headerRowStart: 2,
        headerRowEnd: 3,
        dataStartRow: 5,
        firstCol: 2,
        lastCol: 3,
      },
    };
    const out = await readAll(src, options);
    expect(out.batches.flatMap((b) => b.rows).map((r) => r.fields)).toEqual([
      [2475, 2301.25],
      [2602, 2444],
      [1990, 1850.5],
      [2050.75, 1902],
    ]);
    expect(out.notes[0]?.detail).toMatchObject({ columns: ['Max [psi]', 'Min [psi]'] });
  });
});
