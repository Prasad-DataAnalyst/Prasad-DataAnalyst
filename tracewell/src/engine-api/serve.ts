/** The engine end of the RPC: binds an implementation to a port, such as the worker's global scope. */
import {
  execute,
  isAnswerableCall,
  isRpcRequest,
  reportAsync,
  transferables,
  unknownMethodError,
  unsendableResultError,
} from './messages';
import { framedPort, type ByteChannel } from './framing';
import type { EngineApi, EngineImpl, MessagePortLike, RpcEvent, RpcRequest, RpcResponse } from './protocol';

/**
 * Answers calls arriving on `port` with `impl` and forwards its events, in order. Byte arrays in a
 * result are transferred, not copied, so the implementation gives up any Uint8Array it returns.
 * The returned function stops accepting calls and forwarding events; calls already running are
 * still answered, so no caller is left waiting.
 */
export function serve(impl: EngineImpl, port: MessagePortLike): () => void {
  const offEvents = impl.on((event) => {
    const msg: RpcEvent = { kind: 'event', event };
    try {
      port.postMessage(msg);
    } catch (e) {
      // An event that cannot be cloned is an engine bug: report it without breaking the engine's emit.
      reportAsync(e);
    }
  });
  const onMessage = (ev: MessageEvent): void => {
    const msg: unknown = ev.data;
    if (isRpcRequest(msg)) void answer(impl, port, msg);
    else if (isAnswerableCall(msg))
      reply(port, { kind: 'result', id: msg.id, ok: false, error: unknownMethodError(msg.method).toData() });
  };
  port.addEventListener('message', onMessage);
  port.start?.();
  return () => {
    offEvents();
    port.removeEventListener('message', onMessage);
  };
}

async function answer(impl: EngineImpl, port: MessagePortLike, req: RpcRequest): Promise<void> {
  const outcome = await execute(impl, req.method, req.params);
  if (outcome.ok) sendValue(port, req.id, req.method, outcome.value);
  else reply(port, { kind: 'result', id: req.id, ok: false, error: outcome.error });
}

function sendValue(port: MessagePortLike, id: number, method: keyof EngineApi, value: unknown): void {
  const response: RpcResponse = { kind: 'result', id, ok: true, value };
  try {
    port.postMessage(response, transferables(value));
  } catch (e) {
    reply(port, { kind: 'result', id, ok: false, error: unsendableResultError(method, e).toData() });
  }
}

function reply(port: MessagePortLike, response: RpcResponse): void {
  try {
    port.postMessage(response);
  } catch (e) {
    reportAsync(e);
  }
}

/** Serves an implementation over a byte channel (JSON lines plus binary frames), as an engine process does. */
export function serveStdio(impl: EngineImpl, ch: ByteChannel): () => void {
  return serve(impl, framedPort(ch));
}
