/**
 * The test harness's end of the host bridge (SAD decision D-14): the native engine runs as a
 * process, one per page load, and its pipe reaches the page through Playwright bindings, as it
 * will through the desktop shell's own bridge. Nothing goes over the network, so the production
 * build runs unchanged, CSP included.
 *
 * A page load ends the engine the previous one had, the way closing the app ends it: killed, so
 * its recovery journal stays behind for the next session to offer, as after a crash.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { EngineHost } from '@tw/engine-api';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NATIVE_BINARY = join(ROOT, 'crates', 'tracewell-engine', 'target', 'release', 'tracewell-engine');
export const nativeBuilt = existsSync(NATIVE_BINARY);

declare global {
  interface Window {
    __tracewellHost?: EngineHost;
    __twBridgeOpen?: () => Promise<void>;
    __twBridgeWrite?: (base64: string) => Promise<void>;
    __twBridgeRead?: () => Promise<string | null>;
  }
}

/** One engine process and what it has written that the page has not read yet. */
class Session {
  private readonly chunks: Buffer[] = [];
  private waiting: ((data: string | null) => void) | null = null;
  private ended = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.waiting === null) this.chunks.push(chunk);
      else this.deliver(chunk.toString('base64'));
    });
    child.stdout.on('end', () => this.finish());
    child.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGKILL') process.stderr.write(`[native] the engine stopped (${code ?? signal})\n`);
      this.finish();
    });
    child.stderr.on('data', (d: Buffer) => process.stderr.write(`[native] ${d.toString()}`));
    // A write that races the end of the engine fails with EPIPE, and the pipe reports it as an
    // error event too; unheard, that event would end the test worker. The write's own promise
    // carries the failure, and the page learns of the end from read().
    child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (!this.ended || e.code !== 'EPIPE')
        process.stderr.write(`[native] the pipe to the engine failed: ${e.message}\n`);
    });
  }

  write(base64: string): Promise<void> {
    if (this.ended) return Promise.reject(new Error('The engine has stopped.'));
    return new Promise((resolve, reject) =>
      this.child.stdin.write(Buffer.from(base64, 'base64'), (e) => (e ? reject(e) : resolve())),
    );
  }

  /** Everything written since the last read, waiting for the engine when nothing is; null once it has stopped. */
  read(): Promise<string | null> {
    if (this.chunks.length > 0) return Promise.resolve(Buffer.concat(this.chunks.splice(0)).toString('base64'));
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /** Ends the engine as a closed app ends it: no shutdown, so its journal stays for recovery. */
  kill(): void {
    this.child.kill('SIGKILL');
    this.finish();
  }

  private deliver(data: string | null): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.(data);
  }

  private finish(): void {
    this.ended = true;
    if (this.chunks.length === 0) this.deliver(null);
  }
}

/** Runs in the page before its own scripts: the EngineHost the app looks for, over the bindings. */
function installHost(): void {
  const toBase64 = (bytes: Uint8Array): string => {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const fromBase64 = (base64: string): Uint8Array => {
    const text = atob(base64);
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  };
  const binding = <K extends '__twBridgeOpen' | '__twBridgeWrite' | '__twBridgeRead'>(name: K) => {
    const f = window[name];
    if (f === undefined) throw new Error(`The test harness did not expose ${name}.`);
    return f as NonNullable<Window[K]>;
  };
  window.__tracewellHost = {
    open: () => binding('__twBridgeOpen')(),
    write: (bytes) => binding('__twBridgeWrite')(toBase64(bytes)),
    read: async () => {
      const data = await binding('__twBridgeRead')();
      return data === null ? null : fromBase64(data);
    },
  };
}

export interface NativeHost {
  /** Ends the engine of the last page load. */
  stop(): void;
}

/**
 * Gives `page` the native engine. Its working folder, recovery journals and mapping templates
 * live in `folder`, so they outlive each engine process, as the desktop edition's do.
 */
export async function attachNativeHost(page: Page, folder: string): Promise<NativeHost> {
  mkdirSync(folder, { recursive: true });
  let session: Session | null = null;
  await page.exposeBinding('__twBridgeOpen', () => {
    session?.kill();
    const child = spawn(NATIVE_BINARY, [
      'serve',
      '--workdir',
      join(folder, 'work'),
      '--templates',
      join(folder, 'mapping-templates.json'),
      '--recovery',
      join(folder, 'recovery'),
    ]);
    session = new Session(child);
  });
  await page.exposeBinding('__twBridgeWrite', (_source, base64: string) => {
    if (session === null) throw new Error('The page wrote to the engine before opening it.');
    return session.write(base64);
  });
  await page.exposeBinding('__twBridgeRead', () => session?.read() ?? Promise.resolve(null));
  await page.addInitScript(installHost);
  return { stop: () => session?.kill() };
}
