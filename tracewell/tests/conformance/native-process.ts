/**
 * The native engine as a child process spoken to over stdio, for the parity suite and the
 * benchmark. The binary comes from `npm run build:native`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { EngineClient, stdioTransport } from '@tw/engine-api';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NATIVE_BINARY = join(ROOT, 'crates', 'tracewell-engine', 'target', 'release', 'tracewell-engine');
export const nativeBuilt = existsSync(NATIVE_BINARY);

export interface NativeProcess {
  client: EngineClient;
  child: ChildProcessWithoutNullStreams;
  workdir: string;
  /** Whether stop() deletes the work folder (true when the process made it). */
  ownsWorkdir: boolean;
}

/** Starts the engine with `args` after `serve --workdir`; a temporary work folder unless one is given. */
export function startNative(args: string[], workdir?: string): NativeProcess {
  const dir = workdir ?? mkdtempSync(join(tmpdir(), 'tw-native-'));
  const child = spawn(NATIVE_BINARY, ['serve', '--workdir', dir, ...args]);
  child.stderr.on('data', (d: Buffer) => process.stderr.write(`[native] ${d.toString()}`));
  const client = new EngineClient(
    stdioTransport({
      readable: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      write: (bytes) =>
        new Promise<void>((resolve, reject) => child.stdin.write(bytes, (e) => (e ? reject(e) : resolve()))),
    }),
  );
  return { client, child, workdir: dir, ownsWorkdir: workdir === undefined };
}

export function stopNative(n: NativeProcess): void {
  n.client.close();
  n.child.stdin.end();
  n.child.kill();
  if (n.ownsWorkdir) rmSync(n.workdir, { recursive: true, force: true });
}

/** The process's peak resident memory in bytes (Linux VmHWM), or null where it cannot be read. */
export function peakResidentBytes(pid: number | undefined): number | null {
  if (pid === undefined) return null;
  try {
    const line = readFileSync(`/proc/${pid}/status`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('VmHWM:'));
    const kb = Number(line?.split(/\s+/)[1]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}
