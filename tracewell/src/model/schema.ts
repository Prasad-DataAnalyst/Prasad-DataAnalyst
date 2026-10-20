/** Table schemas (SAD section 7.4): what each column is, and how sure the engine is about it. */
import type { Detection } from './detection';
import type { ColumnId, DatasetId, FileId, StepId } from './ids';
import type { LogicalType } from './values';

export type ColumnRole =
  'measure' | 'id' | 'time' | 'latitude' | 'longitude' | 'easting' | 'northing' | 'geometry' | 'unit' | 'text';

export type QuantityKind =
  | 'length'
  | 'area'
  | 'volume'
  | 'std_volume'
  | 'mass'
  | 'time'
  | 'temperature'
  | 'temperature_diff'
  | 'pressure_abs'
  | 'pressure_gauge'
  | 'pressure_diff'
  | 'energy'
  | 'power'
  | 'density'
  | 'mass_rate'
  | 'volume_rate'
  | 'std_volume_rate'
  | 'energy_rate'
  | 'fraction'
  | 'velocity'
  | 'dimensionless';

export type DateFormat = 'iso' | 'dmy' | 'mdy' | 'ymd-slash' | 'excel-serial';

/** How datetimes without an explicit zone are read; naive values are taken as UTC (rule TW-TIME-004). */
export type TimezoneMode = 'utc' | 'offset' | 'naive-assumed-utc';

/** Coordinate reference system, held at dataset level (SAD section 7.6). Slice 1 records it but never transforms. */
export interface CrsRef {
  code: 'OGC:CRS84' | 'EPSG:4326' | `EPSG:${number}` | 'unknown';
  source: 'rfc7946-default' | 'geojson-crs-member' | 'assumed-latlon' | 'user';
}

export interface ColumnSchema {
  id: ColumnId;
  name: string;
  /** The original header cell texts, top to bottom (more than one for a flattened multi-row header). */
  sourceHeader: string[];
  /** 0-based field position in the source row. */
  sourceIndex: number;
  type: Detection<LogicalType>;
  role: Detection<ColumnRole>;
  unit: Detection<string | null>;
  quantity: QuantityKind | null;
  nullMarkers: Detection<string[]>;
  dateFormat?: Detection<DateFormat>;
  timezone?: Detection<TimezoneMode>;
  decimalSeparator?: Detection<'.' | ','>;
  /** Set on columns added by a `convert_unit` step in 'add_column' mode. */
  derivedFrom?: { column: ColumnId; step: StepId };
}

/** A column as planned by detection, before any step can derive from it. */
export type ColumnPlan = Omit<ColumnSchema, 'derivedFrom'>;

export type SourceFormat = 'csv' | 'tsv' | 'xlsx' | 'geojson';

export interface TableSchema {
  datasetId: DatasetId;
  name: string;
  source: { fileId: FileId; fileName: string; format: SourceFormat; sheet?: string };
  rowCount: number;
  columns: ColumnSchema[];
  crs: Detection<CrsRef> | null;
  geometryColumn: ColumnId | null;
  /** True when the import stopped at the memory budget (TW-IMP-006). */
  partial: boolean;
}
