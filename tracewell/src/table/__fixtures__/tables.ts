/** Small schema and dataset builders shared by the table module's tests. */
import { detection, type ColumnSchema, type LogicalType, type SourceFormat, type TableSchema } from '@tw/model';
import { TableBuilder, type CellParse } from '../index';
import type { Dataset } from '../dataset';

export function columnSchema(
  id: string,
  type: LogicalType,
  options: { name?: string; unit?: string | null; sourceIndex?: number; header?: string } = {},
): ColumnSchema {
  const name = options.name ?? id.toUpperCase();
  return {
    id,
    name,
    sourceHeader: [options.header ?? name],
    sourceIndex: options.sourceIndex ?? 0,
    type: detection(type, 'high', 'test', 'fixture'),
    role: detection('text', 'high', 'test', 'fixture'),
    unit: detection(options.unit ?? null, 'high', 'test', 'fixture'),
    quantity: null,
    nullMarkers: detection([], 'high', 'test', 'fixture'),
  };
}

export function tableSchema(
  columns: ColumnSchema[],
  format: SourceFormat = 'csv',
  extra: Partial<TableSchema> = {},
): Omit<TableSchema, 'rowCount'> {
  return {
    datasetId: 'd1',
    name: 'test',
    source: { fileId: 'f'.repeat(64), fileName: `test.${format}`, format },
    columns,
    crs: null,
    geometryColumn: null,
    partial: false,
    ...extra,
  };
}

/** A dataset from rows of plain values; srcLoc is the row index plus 2 (line 1 is the header). */
export function datasetOf(columns: ColumnSchema[], rows: Extract<CellParse, { ok: true }>['value'][][]): Dataset {
  const builder = new TableBuilder(columns.map((c) => ({ id: c.id, type: c.type.value })));
  rows.forEach((row, i) =>
    builder.pushRow(
      i + 2,
      row.map((v) => ({ ok: true, value: v })),
    ),
  );
  return builder.finish(tableSchema(columns));
}
