/** A changed project file opens read-only with the matching TW-PRJ issue; nothing is repaired. */
import { describe, expect, it } from 'vitest';
import type { IntegrityCheck } from '@tw/model';
import { open, savedProject } from './__fixtures__/session';
import { rewriteTwp, setText, text } from './__fixtures__/twp';

function failed(checks: IntegrityCheck[]): string[] {
  return checks.filter((c) => !c.ok).map((c) => `${c.id} ${c.ruleId ?? ''}`);
}

describe('tampered projects', () => {
  it('a modified original opens read-only with TW-PRJ-001', async () => {
    const { bytes } = await savedProject();
    const tampered = rewriteTwp(bytes, (files) => {
      const path = [...files.keys()].find((p) => p.startsWith('originals/')) as string;
      const data = (files.get(path) as Uint8Array).slice();
      data[data.length - 3] = 0x37; // one digit of the last row changes
      files.set(path, data);
    });
    const { engine, report } = await open(tampered);
    expect(report.readOnly).toBe(true);
    expect(failed(report.checks)).toContain('original-checksum TW-PRJ-001');
    const issues = (await engine.listIssues({ limit: 100 })).items.map((i) => i.ruleId);
    expect(issues).toContain('TW-PRJ-001');
    expect((await engine.getProject()).readOnly).toBe(true);
  });

  it('a changed audit line opens read-only with TW-PRJ-002', async () => {
    const { bytes } = await savedProject();
    const tampered = rewriteTwp(bytes, (files) => {
      setText(
        files,
        'audit.jsonl',
        text(files, 'audit.jsonl').replace('Field sheet gives 1511.0', 'Field sheet gives 1611.0'),
      );
    });
    const { engine, report } = await open(tampered);
    expect(report.readOnly).toBe(true);
    expect(failed(report.checks)).toContain('audit-chain TW-PRJ-002');
    expect(report.checks.find((c) => c.id === 'entry-checksum')?.ok).toBe(true);
    expect((await engine.listIssues({ limit: 100 })).items.map((i) => i.ruleId)).toContain('TW-PRJ-002');
    expect((await engine.verifyAudit()).ok).toBe(false);
  });

  it('an altered dataset digest in the manifest opens read-only with TW-PRJ-003', async () => {
    const { bytes, datasetId } = await savedProject();
    const tampered = rewriteTwp(bytes, (files) => {
      const manifest = JSON.parse(text(files, 'manifest.json')) as { datasets: { outputDigest: string }[] };
      (manifest.datasets[0] as { outputDigest: string }).outputDigest = 'f'.repeat(64);
      setText(files, 'manifest.json', JSON.stringify(manifest));
    });
    const { engine, report } = await open(tampered);
    expect(report.readOnly).toBe(true);
    expect(failed(report.checks)).toEqual(['replay-digest TW-PRJ-003']);
    const prj = (await engine.listIssues({ datasetId, limit: 100 })).items.find((i) => i.ruleId === 'TW-PRJ-003');
    expect(prj?.datasetId).toBe(datasetId);
    expect(prj?.severity).toBe('error');
  });

  it('a changed entry without recomputed checksums is reported as TW-PRJ-004', async () => {
    const { bytes } = await savedProject();
    const tampered = rewriteTwp(
      bytes,
      (files) => setText(files, 'README.txt', `${text(files, 'README.txt')}\nedited`),
      false,
    );
    const { report } = await open(tampered);
    expect(report.readOnly).toBe(true);
    expect(failed(report.checks)).toContain('entry-checksum TW-PRJ-004');
  });

  it('a file that is not a project opens read-only instead of failing', async () => {
    const { report } = await open(new TextEncoder().encode('not a zip'));
    expect(report.readOnly).toBe(true);
    expect(failed(report.checks)).toEqual(expect.arrayContaining(['zip TW-PRJ-004', 'audit-chain TW-PRJ-002']));
  });
});
