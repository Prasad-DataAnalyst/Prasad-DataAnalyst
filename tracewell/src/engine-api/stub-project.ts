/**
 * The stub's project state: datasets, issues, exports and an audit log chained like the real one.
 * Every change goes through append(), and changes that can be reverted register how to undo them.
 */
import {
  AUDIT_GENESIS_PREFIX,
  canonicalJson,
  EngineError,
  type Actor,
  type AuditDraft,
  type AuditEntry,
  type AuditSeq,
  type BBox,
  type ChainReport,
  type CheckSummary,
  type ColumnId,
  type DatasetId,
  type DatasetSummary,
  type ExportRecord,
  type IsoUtc,
  type IssueId,
  type JsonValue,
  type OriginalFileInfo,
  type ProjectId,
  type ProjectSummary,
  type RowId,
  type Severity,
  type TableSchema,
  type UserProfile,
} from '@tw/model';
import {
  assumptionsOf,
  SOURCE_FILE,
  sourceColumns,
  STUB_EPOCH_MS,
  STUB_RULE_PACK,
  STUB_RULE_PACK_REF,
  stubHex,
} from './stub-data';
import { mergeFindings, openRows, runRules, type StubIssue } from './stub-issues';
import { outputView, rowCount, viewOf, workingView, type StubDataset } from './stub-view';

/** Stub time: one second per reading, from a fixed instant, so every run is identical. */
export class StubClock {
  private ticks = 0;

  now(): IsoUtc {
    return new Date(STUB_EPOCH_MS + 1000 * this.ticks++).toISOString();
  }
}

const DETECTOR: Actor = { kind: 'system', component: 'detector' };

/** Model types are JSON data by construction; this states it where the compiler cannot see it. */
export function asJson(v: unknown): JsonValue {
  return v as JsonValue;
}

function entryHash(body: Omit<AuditEntry, 'hash'>): string {
  return stubHex(canonicalJson(asJson(body)));
}

export class StubProject {
  readonly datasets = new Map<DatasetId, StubDataset>();
  readonly issues = new Map<IssueId, StubIssue>();
  readonly audit: AuditEntry[] = [];
  readonly exports: ExportRecord[] = [];
  /** How to undo each revertible entry; an entry leaves the map when it is reverted. */
  readonly undo = new Map<AuditSeq, () => void>();
  readonly createdAt: IsoUtc;
  area: BBox | null = null;
  dirty = false;
  lastSavedAt: IsoUtc | null = null;
  private steps = 0;

  constructor(
    private readonly clock: StubClock,
    readonly id: ProjectId,
    public name: string,
    public profile: UserProfile,
    public unitSystem: 'SI' | 'Oilfield',
  ) {
    const created = this.append({ action: 'project.create', target: {}, new: asJson({ name, unitSystem, profile }) });
    this.createdAt = created.at;
  }

  now(): IsoUtc {
    return this.clock.now();
  }

  nextStepId(): string {
    return `s${++this.steps}`;
  }

  private user(): Actor {
    return { kind: 'user', profileId: this.profile.id, name: this.profile.name, role: this.profile.role };
  }

  append(draft: AuditDraft, actor: Actor = this.user()): AuditEntry {
    const prev = this.audit[this.audit.length - 1]?.hash ?? stubHex(AUDIT_GENESIS_PREFIX + this.id);
    const body = { ...draft, seq: this.audit.length + 1, at: this.clock.now(), actor, prev };
    const entry: AuditEntry = { ...body, hash: entryHash(body) };
    this.audit.push(entry);
    this.dirty = draft.action !== 'project.save';
    return entry;
  }

  verify(): ChainReport {
    let prev = stubHex(AUDIT_GENESIS_PREFIX + this.id);
    for (const entry of this.audit) {
      const { hash, ...body } = entry;
      if (body.prev !== prev || entryHash(body) !== hash) {
        return { ok: false, entries: this.audit.length, brokenAt: entry.seq, reason: `Entry ${entry.seq} does not match the chain.` };
      }
      prev = hash;
    }
    return { ok: true, entries: this.audit.length };
  }

  dataset(id: DatasetId): StubDataset {
    const ds = this.datasets.get(id);
    if (ds === undefined) {
      throw new EngineError('NOT_FOUND', `There is no dataset ${id} in this project.`, 'Choose a dataset from the project tree.');
    }
    return ds;
  }

  issue(id: IssueId): StubIssue {
    const issue = this.issues.get(id);
    if (issue === undefined) {
      throw new EngineError('NOT_FOUND', `There is no issue ${id} in this project.`, 'Run the checks again and choose an issue from the register.');
    }
    return issue;
  }

  /** Adds the canned file as a new dataset, logging source.add and detection.assume as an import does. */
  addCannedDataset(name: string): StubDataset {
    const id = `d${this.datasets.size + 1}`;
    const ds: StubDataset = { id, name, columns: sourceColumns(), edits: new Map(), excluded: new Map(), steps: [], checked: false };
    this.datasets.set(id, ds);
    this.append({
      action: 'source.add',
      target: { datasetId: id, fileId: SOURCE_FILE.fileId },
      new: { name, fileName: SOURCE_FILE.name, rows: rowCount() },
      payload: { format: 'csv' },
    });
    this.append({ action: 'detection.assume', target: { datasetId: id }, payload: asJson({ assumptions: assumptionsOf(id, ds.columns) }) }, DETECTOR);
    return ds;
  }

  runChecks(ds: StubDataset): CheckSummary {
    const entry = this.append({
      action: 'check.run',
      target: { datasetId: ds.id },
      payload: asJson({ packs: [STUB_RULE_PACK_REF] }),
    });
    ds.checked = true;
    this.recheck(ds, entry.seq);
    return this.checkSummary(ds);
  }

  /** Re-runs the rules after a change, once checks have run on the dataset (SAD section 7.7). */
  afterChange(ds: StubDataset, seq: AuditSeq): void {
    if (ds.checked) this.recheck(ds, seq);
  }

  private recheck(ds: StubDataset, seq: AuditSeq): void {
    mergeFindings(this.issues, ds, runRules(workingView(ds)), seq);
  }

  private checkSummary(ds: StubDataset): CheckSummary {
    const bySeverity: Record<Severity, number> = { error: 0, warning: 0, note: 0 };
    const byRule: Record<string, number> = {};
    let issues = 0;
    for (const issue of this.issuesOf(ds.id)) {
      if (issue.flagged.size === 0) continue;
      issues++;
      bySeverity[issue.rule.severity]++;
      byRule[issue.rule.id] = (byRule[issue.rule.id] ?? 0) + 1;
    }
    // The stub does no real work, so it reports no duration rather than a made-up one.
    return { datasetId: ds.id, packs: [STUB_RULE_PACK_REF], issues, bySeverity, byRule, durationMs: 0 };
  }

  issuesOf(datasetId: DatasetId): StubIssue[] {
    return [...this.issues.values()].filter((i) => i.datasetId === datasetId);
  }

  openIssueCounts(datasetId: DatasetId): Record<Severity, number> {
    const counts: Record<Severity, number> = { error: 0, warning: 0, note: 0 };
    for (const issue of this.issuesOf(datasetId)) if (openRows(issue).length > 0) counts[issue.rule.severity]++;
    return counts;
  }

  columnName(ds: StubDataset, columnId: ColumnId): string {
    return ds.columns.find((c) => c.id === columnId)?.name ?? columnId;
  }

  checkRow(rowId: RowId): void {
    if (!Number.isInteger(rowId) || rowId < 0 || rowId >= rowCount()) {
      throw new EngineError('NOT_FOUND', `There is no row ${rowId} in this dataset.`, 'Choose a row shown in the grid.');
    }
  }

  originals(): OriginalFileInfo[] {
    const first = this.audit.find((e) => e.action === 'source.add');
    if (first === undefined) return [];
    const { name, size, fileId, mediaType } = SOURCE_FILE;
    return [{ fileId, name, size, mediaType, addedSeq: first.seq }];
  }

  datasetSummary(ds: StubDataset): DatasetSummary {
    return {
      id: ds.id,
      name: ds.name,
      source: { fileId: SOURCE_FILE.fileId, fileName: SOURCE_FILE.name, format: 'csv' },
      rowCount: rowCount(),
      outputRowCount: outputView(ds).rows.length,
      columnCount: ds.columns.length,
      assumptions: assumptionsOf(ds.id, ds.columns).length,
      partial: false,
      steps: ds.steps.map((s) => ({ ...s })),
    };
  }

  schema(ds: StubDataset, stage: 'working' | 'output'): TableSchema {
    const view = viewOf(ds, stage);
    return {
      datasetId: ds.id,
      name: ds.name,
      source: { fileId: SOURCE_FILE.fileId, fileName: SOURCE_FILE.name, format: 'csv' },
      rowCount: view.rows.length,
      columns: view.columns.map((c) => c.schema),
      crs: null,
      geometryColumn: null,
      partial: false,
    };
  }

  summary(): ProjectSummary {
    const head = this.audit[this.audit.length - 1];
    return {
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      profile: { ...this.profile },
      unitSystem: this.unitSystem,
      projectArea: this.area,
      readOnly: false,
      dirty: this.dirty,
      lastSavedAt: this.lastSavedAt,
      originals: this.originals(),
      datasets: [...this.datasets.values()].map((ds) => this.datasetSummary(ds)),
      exports: this.exports.map((e) => ({ ...e })),
      rulePacks: [STUB_RULE_PACK_REF],
      auditHead: { seq: head?.seq ?? 0, hash: head?.hash ?? stubHex(AUDIT_GENESIS_PREFIX + this.id) },
    };
  }

  rulePacks(): (typeof STUB_RULE_PACK)[] {
    return [STUB_RULE_PACK];
  }
}
