/**
 * Feature properties as table rows. Columns are the union of property keys in first-seen order, so
 * the keys known at any point are a prefix of the final list: a row holds one field per key seen
 * so far, and a row shorter than a later one simply lacks the keys that appeared after it.
 */
import type { Geometry, RawField, RawRow } from '@tw/model';
import type { ParsedFeature } from './parser';
import { isGeometryLike, isRecord } from './json';

export class PropertyColumns {
  private readonly index = new Map<string, number>();
  private readonly keyList: string[] = [];
  private readonly nestedKeys = new Set<string>();
  private readonly typeList: string[] = [];
  private readonly typeSet = new Set<string>();
  private missingGeometry = 0;

  /** Property keys in first-seen order. */
  get keys(): readonly string[] {
    return this.keyList;
  }

  /** Keys that held an object or an array in at least one feature, in first-seen order. */
  get nested(): string[] {
    return this.keyList.filter((k) => this.nestedKeys.has(k));
  }

  /** Geometry types in first-seen order. */
  get geometryTypes(): readonly string[] {
    return this.typeList;
  }

  /** Features whose geometry is null, missing or not an object. */
  get featuresWithoutGeometry(): number {
    return this.missingGeometry;
  }

  toRow(feature: ParsedFeature): RawRow {
    const fields: RawField[] = [];
    const properties = isRecord(feature.properties) ? feature.properties : {};
    for (const [key, value] of Object.entries(properties)) {
      fields[this.columnOf(key)] = this.fieldOf(key, value);
    }
    // Holes left by keys this feature lacks, and the tail up to the keys known so far, are nulls.
    const row = Array.from({ length: this.keyList.length }, (_, i) => fields[i] ?? null);
    return { srcLoc: feature.index, fields: row, geometry: this.geometryOf(feature.geometry) };
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

  private geometryOf(value: unknown): Geometry | null {
    if (!isGeometryLike(value)) {
      this.missingGeometry++;
      return null;
    }
    if (!this.typeSet.has(value.type)) {
      this.typeSet.add(value.type);
      this.typeList.push(value.type);
    }
    // Kept as written: whether the geometry is valid is the rules module's job (TW-GEO-001).
    settleNumbers(value);
    return value as unknown as Geometry;
  }
}

/**
 * Makes a parsed geometry hold exactly what its JSON text holds. A number beyond the double range
 * parses as an infinity, which JSON cannot write and no digest can encode, so it becomes null (the
 * validity check then reports the position); -0 becomes 0. What is shown, exported, saved and
 * hashed is then the value itself. The geometry is the parser's own fresh value, changed in place
 * and without recursion, so a deeply nested one cannot exhaust the stack.
 */
function settleNumbers(root: object): void {
  const pending: object[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const holder = node as Record<string, unknown>;
    for (const key of Object.keys(holder)) {
      const v = holder[key];
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) holder[key] = null;
        else if (v === 0) holder[key] = 0;
      } else if (typeof v === 'object' && v !== null) {
        pending.push(v);
      }
    }
  }
}
