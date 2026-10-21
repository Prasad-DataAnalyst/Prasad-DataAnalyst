/**
 * The stub's project state: datasets, issues, exports and an audit log chained like the real one.
 * Every change goes through append(), and changes that can be reverted register how to undo them.
 */
import {
  AUDIT_GENESIS_PREFIX,
  canonicalJson,
  EngineError,
  type Actor,
  type Assumption,
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

/** How to undo one audit entry. check() throws when a later change makes the undo unsafe. */
export interface Revert {
  check(): void;
  apply(): void;
}

const DETECTOR: Actor = { kind: 'system', component: 'detector' };

/** Model types are JSON data by construction; this states it where the compiler cannot see it. */
export function asJson(v: unknown): JsonValue {
  return v as JsonValue;
}

function entryHash(body: Omit<AuditEntry, 'hash'>): string {
  return stubHex(canonicalJson(asJson(body)));
}

export function actorName(actor: Actor): string {
  return actor.kind === 'user' ? actor.name : `system (${actor.component})`;
}

export class StubProject {
  readonly datasets = new Map<DatasetId, StubDataset>();
  readonly issues = new Map<IssueId, StubIssue>();
  readonly audit: AuditEntry[] = [];
  readonly exports: ExportRecord[] = [];
  /** How to undo each revertible entry; an entry leaves the map when it is reverted. */
  readonly undo = new Map<AuditSeq, Revert>();
  readonly createdAt: IsoUtc;
  area: BBox | null = null;
  dirty = false;
  readOnly = false;
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

  user(): Actor {
    return { kind: 'user', profileId: this.profile.id, name: this.profile.name, role: this.profile.role };
  }

  /** Refuses every change to a project that failed an integrity check on open (TW-PRJ-*). */
  assertWritable(): void {
    if (this.readOnly) {
      throw new EngineError(
        'READ_ONLY_PROJECT',
        'This project is open read-only because it failed an integrity check.',
        'Review the integrity report, then start a new project from the original files to make changes.',
      );
    }
  }

  append(draft: AuditDraft, actor: Actor = this.user()): AuditEntry {
    const body = { ...draft, seq: this.audit.length + 1, at: this.clock.now(), actor, prev: this.head().hash };
    const entry: AuditEntry = { ...body, hash: entryHash(body) };
    this.audit.push(entry);
    this.dirty = draft.action !== 'project.save';
    return entry;
  }

  head(): { seq: AuditSeq; hash: string } {
    const last = this.audit[this.audit.length - 1];
    return { seq: last?.seq ?? 0, hash: last?.hash ?? stubHex(AUDIT_GENESIS_PREFIX + this.id) };
  }

  entry(seq: AuditSeq): AuditEntry {
    const found = this.audit[seq - 1];
    if (found === undefined) {
      throw new EngineError('NOT_FOUND', `There is no audit entry ${seq}.`, 'Choose an entry from the audit log.');
    }
    return found;
  }

  verify(): ChainReport {
    let prev = stubHex(AUDIT_GENESIS_PREFIX + this.id);
    for (const entry of this.audit) {
      const { hash, ...body } = entry;
      if (body.prev !== prev || entryHash(body) !== hash) {
        return {
          ok: false,
          entries: this.audit.length,
          brokenAt: entry.seq,
          reason: `Entry ${entry.seq} does not match the chain.`,
        };
      }
      prev = hash;
    }
    return { ok: true, entries: this.audit.length };
  }

  dataset(id: DatasetId): StubDataset {
    const ds = this.datasets.get(id);
    if (ds === undefined) {
      throw new EngineError(
        'NOT_FOUND',
        `There is no dataset ${id} in this project.`,
        'Choose a dataset from the project tree.',
      );
    }
    return ds;
  }

  issue(id: IssueId): StubIssue {
    const issue = this.issues.get(id);
    if (issue === undefined) {
      throw new EngineError(
        'NOT_FOUND',
        `There is no issue ${id} in this project.`,
        'Run the checks again and choose an issue from the register.',
      );
    }
    return issue;
  }

  nextDatasetId(): DatasetId {
    return `d${this.datasets.size + 1}`;
  }

  /** A dataset of the canned file that is not yet part of the project. */
  draftDataset(name: string): StubDataset {
    return {
      id: this.nextDatasetId(),
      name,
      columns: sourceColumns(),
      edits: new Map(),
      excluded: new Map(),
      steps: [],
      checked: false,
      confirmed: new Set(),
      latestOverride: new Map(),
    };
  }

  /** Adds a drafted dataset, logging source.add and detection.assume as an import does. */
  addDataset(ds: StubDataset): void {
    this.datasets.set(ds.id, ds);
    this.append({
      action: 'source.add',
      target: { datasetId: ds.id, fileId: SOURCE_FILE.fileId },
      new: { name: ds.name, fileName: SOURCE_FILE.name, rows: rowCount() },
      payload: { format: 'csv' },
    });
    this.append(
      {
        action: 'detection.assume',
        target: { datasetId: ds.id },
        payload: asJson({ assumptions: this.assumptions(ds) }),
      },
      DETECTOR,
    );
  }

  assumptions(ds: StubDataset): Assumption[] {
    return assumptionsOf(ds.id, ds.columns, ds.confirmed);
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
      throw new EngineError(
        'NOT_FOUND',
        `There is no row ${rowId} in this dataset.`,
        'Choose a row shown in the grid.',
      );
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
      assumptions: this.assumptions(ds).length,
      partial: false,
      steps: ds.steps.map((s) => structuredClone(s)),
    };
  }

  schema(ds: StubDataset, stage: 'working' | 'output'): TableSchema {
    const view = viewOf(ds, stage);
    return {
      datasetId: ds.id,
      name: ds.name,
      source: { fileId: SOURCE_FILE.fileId, fileName: SOURCE_FILE.name, format: 'csv' },
      rowCount: view.rows.length,
      columns: view.columns.map((c) => structuredClone(c.schema)),
      crs: null,
      geometryColumn: null,
      partial: false,
    };
  }

  summary(): ProjectSummary {
    return {
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      profile: { ...this.profile },
      unitSystem: this.unitSystem,
      projectArea: this.area === null ? null : [...this.area],
      readOnly: this.readOnly,
      dirty: this.dirty,
      lastSavedAt: this.lastSavedAt,
      originals: this.originals(),
      datasets: [...this.datasets.values()].map((ds) => this.datasetSummary(ds)),
      exports: this.exports.map((e) => ({ ...e })),
      // Like the real manifest, the project records the packs its check runs used.
      rulePacks: [...this.datasets.values()].some((ds) => ds.checked) ? [STUB_RULE_PACK_REF] : [],
      auditHead: this.head(),
    };
  }

  rulePacks(): (typeof STUB_RULE_PACK)[] {
    return [STUB_RULE_PACK];
  }
}
