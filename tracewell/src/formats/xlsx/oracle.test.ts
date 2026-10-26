/**
 * Oracle: a workbook from writeXlsx read by an independent implementation, openpyxl (SAD section
 * 13.1). Skipped where Python 3 with openpyxl is not installed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeXlsx, type XlsxWriteBook } from './index';

const OPENPYXL_AVAILABLE = spawnSync('python3', ['-I', '-c', 'import openpyxl'], { stdio: 'ignore' }).status === 0;

/**
 * Prints, as JSON, what openpyxl sees: each sheet's frozen pane, filter range, merges and cells.
 * Dates are written to the millisecond after rounding, because openpyxl converts serials with
 * floating-point arithmetic that can land a microsecond away.
 */
const READER = String.raw`
import datetime, json, sys
from openpyxl import load_workbook

def value_of(v):
    if isinstance(v, datetime.datetime):
        v = v + datetime.timedelta(microseconds=500)
        return v.replace(microsecond=v.microsecond // 1000 * 1000).isoformat(timespec="milliseconds")
    if isinstance(v, datetime.date):
        return v.isoformat()
    return v

wb = load_workbook(sys.argv[1])
out = {"sheetnames": wb.sheetnames, "sheets": {}}
for ws in wb.worksheets:
    cells = []
    for row in ws.iter_rows():
        for c in row:
            if c.value is None:
                continue
            cells.append({"ref": c.coordinate, "value": value_of(c.value), "data_type": c.data_type,
                          "is_date": c.is_date, "number_format": c.number_format})
    out["sheets"][ws.title] = {
        "freeze_panes": ws.freeze_panes,
        "auto_filter": ws.auto_filter.ref,
        "merged": [str(r) for r in ws.merged_cells.ranges],
        "dimensions": ws.dimensions,
        "cells": cells,
    }
print(json.dumps(out))
`;

interface OracleCell {
  ref: string;
  value: unknown;
  data_type: string;
  is_date: boolean;
  number_format: string;
}

interface OracleSheet {
  freeze_panes: string | null;
  auto_filter: string | null;
  merged: string[];
  dimensions: string;
  cells: OracleCell[];
}

interface OracleBook {
  sheetnames: string[];
  sheets: Record<string, OracleSheet>;
}

const scratch = mkdtempSync(join(tmpdir(), 'tracewell-xlsx-oracle-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function readWithOpenpyxl(bytes: Uint8Array, file: string): OracleBook {
  const path = join(scratch, file);
  writeFileSync(path, bytes);
  const run = spawnSync('python3', ['-I', '-c', READER, path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`openpyxl failed: ${run.stderr}`);
  return JSON.parse(run.stdout) as OracleBook;
}

const BOOK: XlsxWriteBook = {
  created: '2026-10-21T09:15:30.250Z',
  creator: 'Prasad (Prasad-DataAnalyst)',
  title: 'Well tests',
  sheets: [
    {
      name: 'Well tests',
      columns: [
        { header: 'Well', kind: 'string' },
        { header: 'Pressure [kPa]', kind: 'number' },
        { header: 'Runs', kind: 'integer' },
        { header: 'Flowing', kind: 'boolean' },
        { header: 'Test date', kind: 'date' },
        { header: 'Measured at', kind: 'datetime' },
      ],
      rows: [
        ['A-01', 2510.5, 3, true, { date: '2026-01-31' }, { datetime: '2026-01-31T06:30:00.125Z' }],
        [
          'Ünïcode – 東京',
          -0.000123,
          9007199254740991,
          false,
          { date: '1900-03-01' },
          { datetime: '9999-12-31T23:59:59.999Z' },
        ],
        [null, null, null, null, null, null],
        ['00123', 1e21, -4, true, { date: '9999-12-31' }, { datetime: '1900-03-01T12:00:00.000Z' }],
      ],
      freezeHeader: true,
      autoFilter: true,
    },
    {
      name: 'Notes',
      columns: [{ header: 'Note', kind: 'string' }],
      rows: [['Plain sheet']],
      freezeHeader: false,
      autoFilter: false,
    },
  ],
};

describe.skipIf(!OPENPYXL_AVAILABLE)('openpyxl reads what writeXlsx writes', () => {
  const book = OPENPYXL_AVAILABLE ? readWithOpenpyxl(writeXlsx(BOOK), 'book.xlsx') : null;
  const wells = (): OracleSheet => book?.sheets['Well tests'] as OracleSheet;
  const cell = (ref: string): OracleCell | undefined => wells().cells.find((c) => c.ref === ref);

  it('lists the sheets in order', () => {
    expect(book?.sheetnames).toEqual(['Well tests', 'Notes']);
  });

  it('sees the frozen header, the filter range and no merges', () => {
    expect(wells().freeze_panes).toBe('A2');
    expect(wells().auto_filter).toBe('A1:F5');
    expect(wells().merged).toEqual([]);
    expect(wells().dimensions).toBe('A1:F5');
    const notes = book?.sheets['Notes'] as OracleSheet;
    expect(notes.freeze_panes).toBeNull();
    expect(notes.auto_filter).toBeNull();
  });

  it('types the cells: numbers n, booleans b, text s', () => {
    expect(cell('B2')).toMatchObject({ data_type: 'n', value: 2510.5, is_date: false });
    expect(cell('B3')).toMatchObject({ data_type: 'n', value: -0.000123 });
    expect(cell('B5')).toMatchObject({ data_type: 'n', value: 1e21 });
    expect(cell('C3')).toMatchObject({ data_type: 'n', value: 9007199254740991, is_date: false });
    expect(cell('D2')).toMatchObject({ data_type: 'b', value: true });
    expect(cell('D3')).toMatchObject({ data_type: 'b', value: false });
    expect(cell('A3')).toMatchObject({ data_type: 's', value: 'Ünïcode – 東京' });
    expect(cell('A5')).toMatchObject({ data_type: 's', value: '00123' });
    expect(cell('A1')).toMatchObject({ data_type: 's', value: 'Well' });
  });

  it('sees dates and date-times as dates with their values', () => {
    const dates: [string, string][] = [
      ['E2', '2026-01-31T00:00:00.000'],
      ['E3', '1900-03-01T00:00:00.000'],
      ['E5', '9999-12-31T00:00:00.000'],
      ['F2', '2026-01-31T06:30:00.125'],
      ['F3', '9999-12-31T23:59:59.999'],
      ['F5', '1900-03-01T12:00:00.000'],
    ];
    for (const [ref, value] of dates) {
      expect(cell(ref), ref).toMatchObject({ is_date: true, data_type: 'd', value });
    }
  });

  it('leaves the empty row empty', () => {
    expect(wells().cells.filter((c) => c.ref.endsWith('4') && c.ref.length === 2)).toEqual([]);
  });
});
