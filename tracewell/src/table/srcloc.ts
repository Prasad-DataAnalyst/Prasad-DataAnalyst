/** Per-row source locators in Uint32Array chunks (CSV line, sheet row or feature index). */
import { invalidArgument } from './errors';

const CHUNK_SHIFT = 16;
const CHUNK_SIZE = 1 << CHUNK_SHIFT;
const CHUNK_MASK = CHUNK_SIZE - 1;

export class SrcLocs {
  private readonly chunks: Uint32Array[] = [];
  private count = 0;

  get length(): number {
    return this.count;
  }

  push(loc: number): void {
    if (!Number.isInteger(loc) || loc < 0 || loc > 0xffffffff) {
      throw invalidArgument(`A source locator must be a whole number from 0 to 4294967295, not ${String(loc)}.`);
    }
    const chunk = this.count >>> CHUNK_SHIFT;
    if (chunk === this.chunks.length) this.chunks.push(new Uint32Array(CHUNK_SIZE));
    (this.chunks[chunk] as Uint32Array)[this.count & CHUNK_MASK] = loc;
    this.count++;
  }

  /** The caller has checked that `r` is a row of the dataset. */
  get(r: number): number {
    return this.chunks[r >>> CHUNK_SHIFT]?.[r & CHUNK_MASK] ?? 0;
  }

  bytes(): number {
    return this.chunks.length * CHUNK_SIZE * 4;
  }
}
