import { describe, expect, it } from 'vitest';
import type { RowWindow } from '@tw/model';
import { RowPageCache } from './row-cache';

function fakeFetch(total: number) {
  const calls: [number, number][] = [];
  const fetch = async (offset: number, limit: number): Promise<RowWindow> => {
    calls.push([offset, limit]);
    const n = Math.max(0, Math.min(limit, total - offset));
    return {
      datasetId: 'd1',
      stage: 'working',
      offset,
      totalRows: total,
      columns: [],
      rows: Array.from({ length: n }, (_, i) => ({ rowId: offset + i, locator: '', cells: [], edited: [], issue: [] })),
    };
  };
  return { calls, fetch };
}

describe('RowPageCache', () => {
  it('fetches aligned pages and slices the window asked for', async () => {
    const { calls, fetch } = fakeFetch(1000);
    const cache = new RowPageCache(fetch, { pageSize: 200 });
    const w = await cache.get(150, 100);
    expect(calls).toEqual([
      [0, 200],
      [200, 200],
    ]);
    expect(w.offset).toBe(150);
    expect(w.rows.map((r) => r.rowId)).toEqual(Array.from({ length: 100 }, (_, i) => 150 + i));
    expect(w.totalRows).toBe(1000);
  });

  it('serves repeated windows from the cache', async () => {
    const { calls, fetch } = fakeFetch(1000);
    const cache = new RowPageCache(fetch);
    await cache.get(0, 50);
    await cache.get(10, 50);
    expect(calls).toHaveLength(1);
  });

  it('evicts the least recently used page beyond maxPages', async () => {
    const { calls, fetch } = fakeFetch(10_000);
    const cache = new RowPageCache(fetch, { pageSize: 100, maxPages: 3 });
    await cache.get(0, 1); // page 0
    await cache.get(100, 1); // page 1
    await cache.get(200, 1); // page 2
    await cache.get(0, 1); // page 0 used again
    await cache.get(300, 1); // page 3 evicts page 1
    expect(cache.size).toBe(3);
    await cache.get(0, 1);
    expect(calls.filter(([o]) => o === 0)).toHaveLength(1);
    await cache.get(100, 1);
    expect(calls.filter(([o]) => o === 100)).toHaveLength(2);
  });

  it('clears everything on invalidate', async () => {
    const { calls, fetch } = fakeFetch(1000);
    const cache = new RowPageCache(fetch);
    await cache.get(0, 10);
    cache.invalidate();
    expect(cache.size).toBe(0);
    await cache.get(0, 10);
    expect(calls).toHaveLength(2);
  });

  it('shares one fetch between concurrent requests for the same page', async () => {
    const { calls, fetch } = fakeFetch(1000);
    const cache = new RowPageCache(fetch);
    const [a, b] = await Promise.all([cache.get(0, 10), cache.get(5, 10)]);
    expect(calls).toHaveLength(1);
    expect(a.rows[0]?.rowId).toBe(0);
    expect(b.rows[0]?.rowId).toBe(5);
  });

  it('does not keep a failed page', async () => {
    let fail = true;
    const { fetch } = fakeFetch(100);
    const cache = new RowPageCache(async (o, l) => {
      if (fail) throw new Error('engine busy');
      return fetch(o, l);
    });
    await expect(cache.get(0, 10)).rejects.toThrow('engine busy');
    fail = false;
    expect((await cache.get(0, 10)).rows).toHaveLength(10);
  });
});
