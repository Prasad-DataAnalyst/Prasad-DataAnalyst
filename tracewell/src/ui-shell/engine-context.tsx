/** React wiring for the engine client: a provider and hooks for events and jobs. */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { EngineError, type EngineErrorData, type JobHandle, type JobProgress } from '@tw/model';
import type { EngineClient, EngineEvent } from '@tw/engine-api';

const EngineContext = createContext<EngineClient | null>(null);

export function EngineProvider(p: { engine: EngineClient; children: ReactNode }): React.JSX.Element {
  return <EngineContext.Provider value={p.engine}>{p.children}</EngineContext.Provider>;
}

export function useEngine(): EngineClient {
  const engine = useContext(EngineContext);
  if (engine === null) throw new Error('useEngine must be used inside an EngineProvider.');
  return engine;
}

/** Subscribes to engine events for the lifetime of the component; the latest callback is always used. */
export function useEngineEvents(cb: (e: EngineEvent) => void): void {
  const engine = useEngine();
  const latest = useRef(cb);
  useEffect(() => {
    latest.current = cb;
  });
  useEffect(() => engine.onEvent((e) => latest.current(e)), [engine]);
}

type JobState = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';

export function toErrorData(e: unknown): EngineErrorData {
  const err = EngineError.from(e);
  return err.detail === undefined
    ? { code: err.code, message: err.message, fix: err.fix }
    : { code: err.code, message: err.message, fix: err.fix, detail: err.detail };
}

interface JobView<T> {
  jobId: string;
  state: JobState;
  progress: JobProgress | null;
  result: T | null;
  error: EngineErrorData | null;
}

/**
 * Follows one job: progress while it runs, then its result or error. The view is keyed by job id,
 * so a new handle starts as "running" without resetting state inside the effect.
 */
export function useJob<T>(h: JobHandle | null): {
  state: JobState;
  progress: JobProgress | null;
  result: T | null;
  error: EngineErrorData | null;
  cancel(): void;
} {
  const engine = useEngine();
  const [view, setView] = useState<JobView<T> | null>(null);

  useEffect(() => {
    if (h === null) return;
    let live = true;
    const update = (patch: Partial<JobView<T>>) =>
      setView((v) => ({
        ...(v?.jobId === h.jobId ? v : { jobId: h.jobId, state: 'running', progress: null, result: null, error: null }),
        ...patch,
      }));
    engine
      .awaitJob<T>(h, (progress) => {
        if (live) update({ progress });
      })
      .then(
        (result) => {
          if (live) update({ result, state: 'done' });
        },
        (e: unknown) => {
          if (!live) return;
          const error = toErrorData(e);
          update({ error, state: error.code === 'CANCELLED' ? 'cancelled' : 'failed' });
        },
      );
    return () => {
      live = false;
    };
  }, [engine, h]);

  const current = h !== null && view?.jobId === h.jobId ? view : null;
  return {
    state: h === null ? 'idle' : (current?.state ?? 'running'),
    progress: current?.progress ?? null,
    result: current?.result ?? null,
    error: current?.error ?? null,
    cancel: () => {
      if (h !== null) void engine.cancelJob(h.jobId);
    },
  };
}
