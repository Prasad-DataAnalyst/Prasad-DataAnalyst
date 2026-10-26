import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readZip } from '@tw/io';
import { schemas } from '@tw/model';
import { CTX, SOURCE_SHA, datasetOf, inputOf, viewOf } from './__fixtures__/input';
import { buildExport } from './index';

const result = await buildExport(inputOf(viewOf(datasetOf()), { profile: 'csv' }), CTX);
const zip = readZip(result.bytes ?? new Uint8Array());

describe('export package', () => {
  it('holds the data file, README, manifest, audit, issues and checksums', () => {
    expect(zip.paths().sort()).toEqual([
      'CHECKSUMS.sha256',
      'README.txt',
      'audit.jsonl',
      'data.csv',
      'issues.csv',
      'manifest.json',
    ]);
  });

  it('has a manifest that validates against the export manifest schema', () => {
    const parsed = schemas.exportManifest.safeParse(JSON.parse(zip.readText('manifest.json')));
    expect(parsed.success).toBe(true);
    expect(result.manifest.validation.ok).toBe(true);
  });

  it('lists every source SHA-256, the rule packs and the open warnings in the README', () => {
    const readme = zip.readText('README.txt');
    expect(readme).toContain(SOURCE_SHA);
    expect(readme).toContain('tracewell.generic-dq 0.1.0');
    expect(readme).toContain('OPEN WARNINGS');
    expect(readme).toContain('sha256sum -c CHECKSUMS.sha256');
  });

  it('writes one audit entry per line and one issue per row', () => {
    expect(zip.readText('audit.jsonl').trim().split('\n')).toHaveLength(3);
    expect(zip.readText('issues.csv').trim().split('\r\n')).toHaveLength(2);
  });

  describe('sha256sum -c', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-export-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    it('passes on the extracted package', () => {
      for (const p of zip.paths()) {
        const target = join(dir, p);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, zip.read(p));
      }
      const out = execFileSync('sha256sum', ['-c', 'CHECKSUMS.sha256'], { cwd: dir, encoding: 'utf8' });
      expect(out).not.toMatch(/FAILED/);
      expect(out.trim().split('\n')).toHaveLength(5);
    });
  });
});
