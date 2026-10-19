/**
 * Processing and extraction steps: declarative JSON, so each engine can translate them natively
 * (SAD section 4.2). Steps never change the original data; they build views over it.
 */
import type { AuditSeq, BBox, ColumnId, StepId } from './ids';
import type { DateCell, DateTimeCell } from './values';

export type PredicateValue = string | number | boolean | DateCell | DateTimeCell;

/** Every comparison with null is false (as in SQL); only 'is_null' matches a null. */
export type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | { column: ColumnId; op: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'; value: PredicateValue }
  /** Inclusive at both ends. */
  | { column: ColumnId; op: 'between'; low: PredicateValue; high: PredicateValue }
  | { column: ColumnId; op: 'in'; values: (string | number)[] }
  | { column: ColumnId; op: 'contains'; text: string; caseSensitive?: boolean }
  | { column: ColumnId; op: 'is_null' | 'not_null' }
  | { bbox: BBox; geometry: ColumnId }
  | { bbox: BBox; lat: ColumnId; lon: ColumnId };

export type StepInput =
  | { kind: 'convert_unit'; columnId: ColumnId; toUnit: string; mode: 'replace' | 'add_column' }
  | { kind: 'filter'; predicate: Predicate; label?: string }
  | { kind: 'select_columns'; columnIds: ColumnId[] };

export type Step = StepInput & { id: StepId; seq: AuditSeq };
