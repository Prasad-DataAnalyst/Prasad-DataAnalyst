/** Data hooks for the views: engine queries that refresh when the project changes. */
import { useEffect, useRef, useState } from 'react';
import type { EngineClient, EngineEvent } from '@tw/engine-api';
import type { DatasetId, EngineErrorData, ProjectSummary } from '@tw/model';
import { toErrorData, useWorkbench, type CentreTab } from '@tw/ui-shell';

type Change = Extract<EngineEvent, { type: 'project.changed' }>['what'][number];

/** A counter that moves on whenever the project changes in one of the watched ways. */
export function useChangeVersion(engine: EngineClient, watch: readonly Change[], datasetId?: DatasetId): number {
  const [version, setVersion] = useState(0);
  const latest = useRef({ watch, datasetId });
  useEffect(() => {
    latest.current = { watch, datasetId };
  });
  useEffect(
    () =>
      engine.onEvent((e) => {
        if (e.type !== 'project.changed') return;
        const { watch: w, datasetId: d } = latest.current;
        if (d !== undefined && e.datasetId !== undefined && e.datasetId !== d) return;
        if (e.what.some((x) => w.includes(x))) setVersion((v) => v + 1);
      }),
    [engine],
  );
  return version;
}

export interface Query<T> {
  data: T | null;
  error: EngineErrorData | null;
  loading: boolean;
}

/**
 * Runs `fetch` whenever `key` or the change version moves on. While a refresh for the same key is
 * running the previous data stays on screen, so a grid or list does not flicker on every change.
 */
export function useEngineQuery<T>(
  engine: EngineClient,
  key: string | null,
  fetch: () => Promise<T>,
  watch: readonly Change[] = ['project', 'datasets', 'schema', 'issues', 'audit', 'steps', 'exports'],
): Query<T> {
  const version = useChangeVersion(engine, watch);
  const fetchRef = useRef(fetch);
  useEffect(() => {
    fetchRef.current = fetch;
  });
  const [result, setResult] = useState<{
    key: string;
    version: number;
    data: T | null;
    error: EngineErrorData | null;
  } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    fetchRef.current().then(
      (data) => live && setResult({ key, version, data, error: null }),
      (e: unknown) => live && setResult({ key, version, data: null, error: toErrorData(e) }),
    );
    return () => {
      live = false;
    };
  }, [key, version]);
  if (key === null || result === null || result.key !== key) return { data: null, error: null, loading: key !== null };
  return { data: result.data, error: result.error, loading: result.version !== version };
}

export function useProject(): ProjectSummary | null {
  return useWorkbench((s) => s.project);
}

/** The dataset a view is about: its tab's dataset, else the selected one, else the first. */
export function datasetFor(tab: CentreTab | undefined, project: ProjectSummary | null): DatasetId | null {
  if (tab?.datasetId !== undefined) return tab.datasetId;
  const s = useWorkbench.getState().selection;
  if ('datasetId' in s && s.datasetId !== undefined) return s.datasetId;
  return project?.datasets[0]?.id ?? null;
}

/** Runs an engine call and shows its error in the shell's error banner instead of throwing. */
export async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    useWorkbench.getState().showError(null);
    return await run();
  } catch (e) {
    useWorkbench.getState().showError(toErrorData(e));
    return null;
  }
}
