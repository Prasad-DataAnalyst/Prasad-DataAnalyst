import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readZip, sha256Hex } from '@tw/io';
import { canonicalCell, EngineError, type CellValue, type RawField } from '@tw/model';
import {
  openWorkbook,
  writeXlsx,
  type XlsxColumnKind,
  type XlsxSheet,
  type XlsxWriteBook,
  type XlsxWriteSheet,
  type XlsxWriteValue,
} from './index';

const CREATED = '2026-10-21T09:15:30.250Z';
const CREATOR = 'Prasad (Prasad-DataAnalyst)';

function book(sheets: XlsxWriteSheet[], extra: Partial<XlsxWriteBook> = {}): XlsxWriteBook {
  return { sheets, created: CREATED, creator: CREATOR, ...extra };
}

function sheet(
  columns: { header: string; kind: XlsxColumnKind; width?: number }[],
  rows: XlsxWriteValue[][],
  extra: Partial<XlsxWriteSheet> = {},
): XlsxWriteSheet {
  return { name: 'Data', columns, rows, freezeHeader: true, autoFilter: true, ...extra };
}

/** Values of the data rows (row 2 on), one array per row, with empty cells as null. */
function dataValues(read: XlsxSheet, width: number): RawField[][] {
  const last = read.rows[read.rows.length - 1]?.r ?? 0;
  const out: RawField[][] = [];
  for (let r = 1; r <= last; r++) {
    const row = read.rows.find((x) => x.r === r);
    const values: RawField[] = new Array<RawField>(width).fill(null);
    for (const cell of row?.cells ?? []) values[cell.c] = cell.v;
    out.push(values);
  }
  return out;
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

function partText(bytes: Uint8Array, path: string): string {
  return readZip(bytes).readText(path);
}

const SAMPLE = sheet(
  [
    { header: 'Well', kind: 'string' },
    { header: 'Pressure [kPa]', kind: 'number' },
    { header: 'Count', kind: 'integer' },
    { header: 'Active', kind: 'boolean' },
    { header: 'Date', kind: 'date' },
    { header: 'Measured at', kind: 'datetime', width: 24 },
  ],
  [
    ['A-01', 2510.5, 3, true, { date: '2026-01-31' }, { datetime: '2026-01-31T06:30:00.125Z' }],
    ['A-02', -0.000123, 9007199254740991, false, { date: '1900-03-01' }, { datetime: '9999-12-31T23:59:59.999Z' }],
    [null, null, null, null, null, null],
    ['<&> "quoted" \'single\'', 1e21, -4, true, { date: '9999-12-31' }, { datetime: '1900-01-01T00:00:00.000Z' }],
  ],
);

describe('writeXlsx then openWorkbook', () => {
  const bytes = writeXlsx(
    book([
      SAMPLE,
      sheet([{ header: 'Note', kind: 'string' }], [['x']], { name: 'Log', freezeHeader: false, autoFilter: false }),
    ]),
  );
  const workbook = openWorkbook(bytes);
  const data = workbook.readSheet('Data');

  it('round-trips the values', () => {
    expect(workbook.sheets).toEqual([
      { name: 'Data', state: 'visible' },
      { name: 'Log', state: 'visible' },
    ]);
    expect(data.rows[0]?.cells.map((c) => c.v)).toEqual(SAMPLE.columns.map((c) => c.header));
    expect(dataValues(data, 6)).toEqual(SAMPLE.rows);
  });

  it('types the cells by column kind', () => {
    const cells = data.rows[1]?.cells ?? [];
    expect(cells.map((c) => [c.t, c.numFmt, c.isDate, c.formula])).toEqual([
      ['inlineStr', null, false, false],
      ['n', null, false, false],
      ['n', '0', false, false],
      ['b', null, false, false],
      ['n', 'yyyy-mm-dd', true, false],
      ['n', 'yyyy-mm-dd hh:mm:ss.000', true, false],
    ]);
  });

  it('freezes the header at A2, filters the data range and writes no merges', () => {
    expect(data.frozen).toEqual({ r: 1, c: 0 });
    expect(data.autoFilter).toEqual({ s: { r: 0, c: 0 }, e: { r: 4, c: 5 } });
    expect(data.merges).toEqual([]);
    expect(data.dimension).toBe('A1:F5');
    const log = workbook.readSheet('Log');
    expect(log.frozen).toBeNull();
    expect(log.autoFilter).toBeNull();
  });

  it('writes no formulas, a hidden filter name and fixed document properties', () => {
    const xml = partText(bytes, 'xl/worksheets/sheet1.xml');
    expect(xml).not.toContain('<f>');
    expect(xml).not.toContain('mergeCell');
    expect(partText(bytes, 'xl/workbook.xml')).toContain(
      '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'Data\'!$A$1:$F$5</definedName>',
    );
    const core = partText(bytes, 'docProps/core.xml');
    expect(core).toContain('<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-21T09:15:30Z</dcterms:created>');
    expect(core).toContain('<dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-21T09:15:30Z</dcterms:modified>');
    expect(core).toContain(`<dc:creator>${CREATOR}</dc:creator>`);
    expect(core).not.toContain('dc:title');
    expect(partText(bytes, 'docProps/app.xml')).toContain('<Application>Tracewell</Application>');
  });

  it('sizes columns from their text, honours given widths and caps long text', () => {
    const xml = partText(bytes, 'xl/worksheets/sheet1.xml');
    const widths = [...xml.matchAll(/<col min="(\d+)" max="\d+" width="([\d.]+)"/g)].map((m) => Number(m[2]));
    expect(widths).toHaveLength(6);
    expect(widths[0]).toBe(23);
    expect(widths[5]).toBe(24);
    const long = writeXlsx(book([sheet([{ header: 'Text', kind: 'string' }], [['x'.repeat(500)]])]));
    expect(partText(long, 'xl/worksheets/sheet1.xml')).toContain('width="60"');
  });
});

describe('determinism', () => {
  it('gives byte-identical output for the same input', () => {
    const a = writeXlsx(book([SAMPLE], { title: 'Well tests' }));
    const b = writeXlsx(book([SAMPLE], { title: 'Well tests' }));
    expect(sha256Hex(a)).toBe(sha256Hex(b));
    expect(a).toEqual(b);
  });

  it('changes only with the input, such as the creation time', () => {
    const a = writeXlsx(book([SAMPLE]));
    const b = writeXlsx(book([SAMPLE], { created: '2026-10-22T09:15:30.250Z' }));
    expect(sha256Hex(a)).not.toBe(sha256Hex(b));
  });

  it('accepts rows from a generator, read only once', () => {
    function* rows(): Generator<XlsxWriteValue[]> {
      yield ['a', 1];
      yield ['b', 2];
    }
    const columns: XlsxWriteSheet['columns'] = [
      { header: 'k', kind: 'string' },
      { header: 'v', kind: 'number' },
    ];
    const fromGenerator = writeXlsx(book([sheet(columns, [], { rows: rows() })]));
    const fromArray = writeXlsx(
      book([
        sheet(columns, [
          ['a', 1],
          ['b', 2],
        ]),
      ]),
    );
    expect(fromGenerator).toEqual(fromArray);
  });
});

describe('text that XML cannot carry as is', () => {
  it('round-trips control characters, carriage returns, lone surrogates and literal escapes', () => {
    const texts = [
      'line1\r\nline2\rline3\n',
      '\u0000\u0001\u001f\u000b\u000c',
      '\ud800 lone \udc00 high/low',
      'pair 😀 kept',
      '_x0041_ and _x005F_ stay literal',
      '  leading and trailing  ',
      '\ttab',
      '￾￿',
      ']]> <![CDATA[ x ]]>',
      '',
    ];
    const bytes = writeXlsx(
      book([
        sheet(
          [{ header: 'Text', kind: 'string' }],
          texts.map((t) => [t]),
        ),
      ]),
    );
    expect(dataValues(openWorkbook(bytes).readSheet('Data'), 1).map((r) => r[0])).toEqual(texts);
  });

  it('keeps a header with markup and escapes the title', () => {
    const bytes = writeXlsx(
      book([sheet([{ header: 'Rate <m3/d> & "more"', kind: 'number' }], [[1]])], { title: 'T & <C>\u0001' }),
    );
    expect(openWorkbook(bytes).readSheet('Data').rows[0]?.cells[0]?.v).toBe('Rate <m3/d> & "more"');
    expect(partText(bytes, 'docProps/core.xml')).toContain('<dc:title>T &amp; &lt;C&gt;�</dc:title>');
  });

  it('writes text of exactly 32,767 characters and refuses longer text', () => {
    const max = 'é'.repeat(32_767);
    const bytes = writeXlsx(book([sheet([{ header: 'T', kind: 'string' }], [[max]])]));
    expect(dataValues(openWorkbook(bytes).readSheet('Data'), 1)[0]?.[0]).toBe(max);
    const e = engineError(() => writeXlsx(book([sheet([{ header: 'T', kind: 'string' }], [[`${max}x`]])])));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.message).toContain('32,767');
  });
});

describe('invalid input', () => {
  const columns: XlsxWriteSheet['columns'] = [{ header: 'n', kind: 'number' }];

  it.each([
    ['', 'empty'],
    ['a'.repeat(32), 'too long'],
    ['a/b', 'forbidden character'],
    ["'quoted'", 'apostrophes'],
    ['History', 'reserved'],
    ['tab\tname', 'control character'],
  ])('refuses the sheet name %j (%s)', (name) => {
    expect(engineError(() => writeXlsx(book([sheet(columns, [], { name })]))).code).toBe('INVALID_INPUT');
  });

  it('refuses duplicate sheet names regardless of case, and a book without sheets', () => {
    expect(
      engineError(() => writeXlsx(book([sheet(columns, []), sheet(columns, [], { name: 'DATA' })]))).message,
    ).toContain('twice');
    expect(engineError(() => writeXlsx(book([]))).code).toBe('INVALID_INPUT');
  });

  it('refuses a creation time that is not an IsoUtc instant', () => {
    for (const created of ['2026-10-21', '2026-10-21T09:15:30Z', '2026-02-30T00:00:00.000Z', 'soon']) {
      expect(engineError(() => writeXlsx(book([sheet(columns, [])], { created }))).code).toBe('INVALID_INPUT');
    }
  });

  it('refuses values that do not match their column kind', () => {
    const cases: [XlsxColumnKind, XlsxWriteValue][] = [
      ['number', '1'],
      ['integer', true],
      ['number', Number.POSITIVE_INFINITY],
      ['number', Number.NaN],
      ['string', 5],
      ['boolean', 1],
      ['date', { datetime: '2026-01-31T00:00:00.000Z' }],
      ['datetime', { date: '2026-01-31' }],
      ['date', '2026-01-31'],
    ];
    for (const [kind, value] of cases) {
      const e = engineError(() => writeXlsx(book([sheet([{ header: 'h', kind }], [[value]])])));
      expect(e.code, `${kind} ${String(value)}`).toBe('INVALID_INPUT');
      expect(e.detail).toMatchObject({ sheet: 'Data', row: 2, column: 'h' });
    }
  });

  it('refuses rows of the wrong length, dates before 1900 and impossible widths', () => {
    expect(engineError(() => writeXlsx(book([sheet(columns, [[1, 2]])]))).code).toBe('INVALID_INPUT');
    const early = engineError(() =>
      writeXlsx(book([sheet([{ header: 'd', kind: 'date' }], [[{ date: '1850-06-01' }]])])),
    );
    expect(early.message).toContain('1850-06-01');
    expect(engineError(() => writeXlsx(book([sheet([{ header: 'n', kind: 'number', width: 0 }], [])]))).code).toBe(
      'INVALID_INPUT',
    );
  });

  it('writes a sheet without columns or rows', () => {
    const bytes = writeXlsx(book([sheet([], [], { name: 'Empty' })]));
    const read = openWorkbook(bytes).readSheet('Empty');
    expect(read.rows).toEqual([]);
    expect(read.autoFilter).toBeNull();
    expect(read.frozen).toEqual({ r: 1, c: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// Property: random tables round-trip with equal canonical cells.

const MS_1900_03_01 = Date.parse('1900-03-01T00:00:00.000Z');
const MS_9999_12_31 = Date.parse('9999-12-31T23:59:59.999Z');
const DAY = 86_400_000;

// Long text reaches Excel's limit of 32,767 UTF-16 units: ASCII exactly, and any code points
// (at most two units each) nearly.
const longText = fc.oneof(
  fc.string({ unit: 'binary-ascii', minLength: 32_000, maxLength: 32_767 }),
  fc.string({ unit: 'binary', minLength: 16_000, maxLength: 16_383 }),
);

const text = fc.oneof(
  { weight: 8, arbitrary: fc.string({ unit: 'grapheme', maxLength: 40 }) },
  { weight: 2, arbitrary: fc.string({ unit: 'binary', maxLength: 40 }) },
  { weight: 1, arbitrary: longText },
);

const valueOf: Record<XlsxColumnKind, fc.Arbitrary<XlsxWriteValue>> = {
  string: text,
  number: fc.double({ noNaN: true, noDefaultInfinity: true }),
  integer: fc.maxSafeInteger(),
  boolean: fc.boolean(),
  date: fc
    .integer({ min: MS_1900_03_01 / DAY, max: Math.floor(MS_9999_12_31 / DAY) })
    .map((day) => ({ date: new Date(day * DAY).toISOString().slice(0, 10) })),
  datetime: fc
    .integer({ min: MS_1900_03_01, max: MS_9999_12_31 })
    .map((ms) => ({ datetime: new Date(ms).toISOString() })),
};

const KIND_LIST: XlsxColumnKind[] = ['string', 'number', 'integer', 'boolean', 'date', 'datetime'];

const table = fc.array(fc.constantFrom(...KIND_LIST), { minLength: 1, maxLength: 6 }).chain((kinds) =>
  fc.record({
    kinds: fc.constant(kinds),
    headers: fc.tuple(...kinds.map(() => fc.string({ unit: 'grapheme', maxLength: 20 }))),
    rows: fc.array(fc.tuple(...kinds.map((k) => fc.option(valueOf[k], { freq: 5 }))), { maxLength: 15 }),
  }),
);

describe('property: random tables', () => {
  it('round-trip through writeXlsx and openWorkbook with equal canonical cells', () => {
    fc.assert(
      fc.property(table, ({ kinds, headers, rows }) => {
        const columns = kinds.map((kind, i) => ({ header: headers[i] ?? '', kind }));
        const bytes = writeXlsx(book([sheet(columns, rows)]));
        const read = openWorkbook(bytes).readSheet('Data');
        const header = new Array<RawField>(kinds.length).fill(null);
        for (const cell of read.rows.find((r) => r.r === 0)?.cells ?? []) header[cell.c] = cell.v;
        expect(header).toEqual(headers);
        const got = dataValues(read, kinds.length).map((r) => r.map((v) => canonicalCell(v as CellValue)));
        // Trailing rows that hold only nulls leave no trace in the sheet.
        const expected = rows.map((r) => r.map((v) => canonicalCell(v)));
        while (expected.length > got.length && expected[expected.length - 1]?.every((c) => c === canonicalCell(null))) {
          expected.pop();
        }
        expect(got).toEqual(expected);
        expect(read.autoFilter).toEqual({ s: { r: 0, c: 0 }, e: { r: rows.length, c: kinds.length - 1 } });
      }),
      { numRuns: 60 },
    );
  });
});
