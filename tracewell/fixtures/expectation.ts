/**
 * The shape of `<name>.expected.json` and its check. The check is hand-written because the loader
 * may depend only on model and io; fixtures/README.md says how each field is counted.
 */
import type {
  ColumnRole,
  Confidence,
  ImportNoteCode,
  LogicalType,
  Sha256Hex,
  SourceFormat,
  TextEncodingName,
} from '@tw/model';
import type { FixtureName } from './names';

/** Dataset-level detections an expectation may state. */
export interface FixtureDetections {
  encoding: TextEncodingName;
  delimiter: string;
  decimalSeparator: '.' | ',';
  skipLines: number;
  headerRows: number;
  sheet: string;
  date1904: boolean;
  crs: string;
}

export interface FixtureExpectation {
  file: FixtureName;
  format: SourceFormat;
  detections: Partial<FixtureDetections>;
  /** The confidence of each detection listed in `detections`; one that is not 'high' is assumed. */
  confidence: Partial<Record<keyof FixtureDetections, Confidence>>;
  rowCount: number;
  /** `assumed` names the column's assumed detections ('type', 'unit', 'timezone', ...), sorted. */
  columns: { name: string; type: LogicalType; unit: string | null; role: ColumnRole; assumed?: string[] }[];
  /** Rule ID to affected count (rows, or 1 per column- or dataset-scope issue); unlisted rule IDs must not appear. */
  issues: Record<string, number>;
  /** Import note codes the readers emit, unique and sorted. */
  notes?: ImportNoteCode[];
  /** Source locators where the fixture tests them: of each data row, and of the notes by code. */
  locators?: { rows: number[]; notes?: Partial<Record<ImportNoteCode, number[]>> };
  /** Golden view digest after import, filled in once stable. */
  workingDigest?: Sha256Hex;
}

const FORMATS: ReadonlySet<string> = new Set<SourceFormat>(['csv', 'tsv', 'xlsx', 'geojson', 'json', 'parquet']);
const TYPES: ReadonlySet<string> = new Set<LogicalType>([
  'string',
  'integer',
  'number',
  'boolean',
  'date',
  'datetime',
  'geometry',
]);
const ROLES: ReadonlySet<string> = new Set<ColumnRole>([
  'measure',
  'id',
  'time',
  'latitude',
  'longitude',
  'easting',
  'northing',
  'geometry',
  'unit',
  'text',
]);
/** The detections a column schema holds (SAD section 7.4), which are the ones a column can assume. */
const COLUMN_DETECTIONS: ReadonlySet<string> = new Set([
  'dateFormat',
  'decimalSeparator',
  'nullMarkers',
  'role',
  'timezone',
  'type',
  'unit',
]);
const CONFIDENCES: ReadonlySet<string> = new Set<Confidence>(['high', 'medium', 'low']);
const NOTE_CODES: ReadonlySet<string> = new Set<ImportNoteCode>([
  'TW-IMP-001',
  'TW-IMP-002',
  'TW-IMP-003',
  'TW-IMP-004',
]);
const ENCODINGS: ReadonlySet<string> = new Set<TextEncodingName>(['utf-8', 'utf-16le', 'utf-16be', 'windows-1252']);
const DELIMITERS: ReadonlySet<string> = new Set([',', ';', '\t', '|']);
const DECIMAL_SEPARATORS: ReadonlySet<string> = new Set(['.', ',']);
const RULE_ID = /^TW-(?:DQ|UNIT|TIME|GEO|IMP|PRJ|EXP)-\d{3}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CRS = /^(?:OGC:CRS84|EPSG:\d+|unknown)$/;

type Json = Record<string, unknown>;
type Check = (v: unknown, path: string) => void;

function fail(path: string, wanted: string): never {
  throw new Error(`${path} must be ${wanted}.`);
}

function object(v: unknown, path: string): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'an object');
  return v as Json;
}

function array(v: unknown, path: string, min = 0): unknown[] {
  if (!Array.isArray(v) || v.length < min) fail(path, min > 0 ? `an array of at least ${min}` : 'an array');
  return v;
}

function text(v: unknown, path: string): string {
  if (typeof v !== 'string' || v === '') fail(path, 'a non-empty string');
  return v;
}

function oneOf(v: unknown, allowed: ReadonlySet<string>, path: string): string {
  if (typeof v !== 'string' || !allowed.has(v))
    fail(path, `one of ${[...allowed].map((a) => JSON.stringify(a)).join(', ')}`);
  return v;
}

function count(v: unknown, path: string, min = 0): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) fail(path, `a whole number of at least ${min}`);
}

/** Fails on any key outside `allowed`, so a misspelt field cannot slip through unchecked. */
function onlyKeys(o: Json, allowed: readonly string[], path: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0) fail(path, `free of unknown fields (found ${extra.join(', ')})`);
}

/** Fails unless the strings are unique and in ascending order. */
function sortedUnique(values: readonly string[], path: string): void {
  if (values.join('\n') !== [...new Set(values)].sort().join('\n')) fail(path, 'unique and sorted');
}

const DETECTION_CHECKS: Readonly<Record<keyof FixtureDetections, Check>> = {
  encoding: (v, p) => oneOf(v, ENCODINGS, p),
  delimiter: (v, p) => oneOf(v, DELIMITERS, p),
  decimalSeparator: (v, p) => oneOf(v, DECIMAL_SEPARATORS, p),
  skipLines: (v, p) => count(v, p),
  headerRows: (v, p) => count(v, p, 1),
  sheet: (v, p) => text(v, p),
  date1904: (v, p) => {
    if (typeof v !== 'boolean') fail(p, 'true or false');
  },
  crs: (v, p) => {
    if (typeof v !== 'string' || !CRS.test(v)) fail(p, 'OGC:CRS84, EPSG:<code> or unknown');
  },
};

function checkDetections(v: unknown): string[] {
  const o = object(v, 'detections');
  onlyKeys(o, Object.keys(DETECTION_CHECKS), 'detections');
  for (const [key, value] of Object.entries(o))
    DETECTION_CHECKS[key as keyof FixtureDetections](value, `detections.${key}`);
  return Object.keys(o);
}

/** Every listed detection has a confidence, and nothing else does. */
function checkConfidence(v: unknown, listed: readonly string[]): void {
  const o = object(v, 'confidence');
  onlyKeys(o, listed, 'confidence');
  for (const key of listed) oneOf(o[key], CONFIDENCES, `confidence.${key}`);
}

function checkColumn(v: unknown, path: string): void {
  const o = object(v, path);
  onlyKeys(o, ['name', 'type', 'unit', 'role', 'assumed'], path);
  text(o['name'], `${path}.name`);
  oneOf(o['type'], TYPES, `${path}.type`);
  if (o['unit'] !== null) text(o['unit'], `${path}.unit`);
  oneOf(o['role'], ROLES, `${path}.role`);
  if (o['assumed'] === undefined) return;
  const names = array(o['assumed'], `${path}.assumed`, 1).map((n, i) =>
    oneOf(n, COLUMN_DETECTIONS, `${path}.assumed[${i}]`),
  );
  sortedUnique(names, `${path}.assumed`);
}

function checkIssues(v: unknown): void {
  for (const [rule, n] of Object.entries(object(v, 'issues'))) {
    if (!RULE_ID.test(rule)) fail(`issues["${rule}"]`, 'keyed by a rule ID such as TW-DQ-001');
    count(n, `issues["${rule}"]`, 1);
  }
}

function checkNotes(v: unknown): void {
  sortedUnique(
    array(v, 'notes').map((c, i) => oneOf(c, NOTE_CODES, `notes[${i}]`)),
    'notes',
  );
}

function checkLines(v: unknown, path: string): void {
  array(v, path).forEach((n, i) => count(n, `${path}[${i}]`, 0));
}

function checkLocators(v: unknown): void {
  const o = object(v, 'locators');
  onlyKeys(o, ['rows', 'notes'], 'locators');
  checkLines(o['rows'], 'locators.rows');
  if (o['notes'] === undefined) return;
  for (const [code, lines] of Object.entries(object(o['notes'], 'locators.notes'))) {
    oneOf(code, NOTE_CODES, `locators.notes key "${code}"`);
    checkLines(lines, `locators.notes.${code}`);
  }
}

const EXPECTATION_KEYS = [
  'file',
  'format',
  'detections',
  'confidence',
  'rowCount',
  'columns',
  'issues',
  'notes',
  'locators',
  'workingDigest',
];

/**
 * Checks a parsed expected file for fixture `name` and returns it typed. Throws an Error naming the
 * first field that is wrong.
 */
export function parseExpectation(v: unknown, name: FixtureName): FixtureExpectation {
  const o = object(v, 'the document');
  onlyKeys(o, EXPECTATION_KEYS, 'the document');
  if (o['file'] !== name) fail('file', `"${name}"`);
  oneOf(o['format'], FORMATS, 'format');
  checkConfidence(o['confidence'], checkDetections(o['detections']));
  count(o['rowCount'], 'rowCount');
  array(o['columns'], 'columns', 1).forEach((c, i) => checkColumn(c, `columns[${i}]`));
  checkIssues(o['issues']);
  if (o['notes'] !== undefined) checkNotes(o['notes']);
  if (o['locators'] !== undefined) checkLocators(o['locators']);
  if (o['workingDigest'] !== undefined && !SHA256_HEX.test(String(o['workingDigest']))) {
    fail('workingDigest', '64 lowercase hex characters');
  }
  return o as unknown as FixtureExpectation;
}
