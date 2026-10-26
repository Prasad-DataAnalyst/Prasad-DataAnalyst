import { describe, expect, it } from 'vitest';
import { openWorkbook } from '@tw/formats-xlsx';
import { readZip } from '@tw/io';
import { CTX, datasetOf, inputOf, viewOf } from './__fixtures__/input';
import { buildExport } from './index';

const view = viewOf(datasetOf());

describe('Excel export', () => {
  it('passes read-back and has Data, Report and Log sheets', async () => {
    const result = await buildExport(inputOf(view, { profile: 'excel' }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    const book = openWorkbook(readZip(result.bytes ?? new Uint8Array()).read('data.xlsx'));
    expect(book.sheets.map((s) => s.name)).toEqual(['Data', 'Report', 'Log']);
  });

  it('stores numbers as numbers and dates with date formats; frozen header, filter, no merges', async () => {
    const result = await buildExport(inputOf(view, { profile: 'excel' }), CTX);
    const ids = result.validation.checks.filter((c) => c.file === 'data.xlsx').map((c) => [c.id, c.ok]);
    expect(ids).toContainEqual(['RB-XLSX-TYPES', true]);
    expect(ids).toContainEqual(['RB-XLSX-STRUCTURE', true]);
    const data = openWorkbook(readZip(result.bytes ?? new Uint8Array()).read('data.xlsx')).readSheet('Data');
    expect(data.frozen).toEqual({ r: 1, c: 0 });
    expect(data.merges).toEqual([]);
    const first = data.rows.find((r) => r.r === 1);
    expect(first?.cells.find((c) => c.c === 3)).toMatchObject({ t: 'n', v: 1205.3 });
    expect(first?.cells.find((c) => c.c === 1)?.isDate).toBe(true);
  });

  it('writes one Log row per audit entry', async () => {
    const input = inputOf(view, { profile: 'excel' });
    const result = await buildExport(input, CTX);
    const log = openWorkbook(readZip(result.bytes ?? new Uint8Array()).read('data.xlsx')).readSheet('Log');
    expect(log.rows.filter((r) => r.r > 0)).toHaveLength(input.audit.length);
  });

  it('lists sources, rule packs and column digests on the Report sheet', async () => {
    const result = await buildExport(inputOf(view, { profile: 'excel' }), CTX);
    const report = openWorkbook(readZip(result.bytes ?? new Uint8Array()).read('data.xlsx')).readSheet('Report');
    const text = report.rows.flatMap((r) => r.cells.map((c) => String(c.v))).join('\n');
    expect(text).toContain('well_daily.csv');
    expect(text).toContain('tracewell.generic-dq 0.1.0');
    expect(text).toContain('Column digest Pressure [psia]');
  });
});
