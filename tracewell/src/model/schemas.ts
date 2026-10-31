/**
 * Zod schemas for every persisted or protocol document. Objects are strict: an unknown key is
 * rejected rather than stripped, because stripping would let an edited audit line or manifest
 * verify after the edit. Content rules that need a friendly error code (such as the minimum
 * reason length, REASON_REQUIRED) are the engine's job; these schemas check structure.
 */
import { z } from 'zod';
import type { AuditAction, AuditEntry } from './audit';
import type { Confidence } from './detection';
import type { OverridableProperty, Decision } from './decisions';
import type { ExportManifest, ExportProfileId, ValidationCheck } from './export';
import type { ImportNoteCode } from './formats';
import type { BBox, JsonValue } from './ids';
import { isJsonValue, MAX_JSON_DEPTH, withinDepth } from './json';
import { members } from './literals';
import type { ProjectManifest } from './project';
import type { CheckSpec, RuleCategory, RulePack, Severity } from './rules';
import type { ColumnRole, DateFormat, QuantityKind, SourceFormat, TimezoneMode } from './schema';
import type { Predicate, StepInput } from './steps';
import type { Recipe } from './recipes';
import type { MappingTemplate } from './templates';
import type { UnitConvention, UnitDef } from './units';
import { isDateText, isDateTimeText, type Geometry, type LogicalType } from './values';

// ---------------------------------------------------------------------------------------------
// Literal lists, proven complete against the model's unions

const LOGICAL_TYPES = members<LogicalType>()([
  'string',
  'integer',
  'number',
  'boolean',
  'date',
  'datetime',
  'geometry',
]);
const COLUMN_ROLES = members<ColumnRole>()([
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
const DATE_FORMATS = members<DateFormat>()(['iso', 'dmy', 'mdy', 'ymd-slash', 'excel-serial']);
const TIMEZONE_MODES = members<TimezoneMode>()(['utc', 'offset', 'naive-assumed-utc']);
const SOURCE_FORMATS = members<SourceFormat>()(['csv', 'tsv', 'xlsx', 'geojson', 'json', 'parquet']);
const QUANTITY_KINDS = members<QuantityKind>()([
  'length',
  'area',
  'volume',
  'std_volume',
  'mass',
  'time',
  'temperature',
  'temperature_diff',
  'pressure_abs',
  'pressure_gauge',
  'pressure_diff',
  'energy',
  'power',
  'density',
  'mass_rate',
  'volume_rate',
  'std_volume_rate',
  'energy_rate',
  'fraction',
  'velocity',
  'dimensionless',
]);
const UNIT_CONVENTIONS = members<UnitConvention>()([
  'gauge',
  'std-60F-14.696psia',
  'std-15C-101.325kPa',
  'std-0C-101.325kPa',
]);
const CONFIDENCES = members<Confidence>()(['high', 'medium', 'low']);
const SEVERITIES = members<Severity>()(['error', 'warning', 'note']);
const RULE_CATEGORIES = members<RuleCategory>()([
  'completeness',
  'uniqueness',
  'validity',
  'range',
  'units',
  'time',
  'spatial',
  'import',
  'project',
  'export',
]);
const IMPORT_NOTE_CODES = members<ImportNoteCode>()(['TW-IMP-001', 'TW-IMP-002', 'TW-IMP-003', 'TW-IMP-004']);

/** Check primitives that take no parameters. */
type SimpleCheckKind = Exclude<CheckSpec, { kind: 'ts_gap' | 'flatline' | 'spike' | 'import_note' }>['kind'];
const SIMPLE_CHECK_KINDS = members<SimpleCheckKind>()([
  'not_null',
  'duplicate_rows',
  'duplicate_key',
  'type_conformance',
  'below_detection_limit',
  'physical_range',
  'null_marker',
  'unit_known',
  'unit_consistent',
  'ts_duplicate',
  'ts_order',
  'tz_specified',
  'date_ambiguous',
  'geometry_valid',
  'coord_range',
  'latlon_swapped',
  'within_area',
  'crs_wgs84',
  'geometry_present',
  'system',
]);

const AUDIT_ACTIONS = members<AuditAction>()([
  'project.create',
  'source.add',
  'detection.assume',
  'detection.override',
  'check.run',
  'cell.edit',
  'issue.accept',
  'issue.comment',
  'rows.exclude',
  'step.apply',
  'step.remove',
  'entry.revert',
  'project.area',
  'export.create',
  'project.save',
  'recipe.apply',
]);
const OVERRIDABLE_PROPERTIES = members<OverridableProperty>()([
  'name',
  'type',
  'unit',
  'role',
  'nullMarkers',
  'dateFormat',
  'timezone',
  'crs',
  'encoding',
  'delimiter',
  'decimalSeparator',
  'headerRows',
  'skipLines',
  'sheet',
  'tableIndex',
]);
const EXPORT_PROFILE_IDS = members<ExportProfileId>()(['excel', 'csv', 'parquet', 'geojson']);
const VALIDATION_CHECK_IDS = members<ValidationCheck['id']>()([
  'RB-OPEN',
  'RB-ROWS',
  'RB-HEADER',
  'RB-VALUES',
  'RB-CSV-ENCODING',
  'RB-XLSX-TYPES',
  'RB-XLSX-STRUCTURE',
  'RB-GEOJSON-STRUCTURE',
  'RB-PARQUET-TYPES',
  'RB-PKG-CHECKSUMS',
  'RB-PKG-CONTENTS',
]);
const EXPORT_FILE_ROLES = members<ExportManifest['files'][number]['role']>()([
  'data',
  'readme',
  'audit',
  'issues',
  'manifest',
]);

// ---------------------------------------------------------------------------------------------
// Scalars

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:)/;
/** Line breaks cannot be listed in CHECKSUMS.sha256; a backslash is a Windows separator. */
const UNLISTABLE = /[\\\n\r]/;
/** In a 'u' regex a well-formed surrogate pair is one code point, so this matches only lone halves. */
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * A relative ZIP entry path that cannot escape the package or name a directory, and that the io ZIP
 * writer and CHECKSUMS.sha256 both accept. A lone surrogate has no UTF-8 form, so the name written
 * would differ from the name listed.
 */
function isPackagePath(p: string): boolean {
  if (ABSOLUTE_PATH.test(p) || UNLISTABLE.test(p) || p.includes('\u0000') || LONE_SURROGATE.test(p)) return false;
  return p.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

const nonEmpty = z.string().min(1);
const positive = z.number().positive();
const count = z.int().min(0);
const rowId = z.int().min(0);
const auditSeq = z.int().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 digest: 64 lowercase hex characters.');
// The same checks canonicalCell applies, so a value these schemas accept can always be digested.
const isoUtc = z.string().refine(isDateTimeText, 'Expected a UTC instant written as YYYY-MM-DDTHH:mm:ss.sssZ.');
const calendarDate = z.string().refine(isDateText, 'Expected a calendar date written as YYYY-MM-DD.');
/** Semantic Versioning 2.0.0 without build metadata: no leading zeros, so each version has one spelling. */
const semver = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    'Expected a version written as MAJOR.MINOR.PATCH, without leading zeros.',
  );
const packagePath = z.string().refine(isPackagePath, 'Expected a relative path inside the package.');

const projectId = z.string().regex(/^p_[0-9a-f]{16}$/, "Expected a project ID: 'p_' and 16 lowercase hex characters.");
const datasetId = z.string().regex(/^d[1-9]\d*$/, "Expected a dataset ID such as 'd1'.");
const columnId = z.string().regex(/^c(?:0|[1-9]\d*)(?:~[^\s~]+)*$/, "Expected a column ID such as 'c3' or 'c3~kPa'.");
const issueId = z.string().regex(/^I-[0-9a-f]{12}$/, "Expected an issue ID: 'I-' and 12 lowercase hex characters.");
const stepId = z.string().regex(/^s[1-9]\d*$/, "Expected a step ID such as 's1'.");
const exportId = z.string().regex(/^e_[0-9a-f]{8}$/, "Expected an export ID: 'e_' and 8 lowercase hex characters.");

// Not z.json(): it rebuilds objects and drops an own '__proto__' key, so a parsed audit line would
// no longer hash as written, and it lets a reference cycle through. This checks in place instead.
const json: z.ZodType<JsonValue> = z.custom<JsonValue>(
  isJsonValue,
  'Expected a JSON value: null, a boolean, a finite number, a string, an array or a plain object.',
);

const longitude = z.number().min(-180).max(180);
const latitude = z.number().min(-90).max(90);
/** RFC 7946 section 5.2: a west edge east of the east edge means the box crosses the antimeridian. */
const bbox: z.ZodType<BBox> = z
  .tuple([longitude, latitude, longitude, latitude])
  .refine(
    ([, south, , north]) => south <= north,
    'The south edge of a bounding box cannot lie north of its north edge.',
  );

// ---------------------------------------------------------------------------------------------
// Values

const position = z.array(z.number()).min(2);
const geometry: z.ZodType<Geometry> = z.lazy(() =>
  z.union([
    z.strictObject({ type: z.literal('Point'), coordinates: position }),
    z.strictObject({ type: z.enum(['MultiPoint', 'LineString']), coordinates: z.array(position) }),
    z.strictObject({ type: z.enum(['MultiLineString', 'Polygon']), coordinates: z.array(z.array(position)) }),
    z.strictObject({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(z.array(position))) }),
    z.strictObject({ type: z.literal('GeometryCollection'), geometries: z.array(geometry) }),
  ]),
);
const dateCell = z.strictObject({ date: calendarDate });
const dateTimeCell = z.strictObject({ datetime: isoUtc });
const cellValue = z.union([
  z.null(),
  z.string(),
  z.number(),
  z.boolean(),
  dateCell,
  dateTimeCell,
  z.strictObject({ geometry }),
]);

// ---------------------------------------------------------------------------------------------
// Uniqueness refinements

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated];
}

/** Adds one issue per repeated key at `path`, so a manifest cannot list the same thing twice. */
function requireUnique<T>(path: string, key: (item: T) => string) {
  return (items: readonly T[], ctx: z.RefinementCtx): void => {
    for (const value of duplicates(items.map(key))) {
      ctx.addIssue({ code: 'custom', path: [path], message: `Duplicate ${path} entry: ${value}.` });
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Audit entry

const conversionMethod = z.strictObject({
  from: nonEmpty,
  to: nonEmpty,
  fromFactor: positive,
  fromOffset: z.number(),
  toFactor: positive,
  toOffset: z.number(),
  formula: nonEmpty,
  source: nonEmpty,
  registryVersion: nonEmpty,
});

const actor = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), profileId: nonEmpty, name: nonEmpty, role: z.literal('Analyst') }),
  z.strictObject({ kind: z.literal('system'), component: z.enum(['detector', 'engine']) }),
]);

const auditTarget = z.strictObject({
  datasetId: datasetId.exactOptional(),
  rowId: rowId.exactOptional(),
  columnId: columnId.exactOptional(),
  issueId: issueId.exactOptional(),
  stepId: stepId.exactOptional(),
  seq: auditSeq.exactOptional(),
  fileId: sha256.exactOptional(),
  locator: z.string().exactOptional(),
});

const auditEntry = z.strictObject({
  seq: auditSeq,
  at: isoUtc,
  actor,
  action: z.enum(AUDIT_ACTIONS),
  target: auditTarget,
  old: json.exactOptional(),
  new: json.exactOptional(),
  reason: z.string().exactOptional(),
  method: conversionMethod.exactOptional(),
  rule: z.strictObject({ id: nonEmpty, version: semver }).exactOptional(),
  payload: json.exactOptional(),
  prev: sha256,
  hash: sha256,
});

// ---------------------------------------------------------------------------------------------
// Rule-pack

// A selector names at least one filter and no filter is an empty list. Both {} and { roles: [] }
// could be read as "every column" or as "no column", and the two engines must not disagree on it.
const columnSelector = z.union([
  z.strictObject({ dataset: z.literal(true) }),
  z
    .strictObject({
      roles: z.array(z.enum(COLUMN_ROLES)).min(1).exactOptional(),
      types: z.array(z.enum(LOGICAL_TYPES)).min(1).exactOptional(),
      quantities: z.array(z.enum(QUANTITY_KINDS)).min(1).exactOptional(),
      all: z.literal(true).exactOptional(),
    })
    .refine((s) => Object.keys(s).length > 0, 'Name at least one filter, or use { all: true } for every column.'),
]);

const checkSpec = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(SIMPLE_CHECK_KINDS) }),
  z.strictObject({ kind: z.literal('ts_gap'), factor: positive }),
  z.strictObject({ kind: z.literal('flatline'), minRun: z.int().min(2) }),
  z.strictObject({ kind: z.literal('spike'), window: z.int().min(1), k: positive }),
  z.strictObject({ kind: z.literal('import_note'), code: z.enum([...IMPORT_NOTE_CODES, 'TW-IMP-005', 'TW-IMP-006']) }),
]);

const ruleDef = z.strictObject({
  id: nonEmpty,
  version: semver,
  title: nonEmpty,
  category: z.enum(RULE_CATEGORIES),
  severity: z.enum(SEVERITIES),
  appliesTo: columnSelector,
  check: checkSpec,
  message: nonEmpty,
  explanation: nonEmpty,
  source: nonEmpty,
});

const rulePack = z
  .strictObject({ id: nonEmpty, version: semver, title: nonEmpty, source: nonEmpty, rules: z.array(ruleDef) })
  .superRefine((pack, ctx) => requireUnique<z.output<typeof ruleDef>>('rules', (r) => r.id)(pack.rules, ctx));

// ---------------------------------------------------------------------------------------------
// Steps

const predicateValue = z.union([z.string(), z.number(), z.boolean(), dateCell, dateTimeCell]);
const predicate: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(predicate) }),
    z.strictObject({ any: z.array(predicate) }),
    z.strictObject({ not: predicate }),
    z.strictObject({ column: columnId, op: z.enum(['eq', 'ne', 'lt', 'le', 'gt', 'ge']), value: predicateValue }),
    z.strictObject({ column: columnId, op: z.literal('between'), low: predicateValue, high: predicateValue }),
    z.strictObject({ column: columnId, op: z.literal('in'), values: z.array(z.union([z.string(), z.number()])) }),
    z.strictObject({
      column: columnId,
      op: z.literal('contains'),
      text: z.string(),
      caseSensitive: z.boolean().exactOptional(),
    }),
    z.strictObject({ column: columnId, op: z.enum(['is_null', 'not_null']) }),
    z.strictObject({ bbox, geometry: columnId }),
    z.strictObject({ bbox, lat: columnId, lon: columnId }),
  ]),
);

const convertUnitStep = z.strictObject({
  kind: z.literal('convert_unit'),
  columnId,
  toUnit: nonEmpty,
  mode: z.enum(['replace', 'add_column']),
});
const filterStep = z.strictObject({ kind: z.literal('filter'), predicate, label: z.string().exactOptional() });
const selectColumnsStep = z.strictObject({
  kind: z.literal('select_columns'),
  columnIds: z
    .array(columnId)
    .min(1)
    .refine((ids) => duplicates(ids).length === 0, 'Each column can be selected only once.'),
});

const stepInput = z.discriminatedUnion('kind', [convertUnitStep, filterStep, selectColumnsStep]);

const stepIdentity = { id: stepId, seq: auditSeq };
const step = z.discriminatedUnion('kind', [
  convertUnitStep.extend(stepIdentity),
  filterStep.extend(stepIdentity),
  selectColumnsStep.extend(stepIdentity),
]);

// ---------------------------------------------------------------------------------------------
// Decisions

const rowList = z.array(rowId).min(1);
const cellInput = z.union([z.strictObject({ text: z.string() }), z.strictObject({ value: cellValue })]);

const decision = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('edit_cell'),
    datasetId,
    rowId,
    columnId,
    value: cellInput,
    reason: z.string(),
    issueId: issueId.exactOptional(),
  }),
  z.strictObject({
    kind: z.literal('accept_issue'),
    issueId,
    rows: z.union([z.literal('all'), rowList]),
    reason: z.string(),
  }),
  z.strictObject({
    kind: z.literal('exclude_rows'),
    datasetId,
    rows: z.union([rowList, z.strictObject({ issueId })]),
    reason: z.string(),
  }),
  z.strictObject({ kind: z.literal('comment_issue'), issueId, text: z.string() }),
  z.strictObject({
    kind: z.literal('override_detection'),
    datasetId,
    columnId: columnId.exactOptional(),
    property: z.enum(OVERRIDABLE_PROPERTIES),
    value: json,
    reason: z.string(),
  }),
  z.strictObject({ kind: z.literal('set_project_area'), bbox: bbox.nullable(), reason: z.string() }),
  z.strictObject({ kind: z.literal('revert'), seq: auditSeq, reason: z.string() }),
]);

// ---------------------------------------------------------------------------------------------
// Manifests

const rulePackRef = z.strictObject({ id: nonEmpty, version: semver, sha256 });
/** Two versions of one pack may both be recorded (older check runs used the older one); one version twice may not. */
const packKey = (ref: { id: string; version: string }): string => `${ref.id}@${ref.version}`;
const registryRef = z.strictObject({ version: nonEmpty, sha256 });
const auditHead = z.strictObject({ seq: auditSeq, hash: sha256 });
const originalFileShape = { fileId: sha256, name: nonEmpty, size: count, mediaType: nonEmpty, addedSeq: auditSeq };

const projectManifest = z
  .strictObject({
    format: z.literal('tracewell-project'),
    formatVersion: z.literal('0.1'),
    appVersion: nonEmpty,
    projectId,
    name: nonEmpty,
    createdAt: isoUtc,
    savedAt: isoUtc,
    savedBy: nonEmpty,
    unitSystem: z.enum(['SI', 'Oilfield']),
    projectArea: bbox.nullable(),
    unitRegistry: registryRef,
    rulePacks: z.array(rulePackRef),
    originals: z.array(z.strictObject({ ...originalFileShape, path: packagePath })),
    datasets: z.array(
      z.strictObject({ id: datasetId, name: nonEmpty, rowCount: count, workingDigest: sha256, outputDigest: sha256 }),
    ),
    auditHead,
    entries: z.array(z.strictObject({ path: packagePath, size: count, sha256 })),
  })
  .superRefine((m, ctx) => {
    requireUnique<{ id: string; version: string }>('rulePacks', packKey)(m.rulePacks, ctx);
    requireUnique<{ fileId: string }>('originals', (o) => o.fileId)(m.originals, ctx);
    requireUnique<{ id: string }>('datasets', (d) => d.id)(m.datasets, ctx);
    requireUnique<{ path: string }>('entries', (e) => e.path)(m.entries, ctx);
  });

const assumption = z.strictObject({
  datasetId,
  columnId: columnId.nullable(),
  property: nonEmpty,
  value: json,
  confidence: z.enum(CONFIDENCES),
  evidence: z.string(),
});

const substitution = z.strictObject({
  ruleId: z.literal('TW-EXP-002'),
  what: nonEmpty,
  why: nonEmpty,
  instead: nonEmpty,
});

const validationReport = z
  .strictObject({
    ok: z.boolean(),
    checks: z.array(
      z.strictObject({
        id: z.enum(VALIDATION_CHECK_IDS),
        ok: z.boolean(),
        detail: z.string(),
        file: z.string().exactOptional(),
      }),
    ),
  })
  .refine((r) => !r.ok || r.checks.every((c) => c.ok), {
    message: 'A validation report cannot be ok while one of its checks failed.',
    path: ['ok'],
  })
  // An export is reported as validated only after it was read back, so "ok" with nothing checked is a hidden failure.
  .refine((r) => !r.ok || r.checks.length > 0, {
    message: 'A validation report cannot be ok without any check.',
    path: ['ok'],
  });

const exportColumn = z.strictObject({
  id: columnId,
  name: z.string(),
  header: z.string(),
  type: z.enum(LOGICAL_TYPES),
  unit: z.string().nullable(),
  sha256,
});

const exportManifest = z
  .strictObject({
    format: z.literal('tracewell-export'),
    formatVersion: z.literal('0.1'),
    exportId,
    createdAt: isoUtc,
    appVersion: nonEmpty,
    owner: nonEmpty,
    profile: z.enum(EXPORT_PROFILE_IDS),
    project: z.strictObject({ id: projectId, name: nonEmpty }),
    dataset: z.strictObject({
      id: datasetId,
      name: nonEmpty,
      rowCount: count,
      partial: z.boolean(),
      columns: z.array(exportColumn),
      viewDigest: sha256,
    }),
    sources: z.array(z.strictObject(originalFileShape)),
    rulePacks: z.array(rulePackRef),
    unitRegistry: registryRef,
    steps: z.array(step),
    excludedRows: count,
    openIssues: z.strictObject({ error: count, warning: count, note: count }),
    assumptions: z.array(assumption),
    substitutions: z.array(substitution),
    options: z.strictObject({ neutralizeFormulas: z.boolean() }).exactOptional(),
    files: z.array(z.strictObject({ path: packagePath, size: count, sha256, role: z.enum(EXPORT_FILE_ROLES) })),
    validation: validationReport,
    auditHead,
  })
  .superRefine((m, ctx) => {
    requireUnique<{ id: string; version: string }>('rulePacks', packKey)(m.rulePacks, ctx);
    requireUnique<{ fileId: string }>('sources', (o) => o.fileId)(m.sources, ctx);
    requireUnique<{ id: string }>('steps', (st) => st.id)(m.steps, ctx);
    requireUnique<{ path: string }>('files', (f) => f.path)(m.files, ctx);
    requireUnique<{ id: string }>('columns', (c) => c.id)(m.dataset.columns, ctx);
  });

// ---------------------------------------------------------------------------------------------
// Unit registry

const unitDef = z.strictObject({
  // A derived column is named '<column>~<code>', so a code cannot hold whitespace or '~'.
  code: z.string().regex(/^[^\s~]+$/, "Expected a unit code without whitespace or '~'."),
  label: nonEmpty,
  aliases: z.array(nonEmpty),
  quantity: z.enum(QUANTITY_KINDS),
  toSI: z.strictObject({ factor: positive, offset: z.number() }),
  exact: z.boolean(),
  convention: z.enum(UNIT_CONVENTIONS).nullable(),
  source: nonEmpty,
});

/** Every code and alias must name one unit only; a unit may repeat its own code among its aliases. */
function unitNamesUnique(units: readonly UnitDef[], ctx: z.RefinementCtx): void {
  const names = units.flatMap((u) => [...new Set([u.code, ...u.aliases])]);
  for (const name of duplicates(names)) {
    ctx.addIssue({
      code: 'custom',
      path: ['units'],
      message: `The unit name "${name}" is used by more than one unit.`,
    });
  }
}

const unitRegistry = z
  .strictObject({ version: nonEmpty, units: z.array(unitDef).min(1) })
  .superRefine((r, ctx) => unitNamesUnique(r.units, ctx));

// ---------------------------------------------------------------------------------------------
// Mapping templates (FR-IMP-06)

const templateColumn = z.strictObject({
  sourceHeader: z.array(z.string()).min(1),
  name: nonEmpty,
  type: z.enum(LOGICAL_TYPES),
  unit: nonEmpty.nullable(),
  role: z.enum(COLUMN_ROLES),
  nullMarkers: z.array(z.string()),
  dateFormat: z.enum(DATE_FORMATS).exactOptional(),
  timezone: z.enum(TIMEZONE_MODES).exactOptional(),
});

const mappingTemplate = z.strictObject({
  id: z.string().regex(/^mt_[0-9a-f]{12}$/, "Expected a template ID: 'mt_' and 12 lowercase hex characters."),
  name: nonEmpty,
  savedFrom: z.strictObject({ fileName: nonEmpty, format: z.enum(SOURCE_FORMATS) }),
  columns: z.array(templateColumn).min(1),
  savedAt: isoUtc,
  savedBy: nonEmpty,
});

// ---------------------------------------------------------------------------------------------
// Recipes (FR-RCP-01..03): read from files other people send, so every part is checked

const recipeColumn = z.strictObject({
  key: columnId,
  name: nonEmpty,
  type: z.enum(LOGICAL_TYPES),
  unit: nonEmpty.nullable(),
});

const recipeBaselineIssue = z.strictObject({
  ruleId: nonEmpty,
  columns: z.array(nonEmpty),
  severity: z.enum(SEVERITIES),
  flagged: count,
});

const recipe = z.strictObject({
  format: z.literal('tracewell-recipe'),
  formatVersion: z.literal(1),
  id: z.string().regex(/^rcp_[0-9a-f]{12}$/, "Expected a recipe ID: 'rcp_' and 12 lowercase hex characters."),
  name: nonEmpty,
  version: z.int().min(1),
  savedAt: isoUtc,
  savedBy: nonEmpty,
  appVersion: semver,
  columns: z.array(recipeColumn),
  check: z.strictObject({ packs: z.array(rulePackRef).min(1) }).nullable(),
  steps: z.array(stepInput),
  export: z.strictObject({ profile: z.enum(EXPORT_PROFILE_IDS), neutralizeFormulas: z.boolean() }).nullable(),
  baseline: z.strictObject({ rows: count, issues: z.array(recipeBaselineIssue) }).nullable(),
});

// ---------------------------------------------------------------------------------------------
// Compile-time proof that each schema accepts exactly the shape of its model type

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Proof<T extends true> = T;
type _SchemaProofs = [
  Proof<Same<z.output<typeof auditEntry>, AuditEntry>>,
  Proof<Same<z.output<typeof rulePack>, RulePack>>,
  Proof<Same<z.output<typeof checkSpec>, CheckSpec>>,
  Proof<Same<z.output<typeof stepInput>, StepInput>>,
  Proof<Same<z.output<typeof decision>, Decision>>,
  Proof<Same<z.output<typeof projectManifest>, ProjectManifest>>,
  Proof<Same<z.output<typeof exportManifest>, ExportManifest>>,
  Proof<Same<z.output<typeof unitRegistry>, { version: string; units: UnitDef[] }>>,
  Proof<Same<z.output<typeof mappingTemplate>, MappingTemplate>>,
  Proof<Same<z.output<typeof recipe>, Recipe>>,
];

/**
 * Measures the whole document before any recursive part of a schema walks it. Without this, input
 * nested a few thousand levels deep (which JSON.parse accepts) makes safeParse throw a RangeError
 * instead of returning a failure, and a tampered project file could not even be opened read-only.
 */
function bounded<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return z
    .custom<unknown>(
      (v) => withinDepth(v),
      `Expected a document whose arrays and objects nest at most ${MAX_JSON_DEPTH} levels deep.`,
    )
    .pipe(schema);
}

export const schemas: {
  auditEntry: z.ZodType<AuditEntry>;
  rulePack: z.ZodType<RulePack>;
  stepInput: z.ZodType<StepInput>;
  decision: z.ZodType<Decision>;
  projectManifest: z.ZodType<ProjectManifest>;
  exportManifest: z.ZodType<ExportManifest>;
  unitRegistry: z.ZodType<{ version: string; units: UnitDef[] }>;
  mappingTemplate: z.ZodType<MappingTemplate>;
  recipe: z.ZodType<Recipe>;
} = Object.freeze({
  auditEntry: bounded(auditEntry),
  rulePack: bounded(rulePack),
  stepInput: bounded(stepInput),
  decision: bounded(decision),
  projectManifest: bounded(projectManifest),
  exportManifest: bounded(exportManifest),
  unitRegistry: bounded(unitRegistry),
  mappingTemplate: bounded(mappingTemplate),
  recipe: bounded(recipe),
});
