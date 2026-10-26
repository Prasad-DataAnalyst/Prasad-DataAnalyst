/**
 * Cell edits on top of a dataset, keyed by (row, column) and stamped with the audit entry that made
 * them, so lineage can say which decision produced a value. The dataset itself is never mutated.
 */
import type { AuditSeq, CellValue, ColumnId, RowId } from '@tw/model';
import { invalidArgument } from './errors';

interface Edit {
  value: CellValue;
  seq: AuditSeq;
}

export class Overlay {
  // Column first: rules and digests read a column at a time, and most columns have no edits.
  private readonly byColumn = new Map<ColumnId, Map<RowId, Edit>>();

  set(r: RowId, c: ColumnId, v: CellValue, seq: AuditSeq): void {
    if (!Number.isInteger(r) || r < 0) throw invalidArgument(`An edit was given the invalid row ${String(r)}.`);
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw invalidArgument(`An edit was given the invalid audit sequence ${String(seq)}.`);
    }
    let rows = this.byColumn.get(c);
    if (rows === undefined) {
      rows = new Map();
      this.byColumn.set(c, rows);
    }
    rows.set(r, { value: v, seq });
  }

  delete(r: RowId, c: ColumnId): void {
    const rows = this.byColumn.get(c);
    if (rows === undefined) return;
    rows.delete(r);
    if (rows.size === 0) this.byColumn.delete(c);
  }

  get(r: RowId, c: ColumnId): { value: CellValue; seq: AuditSeq } | undefined {
    const edit = this.byColumn.get(c)?.get(r);
    return edit === undefined ? undefined : { value: edit.value, seq: edit.seq };
  }

  has(r: RowId, c: ColumnId): boolean {
    return this.byColumn.get(c)?.has(r) ?? false;
  }

  /** Every edit, ordered by row and then column ID, so the order never depends on edit history. */
  *entries(): IterableIterator<{ rowId: RowId; columnId: ColumnId; value: CellValue; seq: AuditSeq }> {
    const all: { rowId: RowId; columnId: ColumnId; value: CellValue; seq: AuditSeq }[] = [];
    for (const [columnId, rows] of this.byColumn) {
      for (const [rowId, { value, seq }] of rows) all.push({ rowId, columnId, value, seq });
    }
    all.sort((a, b) => a.rowId - b.rowId || (a.columnId < b.columnId ? -1 : a.columnId > b.columnId ? 1 : 0));
    yield* all;
  }

  clone(): Overlay {
    const out = new Overlay();
    for (const [c, rows] of this.byColumn) out.byColumn.set(c, new Map(rows));
    return out;
  }
}
