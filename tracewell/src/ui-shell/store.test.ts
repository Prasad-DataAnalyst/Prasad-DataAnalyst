import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREFS_KEY, createWorkbenchStore, loadPrefs } from './store';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tabs', () => {
  it('de-duplicates by kind and dataset and focuses the existing tab', () => {
    const store = createWorkbenchStore();
    store.getState().openTab({ id: 't1', kind: 'data', title: 'Data d1', datasetId: 'd1' });
    store.getState().openTab({ id: 't2', kind: 'issues', title: 'Issues', datasetId: 'd1' });
    store.getState().openTab({ id: 't3', kind: 'data', title: 'Data d1 again', datasetId: 'd1' });
    expect(store.getState().tabs.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(store.getState().activeTabId).toBe('t1');
    store.getState().openTab({ id: 't4', kind: 'data', title: 'Data d2', datasetId: 'd2' });
    expect(store.getState().tabs).toHaveLength(3);
  });

  it('activates a neighbour when the active tab closes', () => {
    const store = createWorkbenchStore();
    for (const id of ['a', 'b', 'c']) store.getState().openTab({ id, kind: 'data', title: id, datasetId: `d${id}` });
    store.getState().activateTab('b');
    store.getState().closeTab('b');
    expect(store.getState().activeTabId).toBe('c');
    store.getState().closeTab('c');
    expect(store.getState().activeTabId).toBe('a');
    store.getState().closeTab('a');
    expect(store.getState().activeTabId).toBeNull();
  });

  it('ignores activating an unknown tab', () => {
    const store = createWorkbenchStore();
    store.getState().activateTab('nope');
    expect(store.getState().activeTabId).toBeNull();
  });
});

describe('jobs', () => {
  const handle = { jobId: 'j1', kind: 'import' as const };

  it('moves from running to done with progress on the way', () => {
    const store = createWorkbenchStore();
    store.getState().trackJob(handle, 'Importing');
    store
      .getState()
      .updateJob({ type: 'job.progress', jobId: 'j1', progress: { phase: 'read', done: 5, unit: 'rows' } });
    expect(store.getState().jobs['j1']).toMatchObject({ state: 'running', progress: { done: 5 } });
    store.getState().updateJob({ type: 'job.done', jobId: 'j1' });
    expect(store.getState().jobs['j1']?.state).toBe('done');
  });

  it('records the error of a failed job', () => {
    const store = createWorkbenchStore();
    store.getState().trackJob(handle, 'Importing');
    const error = { code: 'PARSE_FAILED' as const, message: 'Bad file.', fix: 'Check the file.' };
    store.getState().updateJob({ type: 'job.failed', jobId: 'j1', error });
    expect(store.getState().jobs['j1']).toMatchObject({ state: 'failed', error });
  });

  it('does not reopen a finished job on a late progress event', () => {
    const store = createWorkbenchStore();
    store.getState().trackJob(handle, 'Importing');
    store.getState().updateJob({ type: 'job.cancelled', jobId: 'j1' });
    store
      .getState()
      .updateJob({ type: 'job.progress', jobId: 'j1', progress: { phase: 'read', done: 9, unit: 'rows' } });
    expect(store.getState().jobs['j1']).toMatchObject({ state: 'cancelled', progress: null });
  });

  it('ignores events for jobs it does not track and non-job events', () => {
    const store = createWorkbenchStore();
    store.getState().updateJob({ type: 'job.done', jobId: 'other' });
    store.getState().updateJob({ type: 'log', level: 'info', message: 'x', at: '2026-10-19T09:00:00.000Z' });
    expect(store.getState().jobs).toEqual({});
  });
});

describe('preferences', () => {
  it('survive a localStorage that throws on every access', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const store = createWorkbenchStore();
    expect(store.getState().theme).toBe('light');
    expect(() => store.getState().setTheme('dark')).not.toThrow();
    expect(store.getState().theme).toBe('dark');
  });

  it('round-trip through localStorage', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => data.set(k, v),
    });
    const store = createWorkbenchStore();
    store.getState().setTheme('dark');
    store.getState().setDensity('comfortable');
    expect(JSON.parse(data.get(PREFS_KEY) ?? '{}')).toEqual({ theme: 'dark', density: 'comfortable' });
    expect(createWorkbenchStore().getState()).toMatchObject({ theme: 'dark', density: 'comfortable' });
  });

  it('fall back to defaults for corrupt or unexpected stored values', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{"theme":"neon","density":7}', setItem: () => undefined });
    expect(loadPrefs()).toEqual({ theme: 'light', density: 'compact' });
    vi.stubGlobal('localStorage', { getItem: () => 'not json', setItem: () => undefined });
    expect(loadPrefs()).toEqual({ theme: 'light', density: 'compact' });
  });
});
