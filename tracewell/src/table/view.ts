/**
 * The working view of a dataset: base columns, derived columns from steps, cell edits, excluded
 * rows, a row filter and a column order. Every consumer (grid, rules, export, digests) reads values
 * through a View, so all of them agree on what the data currently is.
 *
 * Value resolution order is overlay, then derived, then base. A derived column whose ID equals a
 * base column's replaces it in place (a step in 'replace' mode).
 */
import type { CellValue, ColumnId, ColumnSchema, RowId, TableSchema } from '@tw/model';
import type { Dataset } from './dataset';
import { invalidArgument, notFound } from './errors';
import type { Overlay } from './overlay';
import { RowSet } from './rowset';

export interface DerivedColumn {
  schema: ColumnSchema;
  /** `get` resolves edits, derived columns listed earlier, and base columns, so steps chain in order. */
  compute(get: (c: ColumnId, r: RowId) => CellValue, r: RowId): CellValue;
}

export interface ViewSpec {
  overlay: Overlay;
  excluded: RowSet;
  derived: DerivedColumn[];
  hidden: ColumnId[];
  rowFilter: RowSet | null;
  columnOrder: ColumnId[] | null;
}

export class View {
  readonly dataset: Dataset;
  readonly schema: TableSchema;
  private readonly spec: ViewSpec;
  private readonly visibleRows: Uint32Array;
  private readonly visibleColumns: ColumnId[];
  /** Every column a caller may read, hidden ones included, with its schema. */
  private readonly schemas = new Map<ColumnId, ColumnSchema>();
  /** For each column with derived definitions, their positions in spec.derived, ascending. */
  private readonly derivedAt = new Map<ColumnId, number[]>();
  private readonly baseIds: ReadonlySet<ColumnId>;

  constructor(ds: Dataset, spec: ViewSpec) {
    this.dataset = ds;
    this.spec = spec;
    this.baseIds = new Set(ds.schema.columns.map((c) => c.id));
    for (const c of ds.schema.columns) this.schemas.set(c.id, c);
    spec.derived.forEach((d, i) => {
      this.schemas.set(d.schema.id, d.schema);
      this.derivedAt.set(d.schema.id, [...(this.derivedAt.get(d.schema.id) ?? []), i]);
    });
    this.visibleRows = visibleRowIds(ds.rowCount, spec);
    this.visibleColumns = this.orderColumns();
    this.schema = {
      ...ds.schema,
      rowCount: this.visibleRows.length,
      columns: this.visibleColumns.map((c) => this.columnSchema(c)),
    };
  }

  get rowCount(): number {
    return this.visibleRows.length;
  }

  /** The row ID at visible position `i` (0-based). */
  rowIdAt(i: number): RowId {
    const r = Number.isInteger(i) ? this.visibleRows[i] : undefined;
    if (r === undefined) {
      throw notFound(`The view has no row at position ${String(i)}; it shows ${this.rowCount} rows.`);
    }
    return r;
  }

  /** The visible position of a row, or -1 when it is excluded, filtered out or does not exist. */
  indexOf(r: RowId): number {
    let lo = 0;
    let hi = this.visibleRows.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const at = this.visibleRows[mid] as number;
      if (at === r) return mid;
      if (at < r) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  *rows(): IterableIterator<RowId> {
    yield* this.visibleRows;
  }

  /** Visible columns in display order. */
  columnIds(): ColumnId[] {
    return [...this.visibleColumns];
  }

  /** The schema of any column of the view, including hidden ones (rules may read them). */
  columnSchema(c: ColumnId): ColumnSchema {
    const schema = this.schemas.get(c);
    if (schema === undefined) throw this.unknownColumn(c);
    return schema;
  }

  value(r: RowId, c: ColumnId): CellValue {
    const edit = this.spec.overlay.get(r, c);
    return edit !== undefined ? edit.value : this.baseValue(r, c);
  }

  /** The value without cell edits: derived if a step defines the column, otherwise the dataset's. */
  baseValue(r: RowId, c: ColumnId): CellValue {
    return this.resolve(c, r, this.spec.derived.length, false);
  }

  /** The source text kept for a failed parse or a null marker; derived columns have none. */
  raw(r: RowId, c: ColumnId): string | undefined {
    if (!this.schemas.has(c)) throw this.unknownColumn(c);
    if (this.derivedAt.has(c) || !this.hasBase(c)) return undefined;
    return this.dataset.column(c).raw(r);
  }

  isEdited(r: RowId, c: ColumnId): boolean {
    return this.spec.overlay.has(r, c);
  }

  /** A page of visible rows; `values[i][j]` is row i's value in column `cols[j]`. */
  window(offset: number, limit: number, cols?: ColumnId[]): { rowIds: RowId[]; values: CellValue[][] } {
    checkWindow(offset, limit);
    const columns = cols ?? this.visibleColumns;
    for (const c of columns) if (!this.schemas.has(c)) throw this.unknownColumn(c);
    const end = Math.min(this.rowCount, offset + limit);
    const rowIds: RowId[] = [];
    const values: CellValue[][] = [];
    for (let i = offset; i < end; i++) {
      const r = this.visibleRows[i] as RowId;
      rowIds.push(r);
      values.push(columns.map((c) => this.value(r, c)));
    }
    return { rowIds, values };
  }

  /**
   * The value of column `c` as seen by derived definitions before position `limit`.
   * `withEdits` is false only for the top-level baseValue lookup of the column itself.
   */
  private resolve(c: ColumnId, r: RowId, limit: number, withEdits: boolean): CellValue {
    if (withEdits) {
      const edit = this.spec.overlay.get(r, c);
      if (edit !== undefined) return edit.value;
    }
    const at = latestBefore(this.derivedAt.get(c), limit);
    if (at >= 0) {
      const derived = this.spec.derived[at] as DerivedColumn;
      return derived.compute((c2, r2) => this.resolve(c2, r2, at, true), r);
    }
    if (!this.hasBase(c)) throw this.unknownColumn(c);
    return this.dataset.column(c).get(r);
  }

  private hasBase(c: ColumnId): boolean {
    return this.baseIds.has(c);
  }

  private orderColumns(): ColumnId[] {
    const hidden = new Set(this.spec.hidden);
    const natural = [...this.schemas.keys()].filter((c) => !hidden.has(c));
    const order = this.spec.columnOrder;
    if (order === null) return natural;
    const seen = new Set<ColumnId>();
    for (const c of order) {
      if (!this.schemas.has(c)) throw this.unknownColumn(c);
      if (seen.has(c)) throw invalidArgument(`Column ${c} appears twice in the column order.`);
      seen.add(c);
    }
    // Columns the order does not mention (for example one a later step added) keep their natural place at the end.
    const ordered = order.filter((c) => !hidden.has(c));
    return [...ordered, ...natural.filter((c) => !seen.has(c))];
  }

  private unknownColumn(c: ColumnId): Error {
    return notFound(`The view of dataset ${this.dataset.schema.datasetId} has no column ${c}.`, {
      datasetId: this.dataset.schema.datasetId,
      column: c,
    });
  }
}

/** The last position in `positions` (ascending) that is below `limit`, or -1. */
function latestBefore(positions: number[] | undefined, limit: number): number {
  if (positions === undefined) return -1;
  for (let i = positions.length - 1; i >= 0; i--) {
    const p = positions[i] as number;
    if (p < limit) return p;
  }
  return -1;
}

/** All rows minus the excluded ones, then narrowed by the row filter. */
function visibleRowIds(rowCount: number, spec: ViewSpec): Uint32Array {
  checkCapacity('excluded', spec.excluded, rowCount);
  let visible = RowSet.all(rowCount).minus(spec.excluded);
  if (spec.rowFilter !== null) {
    checkCapacity('rowFilter', spec.rowFilter, rowCount);
    visible = visible.intersect(spec.rowFilter);
  }
  const out = new Uint32Array(visible.size);
  let i = 0;
  for (const r of visible) out[i++] = r;
  return out;
}

function checkCapacity(name: string, set: RowSet, rowCount: number): void {
  if (set.capacity !== rowCount) {
    throw invalidArgument(`The ${name} row set has capacity ${set.capacity} but the dataset has ${rowCount} rows.`);
  }
}

function checkWindow(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw invalidArgument(`A window offset must be a whole number of at least 0, not ${String(offset)}.`);
  }
  // The protocol's ROW_WINDOW_MAX is enforced at the engine boundary; export pages through larger windows.
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw invalidArgument(`A window limit must be a whole number of at least 0, not ${String(limit)}.`);
  }
}
