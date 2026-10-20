/** Internal stream helpers shared by hashing and the byte sources. */
import { throwIfAborted } from './errors';

/**
 * Reads a stream to its end, calling `visit` for each chunk. Aborting `signal` cancels the stream
 * (even while a read is pending) and throws EngineError('CANCELLED'). If `visit` throws, the
 * stream is cancelled so its source can release files or memory, and the error is rethrown.
 */
export async function forEachChunk(
  stream: ReadableStream<Uint8Array>,
  visit: (chunk: Uint8Array) => void,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const reader = stream.getReader();
  const onAbort = (): void => {
    reader.cancel().catch(ignore);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) return;
      visit(value);
    }
  } catch (e) {
    await reader.cancel(e).catch(ignore);
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** Cancelling an already errored or closed stream rejects; there is nothing left to release. */
function ignore(): void {}

/** A pull-based stream over `bytes` in chunks that are copies, so a consumer may transfer them. */
export function chunkedStream(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, bytes.byteLength);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    },
    { highWaterMark: 0 },
  );
}
