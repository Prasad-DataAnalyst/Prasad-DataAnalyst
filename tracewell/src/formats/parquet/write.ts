/**
 * Parquet writer (export profile 'parquet', SAD section 10.1). Each logical type has one physical
 * and converted type, chosen so pandas, Polars, DuckDB, Spark and Power BI read the values as the
 * same types without options. Every column is optional (nullable).
 */
import { parquetWriteBuffer } from 'hyparquet-writer';
import { EngineError, type CellValue, type LogicalType } from '@tw/model';

/**
 * The Parquet types of a column: the physical and converted type this writer sets, and every
 * annotation read-back accepts for it. Other writers state the same type in other ways: DuckDB
 * marks a BIGINT INT_64. Date-times are UTC instants in microseconds, the unit every Parquet
 * writer can mark as UTC; Tracewell's values are whole milliseconds, so the values are exact.
 */
export interface ParquetType {
  physical: 'BYTE_ARRAY' | 'DOUBLE' | 'INT64' | 'BOOLEAN' | 'INT32';
  converted: 'UTF8' | 'DATE' | 'TIMESTAMP_MICROS' | 'JSON' | null;
  annotations: readonly (string | null)[];
}

export const PARQUET_TYPES: Readonly<Record<LogicalType, ParquetType>> = Object.freeze({
  string: { physical: 'BYTE_ARRAY', converted: 'UTF8', annotations: ['UTF8', 'STRING'] },
  number: { physical: 'DOUBLE', converted: null, annotations: [null] },
  integer: { physical: 'INT64', converted: null, annotations: [null, 'INT_64'] },
  boolean: { physical: 'BOOLEAN', converted: null, annotations: [null] },
  date: { physical: 'INT32', converted: 'DATE', annotations: ['DATE'] },
  datetime: {
    physical: 'INT64',
    converted: 'TIMESTAMP_MICROS',
    annotations: ['TIMESTAMP_MICROS', 'TIMESTAMP(MICROS, UTC)'],
  },
  geometry: { physical: 'BYTE_ARRAY', converted: 'JSON', annotations: ['JSON'] },
});

export interface ParquetColumnIn {
  name: string;
  type: LogicalType;
  values: readonly CellValue[];
}

const DAY_MS = 86_400_000;

function mismatch(name: string, type: LogicalType, v: CellValue): EngineError {
  return new EngineError(
    'INTERNAL',
    `The value ${JSON.stringify(v)} in column "${name}" is not a ${type} value, so it cannot be written to Parquet.`,
    'Report this problem; the export was not written.',
  );
}

/** The column's values in the form the writer stores for its Parquet type. */
function stored(col: ParquetColumnIn): unknown[] {
  return col.values.map((v) => {
    if (v === null) return null;
    switch (col.type) {
      case 'string':
        if (typeof v === 'string') return v;
        break;
      case 'number':
        if (typeof v === 'number') return v;
        break;
      case 'integer':
        if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
        break;
      case 'boolean':
        if (typeof v === 'boolean') return v;
        break;
      case 'date':
        if (typeof v === 'object' && 'date' in v) return Date.parse(`${v.date}T00:00:00Z`) / DAY_MS;
        break;
      case 'datetime':
        if (typeof v === 'object' && 'datetime' in v) return BigInt(Date.parse(v.datetime)) * 1000n;
        break;
      case 'geometry':
        if (typeof v === 'object' && 'geometry' in v) return v.geometry;
        break;
    }
    throw mismatch(col.name, col.type, v);
  });
}

/** The columns as a Parquet file: one schema element per column, row groups of up to 100,000 rows. */
export function writeParquet(columns: readonly ParquetColumnIn[], kvMetadata: Record<string, string> = {}): Uint8Array {
  if (columns.length === 0) {
    throw new EngineError('INVALID_INPUT', 'A Parquet file needs at least one column.', 'Export at least one column.');
  }
  const schema = [
    { name: 'root', num_children: columns.length },
    ...columns.map((c) => {
      const t = PARQUET_TYPES[c.type];
      return {
        name: c.name,
        type: t.physical,
        repetition_type: 'OPTIONAL' as const,
        ...(t.converted === null ? {} : { converted_type: t.converted }),
      };
    }),
  ];
  const buffer = parquetWriteBuffer({
    columnData: columns.map((c) => ({ name: c.name, data: stored(c) as never })),
    schema: schema as never,
    rowGroupSize: 100_000,
    kvMetadata: Object.entries(kvMetadata).map(([key, value]) => ({ key, value })),
  });
  return new Uint8Array(buffer);
}
