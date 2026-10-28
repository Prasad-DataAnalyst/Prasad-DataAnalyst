import { describe, expect, it } from 'vitest';
import { readZip } from '@tw/io';
import { CTX, datasetOf, inputOf, viewOf } from './__fixtures__/input';
import { buildExport, expectedShape, readBack } from './index';
import { neutralizeFormula, restoreFormula } from './values';

const view = viewOf(datasetOf());

async function csvExport() {
  const result = await buildExport(inputOf(view, { profile: 'csv' }), CTX);
  if (result.bytes === undefined) throw new Error(JSON.stringify(result.validation.checks.filter((c) => !c.ok)));
  return { result, text: readZip(result.bytes).readText('data.csv') };
}

describe('CSV export', () => {
  it('passes every read-back check', async () => {
    const { result } = await csvExport();
    expect(result.ok).toBe(true);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    const ids = new Set(result.validation.checks.map((c) => c.id));
    for (const id of [
      'RB-OPEN',
      'RB-ROWS',
      'RB-HEADER',
      'RB-VALUES',
      'RB-CSV-ENCODING',
      'RB-PKG-CHECKSUMS',
      'RB-PKG-CONTENTS',
    ]) {
      expect(ids.has(id as never), id).toBe(true);
    }
  });

  it("writes 'Name [unit]' headers, ISO dates and datetimes, canonical numbers and CRLF", async () => {
    const { text } = await csvExport();
    const [header, first, second] = text.split('\r\n');
    expect(header).toBe('well_id,date,reading time,Pressure [psia],Choke,lat,lon,Online,Note');
    expect(first).toBe(
      'NS-A01,2026-01-01,2026-01-01T06:00:00.000Z,1205.3,32,57.4802,1.7501,true,"normal, ""steady"" flow"',
    );
    expect(second).toContain('0.30000000000000004');
    expect(text).toContain('1e+21');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('is byte-identical for the same input and clock', async () => {
    const a = await buildExport(inputOf(view, { profile: 'csv' }), CTX);
    const b = await buildExport(inputOf(view, { profile: 'csv' }), CTX);
    expect(a.bytes).toEqual(b.bytes);
    expect(a.packageSha256).toBe(b.packageSha256);
    expect(a.packageName).toBe('well daily-e_0000abcd.zip');
  });

  it('reads back a hand-written file with a ragged row as a failure', () => {
    const shape = expectedShape(view, ['c0', 'c4']);
    const bytes = new TextEncoder().encode('well_id,Choke\r\nNS-A01,32\r\nNS-A02\r\nNS-A03,\r\nNS-A01,34\r\n');
    const checks = readBack.csv(bytes, shape, 'x.csv');
    expect(checks.find((c) => c.id === 'RB-CSV-ENCODING')?.ok).toBe(false);
    expect(checks.find((c) => c.id === 'RB-VALUES')?.ok).toBe(false);
  });

  it('flags a byte-order mark and invalid UTF-8', () => {
    const shape = expectedShape(view, ['c0']);
    const bom = new TextEncoder().encode('﻿well_id\r\nNS-A01\r\nNS-A02\r\nNS-A03\r\nNS-A01\r\n');
    expect(readBack.csv(bom, shape, 'x.csv').find((c) => c.id === 'RB-CSV-ENCODING')?.ok).toBe(false);
    expect(readBack.csv(Uint8Array.of(0xff, 0xfe, 0x41), shape, 'x.csv')[0]).toMatchObject({
      id: 'RB-OPEN',
      ok: false,
    });
  });
});

describe('formula neutralisation (CSV)', () => {
  const cols = [
    { name: 'Note', type: 'string' as const, role: 'text' as const },
    { name: 'Value', type: 'number' as const, role: 'measure' as const },
  ];
  const rows = [
    ['=SUM(A1)', -5],
    ['+1', 1],
    ['-x', 2],
    ['@cmd', 3],
    ["'=x", 4],
    ['plain', 5],
    ['\ttab', 6],
  ];
  const formulaView = viewOf(datasetOf(cols, rows, null));

  it('prefixes an apostrophe to text a spreadsheet would run, leaves numbers alone, and still validates', async () => {
    const result = await buildExport(inputOf(formulaView, { profile: 'csv', neutralizeFormulas: true }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    const zip = readZip(result.bytes as Uint8Array);
    const lines = zip.readText('data.csv').split('\r\n');
    expect(lines.slice(1, 8)).toEqual(["'=SUM(A1),-5", "'+1,1", "'-x,2", "'@cmd,3", "''=x,4", 'plain,5', "'\ttab,6"]);
    expect(result.manifest.options).toEqual({ neutralizeFormulas: true });
    expect(zip.readText('README.txt')).toContain('Formulas: neutralised');
  });

  it('is off unless asked for, and the manifest says so', async () => {
    const result = await buildExport(inputOf(formulaView, { profile: 'csv' }), CTX);
    expect(readZip(result.bytes as Uint8Array).readText('data.csv')).toContain('\r\n=SUM(A1),-5\r\n');
    expect(result.manifest.options).toEqual({ neutralizeFormulas: false });
  });

  it('restores exactly what neutralisation changed', () => {
    for (const t of ['=a', "'=a", "''=a", 'a', "'a", '', '-', '\r']) {
      expect(restoreFormula(neutralizeFormula(t))).toBe(t);
    }
  });
});
