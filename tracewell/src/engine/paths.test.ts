/** Files given by path (desktop and Node): previews read only what they need, whatever the size. */
import { describe, expect, it } from 'vitest';
import type { ByteSource } from '@tw/model';
import { awaitJob, newEngine, PROFILE } from './__fixtures__/session';

const HEAD = new TextEncoder().encode('well_id,date,oil\r\nW1,2026-01-01,12.5\r\nW2,2026-01-01,13\r\n');
const TEN_GB = 10_037_203_593;

function hugeFile(): {
  open: (path: string) => Promise<ByteSource>;
  readFile: () => Promise<Uint8Array>;
  read: number[];
} {
  const read: number[] = [];
  const source: ByteSource = {
    name: 'well_daily.csv',
    size: TEN_GB,
    slice: async (start, end) => {
      read.push(end - start);
      return HEAD.slice(start, Math.min(end, HEAD.length));
    },
    stream: () => new Blob([HEAD]).stream(),
  };
  return {
    read,
    open: async () => source,
    readFile: async () => {
      throw new Error('a 10 GB file must never be read whole');
    },
  };
}

describe('files given by path', () => {
  it('previews a 10 GB file from its first bytes only', async () => {
    const fs = hugeFile();
    const engine = newEngine({ fs: { ...fs, writeFile: async () => undefined } });
    await engine.newProject({ name: 'Big', profile: PROFILE });
    const preview = await engine.sniff({ kind: 'path', path: '/data/well_daily.csv' });
    expect(preview.columns.map((c) => c.name)).toEqual(['well_id', 'date', 'oil']);
    expect(Math.max(...fs.read)).toBeLessThanOrEqual(1 << 20);
  });

  it('refuses to import a file larger than memory, pointing to the desktop edition', async () => {
    const fs = hugeFile();
    const engine = newEngine({ fs: { ...fs, writeFile: async () => undefined } });
    await engine.newProject({ name: 'Big', profile: PROFILE });
    const job = await engine.importFile({ kind: 'path', path: '/data/well_daily.csv' });
    await expect(awaitJob(engine, job)).rejects.toMatchObject({
      code: 'MEMORY_BUDGET',
      fix: expect.stringContaining('desktop edition'),
    });
  });
});
