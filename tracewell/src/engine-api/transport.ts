/**
 * Transports: the same request/response/event messages over a MessagePort, a Web Worker or a
 * direct in-process call, so the UI cannot tell which engine or boundary it is talking to.
 */
import { EngineError } from '@tw/model';
import {
  closedError,
  execute,
  isRpcEvent,
  isRpcResponse,
  Listeners,
  reportAsync,
  transferables,
  unsendableCallError,
  unsendableResultError,
  workerError,
  type CallOutcome,
} from './messages';
import type { EngineApi, EngineEvent, EngineImpl, MessagePortLike, RpcRequest, Transport } from './protocol';

interface Pending {
  method: keyof EngineApi;
  resolve(value: unknown): void;
  reject(error: EngineError): void;
}

/** The client end of the RPC over one port; workerTransport adds worker-specific failure handling. */
class PortConnection implements Transport {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Listeners();

  constructor(private readonly port: MessagePortLike) {
    port.addEventListener('message', this.onMessage);
    port.start?.();
  }

  call(method: keyof EngineApi, params: unknown[]): Promise<unknown> {
    if (this.closed) return Promise.reject(closedError(method));
    const id = this.nextId++;
    const request: RpcRequest = { kind: 'call', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try {
        this.port.postMessage(request);
      } catch (e) {
        this.pending.delete(id);
        reject(unsendableCallError(method, e));
      }
    });
  }

  onEvent(cb: (e: EngineEvent) => void): () => void {
    return this.listeners.add(cb);
  }

  /** Rejects every call still waiting for an answer, keeping the connection open for new calls. */
  failPending(error: EngineError): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) p.reject(error);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.port.removeEventListener('message', this.onMessage);
    this.listeners.clear();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) p.reject(closedError(p.method));
  }

  private readonly onMessage = (ev: MessageEvent): void => {
    const msg: unknown = ev.data;
    if (isRpcEvent(msg)) {
      this.listeners.emit(msg.event);
      return;
    }
    if (!isRpcResponse(msg)) return;
    const p = this.pending.get(msg.id);
    if (p === undefined) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(EngineError.from(msg.error));
  };
}

/** Talks to an engine bound with serve() at the other end of a MessagePort. */
export function portTransport(port: MessagePortLike): Transport {
  return new PortConnection(port);
}

/**
 * Talks to an engine running in a Web Worker. The transport owns the worker: close() terminates it.
 * An error event before the worker's first message means its script failed to load or start, and
 * no answer will come, so calls waiting at that moment are rejected rather than left hanging.
 */
export function workerTransport(worker: Worker): Transport {
  const connection = new PortConnection(worker);
  // After the first message, an error is an uncaught exception in a running worker (serve()
  // reports unsendable events that way): calls in flight are still answered, and rejecting them
  // would report as failed a change the engine went on to make. The browser reports the error
  // itself, since nothing here cancels it.
  let started = false;
  const onMessage = (): void => {
    started = true;
  };
  const onError = (ev: ErrorEvent): void => {
    if (!started) connection.failPending(workerError(typeof ev.message === 'string' ? ev.message : ''));
  };
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onError);
  return {
    call: (method, params) => connection.call(method, params),
    onEvent: (cb) => connection.onEvent(cb),
    close: () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      connection.close();
      worker.terminate();
    },
  };
}

/**
 * Calls an implementation in the same thread (Node tests, the conformance suite). Parameters,
 * results, errors and events go through structuredClone, transferring byte arrays as a worker
 * would, so code that passes here behaves the same across a real worker boundary.
 */
export function inProcessTransport(impl: EngineImpl): Transport {
  const listeners = new Listeners();
  const pending = new Set<Pending>();
  let closed = false;
  const offImpl = impl.on((event) => {
    let copy: EngineEvent;
    try {
      copy = structuredClone(event);
    } catch (e) {
      // As in serve(): an event that cannot be copied is an engine bug, reported without breaking the engine's emit.
      reportAsync(e);
      return;
    }
    // Asynchronous like a posted message, so events never arrive inside the call that caused them.
    queueMicrotask(() => {
      if (!closed) listeners.emit(copy);
    });
  });

  const call = (method: keyof EngineApi, params: unknown[]): Promise<unknown> => {
    if (closed) return Promise.reject(closedError(method));
    return new Promise((resolve, reject) => {
      const entry: Pending = { method, resolve, reject };
      pending.add(entry);
      void invoke(impl, method, params).then((outcome) => {
        if (!pending.delete(entry)) return;
        if (outcome.ok) resolve(outcome.value);
        else reject(EngineError.from(outcome.error));
      });
    });
  };

  return {
    call,
    onEvent: (cb) => listeners.add(cb),
    close: () => {
      if (closed) return;
      closed = true;
      offImpl();
      listeners.clear();
      const waiting = [...pending];
      pending.clear();
      for (const p of waiting) p.reject(closedError(p.method));
    },
  };
}

/** One call across the simulated boundary, copying as postMessage would; never rejects. */
async function invoke(impl: EngineImpl, method: keyof EngineApi, params: unknown[]): Promise<CallOutcome> {
  let args: unknown[];
  try {
    args = structuredClone(params);
  } catch (e) {
    return { ok: false, error: unsendableCallError(method, e).toData() };
  }
  const outcome = await execute(impl, method, args);
  try {
    return outcome.ok
      ? { ok: true, value: structuredClone(outcome.value, { transfer: transferables(outcome.value) }) }
      : { ok: false, error: structuredClone(outcome.error) };
  } catch (e) {
    return { ok: false, error: unsendableResultError(method, e).toData() };
  }
}
