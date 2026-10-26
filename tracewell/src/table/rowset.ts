/**
 * A fixed-capacity set of row IDs held as a bitmap. Filters, exclusions, accepted issue rows and
 * views are all row sets, so set algebra must be cheap: every operation works a 32-bit word at a time.
 */
import type { RowId, RowRanges } from '@tw/model';
import { invalidArgument } from './errors';

/** The transport cap on ranges (RowRanges in the model): the count stays exact beyond it. */
const DEFAULT_MAX_RANGES = 1000;

function popcount(word: number): number {
  let w = word - ((word >>> 1) & 0x55555555);
  w = (w & 0x33333333) + ((w >>> 2) & 0x33333333);
  return (((w + (w >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function wordCount(capacity: number): number {
  return Math.ceil(capacity / 32);
}

export class RowSet {
  readonly capacity: number;
  private readonly words: Uint32Array;
  private count = 0;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 0xffffffff) {
      throw invalidArgument(`A row set capacity must be a whole number from 0 to 4294967295, not ${String(capacity)}.`);
    }
    this.capacity = capacity;
    this.words = new Uint32Array(wordCount(capacity));
  }

  static of(capacity: number, ids: Iterable<RowId>): RowSet {
    const set = new RowSet(capacity);
    for (const id of ids) set.add(id);
    return set;
  }

  static all(capacity: number): RowSet {
    const set = new RowSet(capacity);
    set.words.fill(0xffffffff);
    set.clearTail();
    set.count = capacity;
    return set;
  }

  /** Inclusive ranges, as RowRanges carries them; overlapping ranges are allowed. */
  static fromRanges(capacity: number, ranges: [RowId, RowId][]): RowSet {
    const set = new RowSet(capacity);
    for (const [lo, hi] of ranges) {
      set.checkRow(lo);
      set.checkRow(hi);
      if (hi < lo) throw invalidArgument(`The row range [${lo}, ${hi}] ends before it starts.`);
      set.fillRange(lo, hi);
    }
    set.recount();
    return set;
  }

  get size(): number {
    return this.count;
  }

  add(r: RowId): void {
    this.checkRow(r);
    const i = r >>> 5;
    const bit = 1 << (r & 31);
    const word = this.words[i] ?? 0;
    if ((word & bit) !== 0) return;
    this.words[i] = word | bit;
    this.count++;
  }

  delete(r: RowId): void {
    if (!this.inRange(r)) return;
    const i = r >>> 5;
    const bit = 1 << (r & 31);
    const word = this.words[i] ?? 0;
    if ((word & bit) === 0) return;
    this.words[i] = word & ~bit;
    this.count--;
  }

  has(r: RowId): boolean {
    if (!this.inRange(r)) return false;
    return ((this.words[r >>> 5] ?? 0) & (1 << (r & 31))) !== 0;
  }

  union(o: RowSet): RowSet {
    return this.combine(o, (a, b) => a | b);
  }

  intersect(o: RowSet): RowSet {
    return this.combine(o, (a, b) => a & b);
  }

  minus(o: RowSet): RowSet {
    return this.combine(o, (a, b) => a & ~b);
  }

  complement(): RowSet {
    const out = new RowSet(this.capacity);
    for (let i = 0; i < this.words.length; i++) out.words[i] = ~(this.words[i] ?? 0);
    out.clearTail();
    out.count = this.capacity - this.count;
    return out;
  }

  equals(o: RowSet): boolean {
    if (o.capacity !== this.capacity || o.count !== this.count) return false;
    for (let i = 0; i < this.words.length; i++) if (this.words[i] !== o.words[i]) return false;
    return true;
  }

  clone(): RowSet {
    const out = new RowSet(this.capacity);
    out.words.set(this.words);
    out.count = this.count;
    return out;
  }

  /** Row IDs in ascending order. */
  *[Symbol.iterator](): IterableIterator<RowId> {
    const { words } = this;
    for (let i = 0; i < words.length; i++) {
      let w = words[i] ?? 0;
      while (w !== 0) {
        const lowest = w & -w;
        yield i * 32 + (31 - Math.clz32(lowest));
        w ^= lowest;
      }
    }
  }

  toArray(): RowId[] {
    return Array.from(this);
  }

  /** Inclusive runs in ascending order, at most `maxRanges` of them; `count` is always the exact size. */
  toRanges(maxRanges: number = DEFAULT_MAX_RANGES): RowRanges {
    if (!Number.isSafeInteger(maxRanges) || maxRanges < 0) {
      throw invalidArgument(`maxRanges must be a whole number of at least 0, not ${String(maxRanges)}.`);
    }
    const ranges: [RowId, RowId][] = [];
    let start = -1;
    let prev = -2;
    for (const r of this) {
      if (r === prev + 1) {
        prev = r;
        continue;
      }
      if (start >= 0 && !pushRange(ranges, start, prev, maxRanges)) return { count: this.count, ranges };
      start = r;
      prev = r;
    }
    if (start >= 0) pushRange(ranges, start, prev, maxRanges);
    return { count: this.count, ranges };
  }

  private combine(o: RowSet, op: (a: number, b: number) => number): RowSet {
    if (o.capacity !== this.capacity) {
      throw invalidArgument(
        `Row sets of different capacities (${this.capacity} and ${o.capacity}) cannot be combined.`,
      );
    }
    const out = new RowSet(this.capacity);
    for (let i = 0; i < this.words.length; i++) out.words[i] = op(this.words[i] ?? 0, o.words[i] ?? 0);
    out.recount();
    return out;
  }

  private inRange(r: RowId): boolean {
    return Number.isInteger(r) && r >= 0 && r < this.capacity;
  }

  private checkRow(r: RowId): void {
    if (!this.inRange(r)) {
      throw invalidArgument(`Row ${String(r)} is outside a row set of capacity ${this.capacity}.`, {
        row: Number.isFinite(r) ? r : String(r),
        capacity: this.capacity,
      });
    }
  }

  private fillRange(lo: number, hi: number): void {
    const first = lo >>> 5;
    const last = hi >>> 5;
    for (let i = first; i <= last; i++) {
      const from = i === first ? lo & 31 : 0;
      const to = i === last ? hi & 31 : 31;
      // Bits from..to set; the 32-bit shift wraps, so a full word is special-cased.
      const mask = to - from === 31 ? 0xffffffff : ((1 << (to - from + 1)) - 1) << from;
      this.words[i] = (this.words[i] ?? 0) | mask;
    }
  }

  /** Bits past the capacity in the last word must stay clear, or size and equality would count them. */
  private clearTail(): void {
    const used = this.capacity & 31;
    if (used !== 0 && this.words.length > 0) {
      const last = this.words.length - 1;
      this.words[last] = (this.words[last] ?? 0) & ((1 << used) - 1);
    }
  }

  private recount(): void {
    let n = 0;
    for (const w of this.words) n += popcount(w);
    this.count = n;
  }
}

/** Appends a range unless the cap is reached; returns false once no more ranges fit. */
function pushRange(ranges: [RowId, RowId][], lo: RowId, hi: RowId, max: number): boolean {
  if (ranges.length >= max) return false;
  ranges.push([lo, hi]);
  return true;
}
