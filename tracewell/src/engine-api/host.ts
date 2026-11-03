/**
 * The host bridge (SAD decision D-14): the page asks its container for an engine instead of
 * starting the Web Worker. The container is the test harness now and the desktop shell later; it
 * runs the native engine as a process and carries that process's pipe, so the page needs no
 * network code and the production CSP stays as it is. The bytes on the pipe are the same JSON
 * lines and binary frames the native engine speaks over stdio (framing.ts).
 */
import { EngineError, type FileInput } from '@tw/model';
import type { Transport } from './protocol';
import { stdioTransport } from './transport';

/** What the page's container provides: one engine session per page load. */
export interface EngineHost {
  /** Starts this page's engine, ending the one an earlier page of this window had. */
  open(): Promise<void>;
  /** Sends bytes to the engine. */
  write(bytes: Uint8Array): Promise<void>;
  /** The next bytes the engine wrote, or null once it has stopped. */
  read(): Promise<Uint8Array | null>;
}

function isBlobInput(v: unknown): v is Extract<FileInput, { kind: 'blob' }> {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { kind?: unknown }).kind === 'blob' &&
    typeof Blob !== 'undefined' &&
    (v as { blob?: unknown }).blob instanceof Blob
  );
}

/**
 * A file the user chose in the page reaches the engine process as its bytes, since a Blob only
 * exists inside the page. Files are top-level parameters of every call that takes one.
 */
async function sendable(params: unknown[]): Promise<unknown[]> {
  return Promise.all(
    params.map(async (p) => {
      if (!isBlobInput(p)) return p;
      try {
        return { kind: 'bytes', name: p.name, bytes: new Uint8Array(await p.blob.arrayBuffer()) };
      } catch (e) {
        throw new EngineError(
          'INVALID_INPUT',
          `The file ${p.name} could not be read: ${e instanceof Error ? e.message : String(e)}.`,
          'Choose the file again; if it is on a removable or network drive, copy it to this computer first.',
        );
      }
    }),
  );
}

/** Talks to the engine the page's container runs, over the container's pipe to it. */
export function hostTransport(host: EngineHost): Transport {
  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const bytes = await host.read();
      if (bytes === null) controller.close();
      else controller.enqueue(bytes);
    },
  });
  const inner = stdioTransport({ readable, write: (bytes) => host.write(bytes) });
  return {
    call: async (method, params) => inner.call(method, await sendable(params)),
    onEvent: (cb) => inner.onEvent(cb),
    close: () => inner.close(),
  };
}
