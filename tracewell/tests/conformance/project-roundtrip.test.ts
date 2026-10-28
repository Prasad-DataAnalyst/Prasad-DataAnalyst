/** A saved project opened in a new engine is the same project: issues, audit and data. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { EngineClient } from '@tw/engine-api';
import type { Issue, ProjectOpenReport, SaveResult } from '@tw/model';
import { defineConformance, importFixture, newProject, runChecks } from './harness';

async function snapshot(engine: EngineClient, datasetId: string) {
  return {
    issues: (await engine.listIssues({ limit: 1000 })).items,
    audit: (await engine.listAudit({ limit: 1000 })).items,
    working: await engine.getRows({ datasetId, stage: 'working', offset: 0, limit: 1000 }),
    output: await engine.getRows({ datasetId, stage: 'output', offset: 0, limit: 1000 }),
    project: await engine.getProject(),
  };
}

defineConformance('project-roundtrip: save to a file and open it in a new engine', async (engine, fresh) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-conformance-'));
  try {
    await newProject(engine);
    const ds = await importFixture(engine, 'csv_null_markers.csv');
    const issues = await runChecks(engine, ds.id);
    const missing = issues.find((i) => i.ruleId === 'TW-DQ-001') as Issue;
    await engine.decide({
      kind: 'accept_issue',
      issueId: missing.id,
      rows: 'all',
      reason: 'Logger offline those days',
    });
    const path = join(dir, 'roundtrip.twp');
    const saved = await engine.awaitJob<SaveResult>(await engine.saveProject({ kind: 'path', path }));
    expect(saved.bytes).toBeUndefined();
    const before = await snapshot(engine, ds.id);

    const other = await fresh();
    try {
      const report = await other.awaitJob<ProjectOpenReport>(await other.openProject({ kind: 'path', path }));
      expect(report.readOnly).toBe(false);
      expect(report.checks.every((c) => c.ok)).toBe(true);
      expect(await snapshot(other, ds.id)).toEqual(before);
    } finally {
      other.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
