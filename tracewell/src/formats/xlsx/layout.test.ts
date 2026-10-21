import { describe, expect, it } from 'vitest';
import { fixtureBytes, fixtureExpectation, sheetOf } from './__fixtures__';
import { detectTables, openWorkbook, type TableBlock } from './index';
import { formatRange } from './refs';

function ranges(blocks: TableBlock[]): string[] {
  return blocks.map((b) => formatRange(b.range));
}

describe('xlsx_merged_two_row_header_units.xlsx', () => {
  const expected = fixtureExpectation<{
    sheet: string;
    range: string;
    headerRows: [number, number];
    dataStartRow: number;
    flattenedHeader: string[];
  }>('xlsx_merged_two_row_header_units.xlsx');
  const sheet = openWorkbook(fixtureBytes('xlsx_merged_two_row_header_units.xlsx')).readSheet(expected.sheet);
  const blocks = detectTables(sheet);

  it('flattens the merged two-row header and the units row into the expected names', () => {
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.flattenedHeader).toEqual(expected.flattenedHeader);
    expect(blocks[0]?.headerRows).toEqual(expected.headerRows);
    expect(blocks[0]?.dataStartRow).toBe(expected.dataStartRow);
  });

  it('skips the title row above the header', () => {
    expect(formatRange((blocks[0] as TableBlock).range)).toBe(expected.range);
    expect(blocks[0]?.headerCells[0]).toEqual(['Well', 'Test date', 'Pressure', 'Pressure', 'Temperature', 'Temperature']);
    expect(blocks[0]?.headerCells.flat()).not.toContain('Well test summary - Field Alpha');
  });

  it('notes the multi-row header with TW-IMP-003', () => {
    const notes = blocks[0]?.notes ?? [];
    expect(notes.map((n) => n.code)).toEqual(['TW-IMP-003']);
    expect(notes[0]?.srcLoc).toBe(2);
    expect(notes[0]?.message).toContain('Pressure / Max [psi]');
  });
});

describe('xlsx_two_tables_one_sheet.xlsx', () => {
  const expected = fixtureExpectation<{ sheet: string; tables: { range: string; flattenedHeader: string[] }[] }>(
    'xlsx_two_tables_one_sheet.xlsx',
  );
  const blocks = detectTables(openWorkbook(fixtureBytes('xlsx_two_tables_one_sheet.xlsx')).readSheet(expected.sheet));

  it('finds two blocks, top-left first, with their titles left out', () => {
    expect(ranges(blocks)).toEqual(expected.tables.map((t) => t.range));
    expect(blocks.map((b) => b.flattenedHeader)).toEqual(expected.tables.map((t) => t.flattenedHeader));
  });

  it('names the second range in a TW-IMP-002 note', () => {
    expect(blocks[0]?.notes).toEqual([]);
    const note = blocks[1]?.notes.find((n) => n.code === 'TW-IMP-002');
    expect(note?.message).toContain('A12:C15');
    expect(note?.detail).toEqual({ sheet: 'Report', range: 'A12:C15' });
    expect(note?.srcLoc).toBe(12);
  });
});

describe('detectTables on in-memory sheets', () => {
  it('splits tables side by side at a blank column', () => {
    const sheet = sheetOf([
      ['Well', 'Oil', undefined, 'Tank', 'Level'],
      ['A', 1, undefined, 'T1', 3.5],
      ['B', 2, undefined, 'T2', 4.5],
    ]);
    const blocks = detectTables(sheet);
    expect(ranges(blocks)).toEqual(['A1:B3', 'D1:E3']);
    expect(blocks[1]?.flattenedHeader).toEqual(['Tank', 'Level']);
  });

  it('joins a units row without merges, ignoring placeholders and format hints', () => {
    const blocks = detectTables(
      sheetOf([
        ['Well', 'Date', 'Oil rate', 'Pressure', 'Temp'],
        ['-', 'yyyy-mm-dd', 'bbl/d', '(psia)', '[degC]'],
        ['A', 'x', 1200, 2500, 80],
      ]),
    );
    expect(blocks[0]?.flattenedHeader).toEqual(['Well', 'Date', 'Oil rate [bbl/d]', 'Pressure [psia]', 'Temp [degC]']);
    expect(blocks[0]?.headerRows).toEqual([0, 1]);
    expect(blocks[0]?.notes.map((n) => n.code)).toEqual(['TW-IMP-003']);
  });

  it('does not read a row of sub-headers or of data text as units', () => {
    const maxMin = detectTables(
      sheetOf([
        ['Pressure', 'Pressure'],
        ['Max', 'Min'],
        [10, 5],
      ]),
    );
    expect(maxMin[0]?.headerRows).toEqual([0, 0]);
    expect(maxMin[0]?.flattenedHeader).toEqual(['Pressure', 'Pressure']);
    const unitsWithoutNumbers = detectTables(
      sheetOf([
        ['Well', 'Zone'],
        ['m', 'ft'],
        ['A', 'B'],
      ]),
    );
    expect(unitsWithoutNumbers[0]?.headerRows).toEqual([0, 0]);
  });

  it('keeps a group header that has sub-headers under it, without vertical merges', () => {
    const blocks = detectTables(
      sheetOf(
        [
          [undefined, 'Pressure', undefined],
          ['Well', 'Max', 'Min'],
          ['A', 10, 5],
        ],
        ['B1:C1'],
      ),
    );
    expect(blocks[0]?.flattenedHeader).toEqual(['Well', 'Pressure / Max', 'Pressure / Min']);
    expect(formatRange((blocks[0] as TableBlock).range)).toBe('A1:C3');
  });

  it('continues a table across a blank row inside its data', () => {
    const blocks = detectTables(
      sheetOf([
        ['Well', 'Oil'],
        ['A', 1],
        [],
        ['B', 2],
        ['C', 3],
      ]),
    );
    expect(ranges(blocks)).toEqual(['A1:B5']);
  });

  it('starts a new table after a long gap even when it begins with numbers', () => {
    const blocks = detectTables(sheetOf([['Well', 'Oil'], ['A', 1], [], [], [], ['B', 2], ['C', 3]]));
    expect(ranges(blocks)).toEqual(['A1:B2', 'A6:B7']);
  });

  it('treats lone cells and single rows as notes, not tables', () => {
    expect(detectTables(sheetOf([['Prepared by: ops'], [], ['Total', 230]]))).toEqual([]);
    expect(detectTables(sheetOf([]))).toEqual([]);
  });

  it('skips a title merged across the full width even when it does not start at the left edge', () => {
    const blocks = detectTables(
      sheetOf(
        [
          [undefined, 'Monthly report', undefined],
          ['Well', 'Oil', 'Gas'],
          ['A', 1, 2],
        ],
        ['A1:C1'],
      ),
    );
    expect(formatRange((blocks[0] as TableBlock).range)).toBe('A2:C3');
  });

  it('keeps a single-column table with its header', () => {
    const blocks = detectTables(sheetOf([['Pressure'], [1], [2]]));
    expect(blocks[0]).toMatchObject({ headerRows: [0, 0], dataStartRow: 1, flattenedHeader: ['Pressure'] });
  });

  it('writes non-text header cells as text and joins line breaks with spaces', () => {
    const blocks = detectTables(sheetOf([['Oil\nrate', 2025, true], [1, 2, 3]]));
    expect(blocks[0]?.flattenedHeader).toEqual(['Oil rate', '2025', 'true']);
    expect(blocks[0]?.headerCells).toEqual([['Oil\nrate', '2025', 'true']]);
  });

  it('extends a header over a vertical merge into the next row', () => {
    const blocks = detectTables(
      sheetOf(
        [
          ['Well', 'Rates', undefined],
          [undefined, 'Oil', 'Gas'],
          ['bbl', undefined, undefined],
          ['A', 1, 2],
        ],
        ['A1:A2', 'B1:C1'],
      ),
    );
    expect(blocks[0]?.headerRows).toEqual([0, 1]);
    expect(blocks[0]?.flattenedHeader).toEqual(['Well', 'Rates / Oil', 'Rates / Gas']);
  });
});
