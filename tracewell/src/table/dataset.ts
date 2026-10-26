/** An imported table: its schema, typed columns and the source locator of every row. */
import type { ColumnId, ColumnSchema, RowId, TableSchema } from '@tw/model';
import { columnBytes, type ColumnData } from './columns';
import { invalidArgument, notFound } from './errors';
import type { SrcLocs } from './srcloc';

export class Dataset {
  readonly schema: TableSchema;
  readonly rowCount: number;
  private readonly byId: ReadonlyMap<ColumnId, ColumnData>;
  private readonly ordered: readonly ColumnData[];

  /** Internal: datasets come from TableBuilder.finish and Dataset.withColumn. */
  constructor(
    schema: TableSchema,
    columns: readonly ColumnData[],
    private readonly locs: SrcLocs,
  ) {
    checkShape(schema, columns, locs);
    this.schema = schema;
    this.rowCount = schema.rowCount;
    this.ordered = columns;
    this.byId = new Map(columns.map((c) => [c.id, c]));
  }

  column(id: ColumnId): ColumnData {
    const col = this.byId.get(id);
    if (col === undefined) {
      throw notFound(`Dataset ${this.schema.datasetId} has no column ${id}.`, {
        datasetId: this.schema.datasetId,
        column: id,
      });
    }
    return col;
  }

  /** Columns in schema order. */
  columns(): readonly ColumnData[] {
    return this.ordered;
  }

  srcLoc(r: RowId): number {
    if (!Number.isInteger(r) || r < 0 || r >= this.rowCount) {
      throw notFound(`Row ${String(r)} does not exist in dataset ${this.schema.datasetId}.`, {
        datasetId: this.schema.datasetId,
        row: Number.isFinite(r) ? r : String(r),
      });
    }
    return this.locs.get(r);
  }

  /** Replaces the column with the same ID in place, or appends it; other columns are shared, not copied. */
  withColumn(col: ColumnData, schema: ColumnSchema): Dataset {
    if (col.id !== schema.id) {
      throw invalidArgument(`Column data ${col.id} was given with the schema of column ${schema.id}.`);
    }
    if (col.type !== schema.type.value) {
      throw invalidArgument(`Column ${col.id} holds ${col.type} values but its schema says ${schema.type.value}.`);
    }
    const at = this.ordered.findIndex((c) => c.id === col.id);
    const columns = [...this.ordered];
    const schemas = [...this.schema.columns];
    if (at < 0) {
      columns.push(col);
      schemas.push(schema);
    } else {
      columns[at] = col;
      schemas[at] = schema;
    }
    return new Dataset({ ...this.schema, columns: schemas }, columns, this.locs);
  }

  estimatedBytes(): number {
    let n = this.locs.bytes();
    for (const col of this.ordered) n += columnBytes(col);
    return n;
  }
}

function checkShape(schema: TableSchema, columns: readonly ColumnData[], locs: SrcLocs): void {
  if (locs.length !== schema.rowCount) {
    throw invalidArgument(`The dataset has ${locs.length} source locators for ${schema.rowCount} rows.`);
  }
  if (columns.length !== schema.columns.length) {
    throw invalidArgument(`The dataset has ${columns.length} columns but its schema lists ${schema.columns.length}.`);
  }
  const seen = new Set<ColumnId>();
  columns.forEach((col, i) => {
    const declared = schema.columns[i];
    if (declared?.id !== col.id) {
      throw invalidArgument(`Column ${i} is ${col.id} but the schema names ${String(declared?.id)} there.`);
    }
    if (seen.has(col.id)) throw invalidArgument(`Column ${col.id} appears twice in the dataset.`);
    seen.add(col.id);
    if (col.length !== schema.rowCount) {
      throw invalidArgument(`Column ${col.id} has ${col.length} rows but the dataset has ${schema.rowCount}.`, {
        column: col.id,
        length: col.length,
        rowCount: schema.rowCount,
      });
    }
  });
}
