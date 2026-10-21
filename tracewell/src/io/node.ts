/**
 * Node-only file access for tests, the conformance suite and fixtures (imported as '@tw/io/node').
 * The browser bundle never imports this file; files there arrive as Blobs (see blobSource).
 */
import { open, readFile, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import { EngineError, type ByteSource } from '@tw/model';
import { clampRange, STREAM_CHUNK_BYTES } from './source';

/**
 * Errors meaning "there is no regular file at this path": it does not exist, a parent in the path
 * is a regular file (ENOTDIR), or the path names a directory (EISDIR).
 */
const NO_FILE_CODES: ReadonlySet<unknown> = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

function isMissingFile(e: unknown): boolean {
  return typeof e === 'object' && e !== null && NO_FILE_CODES.has((e as { code?: unknown }).code);
}

function notFound(path: string): EngineError {
  const message = `The file "${path}" does not exist or is not a regular file.`;
  return new EngineError('NOT_FOUND', message, 'Check the path and try again.', { path });
}

/**
 * A source over a file on disk. The size is read once, now; the file must not change while the
 * source is in use. Every slice and stream opens the file afresh and closes it when done.
 * Throws EngineError('NOT_FOUND') when the path does not exist or is not a regular file.
 */
export async function nodeFileSource(path: string): Promise<ByteSource> {
  const info = await stat(path).catch((e: unknown) => {
    throw isMissingFile(e) ? notFound(path) : e;
  });
  if (!info.isFile()) throw notFound(path);
  const size = info.size;
  return {
    name: basename(path),
    size,
    slice: (start: number, end: number) => readRange(path, ...clampRange(start, end, size)),
    stream: () => fileStream(path),
  };
}

async function readRange(path: string, from: number, to: number): Promise<Uint8Array> {
  const out = new Uint8Array(to - from);
  const handle = await open(path, 'r').catch((e: unknown) => {
    throw isMissingFile(e) ? notFound(path) : e;
  });
  try {
    let filled = 0;
    while (filled < out.length) {
      const { bytesRead } = await handle.read(out, filled, out.length - filled, from + filled);
      if (bytesRead === 0) break; // the file shrank since it was opened
      filled += bytesRead;
    }
    return filled === out.length ? out : out.slice(0, filled);
  } finally {
    await handle.close();
  }
}

/** Chunks are fresh Uint8Arrays, not slices of Node's shared Buffer pool, so they may be transferred. */
function fileStream(path: string): ReadableStream<Uint8Array> {
  let handle: FileHandle | undefined;
  let position = 0;
  const release = async (): Promise<void> => {
    const current = handle;
    handle = undefined;
    await current?.close();
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          handle ??= await open(path, 'r');
          const chunk = new Uint8Array(STREAM_CHUNK_BYTES);
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
          if (bytesRead === 0) {
            await release();
            controller.close();
            return;
          }
          position += bytesRead;
          controller.enqueue(bytesRead === chunk.length ? chunk : chunk.slice(0, bytesRead));
        } catch (e) {
          await release();
          throw isMissingFile(e) ? notFound(path) : e;
        }
      },
      cancel: release,
    },
    { highWaterMark: 0 },
  );
}

/**
 * A Buffer as a plain Uint8Array. A Buffer that does not own its whole ArrayBuffer may be a slice
 * of Node's shared pool, so it is copied rather than viewed.
 */
function plainBytes(buffer: Uint8Array): Uint8Array {
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    return new Uint8Array(buffer.buffer, 0, buffer.byteLength);
  }
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy;
}

/**
 * Whole-file reads and writes. readFile returns a plain Uint8Array rather than a Node Buffer and
 * throws EngineError('NOT_FOUND') when the path does not exist or is not a regular file.
 */
export function nodeFs(): {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
} {
  return {
    async readFile(path: string): Promise<Uint8Array> {
      const buffer = await readFile(path).catch((e: unknown) => {
        throw isMissingFile(e) ? notFound(path) : e;
      });
      return plainBytes(buffer);
    },
    async writeFile(path: string, bytes: Uint8Array): Promise<void> {
      await writeFile(path, bytes);
    },
  };
}
