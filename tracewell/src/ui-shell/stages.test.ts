import { describe, expect, it } from 'vitest';
import type { DatasetSummary, ProjectSummary } from '@tw/model';
import { stageStates } from './stages';

function dataset(over: Partial<DatasetSummary> = {}): DatasetSummary {
  return {
    id: 'd1',
    name: 'well daily',
    source: { fileId: 'a'.repeat(64), format: 'csv', locator: '' } as unknown as DatasetSummary['source'],
    rowCount: 10,
    outputRowCount: 10,
    columnCount: 4,
    assumptions: 0,
    partial: false,
    steps: [],
    ...over,
  };
}

function project(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'p_0123456789abcdef',
    name: 'Test',
    createdAt: '2026-10-19T09:00:00.000Z',
    profile: { id: 'u1', name: 'Prasad', role: 'Analyst' },
    unitSystem: 'SI',
    projectArea: null,
    readOnly: false,
    dirty: false,
    lastSavedAt: null,
    originals: [],
    datasets: [],
    exports: [],
    rulePacks: [],
    auditHead: { seq: 1, hash: 'b'.repeat(64) },
    ...over,
  };
}

describe('stageStates', () => {
  it('is all idle without a project', () => {
    expect(Object.values(stageStates(null, null))).toEqual(['idle', 'idle', 'idle', 'idle', 'idle', 'idle']);
  });

  it('points at Import for an empty project', () => {
    expect(stageStates(project(), null)).toMatchObject({ import: 'active', check: 'idle' });
  });

  it('points at Check once a file is imported', () => {
    expect(stageStates(project({ datasets: [dataset()] }), null)).toEqual({
      import: 'done',
      check: 'active',
      review: 'idle',
      process: 'idle',
      extract: 'idle',
      export: 'idle',
    });
  });

  it('flags Import when an import was partial', () => {
    expect(stageStates(project({ datasets: [dataset({ partial: true })] }), null).import).toBe('attention');
  });

  it('flags Review while checked issues are open', () => {
    expect(stageStates(project({ datasets: [dataset()] }), { open: 3 })).toMatchObject({
      check: 'done',
      review: 'attention',
      process: 'active',
      extract: 'active',
      export: 'active',
    });
  });

  it('marks Review done when every issue is resolved', () => {
    expect(stageStates(project({ datasets: [dataset()] }), { open: 0 }).review).toBe('done');
  });

  it('marks Process, Extract and Export done from steps and exports', () => {
    const steps: DatasetSummary['steps'] = [
      { id: 's1', seq: 5, kind: 'convert_unit', columnId: 'c2', toUnit: 'kPa', mode: 'replace' },
      { id: 's2', seq: 6, kind: 'select_columns', columnIds: ['c0', 'c2'] },
    ];
    const exports: ProjectSummary['exports'] = [
      {
        exportId: 'e_00000001',
        profile: 'csv',
        datasetId: 'd1',
        packageName: 'x.zip',
        packageSha256: 'c'.repeat(64),
        createdAt: '2026-10-19T10:00:00.000Z',
        ok: true,
      },
    ];
    expect(stageStates(project({ datasets: [dataset({ steps })], exports }), { open: 0 })).toEqual({
      import: 'done',
      check: 'done',
      review: 'done',
      process: 'done',
      extract: 'done',
      export: 'done',
    });
  });
});
