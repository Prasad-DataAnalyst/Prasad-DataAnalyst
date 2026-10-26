import { describe, expect, it } from 'vitest';
import { EngineError, type RawField } from '@tw/model';
import { writeZip } from '@tw/io';
import { utf8 } from '@tw/model';
import { fixtureBytes, fixtureExpectation, fixtureSource, handWorkbook, oneSheet } from './__fixtures__';
import {
  cellToSerial,
  isDateFormat,
  openWorkbook,
  serialToCell,
  xlsxImporter,
  type XlsxCell,
  type XlsxSheet,
} from './index';
import { parseCellRef } from './refs';

function cellAt(sheet: XlsxSheet, ref: string): XlsxCell | undefined {
  const at = parseCellRef(ref);
  if (at === null) throw new Error(`bad ref ${ref}`);
  return sheet.rows.find((row) => row.r === at.r)?.cells.find((cell) => cell.c === at.c);
}

function valueAt(sheet: XlsxSheet, ref: string): RawField | undefined {
  return cellAt(sheet, ref)?.v;
}

function engineError(fn: () => unknown): EngineError {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineError) return e;
    throw e;
  }
  throw new Error('expected an EngineError');
}

describe('xlsx_hidden_sheets_formulas.xlsx', () => {
  const expected = fixtureExpectation<{
    sheets: { name: string; state: string }[];
    defaultSheet: string;
    cachedValues: Record<string, RawField>;
  }>('xlsx_hidden_sheets_formulas.xlsx');
  const book = openWorkbook(fixtureBytes('xlsx_hidden_sheets_formulas.xlsx'));

  it('lists every sheet with its state', () => {
    expect(book.sheets).toEqual(expected.sheets);
    expect(book.date1904).toBe(false);
  });

  it('defaults to the first visible sheet, the only visible one that holds a table', async () => {
    const sniff = await xlsxImporter.sniff(fixtureSource('xlsx_hidden_sheets_formulas.xlsx'));
    expect(sniff.options).toMatchObject({ format: 'xlsx', xlsx: { sheet: expected.defaultSheet, tableIndex: 0 } });
    expect(sniff.detections['sheet']).toMatchObject({
      value: expected.defaultSheet,
      confidence: 'high',
      method: 'only-visible-sheet-with-table',
    });
    expect(sniff.detections['sheet']?.evidence).toContain('"Calc notes" (hidden)');
    expect(sniff.sheets?.map((s) => [s.name, s.state])).toEqual(expected.sheets.map((s) => [s.name, s.state]));
  });

  it('gives formula cells their cached values and the #DIV/0! cell as an error', () => {
    const sheet = book.readSheet('Production');
    for (const [ref, value] of Object.entries(expected.cachedValues)) {
      expect(cellAt(sheet, ref), ref).toMatchObject({ v: value, formula: true });
    }
    expect(cellAt(sheet, 'E4')).toMatchObject({ t: 'e', v: { error: '#DIV/0!' } });
    expect(cellAt(sheet, 'F2')?.t).toBe('str');
    expect(cellAt(sheet, 'B2')).toMatchObject({ v: 100, formula: false, t: 'n' });
    expect(valueAt(book.readSheet('Summary'), 'B1')).toBe(230);
  });

  it('refuses a sheet name the workbook does not have', () => {
    const e = engineError(() => book.readSheet('Missing'));
    expect(e.code).toBe('NOT_FOUND');
    expect(e.fix).toContain('"Production"');
  });
});

describe('xlsx_date1904.xlsx', () => {
  const expected = fixtureExpectation<{ sheet: string; cells: Record<string, RawField> }>('xlsx_date1904.xlsx');
  const book = openWorkbook(fixtureBytes('xlsx_date1904.xlsx'));

  it('reads the 1904 date system and converts its serials', () => {
    expect(book.date1904).toBe(true);
    const sheet = book.readSheet(expected.sheet);
    expect(valueAt(sheet, 'A2')).toEqual({ date: '2026-01-31' });
    for (const [ref, value] of Object.entries(expected.cells)) expect(valueAt(sheet, ref), ref).toEqual(value);
    expect(cellAt(sheet, 'A2')).toMatchObject({ isDate: true, t: 'n' });
  });
});

describe('xlsx_text_and_serial_dates.xlsx', () => {
  const expected = fixtureExpectation<{ sheet: string; cells: Record<string, RawField> }>(
    'xlsx_text_and_serial_dates.xlsx',
  );
  const sheet = openWorkbook(fixtureBytes('xlsx_text_and_serial_dates.xlsx')).readSheet('Daily');

  it('turns date-formatted serials into DateCell and DateTimeCell, and leaves text dates as text', () => {
    for (const [ref, value] of Object.entries(expected.cells)) expect(valueAt(sheet, ref), ref).toEqual(value);
    expect(cellAt(sheet, 'A2')).toMatchObject({ isDate: true, numFmt: 'dd/mm/yyyy' });
    expect(cellAt(sheet, 'B2')).toMatchObject({ t: 's', isDate: false });
    expect(cellAt(sheet, 'C2')).toMatchObject({ v: 101.5, isDate: false, numFmt: null });
  });
});

describe('xlsx_numbers_as_text.xlsx', () => {
  const expected = fixtureExpectation<{ textCells: Record<string, string>; numberCells: Record<string, number> }>(
    'xlsx_numbers_as_text.xlsx',
  );
  const sheet = openWorkbook(fixtureBytes('xlsx_numbers_as_text.xlsx')).readSheet('IDs');

  it("keeps numeric text in t='s' cells as strings", () => {
    for (const [ref, text] of Object.entries(expected.textCells)) {
      expect(cellAt(sheet, ref), ref).toMatchObject({ t: 's', v: text });
    }
    for (const [ref, n] of Object.entries(expected.numberCells))
      expect(cellAt(sheet, ref), ref).toMatchObject({ t: 'n', v: n });
  });
});

describe('serialToCell and cellToSerial', () => {
  it('handles the 1900 leap-year bug around serial 60', () => {
    expect(serialToCell(1, false)).toEqual({ date: '1900-01-01' });
    expect(serialToCell(59, false)).toEqual({ date: '1900-02-28' });
    expect(serialToCell(60, false)).toEqual({ date: '1900-02-28' });
    expect(serialToCell(61, false)).toEqual({ date: '1900-03-01' });
    expect(serialToCell(0, false)).toEqual({ date: '1899-12-31' });
  });

  it('gives a datetime at 12:00:00.000Z for serial 45000.5', () => {
    expect(serialToCell(45000, false)).toEqual({ date: '2023-03-15' });
    expect(serialToCell(45000.5, false)).toEqual({ datetime: '2023-03-15T12:00:00.000Z' });
  });

  it('rounds times to the millisecond, carrying into the next day', () => {
    expect(serialToCell(45000 + 0.2708333333, false)).toEqual({ datetime: '2023-03-15T06:30:00.000Z' });
    expect(serialToCell(45000.9999999999, false)).toEqual({ datetime: '2023-03-16T00:00:00.000Z' });
  });

  it('counts the 1904 system from 1904-01-01', () => {
    expect(serialToCell(0, true)).toEqual({ date: '1904-01-01' });
    expect(serialToCell(44591, true)).toEqual({ date: '2026-01-31' });
  });

  it('refuses serials outside 1900..9999', () => {
    expect(engineError(() => serialToCell(-1, false)).code).toBe('INVALID_INPUT');
    expect(engineError(() => serialToCell(2958466, false)).code).toBe('INVALID_INPUT');
    expect(engineError(() => serialToCell(Number.NaN, false)).code).toBe('INVALID_INPUT');
    expect(serialToCell(2958465, false)).toEqual({ date: '9999-12-31' });
  });

  it('inverts serialToCell from 1899-12-31 on, including the leap-year gap', () => {
    for (const date of ['1899-12-31', '1900-01-01', '1900-02-28', '1900-03-01', '2026-01-31', '9999-12-31']) {
      expect(serialToCell(cellToSerial({ date }), false)).toEqual({ date });
    }
    expect(cellToSerial({ date: '1900-03-01' })).toBe(61);
    expect(cellToSerial({ datetime: '2023-03-15T12:00:00.000Z' })).toBe(45000.5);
    const instant = { datetime: '2026-01-31T23:59:59.999Z' };
    expect(serialToCell(cellToSerial(instant), false)).toEqual(instant);
  });

  it('refuses dates Excel cannot store and values that are not dates', () => {
    const e = engineError(() => cellToSerial({ date: '1899-12-30' }));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.fix).toContain('CSV');
    expect(engineError(() => cellToSerial({ date: '2026-02-30' })).code).toBe('INVALID_INPUT');
  });
});

describe('isDateFormat', () => {
  it.each([
    [14, null, true],
    [22, null, true],
    [46, null, true],
    [0, null, false],
    [2, '0.00', false],
    [164, 'yyyy-mm-dd', true],
    [164, 'yyyy\\-mm\\-dd\\ hh:mm', true],
    [164, 'mmm-yy', true],
    [164, 'h:mm AM/PM', true],
    [164, '[h]:mm:ss', true],
    [164, 'General', false],
    [164, '"Day "0', false],
    [164, '[Red]0.00;[Blue]-0.00', false],
    [164, '#,##0 \\m', false],
    [164, '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', false],
    [164, '0.00E+00', false],
    [164, '[$-409]d-mmm-yyyy', true],
  ])('id %i, code %s gives %s', (id, code, expected) => {
    expect(isDateFormat(id, code)).toBe(expected);
  });
});

describe('cell types written by hand', () => {
  const styles =
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="hh:mm"/></numFmts>' +
    '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="14"/></cellXfs>';

  it('reads inline, shared rich-text, boolean, error and ISO date cells', () => {
    const bytes = oneSheet(
      '<sheetData><row r="1">' +
        '<c r="A1" t="inlineStr"><is><r><t>Rich </t></r><r><rPr><b/></rPr><t>inline</t></r><rPh><t>x</t></rPh></is></c>' +
        '<c r="B1" t="s"><v>0</v></c>' +
        '<c r="C1" t="b"><v>0</v></c>' +
        '<c r="D1" t="e"><v>#N/A</v></c>' +
        '<c r="E1" t="d"><v>2026-01-31T00:00:00</v></c>' +
        '<c r="F1" t="d" s="1"><v>2026-01-31T00:00:00</v></c>' +
        '<c r="G1" t="d"><v>2026-01-31T10:15:00.250+02:00</v></c>' +
        '<c r="H1" t="d"><v>not a date</v></c>' +
        '</row></sheetData>',
      {
        sharedStrings: '<si><r><t>Shared </t></r><r><t>rich</t></r><rPh sb="0" eb="1"><t>phonetic</t></rPh></si>',
        styles,
      },
    );
    const sheet = openWorkbook(bytes).readSheet('Sheet1');
    expect(sheet.rows[0]?.cells.map((c) => [c.t, c.v, c.isDate])).toEqual([
      ['inlineStr', 'Rich inline', false],
      ['s', 'Shared rich', false],
      ['b', false, false],
      ['e', { error: '#N/A' }, false],
      ['d', { datetime: '2026-01-31T00:00:00.000Z' }, true],
      ['d', { date: '2026-01-31' }, true],
      ['d', { datetime: '2026-01-31T08:15:00.250Z' }, true],
      ['d', 'not a date', false],
    ]);
  });

  it('uses the style to tell dates, times and plain numbers apart', () => {
    const bytes = oneSheet(
      '<sheetData><row r="1"><c r="A1" s="1"><v>46053</v></c><c r="B1" s="2"><v>0.5</v></c>' +
        '<c r="C1" s="3"><v>46053.25</v></c><c r="D1"><v>46053</v></c><c r="E1" s="1"><v>-5</v></c>' +
        '<c r="F1" s="9"><v>7</v></c></row></sheetData>',
      { styles },
    );
    const cells = openWorkbook(bytes).readSheet('Sheet1').rows[0]?.cells ?? [];
    expect(cells.map((c) => [c.v, c.numFmt, c.isDate])).toEqual([
      [{ date: '2026-01-31' }, 'yyyy-mm-dd', true],
      [{ datetime: '1899-12-31T12:00:00.000Z' }, 'hh:mm', true],
      [{ datetime: '2026-01-31T06:00:00.000Z' }, 'mm-dd-yy', true],
      [46053, null, false],
      [-5, 'yyyy-mm-dd', false],
      [7, null, false],
    ]);
  });

  it('decodes _xHHHH_ escapes and keeps white space', () => {
    const bytes = oneSheet(
      '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">  a_x000D__x000A_b _x005F_x0041_ </t></is></c>' +
        '<c r="B1" t="str"><v>tab_x0009_here</v></c></row></sheetData>',
    );
    const cells = openWorkbook(bytes).readSheet('Sheet1').rows[0]?.cells ?? [];
    expect(cells.map((c) => c.v)).toEqual(['  a\r\nb _x0041_ ', 'tab\there']);
  });

  it('keeps formulas without a cached value as null and skips empty styled cells', () => {
    const bytes = oneSheet(
      '<sheetData><row r="1"><c r="A1" s="1"/><c r="B1"><f>1+1</f></c><c r="C1" t="str"><f>A1</f><v></v></c>' +
        '<c r="D1" t="e"/></row></sheetData>',
    );
    const cells = openWorkbook(bytes).readSheet('Sheet1').rows[0]?.cells ?? [];
    expect(cells.map((c) => [c.c, c.v, c.formula])).toEqual([
      [1, null, true],
      [2, '', true],
    ]);
  });

  it('places cells without references and puts rows written out of order back in order', () => {
    const bytes = oneSheet(
      '<sheetData><row r="3"><c><v>3</v></c><c><v>4</v></c></row>' +
        '<row r="1"><c r="B1"><v>1</v></c><c><v>2</v></c></row><row><c r="A4"><v>5</v></c></row></sheetData>',
    );
    const sheet = openWorkbook(bytes).readSheet('Sheet1');
    expect(sheet.rows.map((row) => [row.r, row.cells.map((c) => [c.c, c.v])])).toEqual([
      [
        0,
        [
          [1, 1],
          [2, 2],
        ],
      ],
      [
        2,
        [
          [0, 3],
          [1, 4],
        ],
      ],
      [3, [[0, 5]]],
    ]);
    expect(sheet.dimension).toBe('A1:C4');
  });

  it('reads merges, the frozen pane and the autofilter, ignoring those of custom views', () => {
    const bytes = oneSheet(
      '<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" state="frozen"/></sheetView>' +
        '<sheetView workbookViewId="1"><pane ySplit="9" state="frozen"/></sheetView></sheetViews>' +
        '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' +
        '<autoFilter ref="A2:C9"/><customSheetViews><customSheetView guid="{0}"><autoFilter ref="A1:Z99"/>' +
        '</customSheetView></customSheetViews><mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="C3"/></mergeCells>',
    );
    const sheet = openWorkbook(bytes).readSheet('Sheet1');
    expect(sheet.frozen).toEqual({ r: 2, c: 1 });
    expect(sheet.autoFilter).toEqual({ s: { r: 1, c: 0 }, e: { r: 8, c: 2 } });
    expect(sheet.merges).toEqual([{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }]);
  });

  it('ignores a split pane that is not frozen', () => {
    const bytes = oneSheet(
      '<sheetViews><sheetView workbookViewId="0"><pane xSplit="2000" ySplit="1500" state="split"/></sheetView></sheetViews>' +
        '<sheetData/>',
    );
    const sheet = openWorkbook(bytes).readSheet('Sheet1');
    expect(sheet.frozen).toBeNull();
    expect(sheet.rows).toEqual([]);
    expect(sheet.dimension).toBe('A1');
  });

  it('reads parts whose elements carry a namespace prefix', () => {
    const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const bytes = oneSheet(
      `<x:worksheet xmlns:x="${main}"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>pref</x:t></x:is></x:c>` +
        '<x:c r="B1"><x:v>2.5</x:v></x:c></x:row></x:sheetData></x:worksheet>',
    );
    expect(
      openWorkbook(bytes)
        .readSheet('Sheet1')
        .rows[0]?.cells.map((c) => c.v),
    ).toEqual(['pref', 2.5]);
  });

  it('keeps number text that is not a plain decimal as text', () => {
    const bytes = oneSheet(
      '<sheetData><row r="1"><c r="A1"><v>0x1F</v></c><c r="B1"><v> 1.5E3 </v></c></row></sheetData>',
    );
    expect(
      openWorkbook(bytes)
        .readSheet('Sheet1')
        .rows[0]?.cells.map((c) => c.v),
    ).toEqual(['0x1F', 1500]);
  });
});

describe('sheets and packages written by hand', () => {
  it('lists veryHidden sheets and gives chart sheets no cells', () => {
    const bytes = handWorkbook({
      sheets: [
        { name: 'Secret', state: 'veryHidden', xml: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' },
        { name: 'Chart', chart: true, xml: '' },
        { name: 'Data', xml: '<sheetData/>' },
      ],
      date1904: true,
    });
    const book = openWorkbook(bytes);
    expect(book.sheets).toEqual([
      { name: 'Secret', state: 'veryHidden' },
      { name: 'Chart', state: 'visible' },
      { name: 'Data', state: 'visible' },
    ]);
    expect(book.date1904).toBe(true);
    expect(book.readSheet('Chart').rows).toEqual([]);
    expect(book.readSheet('Secret').rows).toHaveLength(1);
  });

  it('refuses a document type declaration and undeclared entities', () => {
    const doctype = oneSheet(
      '<?xml version="1.0"?><!DOCTYPE worksheet [<!ENTITY x SYSTEM "file:///etc/passwd">]>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
    );
    expect(engineError(() => openWorkbook(doctype).readSheet('Sheet1')).code).toBe('PARSE_FAILED');
    const entity = oneSheet('<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&x;</t></is></c></row></sheetData>');
    expect(engineError(() => openWorkbook(entity).readSheet('Sheet1')).code).toBe('PARSE_FAILED');
  });

  it('reports XML that is not well-formed, naming the part', () => {
    const e = engineError(() => openWorkbook(oneSheet('<sheetData><row r="1"></sheetData>')).readSheet('Sheet1'));
    expect(e.code).toBe('PARSE_FAILED');
    expect(e.message).toContain('xl/worksheets/sheet1.xml');
  });

  it('reports a shared string index the table does not have', () => {
    const bytes = oneSheet('<sheetData><row r="1"><c r="A1" t="s"><v>5</v></c></row></sheetData>', {
      sharedStrings: ['only'],
    });
    const e = engineError(() => openWorkbook(bytes).readSheet('Sheet1'));
    expect(e.code).toBe('PARSE_FAILED');
    expect(e.message).toContain('A1');
  });

  it('refuses files that are not XLSX workbooks', () => {
    expect(engineError(() => openWorkbook(utf8('a,b\n1,2\n'))).code).toBe('FORMAT_UNSUPPORTED');
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(engineError(() => openWorkbook(ole)).message).toContain('.xls');
    const docx = writeZip([{ path: 'word/document.xml', data: utf8('<document/>') }]);
    const e = engineError(() => openWorkbook(docx));
    expect(e.code).toBe('FORMAT_UNSUPPORTED');
    expect(e.message).toContain('no workbook part');
  });

  it('enforces the decompressed-size guard', () => {
    const bytes = fixtureBytes('xlsx_numbers_as_text.xlsx');
    expect(() => openWorkbook(bytes, { maxInflatedBytes: 1024 })).toThrow(/limit/);
    expect(openWorkbook(bytes).sheets).toHaveLength(1);
  });

  it('finds parts whatever the case of their names and resolves relative targets', () => {
    const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const bytes = writeZip([
      {
        path: '_rels/.rels',
        data: utf8(
          `<Relationships xmlns="x"><Relationship Id="r" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        ),
      },
      {
        path: 'xl/workbook.xml',
        data: utf8(
          `<workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="S" sheetId="1" r:id="a"/></sheets></workbook>`,
        ),
      },
      {
        path: 'xl/_rels/workbook.xml.rels',
        data: utf8(
          `<Relationships xmlns="x"><Relationship Id="a" Type="${rel}/worksheet" Target="./sheets/../Worksheets/My%20Sheet.xml"/></Relationships>`,
        ),
      },
      {
        path: 'xl/worksheets/my sheet.xml',
        data: utf8(
          `<worksheet xmlns="${main}"><sheetData><row r="1"><c r="A1"><v>9</v></c></row></sheetData></worksheet>`,
        ),
      },
    ]);
    expect(openWorkbook(bytes).readSheet('S').rows[0]?.cells[0]?.v).toBe(9);
  });
});
