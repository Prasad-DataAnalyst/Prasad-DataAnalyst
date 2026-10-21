/**
 * The stub's export, save and open. The stub writes plain text files that say what they are, not
 * real packages or .twp archives, and it reports canned verification results: it exists so the UI
 * can be built, and nothing it writes should be mistaken for verified output.
 */
import {
  canonicalCell,
  canonicalJson,
  canonicalNumber,
  EngineError,
  utf8,
  type CellValue,
  type ExportColumn,
  type ExportManifest,
  type ExportProfile,
  type ExportProfileStatus,
  type ExportRequest,
  type ExportResult,
  type FileTarget,
  type IntegrityCheck,
  type IntegrityCheckId,
  type ProjectOpenReport,
  type SaveResult,
  type ValidationReport,
} from '@tw/model';
import {
  STUB_ENGINE_VERSION,
  STUB_OWNER,
  STUB_PROFILES,
  STUB_REGISTRY_REF,
  STUB_RULE_PACK_REF,
  stubHex,
} from './stub-data';
import { asJson, type StubProject } from './stub-project';
import { outputView, workingView, type StubDataset, type StubView, type ViewColumn } from './stub-view';

const NO_GEOMETRY_REASON = 'The dataset has no geometry column and no latitude/longitude columns.';
const NO_GEOMETRY_FIX = 'Set the roles of the latitude and longitude columns, or export as Excel or CSV.';
const CANNED = 'Stub engine: canned result; nothing was read back or verified.';

/** Keeps letters, digits, '-' and '_' so the name is safe on every file system. */
function safeName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned === '' ? 'tracewell' : cleaned;
}

/** The stub has no file system, so it can only hand bytes back to the caller. */
export function requireReturnBytes(target: FileTarget | undefined, what: string): void {
  if (target !== undefined && target.kind !== 'return-bytes') {
    throw new EngineError(
      'INVALID_INPUT',
      `The stub engine cannot write ${what} to ${target.path}: it has no file system.`,
      'Ask for the bytes instead (target kind return-bytes), or use the full engine.',
    );
  }
}

function hasCoordinates(ds: StubDataset): boolean {
  const roles = new Set(ds.columns.map((c) => c.role.value));
  return roles.has('geometry') || (roles.has('latitude') && roles.has('longitude'));
}

function profile(id: ExportProfile['id']): ExportProfile {
  const found = STUB_PROFILES.find((p) => p.id === id);
  if (found === undefined) {
    throw new EngineError(
      'NOT_FOUND',
      `There is no export profile ${String(id)}.`,
      'Choose a profile listed in the Export centre.',
    );
  }
  return found;
}

export function profileStatuses(ds: StubDataset): ExportProfileStatus[] {
  return STUB_PROFILES.map((p) => {
    const status: ExportProfileStatus = { profile: structuredClone(p), available: true, substitutions: [] };
    if (p.id === 'geojson' && !hasCoordinates(ds)) {
      Object.assign(status, { available: false, reason: NO_GEOMETRY_REASON, fix: NO_GEOMETRY_FIX });
    }
    return status;
  });
}

function cellText(v: CellValue): string {
  if (v === null) return '';
  if (typeof v === 'number') return canonicalNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  if ('date' in v) return v.date;
  if ('datetime' in v) return v.datetime;
  return cellText(JSON.stringify(v.geometry));
}

function header(c: ViewColumn): string {
  const unit = c.schema.unit.value;
  return unit === null ? c.schema.name : `${c.schema.name} [${unit}]`;
}

function csvText(view: StubView): string {
  const lines = [view.columns.map((c) => cellText(header(c))).join(',')];
  for (const r of view.rows) lines.push(view.columns.map((c) => cellText(c.value(r))).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** A stand-in for the column digest of SAD section 9.4, built from the same canonical cells. */
function columnDigest(c: ViewColumn, view: StubView): string {
  return stubHex(view.rows.map((r) => canonicalCell(c.value(r))).join('\n'));
}

function viewDigest(view: StubView): string {
  return stubHex(view.columns.map((c) => `${c.schema.id}:${columnDigest(c, view)}`).join('\n'));
}

function exportColumns(view: StubView): ExportColumn[] {
  return view.columns.map((c) => ({
    id: c.schema.id,
    name: c.schema.name,
    header: header(c),
    type: c.schema.type.value,
    unit: c.schema.unit.value,
    sha256: columnDigest(c, view),
  }));
}

function cannedValidation(dataFile: string): ValidationReport {
  const ids = ['RB-OPEN', 'RB-ROWS', 'RB-HEADER', 'RB-VALUES', 'RB-PKG-CHECKSUMS'] as const;
  return { ok: true, checks: ids.map((id) => ({ id, ok: true, detail: CANNED, file: dataFile })) };
}

/** Checks the request now and returns the job body; refusals the real engine finds while exporting fail the job. */
export function planExport(project: StubProject, ds: StubDataset, req: ExportRequest): () => ExportResult {
  requireReturnBytes(req.target, 'the export');
  const p = profile(req.profile);
  return () => {
    project.assertWritable();
    if (p.id === 'geojson' && !hasCoordinates(ds)) {
      throw new EngineError('EXPORT_REFUSED', `GeoJSON export refused: ${NO_GEOMETRY_REASON}`, NO_GEOMETRY_FIX);
    }
    return writeExport(project, ds, p, safeName(req.baseName ?? ds.name));
  };
}

function writeExport(project: StubProject, ds: StubDataset, p: ExportProfile, base: string): ExportResult {
  const view = outputView(ds);
  const data = csvText(view);
  const dataFile = `${base}${p.dataExtension}`;
  const exportId = `e_${stubHex(`export:${project.id}:${project.exports.length + 1}`, 8)}`;
  const manifest: ExportManifest = {
    format: 'tracewell-export',
    formatVersion: '0.1',
    exportId,
    createdAt: project.now(),
    appVersion: STUB_ENGINE_VERSION,
    owner: STUB_OWNER,
    profile: p.id,
    project: { id: project.id, name: project.name },
    dataset: {
      id: ds.id,
      name: ds.name,
      rowCount: view.rows.length,
      partial: false,
      columns: exportColumns(view),
      viewDigest: viewDigest(view),
    },
    sources: project.originals(),
    rulePacks: ds.checked ? [STUB_RULE_PACK_REF] : [],
    unitRegistry: { ...STUB_REGISTRY_REF },
    steps: ds.steps.map((s) => structuredClone(s)),
    excludedRows: ds.excluded.size,
    openIssues: project.openIssueCounts(ds.id),
    assumptions: project.assumptions(ds),
    substitutions: [],
    files: [{ path: dataFile, size: utf8(data).byteLength, sha256: stubHex(data), role: 'data' }],
    validation: cannedValidation(dataFile),
    auditHead: project.head(),
  };
  const text = [
    'Tracewell stub engine export, for user interface development only.',
    'This is not a validated export package: nothing was read back or verified.',
    `Profile: ${p.label}. Dataset: ${ds.name} (${ds.id}).`,
    '',
    data,
  ].join('\r\n');
  const bytes = utf8(text);
  const packageName = `${base}.${p.id}.stub.txt`;
  const packageSha256 = stubHex(text);
  const entry = project.append({
    action: 'export.create',
    target: { datasetId: ds.id },
    new: { exportId, profile: p.id, packageName, packageSha256 },
    payload: { rows: view.rows.length, columns: view.columns.length },
  });
  project.exports.push({
    exportId,
    profile: p.id,
    datasetId: ds.id,
    packageName,
    packageSha256,
    createdAt: entry.at,
    ok: true,
  });
  return {
    exportId,
    ok: true,
    packageName,
    packageSha256,
    size: bytes.byteLength,
    bytes,
    manifest,
    validation: manifest.validation,
  };
}

export function planSave(project: StubProject, target: FileTarget | undefined): () => SaveResult {
  requireReturnBytes(target, 'the project');
  return () => {
    project.assertWritable();
    const datasets = [...project.datasets.values()].map((ds) => ({
      id: ds.id,
      workingDigest: viewDigest(workingView(ds)),
      outputDigest: viewDigest(outputView(ds)),
    }));
    const fileName = `${safeName(project.name)}.twp`;
    const entry = project.append({ action: 'project.save', target: {}, new: { fileName }, payload: { datasets } });
    project.lastSavedAt = entry.at;
    const text = canonicalJson(
      asJson({
        format: 'tracewell-stub-project',
        note: 'Written by the Tracewell stub engine for user interface development; this is not a .twp project file.',
        project: project.summary(),
        audit: project.audit,
      }),
    );
    const bytes = utf8(text);
    return { fileName, size: bytes.byteLength, sha256: stubHex(text), bytes };
  };
}

const INTEGRITY_CHECKS: readonly IntegrityCheckId[] = [
  'zip',
  'mimetype',
  'format-version',
  'manifest-schema',
  'entry-checksum',
  'original-checksum',
  'audit-chain',
  'replay-digest',
];

/**
 * The open report for the canned project. A file whose name contains "tamper" opens read-only
 * with a failed audit-chain check, so the read-only mode of the UI can be developed too.
 */
export function openReport(project: StubProject, fileName: string): ProjectOpenReport {
  const tampered = /tamper/i.test(fileName);
  project.readOnly = tampered;
  const checks: IntegrityCheck[] = INTEGRITY_CHECKS.map((id) =>
    tampered && id === 'audit-chain'
      ? {
          id,
          ok: false,
          target: 'audit.jsonl',
          ruleId: 'TW-PRJ-002',
          detail: 'Stub engine: canned failure for a file named "tamper".',
        }
      : { id, ok: true, detail: CANNED },
  );
  return { project: project.summary(), readOnly: tampered, checks };
}
