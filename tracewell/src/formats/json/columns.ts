/**
 * JSON records as table rows. Columns are the union of keys in first-seen order, so the keys known
 * at any point are a prefix of the final list: a row holds one field per key seen so far, and a row
 * shorter than a later one simply lacks the keys that appeared after it.
 */
import type { RawField, RawRow } from '@tw/model';

export class RecordColumns {
  private readonly index = new Map<string, number>();
  private readonly keyList: string[] = [];
  private readonly nestedKeys = new Set<string>();

  /** Keys in first-seen order. */
  get keys(): readonly string[] {
    return this.keyList;
  }

  /** Keys that held an object or an array in at least one record, in first-seen order. */
  get nested(): string[] {
    return this.keyList.filter((k) => this.nestedKeys.has(k));
  }

  toRow(srcLoc: number, record: Record<string, unknown>): RawRow {
    const fields: RawField[] = [];
    for (const [key, value] of Object.entries(record)) {
      fields[this.columnOf(key)] = this.fieldOf(key, value);
    }
    // Holes left by keys this record lacks, and the tail up to the keys known so far, are nulls.
    return { srcLoc, fields: Array.from({ length: this.keyList.length }, (_, i) => fields[i] ?? null) };
  }

  private columnOf(key: string): number {
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.keyList.length;
      this.index.set(key, i);
      this.keyList.push(key);
    }
    return i;
  }

  private fieldOf(key: string, value: unknown): RawField {
    switch (typeof value) {
      case 'string':
      case 'boolean':
        return value;
      case 'number':
        // JSON numbers beyond the double range parse as infinities; their text keeps them visible.
        return Number.isFinite(value) ? value : String(value);
      case 'object':
        if (value === null) return null;
        this.nestedKeys.add(key);
        return JSON.stringify(value);
      default:
        return null;
    }
  }
}
