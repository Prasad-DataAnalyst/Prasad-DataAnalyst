/**
 * The data grid's page cache: rows are fetched in aligned pages of `pageSize` (200) and the most
 * recently used `maxPages` (20) are kept, so scrolling back is instant and memory stays bounded
 * whatever the dataset size. Requests for a page already on its way share one fetch.
 */
import type { RowWindow } from '@tw/model';

export class RowPageCache {
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly pages = new Map<number, Promise<RowWindow>>();
  private generation = 0;

  constructor(
    private readonly fetch: (offset: number, limit: number) => Promise<RowWindow>,
    o: { pageSize?: number; maxPages?: number } = {},
  ) {
    this.pageSize = o.pageSize ?? 200;
    this.maxPages = o.maxPages ?? 20;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1) throw new Error('pageSize must be a positive integer.');
    if (!Number.isInteger(this.maxPages) || this.maxPages < 1) throw new Error('maxPages must be a positive integer.');
  }

  /** Rows [offset, offset + limit), assembled from whole pages. */
  async get(offset: number, limit: number): Promise<RowWindow> {
    const first = Math.floor(offset / this.pageSize);
    const last = Math.max(first, Math.floor((offset + Math.max(limit, 1) - 1) / this.pageSize));
    const windows = await Promise.all(Array.from({ length: last - first + 1 }, (_, i) => this.page(first + i)));
    const head = windows[0] as RowWindow;
    const rows = windows.flatMap((w) => w.rows);
    const skip = offset - first * this.pageSize;
    return {
      ...head,
      offset,
      totalRows: (windows.at(-1) as RowWindow).totalRows,
      rows: rows.slice(skip, skip + limit),
    };
  }

  /** Forgets every page, for when the data has changed; fetches still on their way are not kept. */
  invalidate(): void {
    this.generation++;
    this.pages.clear();
  }

  /** The number of pages held, for tests and diagnostics. */
  get size(): number {
    return this.pages.size;
  }

  private page(index: number): Promise<RowWindow> {
    const cached = this.pages.get(index);
    if (cached !== undefined) {
      // Most recently used goes to the end of the map's order.
      this.pages.delete(index);
      this.pages.set(index, cached);
      return cached;
    }
    const generation = this.generation;
    const pending = this.fetch(index * this.pageSize, this.pageSize);
    this.pages.set(index, pending);
    pending.catch(() => {
      // A failed page is not cached, so the next request tries again.
      if (generation === this.generation && this.pages.get(index) === pending) this.pages.delete(index);
    });
    while (this.pages.size > this.maxPages) {
      const oldest = this.pages.keys().next().value as number;
      this.pages.delete(oldest);
    }
    return pending;
  }
}
