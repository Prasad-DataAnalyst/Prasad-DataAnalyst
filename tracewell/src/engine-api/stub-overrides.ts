/**
 * Detection overrides in the stub. Column properties that only change how values are read (name,
 * type, unit, role, null markers, time zone) take effect. Properties that would need the file read
 * again with other options can only be confirmed at their detected value: the stub has nothing
 * but its canned file, and pretending to re-read it would show the UI results no engine produces.
 */
import {
  EngineError,
  userDetection,
  type AuditSeq,
  type ColumnId,
  type ColumnRole,
  type ColumnSchema,
  type DateFormat,
  type JsonValue,
  type LogicalType,
  type OverridableProperty,
  type Step,
  type TimezoneMode,
} from '@tw/model';
import { findUnit } from './stub-data';
import type { Revert } from './stub-project';
import { editsOf, fitsType, overrideKey, rootColumn, stepColumns, type StubDataset } from './stub-view';

export interface OverridePlan {
  columnId: ColumnId | undefined;
  property: OverridableProperty;
  old: JsonValue;
  value: JsonValue;
  /** Applies the override that audit entry `seq` records and returns how to undo it. */
  apply(seq: AuditSeq): Revert;
}

// Records rather than lists, so the compiler proves every member of each union is named.
const TYPES: Record<Exclude<LogicalType, 'geometry'>, true> = {
  string: true,
  integer: true,
  number: true,
  boolean: true,
  date: true,
  datetime: true,
};
const ROLES: Record<Exclude<ColumnRole, 'geometry'>, true> = {
  measure: true,
  id: true,
  time: true,
  latitude: true,
  longitude: true,
  easting: true,
  northing: true,
  unit: true,
  text: true,
};
const TIMEZONES: Record<TimezoneMode, true> = { utc: true, offset: true, 'naive-assumed-utc': true };

/** What the canned file's sniff detected for the dataset as a whole. */
const DATASET_DETECTED: Partial<Record<OverridableProperty, JsonValue>> = {
  encoding: 'utf-8',
  delimiter: ',',
  decimalSeparator: '.',
  headerRows: 1,
  skipLines: 0,
};

const NOT_FOR_CSV: ReadonlySet<OverridableProperty> = new Set(['crs', 'sheet', 'tableIndex']);
const COLUMN_ONLY: ReadonlySet<OverridableProperty> = new Set([
  'name',
  'type',
  'unit',
  'role',
  'nullMarkers',
  'dateFormat',
  'timezone',
]);
const READS_VALUES: ReadonlySet<OverridableProperty> = new Set(['type', 'unit']);

/**
 * The column fields each column override writes. Undoing an override restores only these, so a
 * later override of another property of the same column stays in effect, as the log says it is.
 */
const FIELDS: Partial<Record<OverridableProperty, readonly (keyof ColumnSchema)[]>> = {
  name: ['name'],
  type: ['type'],
  unit: ['unit', 'quantity'],
  role: ['role'],
  nullMarkers: ['nullMarkers'],
  dateFormat: ['dateFormat'],
  timezone: ['timezone'],
  decimalSeparator: ['decimalSeparator'],
};

/** Overrides whose validity depends on the column type: a unit needs a number, a time zone a datetime. */
const NEEDS_TYPE: readonly OverridableProperty[] = ['unit', 'timezone'];

function invalid(message: string, fix: string): EngineError {
  return new EngineError('INVALID_INPUT', message, fix);
}

function oneOf<T extends string>(allowed: Record<T, true>, v: JsonValue, what: string): T {
  if (typeof v === 'string' && Object.hasOwn(allowed, v)) return v as T;
  throw invalid(`${JSON.stringify(v)} is not a valid ${what}.`, `Choose one of: ${Object.keys(allowed).join(', ')}.`);
}

/** Checks an override against the dataset and returns how to apply it; throws when it is invalid. */
export function planOverride(
  ds: StubDataset,
  columnId: ColumnId | undefined,
  property: OverridableProperty,
  value: JsonValue,
): OverridePlan {
  if (NOT_FOR_CSV.has(property)) {
    throw invalid(
      `The property ${property} does not apply to a CSV file.`,
      'Override a property the import detected for this file.',
    );
  }
  if (columnId === undefined) {
    if (COLUMN_ONLY.has(property))
      throw invalid(`The property ${property} belongs to a column.`, 'Choose the column to override.');
    return planDatasetOverride(ds, property, value);
  }
  if (DATASET_DETECTED[property] !== undefined && property !== 'decimalSeparator') {
    throw invalid(`The property ${property} belongs to the whole dataset.`, 'Override it without choosing a column.');
  }
  return planColumnOverride(ds, sourceColumn(ds, columnId), property, value);
}

function sourceColumn(ds: StubDataset, columnId: ColumnId): ColumnSchema {
  const column = ds.columns.find((c) => c.id === columnId);
  if (column !== undefined) return column;
  if (columnId.includes('~')) {
    throw invalid(
      `The column ${columnId} is made by a step, not read from the file.`,
      `Override the source column ${rootColumn(columnId)} instead.`,
    );
  }
  throw new EngineError(
    'NOT_FOUND',
    `There is no column ${columnId} in dataset ${ds.id}.`,
    'Choose a column shown in the grid.',
  );
}

function requireDetected(property: OverridableProperty, detected: JsonValue | undefined, value: JsonValue): void {
  if (detected === undefined) {
    throw invalid(
      `The property ${property} was not detected for this column.`,
      'Override a property shown in the column properties.',
    );
  }
  if (JSON.stringify(detected) !== JSON.stringify(value)) {
    throw invalid(
      `The stub engine can only confirm ${property} as detected (${JSON.stringify(detected)}); changing it needs the file read again.`,
      'Confirm the detected value, or use the full engine to read the file with other options.',
    );
  }
}

/** Takes the latest-override slot for `key` and gives back a function that restores it. */
function claimLatest(ds: StubDataset, key: string, seq: AuditSeq): () => void {
  const previous = ds.latestOverride.get(key);
  ds.latestOverride.set(key, seq);
  return () => {
    if (previous === undefined) ds.latestOverride.delete(key);
    else ds.latestOverride.set(key, previous);
  };
}

function requireLatest(ds: StubDataset, key: string, seq: AuditSeq): void {
  if (ds.latestOverride.get(key) !== seq) {
    throw invalid(
      `A later override changed the same property after entry ${seq}.`,
      'Revert the later override first, then this one.',
    );
  }
}

function planDatasetOverride(ds: StubDataset, property: OverridableProperty, value: JsonValue): OverridePlan {
  const detected = DATASET_DETECTED[property];
  requireDetected(property, detected, value);
  const key = overrideKey(undefined, property);
  return {
    columnId: undefined,
    property,
    old: detected ?? null,
    value,
    apply(seq) {
      const wasConfirmed = ds.confirmed.has(property);
      const restoreLatest = claimLatest(ds, key, seq);
      ds.confirmed.add(property);
      return {
        check: () => requireLatest(ds, key, seq),
        apply: () => {
          if (!wasConfirmed) ds.confirmed.delete(property);
          restoreLatest();
        },
      };
    },
  };
}

/** The column after the override, as a function of the entry that records it. */
type ColumnChange = (column: ColumnSchema, seq: AuditSeq) => void;

function planColumnOverride(
  ds: StubDataset,
  column: ColumnSchema,
  property: OverridableProperty,
  value: JsonValue,
): OverridePlan {
  if (READS_VALUES.has(property)) guardSteps(ds, column.id, property);
  const { old, change } = columnChange(column, property, value);
  if (property === 'type') guardEdits(ds, column, value as LogicalType);
  const key = overrideKey(column.id, property);
  const fields = FIELDS[property] ?? [];
  return {
    columnId: column.id,
    property,
    old,
    value,
    apply(seq) {
      const before = pick(column, fields);
      const restoreLatest = claimLatest(ds, key, seq);
      change(column, seq);
      return {
        check: () => {
          requireLatest(ds, key, seq);
          if (READS_VALUES.has(property)) guardSteps(ds, column.id, property);
          if (property === 'type') {
            guardDependentOverrides(ds, column.id, seq);
            guardEdits(ds, column, old as LogicalType);
          }
        },
        apply: () => {
          restoreFields(column, before);
          restoreLatest();
        },
      };
    },
  };
}

/** Edited cells hold typed values, so the column type may change only to a type they all fit. */
function guardEdits(ds: StubDataset, column: ColumnSchema, type: LogicalType): void {
  const misfit = editsOf(ds, column.id).find((e) => !fitsType(e.value, type));
  if (misfit !== undefined) {
    throw invalid(
      `The edited value in row ${misfit.rowId} of ${column.name} is not a valid ${type}.`,
      `Revert the edits of ${column.name} that do not fit, then change the type.`,
    );
  }
}

/** A later unit or time-zone override was accepted because of this type; undoing the type would strand it. */
function guardDependentOverrides(ds: StubDataset, columnId: ColumnId, seq: AuditSeq): void {
  const later = NEEDS_TYPE.find((p) => (ds.latestOverride.get(overrideKey(columnId, p)) ?? 0) > seq);
  if (later !== undefined) {
    throw invalid(
      `A later ${later} override of this column relies on the type set in entry ${seq}.`,
      `Revert the later ${later} override first, then this one.`,
    );
  }
}

/**
 * A conversion step reads the column's type and unit, so neither may change under it. A filter
 * compares values of the column's type: under another type every comparison would be false and
 * the output would empty without a word. (A new unit only reinterprets the values it compares.)
 */
function guardSteps(ds: StubDataset, columnId: ColumnId, property: OverridableProperty): void {
  const reads = (s: Step): boolean =>
    s.kind === 'convert_unit'
      ? rootColumn(s.columnId) === columnId
      : s.kind === 'filter' && property === 'type' && stepColumns(s).some((c) => rootColumn(c) === columnId);
  const step = ds.steps.find(reads);
  if (step !== undefined) {
    const uses = step.kind === 'convert_unit' ? 'converts' : 'filters on';
    throw invalid(
      `Step ${step.id} ${uses} this column, so its ${property} cannot change.`,
      `Remove step ${step.id} first, then change the ${property}.`,
    );
  }
}

/** Marks a field the column did not have, such as a dateFormat on a number column. */
const ABSENT = Symbol('absent');

type Snapshot = Map<keyof ColumnSchema, unknown>;

/** Copies of the given fields, taken before an override writes them. */
function pick(column: ColumnSchema, fields: readonly (keyof ColumnSchema)[]): Snapshot {
  return new Map(fields.map((f) => [f, f in column ? structuredClone(column[f]) : ABSENT]));
}

/** Restores in place, because views and plans hold the column object itself. */
function restoreFields(column: ColumnSchema, before: Snapshot): void {
  const loose = column as unknown as Record<string, unknown>;
  for (const [field, value] of before) {
    if (value === ABSENT) delete loose[field];
    else loose[field] = value;
  }
}

function columnChange(
  column: ColumnSchema,
  property: OverridableProperty,
  value: JsonValue,
): { old: JsonValue; change: ColumnChange } {
  switch (property) {
    case 'name':
      return { old: column.name, change: nameChange(value) };
    case 'type': {
      const type = oneOf(TYPES, value, 'column type for a CSV column');
      return { old: column.type.value, change: (c, seq) => (c.type = userDetection<LogicalType>(type, seq)) };
    }
    case 'unit':
      return { old: column.unit.value, change: unitChange(column, value) };
    case 'role': {
      const role = oneOf(ROLES, value, 'column role for a CSV column');
      return { old: column.role.value, change: (c, seq) => (c.role = userDetection<ColumnRole>(role, seq)) };
    }
    case 'nullMarkers': {
      const markers = nullMarkers(value);
      return { old: column.nullMarkers.value, change: (c, seq) => (c.nullMarkers = userDetection(markers, seq)) };
    }
    case 'timezone':
      return timezoneChange(column, value);
    case 'dateFormat':
      requireDetected(property, column.dateFormat?.value, value);
      return {
        old: column.dateFormat?.value ?? null,
        change: (c, seq) => (c.dateFormat = userDetection(value as DateFormat, seq)),
      };
    case 'decimalSeparator':
      requireDetected(property, column.decimalSeparator?.value, value);
      return {
        old: column.decimalSeparator?.value ?? null,
        change: (c, seq) => (c.decimalSeparator = userDetection(value as '.' | ',', seq)),
      };
    default:
      throw invalid(`The property ${property} cannot be set on a column.`, 'Override it without choosing a column.');
  }
}

function nameChange(value: JsonValue): ColumnChange {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw invalid('A column name must be text of 1 to 200 characters.', 'Type a short, descriptive column name.');
  }
  const name = value.trim();
  return (c) => (c.name = name);
}

function unitChange(column: ColumnSchema, value: JsonValue): ColumnChange {
  if (value === null) {
    return (c, seq) => {
      c.unit = userDetection<string | null>(null, seq);
      c.quantity = null;
    };
  }
  if (column.type.value !== 'number' && column.type.value !== 'integer') {
    throw invalid(
      `${column.name} is not numeric, so it has no unit.`,
      'Set the column type to number first, or clear the unit.',
    );
  }
  const unit = typeof value === 'string' ? findUnit(value) : undefined;
  if (unit === undefined) {
    throw new EngineError(
      'UNIT_UNKNOWN',
      `The unit ${JSON.stringify(value)} is not in the unit registry.`,
      'Choose a unit from the list.',
    );
  }
  return (c, seq) => {
    c.unit = userDetection<string | null>(unit.code, seq);
    c.quantity = unit.quantity;
  };
}

function nullMarkers(value: JsonValue): string[] {
  if (!Array.isArray(value) || !value.every((m): m is string => typeof m === 'string' && m !== '' && m.length <= 100)) {
    throw invalid(
      'Null markers must be a list of non-empty texts.',
      'List the texts that stand for a missing value, such as NA or -999.',
    );
  }
  return [...new Set(value)];
}

function timezoneChange(column: ColumnSchema, value: JsonValue): { old: JsonValue; change: ColumnChange } {
  if (column.type.value !== 'datetime') {
    throw invalid(
      `${column.name} holds no date-times, so it has no time zone.`,
      'Set the column type to datetime first.',
    );
  }
  const mode = oneOf(TIMEZONES, value, 'time zone mode');
  return {
    old: column.timezone?.value ?? null,
    change: (c, seq) => (c.timezone = userDetection<TimezoneMode>(mode, seq)),
  };
}
