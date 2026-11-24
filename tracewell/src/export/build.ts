/**
 * The validated export pipeline (SAD section 10.2): plan, write, read back, assemble the package,
 * re-open it and re-verify, and only then report success. On any failure no package is offered.
 */
import { checksumsFile, readZip, sha256Hex, writeZip, type ZipEntryInput } from '@tw/io';
import {
  EngineError,
  canonicalJson,
  schemas,
  type Assumption,
  type AuditEntry,
  type AuditSeq,
  type CrsRef,
  type Detection,
  type ExportManifest,
  type ExportProfileId,
  type ExportResult,
  type IsoUtc,
  type Issue,
  type JobProgress,
  type JsonValue,
  type OriginalFileInfo,
  type ProjectId,
  type RulePackRef,
  type Sha256Hex,
  type Step,
  type ValidationCheck,
} from '@tw/model';
import { esriWkt } from '@tw/geo';
import { columnDigest, viewDigest, type View } from '@tw/table';
import {
  DEFAULT_LIMITS,
  geometrySource,
  knownCrs,
  planExport,
  type DataKind,
  type ExportLimits,
  type ExportPlan,
} from './plan';
import { headerFor } from './profiles';
import { readBack, type ShapefileParts } from './readback';
import { issuesCsv, renderReadme } from './readme';
import { expectedShape, type ExpectedShape } from './shape';
import { analyseFgb, expectedFgbGeometries, fgbColumns, fgbCrs, fgbFeatures } from './flatgeobuf';
import { expectedKmlGeometries, placemarks } from './kml';
import {
  analyseShapes,
  dbfFields,
  expectedShapes,
  shapeRecords,
  shapeSource,
  type ShapeAnalysis,
  type ShapeSource,
} from './shapefile';
import {
  DEFAULT_WRITERS,
  csvHeader,
  csvRows,
  dataSheet,
  features,
  parquetColumns,
  keyValueSheet,
  logSheet,
  type ExportWriters,
} from './writers';

export interface ExportInput {
  exportId: string;
  baseName: string;
  profile: ExportProfileId;
  at: IsoUtc;
  appVersion: string;
  owner: string;
  project: { id: ProjectId; name: string };
  view: View;
  crs: Detection<CrsRef> | null;
  sources: OriginalFileInfo[];
  rulePacks: RulePackRef[];
  unitRegistry: { version: string; sha256: Sha256Hex };
  steps: Step[];
  stepDescriptions: string[];
  excludedRows: number;
  assumptions: Assumption[];
  issues: Issue[];
  audit: readonly AuditEntry[];
  auditHead: { seq: AuditSeq; hash: Sha256Hex };
  /** CSV data files: prefix an apostrophe to text a spreadsheet would run as a formula. */
  neutralizeFormulas?: boolean;
  /** Format limits; only tests lower them. */
  limits?: ExportLimits;
}

const encoder = new TextEncoder();

function cancelled(): EngineError {
  return new EngineError('CANCELLED', 'The export was cancelled.', 'Start the export again when you are ready.');
}

// Characters file systems refuse, plus control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[<>:"/\\|?*\u0000-\u001f]/g;

function safeBase(name: string): string {
  const cleaned = name
    .replace(UNSAFE_NAME, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return cleaned === '' ? 'export' : cleaned.slice(0, 80);
}

function openIssues(issues: Issue[]): ExportManifest['openIssues'] {
  const out = { error: 0, warning: 0, note: 0 };
  for (const i of issues) if (i.status !== 'resolved') out[i.severity]++;
  return out;
}

function reportRows(input: ExportInput, plan: ExportPlan, shape: ExpectedShape): [string, string][] {
  const open = openIssues(input.issues);
  return [
    ['Project', `${input.project.name} (${input.project.id})`],
    ['Dataset', `${input.view.schema.name} (${input.view.schema.datasetId}), ${input.view.rowCount} rows`],
    ['Export', `${input.exportId}, profile ${input.profile}, created ${input.at} by ${input.owner}`],
    ...input.sources.map((s): [string, string] => ['Source', `${s.name}, ${s.size} bytes, SHA-256 ${s.fileId}`]),
    ...input.rulePacks.map((r): [string, string] => ['Rule pack', `${r.id} ${r.version}, SHA-256 ${r.sha256}`]),
    ['Unit registry', `${input.unitRegistry.version}, SHA-256 ${input.unitRegistry.sha256}`],
    ...input.stepDescriptions.map((d, i): [string, string] => [`Step ${i + 1}`, d]),
    ['Excluded rows', String(input.excludedRows)],
    ...input.assumptions.map((a): [string, string] => [
      'Assumption',
      `${a.columnId ?? 'dataset'} ${a.property} = ${JSON.stringify(a.value)} (${a.confidence})`,
    ]),
    ['Open issues', `errors ${open.error}, warnings ${open.warning}, notes ${open.note}`],
    ...plan.substitutions.map((s): [string, string] => [s.ruleId, `${s.what}. ${s.why} ${s.instead}`]),
    ...shape.columns.map((c): [string, string] => [`Column digest ${c.header}`, c.sha256]),
  ];
}

interface WrittenFile {
  path: string;
  kind: DataKind;
  bytes: Uint8Array;
  shape: ExpectedShape;
  /** The other files of a data file in several parts: a Shapefile's .shx, .dbf and the rest. */
  companions: { path: string; bytes: Uint8Array }[];
}

/** The CRS of the data and where its geometries come from; the plan has accepted both. */
function shapeSourceOf(input: ExportInput): { code: string; source: ShapeSource } {
  const code = knownCrs(input.crs) as string;
  return { code, source: shapeSource(input.view, code) as ShapeSource };
}

/** Where a Shapefile's shapes come from and what they make; the plan has accepted them. */
function shapesOf(input: ExportInput): { code: string; source: ShapeSource; shapes: ShapeAnalysis } {
  const { code, source } = shapeSourceOf(input);
  return { code, source, shapes: analyseShapes(input.view, source) };
}

function* rowValues(view: View, columns: string[]) {
  for (const r of view.rows()) yield columns.map((c) => view.value(r, c));
}

function writeFiles(input: ExportInput, plan: ExportPlan, writers: ExportWriters): WrittenFile[] {
  const view = input.view;
  return plan.dataFiles.map((f): WrittenFile => {
    const shape = expectedShape(view, f.columns);
    const one = { ...f, shape, companions: [] };
    switch (f.kind) {
      case 'shapefile': {
        const { code, source, shapes } = shapesOf(input);
        const fields = dbfFields(
          view,
          f.columns.map((id) => view.columnSchema(id)),
        );
        const written = writers.shapefile({
          shapeType: shapes.shapeType,
          z: shapes.z,
          records: shapeRecords(view, source, shapes),
          fields,
          rows: rowValues(view, f.columns),
          at: input.at,
        });
        const fieldList = writers.csv(
          ['field', 'name', 'unit', 'type'],
          fields.map((x) => [x.name, x.column.name, x.column.unit.value ?? '', x.column.type.value]),
        );
        return {
          ...one,
          bytes: written.shp,
          companions: [
            { path: 'data.shx', bytes: written.shx },
            { path: 'data.dbf', bytes: written.dbf },
            { path: 'data.prj', bytes: encoder.encode(esriWkt(code) ?? '') },
            { path: 'data.cpg', bytes: encoder.encode('UTF-8') },
            { path: 'data.fields.csv', bytes: fieldList },
          ],
        };
      }
      case 'kml': {
        const source = geometrySource(view) ?? 'latlon';
        const columns = f.columns.map((id) => view.columnSchema(id));
        return { ...one, bytes: writers.kml(view.schema.name, placemarks(view, source, columns)) };
      }
      case 'flatgeobuf': {
        const { code, source } = shapeSourceOf(input);
        const a = analyseFgb(view, source);
        const columns = f.columns.map((id) => view.columnSchema(id));
        const header = {
          name: view.schema.name,
          envelope: a.envelope,
          geometryType: a.geometryType,
          hasZ: a.hasZ,
          columns: fgbColumns(columns),
          featuresCount: view.rowCount,
          crs: fgbCrs(code),
        };
        return { ...one, bytes: writers.flatgeobuf(header, fgbFeatures(view, source, columns)) };
      }
      case 'csv':
        return {
          ...one,
          bytes: writers.csv(csvHeader(view, f.columns), csvRows(view, f.columns, input.neutralizeFormulas === true)),
        };
      case 'parquet':
        return { ...one, bytes: writers.parquet(parquetColumns(view, f.columns)) };
      case 'geojson': {
        const source = geometrySource(view) ?? 'latlon';
        return { ...one, bytes: writers.geojson(features(view, source)) };
      }
      case 'xlsx': {
        const sheets = [
          ...(f.columns.length > 0 ? [dataSheet(view, f.columns)] : []),
          keyValueSheet('Report', reportRows(input, plan, expectedShape(view))),
          logSheet(input.audit),
        ];
        return {
          ...one,
          bytes: writers.xlsx({ sheets, created: input.at, creator: input.owner, title: input.view.schema.name }),
        };
      }
    }
  });
}

/** The files of a written data file, as a reader finds them by path. */
function partsOf(file: WrittenFile): (path: string) => Uint8Array | undefined {
  return (path) => (path === file.path ? file.bytes : file.companions.find((c) => c.path === path)?.bytes);
}

async function validateFile(
  file: WrittenFile,
  read: (path: string) => Uint8Array | undefined,
  input: ExportInput,
): Promise<ValidationCheck[]> {
  const bytes = read(file.path) ?? new Uint8Array(0);
  switch (file.kind) {
    case 'kml':
      return readBack.kml(bytes, file.shape, file.path, {
        documentName: input.view.schema.name,
        geometrySha256: columnDigest(expectedKmlGeometries(input.view, geometrySource(input.view) ?? 'latlon')),
      });
    case 'flatgeobuf': {
      const { code, source } = shapeSourceOf(input);
      const a = analyseFgb(input.view, source);
      return readBack.flatgeobuf(bytes, file.shape, file.path, {
        name: input.view.schema.name,
        geometryType: a.geometryType,
        hasZ: a.hasZ,
        crs: fgbCrs(code),
        geometrySha256: columnDigest(expectedFgbGeometries(input.view, source)),
      });
    }
    case 'shapefile': {
      const { code, source, shapes } = shapesOf(input);
      const parts: ShapefileParts = {
        shp: read('data.shp'),
        shx: read('data.shx'),
        dbf: read('data.dbf'),
        prj: read('data.prj'),
        cpg: read('data.cpg'),
        fields: read('data.fields.csv'),
      };
      return readBack.shapefile(parts, file.shape, {
        prj: esriWkt(code) ?? '',
        shapeType: shapes.shapeType,
        geometrySha256: columnDigest(expectedShapes(input.view, source, shapes)),
      });
    }
    case 'csv':
      return readBack.csv(bytes, file.shape, file.path, { neutralized: input.neutralizeFormulas === true });
    case 'parquet':
      return readBack.parquet(bytes, file.shape, file.path);
    case 'xlsx':
      return readBack.xlsx(bytes, file.shape, file.path, {
        expectData: file.shape.columns.length > 0,
        expectedLogRows: input.audit.length,
      });
    case 'geojson': {
      const view = input.view;
      const source = geometrySource(view) ?? 'latlon';
      const lat = view.schema.columns.find((c) => c.role.value === 'latitude');
      const lon = view.schema.columns.find((c) => c.role.value === 'longitude');
      return readBack.geojson(bytes, file.shape, file.path, {
        geometryFrom: source,
        ...(view.schema.geometryColumn === null ? {} : { geometryColumn: view.schema.geometryColumn }),
        ...(lat === undefined ? {} : { latHeader: headerFor(lat) }),
        ...(lon === undefined ? {} : { lonHeader: headerFor(lon) }),
      });
    }
  }
}

export async function buildExport(
  input: ExportInput,
  ctx: { signal: AbortSignal; onProgress(p: JobProgress): void },
  writers: ExportWriters = DEFAULT_WRITERS,
): Promise<ExportResult> {
  const plan = planExport(input.view, input.profile, input.crs, input.limits ?? DEFAULT_LIMITS);
  if (!plan.available) {
    throw new EngineError(
      'EXPORT_REFUSED',
      plan.reason ?? 'This export is not available.',
      plan.fix ?? 'Choose another export profile.',
      {
        profile: input.profile,
      },
    );
  }
  const step = (phase: string, done: number) => {
    if (ctx.signal.aborted) throw cancelled();
    ctx.onProgress({ phase, done, total: 4, unit: 'items' });
  };

  step('Writing', 0);
  const files = writeFiles(input, plan, writers);
  await Promise.resolve();
  step('Reading back', 1);
  const dataChecks = (await Promise.all(files.map((f) => validateFile(f, partsOf(f), input)))).flat();
  const written = files.flatMap((f) => [{ path: f.path, bytes: f.bytes }, ...f.companions]);

  const readmeFile = 'README.txt';
  const auditText = input.audit.map((e) => `${canonicalJson(e as unknown as JsonValue)}\n`).join('');
  const issuesBytes = issuesCsv(input.issues);
  const auditBytes = encoder.encode(auditText);
  const digest = viewDigest(input.view);
  const shape = expectedShape(input.view);
  const entry = (path: string, bytes: Uint8Array, role: ExportManifest['files'][number]['role']) => ({
    path,
    size: bytes.length,
    sha256: sha256Hex(bytes),
    role,
  });
  const validation = { ok: dataChecks.every((c) => c.ok) && dataChecks.length > 0, checks: dataChecks };
  const manifestBase: Omit<ExportManifest, 'files'> = {
    format: 'tracewell-export',
    formatVersion: '0.1',
    exportId: input.exportId,
    createdAt: input.at,
    appVersion: input.appVersion,
    owner: input.owner,
    profile: input.profile,
    project: input.project,
    dataset: {
      id: input.view.schema.datasetId,
      name: input.view.schema.name,
      rowCount: input.view.rowCount,
      partial: input.view.schema.partial,
      columns: shape.columns,
      viewDigest: digest.sha256,
    },
    sources: input.sources,
    rulePacks: input.rulePacks,
    unitRegistry: input.unitRegistry,
    steps: input.steps,
    excludedRows: input.excludedRows,
    openIssues: openIssues(input.issues),
    assumptions: input.assumptions,
    substitutions: plan.substitutions,
    options: { neutralizeFormulas: input.neutralizeFormulas === true },
    validation,
    auditHead: input.auditHead,
  };
  const draftManifest: ExportManifest = { ...manifestBase, files: [] };
  const readmeBytes = encoder.encode(renderReadme(draftManifest, input.stepDescriptions));
  const manifest: ExportManifest = {
    ...manifestBase,
    files: [
      ...written.map((f) => entry(f.path, f.bytes, 'data')),
      entry(readmeFile, readmeBytes, 'readme'),
      entry('audit.jsonl', auditBytes, 'audit'),
      entry('issues.csv', issuesBytes, 'issues'),
    ],
  };
  const checkedManifest = schemas.exportManifest.safeParse(manifest);
  if (!checkedManifest.success) {
    throw new EngineError(
      'INTERNAL',
      `The export manifest is not valid: ${checkedManifest.error.issues[0]?.message ?? 'invalid'}.`,
      'Report this problem; the export was not written.',
    );
  }
  const manifestBytes = encoder.encode(`${canonicalJson(manifest as unknown as JsonValue)}\n`);

  step('Packaging', 2);
  const entries: ZipEntryInput[] = [
    ...written.map((f) => ({ path: f.path, data: f.bytes })),
    { path: readmeFile, data: readmeBytes },
    { path: 'manifest.json', data: manifestBytes },
    { path: 'audit.jsonl', data: auditBytes },
    { path: 'issues.csv', data: issuesBytes },
  ];
  const sums = checksumsFile(entries.map((e) => ({ path: e.path, sha256: sha256Hex(e.data) })));
  const zip = writeZip([...entries, { path: 'CHECKSUMS.sha256', data: encoder.encode(sums) }], { sort: true });

  step('Verifying the package', 3);
  const packageChecks = readBack.package(zip, manifest);
  const reopened = readZip(zip);
  const insideChecks = (
    await Promise.all(
      files.map((f) =>
        reopened.has(f.path)
          ? validateFile(f, (p) => (reopened.has(p) ? reopened.read(p) : undefined), input)
          : Promise.resolve<ValidationCheck[]>([]),
      ),
    )
  ).flat();
  const checks = [
    ...dataChecks,
    ...packageChecks,
    ...insideChecks.map((c) => ({ ...c, file: `package:${c.file ?? ''}` })),
  ];
  const ok = checks.every((c) => c.ok);
  ctx.onProgress({ phase: 'Done', done: 4, total: 4, unit: 'items' });

  const packageName = `${safeBase(input.baseName)}-${input.exportId}.zip`;
  return {
    exportId: input.exportId,
    ok,
    packageName,
    packageSha256: ok ? sha256Hex(zip) : null,
    size: ok ? zip.length : 0,
    ...(ok ? { bytes: zip } : {}),
    manifest,
    validation: { ok, checks },
  };
}
