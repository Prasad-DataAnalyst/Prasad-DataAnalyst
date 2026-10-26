/**
 * Streaming table construction: ingest pushes one row of parsed cells at a time and checks
 * estimatedBytes() after each batch against the memory budget (SAD section 8.4).
 */
import type { ColumnId, LogicalType, TableSchema } from '@tw/model';
import { columnWriter, type CellParse, type ColumnWriter } from './columns';
import { Dataset } from './dataset';
import { invalidArgument, misuse } from './errors';
import { SrcLocs } from './srcloc';

export class TableBuilder {
  private readonly writers: ColumnWriter[];
  private readonly locs = new SrcLocs();
  private finished = false;

  constructor(columns: { id: ColumnId; type: LogicalType }[]) {
    const ids = new Set<ColumnId>();
    for (const { id } of columns) {
      if (ids.has(id)) throw invalidArgument(`Column ${id} is declared twice.`);
      ids.add(id);
    }
    this.writers = columns.map(({ id, type }) => columnWriter(id, type));
  }

  /** `cells` holds one parsed cell per declared column, in declaration order. */
  pushRow(srcLoc: number, cells: CellParse[]): void {
    if (this.finished) throw misuse('A row was pushed to a table builder after it was finished.');
    if (cells.length !== this.writers.length) {
      throw invalidArgument(
        `Row ${this.locs.length} has ${cells.length} cells but the table has ${this.writers.length} columns.`,
        { row: this.locs.length, cells: cells.length, columns: this.writers.length },
      );
    }
    // Everything is validated before anything is stored, so a rejected row leaves the table unchanged.
    this.writers.forEach((w, i) => w.check(cells[i] as CellParse));
    this.locs.push(srcLoc);
    this.writers.forEach((w, i) => w.store(cells[i] as CellParse));
  }

  get rowCount(): number {
    return this.locs.length;
  }

  estimatedBytes(): number {
    let n = this.locs.bytes();
    for (const w of this.writers) n += w.estimatedBytes();
    return n;
  }

  /** Seals the columns into a Dataset; `schema.columns` must list the declared columns in order. */
  finish(schema: Omit<TableSchema, 'rowCount'>): Dataset {
    if (this.finished) throw misuse('A table builder was finished twice.');
    this.finished = true;
    const columns = this.writers.map((w) => w.finish());
    schema.columns.forEach((c, i) => {
      if (c.type.value !== columns[i]?.type) {
        throw invalidArgument(
          `Column ${c.id} is declared ${String(columns[i]?.type)} but its schema says ${c.type.value}.`,
        );
      }
    });
    return new Dataset({ ...schema, rowCount: this.locs.length }, columns, this.locs);
  }
}
