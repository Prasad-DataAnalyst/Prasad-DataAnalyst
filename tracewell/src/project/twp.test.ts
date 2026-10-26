import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fixtureBytes } from '@tw/fixtures';
import { readZip, sha256Hex, writeZip, type ZipEntryInput } from '@tw/io';
import type { IntegrityCheck, OriginalFileInfo, RulePackRef } from '@tw/model';
import { TWP_MIMETYPE, originalPath, readTwp, suggestedFileName, twpReadme, writeTwp, type TwpInput } from './index';

const CSV = fixtureBytes('csv_well_daily_golden.csv');
const XLSX = fixtureBytes('xlsx_merged_two_row_header_units.xlsx');
const AUDIT = '{"action":"project.create","seq":1}\n{"action":"source.add","seq":2}\n{"action":"source.add","seq":3}\n';
const PACK_JSON = '{"id":"tracewell.generic-dq","version":"0.1.0","rules":[]}';
const REGISTRY_JSON = '{"version":"2026.1","units":[]}';

function info(name: string, bytes: Uint8Array, mediaType: string, addedSeq: number): OriginalFileInfo {
  return { fileId: sha256Hex(bytes), name, size: bytes.length, mediaType, addedSeq };
}

function input(): TwpInput {
  const pack: RulePackRef = { id: 'tracewell.generic-dq', version: '0.1.0', sha256: sha256Hex(PACK_JSON) };
  const csv = info('csv_well_daily_golden.csv', CSV, 'text/csv', 2);
  const xlsx = info(
    'xlsx_merged_two_row_header_units.xlsx',
    XLSX,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    3,
  );
  return {
    manifest: {
      appVersion: '0.1.0',
      projectId: 'p_0123456789abcdef',
      name: 'North Sea wells',
      createdAt: '2026-10-19T09:00:00.000Z',
      savedAt: '2026-10-19T10:00:00.000Z',
      savedBy: 'Prasad',
      unitSystem: 'SI',
      projectArea: null,
      unitRegistry: { version: '2026.1', sha256: sha256Hex(REGISTRY_JSON) },
      rulePacks: [pack],
      originals: [],
      datasets: [
        { id: 'd1', name: 'well daily', rowCount: 5, workingDigest: 'a'.repeat(64), outputDigest: 'b'.repeat(64) },
      ],
      auditHead: { seq: 3, hash: 'c'.repeat(64) },
    },
    originals: [
      { info: csv, bytes: CSV },
      { info: xlsx, bytes: XLSX },
    ],
    auditJsonl: AUDIT,
    rulePacks: [{ ref: pack, json: PACK_JSON }],
    unitRegistry: { version: '2026.1', json: REGISTRY_JSON },
  };
}

const twp = writeTwp(input());

/** Rebuilds the archive with one entry changed, removed or added, keeping everything else. */
function rewrite(bytes: Uint8Array, change: (entries: ZipEntryInput[]) => ZipEntryInput[]): Uint8Array {
  const zip = readZip(bytes);
  const entries = zip.paths().map((path) => ({ path, data: zip.read(path), store: path === 'mimetype' }));
  return writeZip(change(entries));
}

function replace(path: string, data: Uint8Array) {
  return (entries: ZipEntryInput[]) => entries.map((e) => (e.path === path ? { ...e, data } : e));
}

function failed(checks: IntegrityCheck[], id: IntegrityCheck['id']): IntegrityCheck[] {
  return checks.filter((c) => c.id === id && !c.ok);
}

/** The local-file-header compression method of the entry at the given byte offset. */
function methodAt(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint16(offset + 8, true);
}

describe('writeTwp then readTwp', () => {
  const read = readTwp(twp);

  it('passes every integrity check', () => {
    expect(read.checks.map((c) => [c.id, c.ok])).toEqual([
      ['zip', true],
      ['mimetype', true],
      ['format-version', true],
      ['manifest-schema', true],
      ['entry-checksum', true],
      ['original-checksum', true],
    ]);
  });

  it('round-trips the manifest, originals, audit text, rule packs and unit registry', () => {
    const src = input();
    expect(read.manifest?.name).toBe('North Sea wells');
    expect(read.manifest?.projectId).toBe(src.manifest.projectId);
    expect(read.manifest?.datasets).toEqual(src.manifest.datasets);
    expect(read.manifest?.originals.map((o) => o.path)).toEqual(src.originals.map((o) => originalPath(o.info)));
    expect(read.originals.get(sha256Hex(CSV))?.bytes).toEqual(CSV);
    expect(read.originals.get(sha256Hex(XLSX))?.bytes).toEqual(XLSX);
    expect(read.originals.get(sha256Hex(CSV))?.info).toEqual(src.originals[0]?.info);
    expect(read.auditJsonl).toBe(AUDIT);
    expect(read.rulePacks).toEqual(src.rulePacks);
    expect(read.unitRegistry).toEqual(src.unitRegistry);
  });

  it('lists every entry except mimetype, manifest and checksums in manifest.entries', () => {
    const zip = readZip(twp);
    const listed = read.manifest?.entries.map((e) => e.path) ?? [];
    const expected = zip.paths().filter((p) => !['mimetype', 'manifest.json', 'CHECKSUMS.sha256'].includes(p));
    expect([...listed].sort()).toEqual([...expected].sort());
  });

  it('writes the mimetype first, STORED, with the exact content', () => {
    const zip = readZip(twp);
    expect(zip.paths()[0]).toBe('mimetype');
    expect(zip.readText('mimetype')).toBe(TWP_MIMETYPE);
    expect(methodAt(twp, 0)).toBe(0);
    // A STORED mimetype appears literally right after the 30-byte header and the 8-byte name.
    expect(new TextDecoder().decode(twp.subarray(38, 38 + TWP_MIMETYPE.length))).toBe(TWP_MIMETYPE);
  });

  it('stores originals uncompressed', () => {
    // The CSV fixture is text that DEFLATE would shrink; STORED keeps it byte for byte in the archive.
    const needle = new TextDecoder().decode(CSV.subarray(0, 40));
    expect(new TextDecoder('latin1').decode(twp)).toContain(needle);
  });

  it('is byte-identical across two writes of the same input', () => {
    expect(writeTwp(input())).toEqual(twp);
  });

  it('keeps entries after the mimetype in path order', () => {
    const rest = readZip(twp).paths().slice(1);
    expect(rest).toEqual([...rest].sort());
  });
});

describe('tamper detection', () => {
  const csvPath = originalPath(input().originals[0]?.info as OriginalFileInfo);

  it('a changed original fails original-checksum with TW-PRJ-001 and its path', () => {
    const changed = CSV.slice();
    changed[10] = (changed[10] ?? 0) ^ 1;
    const read = readTwp(rewrite(twp, replace(csvPath, changed)));
    const f = failed(read.checks, 'original-checksum');
    expect(f).toHaveLength(1);
    expect(f[0]?.ruleId).toBe('TW-PRJ-001');
    expect(f[0]?.target).toBe(csvPath);
    // The changed bytes are still returned so the user can inspect them.
    expect(read.originals.get(sha256Hex(CSV))?.bytes).toEqual(changed);
  });

  it('a removed manifest fails manifest-schema and still returns the audit text', () => {
    const read = readTwp(rewrite(twp, (es) => es.filter((e) => e.path !== 'manifest.json')));
    expect(failed(read.checks, 'manifest-schema')).toHaveLength(1);
    expect(failed(read.checks, 'format-version')).toHaveLength(1);
    expect(read.manifest).toBeNull();
    expect(read.auditJsonl).toBe(AUDIT);
  });

  it('a changed audit byte fails entry-checksum with TW-PRJ-004', () => {
    const changed = new TextEncoder().encode(AUDIT.replace('create', 'CREATE'));
    const read = readTwp(rewrite(twp, replace('audit.jsonl', changed)));
    const f = failed(read.checks, 'entry-checksum');
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((c) => c.ruleId === 'TW-PRJ-004')).toBe(true);
    expect(f.some((c) => c.target === 'audit.jsonl')).toBe(true);
  });

  it('format version 9.0 fails format-version but not manifest-schema', () => {
    const manifest = JSON.parse(readZip(twp).readText('manifest.json')) as Record<string, unknown>;
    const changed = new TextEncoder().encode(JSON.stringify({ ...manifest, formatVersion: '9.0' }));
    const read = readTwp(rewrite(twp, replace('manifest.json', changed)));
    expect(failed(read.checks, 'format-version')).toHaveLength(1);
    expect(failed(read.checks, 'manifest-schema')).toHaveLength(0);
    expect(read.manifest).toBeNull();
  });

  it('a changed manifest is caught by CHECKSUMS.sha256', () => {
    const manifest = JSON.parse(readZip(twp).readText('manifest.json')) as Record<string, unknown>;
    const changed = new TextEncoder().encode(JSON.stringify({ ...manifest, name: 'Renamed' }));
    const read = readTwp(rewrite(twp, replace('manifest.json', changed)));
    expect(failed(read.checks, 'entry-checksum').map((c) => c.target)).toContain('manifest.json');
  });

  it('an extra entry not listed anywhere fails entry-checksum', () => {
    const read = readTwp(rewrite(twp, (es) => [...es, { path: 'extra.txt', data: new TextEncoder().encode('x') }]));
    expect(failed(read.checks, 'entry-checksum').map((c) => c.target)).toContain('extra.txt');
  });

  it('a wrong mimetype fails the mimetype check', () => {
    const read = readTwp(rewrite(twp, replace('mimetype', new TextEncoder().encode('application/zip'))));
    expect(failed(read.checks, 'mimetype')).toHaveLength(1);
  });

  it('random bytes fail the zip check without throwing', () => {
    const noise = new Uint8Array(4096).map((_, i) => (i * 7919) % 256);
    const read = readTwp(noise);
    expect(read.checks).toEqual([expect.objectContaining({ id: 'zip', ok: false, ruleId: 'TW-PRJ-004' })]);
    expect(read.manifest).toBeNull();
    expect(read.originals.size).toBe(0);
  });

  it('an empty file fails the zip check without throwing', () => {
    expect(readTwp(new Uint8Array(0)).checks[0]).toMatchObject({ id: 'zip', ok: false });
  });
});

describe('writer input checks', () => {
  it('refuses an original whose bytes do not match its file ID', () => {
    const bad = input();
    const first = bad.originals[0];
    if (first === undefined) throw new Error('fixture missing');
    bad.originals[0] = { ...first, bytes: XLSX };
    expect(() => writeTwp(bad)).toThrow(/does not match its recorded file ID/);
  });

  it('refuses a rule pack whose text does not match its SHA-256', () => {
    const bad = input();
    const pack = bad.rulePacks[0];
    if (pack === undefined) throw new Error('fixture missing');
    bad.rulePacks[0] = { ...pack, json: `${PACK_JSON} ` };
    expect(() => writeTwp(bad)).toThrow(/rule pack/);
  });

  it('refuses a manifest that would not validate', () => {
    const bad = input();
    bad.manifest = { ...bad.manifest, projectId: 'not-an-id' };
    expect(() => writeTwp(bad)).toThrow(/manifest is not well formed/);
  });

  it('stores an original with an unsafe file name under a safe entry name', () => {
    const src = input();
    const first = src.originals[0];
    if (first === undefined) throw new Error('fixture missing');
    src.originals = [{ ...first, info: { ...first.info, name: '../../etc/passwd' } }];
    const zip = readZip(writeTwp(src));
    const path = zip.paths().find((p) => p.startsWith('originals/'));
    expect(path).toBe(`originals/${first.info.fileId}/_.._etc_passwd`);
  });
});

describe('README.txt', () => {
  it('explains verification and lists the originals', () => {
    const text = readZip(twp).readText('README.txt');
    expect(text).toContain('sha256sum -c CHECKSUMS.sha256');
    expect(text).toContain('csv_well_daily_golden.csv');
    expect(text).toContain('North Sea wells');
  });

  it('depends only on the manifest', () => {
    const manifest = readTwp(twp).manifest;
    if (manifest === null) throw new Error('manifest missing');
    expect(twpReadme(manifest)).toBe(readZip(twp).readText('README.txt'));
  });
});

describe('suggestedFileName', () => {
  it.each([
    ['North Sea wells', 'North Sea wells.twp'],
    ['  Field: A/B?  ', 'Field_ A_B_.twp'],
    ['already.twp', 'already.twp'],
    ['', 'project.twp'],
    ['...', 'project.twp'],
    ['CON', '_CON.twp'],
    ['line\nbreak\ttab', 'line_break_tab.twp'],
  ])('%j gives %j', (name, expected) => {
    expect(suggestedFileName(name)).toBe(expected);
  });

  it('limits very long names', () => {
    expect(suggestedFileName('x'.repeat(500))).toBe(`${'x'.repeat(100)}.twp`);
  });
});

describe('independent tools', () => {
  const dir = mkdtempSync(join(tmpdir(), 'twp-'));
  const file = join(dir, 'project.twp');
  writeFileSync(file, twp);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('python zipfile lists the archive', () => {
    const listing = execFileSync('python3', ['-I', '-m', 'zipfile', '-l', file], { encoding: 'utf8' });
    expect(listing).toContain('manifest.json');
    expect(listing).toContain('CHECKSUMS.sha256');
  });

  it('the extracted CHECKSUMS.sha256 passes sha256sum -c', () => {
    const out = join(dir, 'x');
    execFileSync('python3', ['-I', '-m', 'zipfile', '-e', file, out]);
    const result = execFileSync('sha256sum', ['-c', 'CHECKSUMS.sha256'], { cwd: out, encoding: 'utf8' });
    expect(result.split('\n').filter((l) => l.trim() !== '')).not.toHaveLength(0);
    expect(result).not.toMatch(/FAILED/);
  });
});
