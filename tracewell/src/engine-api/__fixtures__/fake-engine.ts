/**
 * A scriptable EngineImpl for protocol tests: each test supplies only the methods it needs, and
 * can emit events and inspect the calls the engine received.
 */
import { EngineError } from '@tw/model';
import { isEngineMethod, type EngineApi, type EngineEvent, type EngineImpl } from '../protocol';

export type FakeEngine = EngineImpl & {
  emit(e: EngineEvent): void;
  readonly calls: { method: string; params: unknown[] }[];
  readonly listenerCount: number;
};

export function fakeEngine(methods: Partial<EngineApi>): FakeEngine {
  const listeners = new Set<(e: EngineEvent) => void>();
  const calls: { method: string; params: unknown[] }[] = [];
  const target = {
    on(cb: (e: EngineEvent) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit(e: EngineEvent): void {
      for (const cb of [...listeners]) cb(e);
    },
    calls,
    get listenerCount(): number {
      return listeners.size;
    },
  };
  // Records every protocol call; a method the test did not supply fails like a missing feature.
  const proxy = new Proxy(target, {
    get(t, key, receiver): unknown {
      if (!isEngineMethod(key)) return Reflect.get(t, key, receiver) as unknown;
      const fn = (methods as Record<string, ((...a: unknown[]) => unknown) | undefined>)[key];
      return (...params: unknown[]): unknown => {
        calls.push({ method: key, params });
        if (fn === undefined)
          throw new EngineError('INTERNAL', `The fake engine has no ${key}.`, 'Supply it in the test.');
        return fn(...params);
      };
    },
  });
  return proxy as unknown as FakeEngine;
}

/** A promise with its settle functions exposed, for controlling when a fake call answers. */
export function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every queued message, microtask and timer of the current turn run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
