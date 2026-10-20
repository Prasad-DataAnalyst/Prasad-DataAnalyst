/**
 * Internal helpers shared by the transports and serve(): recognising RPC messages, finding the
 * buffers a result can hand over without copying, and the errors the RPC layer itself raises.
 */
import { EngineError, type EngineErrorData } from '@tw/model';
import {
  isEngineMethod,
  type EngineApi,
  type EngineImpl,
  type RpcEvent,
  type RpcRequest,
  type RpcResponse,
} from './protocol';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function isRpcRequest(v: unknown): v is RpcRequest {
  return (
    isRecord(v) &&
    v['kind'] === 'call' &&
    Number.isSafeInteger(v['id']) &&
    isEngineMethod(v['method']) &&
    Array.isArray(v['params'])
  );
}

/** A call whose method or parameters are wrong but whose id lets serve() still answer it. */
export function isAnswerableCall(v: unknown): v is { kind: 'call'; id: number; method?: unknown } {
  return isRecord(v) && v['kind'] === 'call' && Number.isSafeInteger(v['id']);
}

export function isRpcResponse(v: unknown): v is RpcResponse {
  return isRecord(v) && v['kind'] === 'result' && Number.isSafeInteger(v['id']) && typeof v['ok'] === 'boolean';
}

export function isRpcEvent(v: unknown): v is RpcEvent {
  return isRecord(v) && v['kind'] === 'event' && isRecord(v['event']) && typeof v['event']['type'] === 'string';
}

/**
 * The buffers of every Uint8Array in `value` that can be transferred rather than copied. A view
 * onto part of a larger buffer is left to be copied, because transferring it would detach the
 * rest of that buffer, which its owner may still be using.
 */
export function transferables(value: unknown): ArrayBuffer[] {
  const found = new Set<ArrayBuffer>();
  const seen = new Set<object>();
  const visit = (v: unknown): void => {
    if (!isRecord(v) || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      if (v instanceof Uint8Array && ownsWholeBuffer(v)) found.add(v.buffer);
      return;
    }
    for (const child of Array.isArray(v) ? v : Object.values(v)) visit(child);
  };
  visit(value);
  return [...found];
}

function ownsWholeBuffer(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
  return (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.byteLength > 0
  );
}

export function closedError(method: keyof EngineApi): EngineError {
  return new EngineError(
    'PROTOCOL_MISMATCH',
    `The connection to the engine was closed before the call ${method} finished.`,
    'Reload Tracewell to restart the engine, then repeat the operation.',
  );
}

export function unknownMethodError(method: unknown): EngineError {
  const name = typeof method === 'string' ? method : String(typeof method);
  return new EngineError(
    'PROTOCOL_MISMATCH',
    `The engine does not support the call '${name}'.`,
    'Use a Tracewell user interface built for the same engine protocol version as the engine.',
  );
}

export function unsendableCallError(method: keyof EngineApi, e: unknown): EngineError {
  return new EngineError(
    'INVALID_INPUT',
    `The call ${method} could not be sent to the engine: ${describe(e)}`,
    'Pass only plain data, files and byte arrays to the engine; functions and class instances cannot be sent.',
  );
}

export function unsendableResultError(method: keyof EngineApi, e: unknown): EngineError {
  return new EngineError(
    'INTERNAL',
    `The engine could not send the result of ${method}: ${describe(e)}`,
    'Try the operation again. If it fails again, save the project and report the steps that led to this error.',
  );
}

export function workerError(message: string): EngineError {
  const text = message === '' ? 'The engine worker reported an error.' : `The engine worker reported an error: ${message}`;
  return new EngineError('INTERNAL', text, 'Reload Tracewell to restart the engine, then repeat the operation.');
}

function describe(e: unknown): string {
  if (isRecord(e) && typeof e['message'] === 'string' && e['message'] !== '') return e['message'];
  return typeof e === 'string' && e !== '' ? e : 'unknown reason';
}

export type CallOutcome = { ok: true; value: unknown } | { ok: false; error: EngineErrorData };

/**
 * Runs one call on an implementation and never rejects: whatever the implementation throws comes
 * back as EngineErrorData, the only error form that crosses the protocol.
 */
export async function execute(impl: EngineImpl, method: keyof EngineApi, params: unknown[]): Promise<CallOutcome> {
  const fn: unknown = impl[method];
  if (typeof fn !== 'function') return { ok: false, error: unknownMethodError(method).toData() };
  try {
    const value: unknown = await (fn as (...a: unknown[]) => unknown).apply(impl, params);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: EngineError.from(e).toData() };
  }
}

/**
 * Surfaces an error thrown by a listener without stopping the caller's loop, the way EventTarget
 * reports a throwing listener: later listeners still run and the error is still seen.
 */
export function reportAsync(e: unknown): void {
  queueMicrotask(() => {
    throw e;
  });
}
