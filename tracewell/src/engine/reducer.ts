/**
 * The single reducer (SAD section 8.1): applied to each new audit entry during live operation and
 * to every entry when a project is opened. Because both paths run the same code, a replay that
 * reproduces the saved digests is a real proof that the history explains the data.
 *
 * A live job may already have done an entry's expensive part (the import, the check run) before
 * appending it; it hands that result over as `prepared` so it is not done twice. The result is
 * exactly what this reducer would compute, because the job computed it on the same state.
 */
import { applyOverrides, importSource, previewSource, type ImportOutcome, type ImportSpec } from '@tw/ingest';
import { bytesSource } from '@tw/io';
import {
  EngineError,
  userDetection,
  type Assumption,
  type AuditEntry,
  type AuditSeq,
  type BBox,
  type ByteSource,
  type CellValue,
  type ColumnOverride,
  type CrsRef,
  type Detection,
  type ExportRecord,
  type FormatOptions,
  type IssueDraft,
  type JsonValue,
  type OverridableProperty,
  type RulePackRef,
  type StepInput,
  type UserProfile,
} from '@tw/model';
import { GENERIC_DQ, SYSTEM_RULES, runRules } from '@tw/rules';
import { Overlay, RowSet } from '@tw/table';
import { mergeCheckRun } from './issues-state';
import { newDatasetState, type DatasetState, type ProjectState } from './state';
import { workingView } from './views';

/** What a live job computed for the entry it is about to apply. */
export interface Prepared {
  datasetId: string;
  outcome?: ImportOutcome;
  drafts?: IssueDraft[];
}

export interface ReduceEnv {
  memoryBudgetBytes: number;
  signal: AbortSignal;
  prepared?: Prepared;
}

/** Every rule pack a check run uses, in the order they run. */
export const CHECK_PACKS = [GENERIC_DQ, SYSTEM_RULES];

const NEVER = new AbortController().signal;

/** Properties that only change how a column is read; anything else changes the rows themselves. */
export const COLUMN_PROPERTIES: ReadonlySet<OverridableProperty> = new Set([
  'name',
  'type',
  'unit',
  'role',
  'nullMarkers',
  'dateFormat',
  'timezone',
]);

/** True when an override of `property` reads the file into a different set of rows. */
export function changesRows(property: OverridableProperty): boolean {
  return !COLUMN_PROPERTIES.has(property) && property !== 'crs';
}

function dataset(state: ProjectState, id: string | undefined): DatasetState {
  const ds = id === undefined ? undefined : state.datasets.get(id);
  if (ds === undefined) {
    throw new EngineError(
      'NOT_FOUND',
      `There is no dataset ${String(id)} in this project.`,
      'Choose a listed dataset.',
    );
  }
  return ds;
}

function payload<T>(e: AuditEntry): T {
  return e.payload as unknown as T;
}

function preparedFor(env: ReduceEnv, datasetId: string | undefined): Prepared | undefined {
  return env.prepared !== undefined && env.prepared.datasetId === datasetId ? env.prepared : undefined;
}

/** Runs every check on the dataset's working view, as a check run does. */
export function checkDrafts(
  state: ProjectState,
  ds: DatasetState,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<IssueDraft[]> {
  return runRules(CHECK_PACKS, {
    view: workingView(ds),
    importNotes: ds.notes,
    assumptions: ds.assumptions,
    projectArea: state.projectArea,
    signal,
    onProgress,
  });
}

/** Re-runs the checks after a change, once the user has run them on this dataset. */
export async function recheck(state: ProjectState, ds: DatasetState, seq: AuditSeq): Promise<void> {
  if (!ds.checked) return;
  mergeCheckRun(ds, await checkDrafts(state, ds, NEVER, () => undefined), seq);
}

export function originalSource(state: ProjectState, ds: DatasetState): ByteSource {
  const original = state.originals.get(ds.fileId);
  if (original === undefined) {
    throw new EngineError(
      'PROJECT_INVALID',
      `The original file of dataset ${ds.id} is missing.`,
      'Open the project from a complete .twp file.',
    );
  }
  return bytesSource(original.bytes, original.info.name);
}

/** The spec after one override value, marked as the user's, set by audit entry `seq`. */
async function overrideSpec(
  state: ProjectState,
  ds: DatasetState,
  property: OverridableProperty,
  columnId: string | undefined,
  value: JsonValue,
  seq: AuditSeq,
): Promise<ImportSpec> {
  if (property === 'crs') return { ...ds.spec, crs: userDetection(value as unknown as CrsRef, seq) };
  if (COLUMN_PROPERTIES.has(property)) {
    const o = { columnId: columnId as string, [property]: value } as ColumnOverride;
    const next = applyOverrides(ds.spec, [o]);
    const columns = next.columns.map((c) => {
      if (c.id !== columnId || property === 'name') return c;
      const d = (c as unknown as Record<string, Detection<unknown> | undefined>)[property];
      return d === undefined ? c : { ...c, [property]: userDetection(d.value, seq) };
    });
    return { ...next, columns, fileId: ds.spec.fileId };
  }
  // A reading option: plan the columns again with the new option.
  const options = withOption(ds.spec.options, property, value);
  const preview = await previewSource(originalSource(state, ds), { options });
  const planned = JSON.parse(JSON.stringify(preview.spec)) as Omit<ImportSpec, 'fileId'>;
  return { ...planned, fileId: ds.spec.fileId, datasetName: ds.spec.datasetName };
}

/** Reads the dataset again as audit entry `seq` says it should be read. */
export async function overrideOutcome(
  state: ProjectState,
  ds: DatasetState,
  o: { property: OverridableProperty; columnId: string | undefined; value: JsonValue; seq: AuditSeq },
  env: Pick<ReduceEnv, 'memoryBudgetBytes' | 'signal'>,
): Promise<ImportOutcome> {
  const spec = await overrideSpec(state, ds, o.property, o.columnId, o.value, o.seq);
  return importSource(originalSource(state, ds), ds.id, spec, {
    signal: env.signal,
    memoryBudgetBytes: env.memoryBudgetBytes,
    onProgress: () => undefined,
  });
}

export function withOption(options: FormatOptions, property: OverridableProperty, value: JsonValue): FormatOptions {
  if (options.format === 'csv' || options.format === 'tsv') {
    const csv = { ...options.csv };
    if (property === 'encoding') csv.encoding = value as typeof csv.encoding;
    else if (property === 'delimiter') csv.delimiter = value as typeof csv.delimiter;
    else if (property === 'decimalSeparator') csv.decimalSeparator = value as typeof csv.decimalSeparator;
    else if (property === 'headerRows') csv.headerRows = value as number;
    else if (property === 'skipLines') csv.skipLines = value as number;
    else throw unsupported(property, options.format);
    if (property === 'encoding') csv.bomLength = 0;
    return { ...options, csv };
  }
  if (options.format === 'xlsx') {
    const xlsx = { ...options.xlsx };
    if (property === 'sheet') xlsx.sheet = value as string;
    else if (property === 'tableIndex') xlsx.tableIndex = value as number;
    else throw unsupported(property, options.format);
    return { ...options, xlsx };
  }
  throw unsupported(property, options.format);
}

function unsupported(property: string, format: string): EngineError {
  return new EngineError(
    'INVALID_INPUT',
    `The setting "${property}" does not apply to ${format.toUpperCase()} files.`,
    'Choose a setting that applies to this file.',
  );
}

function install(ds: DatasetState, outcome: ImportOutcome, rowsChange: boolean): void {
  ds.spec = outcome.spec;
  ds.dataset = outcome.dataset;
  ds.notes = outcome.notes;
  // A value the user set is never assumed, so the outcome's assumptions already leave it out.
  ds.assumptions = outcome.assumptions;
  if (rowsChange) {
    ds.overlay = new Overlay();
    ds.excluded = new RowSet(ds.dataset.rowCount);
    ds.excludedBy = new Map();
    ds.issues = new Map();
  }
}

/** Applies an override (or the revert of one, with the old value) recorded by entry `seq`. */
async function applyOverride(
  state: ProjectState,
  target: AuditEntry,
  value: JsonValue,
  seq: AuditSeq,
  env: ReduceEnv,
): Promise<void> {
  const ds = dataset(state, target.target.datasetId);
  const { property } = payload<{ property: OverridableProperty }>(target);
  const outcome =
    preparedFor(env, ds.id)?.outcome ??
    (await overrideOutcome(state, ds, { property, columnId: target.target.columnId, value, seq }, env));
  install(ds, outcome, changesRows(property));
  await recheck(state, ds, seq);
}

export async function applyEntry(state: ProjectState, e: AuditEntry, env: ReduceEnv): Promise<void> {
  switch (e.action) {
    case 'project.create': {
      const n = e.new as { name: string; unitSystem: 'SI' | 'Oilfield' };
      state.name = n.name;
      state.unitSystem = n.unitSystem;
      state.createdAt = e.at;
      state.profile = payload<{ profile: UserProfile }>(e).profile;
      return;
    }
    case 'source.add': {
      const p = payload<{ spec: ImportSpec; mediaType: string }>(e);
      const id = e.target.datasetId as string;
      const original = state.originals.get(p.spec.fileId);
      if (original === undefined) {
        throw new EngineError(
          'PROJECT_INVALID',
          `The original file ${p.spec.fileName} is missing.`,
          'Open the project from a complete .twp file.',
        );
      }
      if (original.info.addedSeq === 0) original.info = { ...original.info, addedSeq: e.seq };
      const outcome =
        preparedFor(env, id)?.outcome ??
        (await importSource(bytesSource(original.bytes, p.spec.fileName), id, p.spec, {
          signal: env.signal,
          memoryBudgetBytes: env.memoryBudgetBytes,
          onProgress: () => undefined,
        }));
      state.datasets.set(id, newDatasetState(id, outcome.spec, outcome.dataset, outcome.notes, outcome.assumptions));
      state.nextDataset = Math.max(state.nextDataset, Number(id.slice(1)) + 1);
      return;
    }
    case 'detection.assume': {
      dataset(state, e.target.datasetId).assumptions = payload<{ assumptions: Assumption[] }>(e).assumptions;
      return;
    }
    case 'detection.override':
      await applyOverride(state, e, e.new as JsonValue, e.seq, env);
      return;
    case 'check.run': {
      const ds = dataset(state, e.target.datasetId);
      ds.checked = true;
      ds.checkPacks = payload<{ packs: RulePackRef[] }>(e).packs;
      for (const ref of ds.checkPacks) {
        if (!state.rulePacks.some((r) => r.id === ref.id && r.version === ref.version)) state.rulePacks.push(ref);
      }
      const drafts = preparedFor(env, ds.id)?.drafts;
      if (drafts === undefined) await recheck(state, ds, e.seq);
      else mergeCheckRun(ds, drafts, e.seq);
      return;
    }
    case 'cell.edit': {
      const ds = dataset(state, e.target.datasetId);
      ds.overlay.set(e.target.rowId as number, e.target.columnId as string, e.new as CellValue, e.seq);
      await recheck(state, ds, e.seq);
      return;
    }
    case 'issue.accept': {
      const ds = dataset(state, e.target.datasetId);
      const st = ds.issues.get(e.target.issueId as string);
      if (st === undefined) return;
      const rows = payload<{ rows: number[] | 'all' }>(e).rows;
      if (rows === 'all' || st.draft.scope !== 'rows') st.acceptedWhole = true;
      for (const r of rows === 'all' ? st.current.toArray() : rows) {
        st.accepted.add(r);
        st.decidedBy.set(r, e.seq);
      }
      return;
    }
    case 'rows.exclude': {
      const ds = dataset(state, e.target.datasetId);
      for (const r of payload<{ rows: number[] }>(e).rows) {
        ds.excluded.add(r);
        ds.excludedBy.set(r, e.seq);
      }
      await recheck(state, ds, e.seq);
      return;
    }
    case 'issue.comment': {
      const ds = dataset(state, e.target.datasetId);
      const st = ds.issues.get(e.target.issueId as string);
      const by = e.actor.kind === 'user' ? e.actor.name : `system (${e.actor.component})`;
      st?.comments.push({ seq: e.seq, at: e.at, by, text: e.new as string });
      return;
    }
    case 'step.apply': {
      const ds = dataset(state, e.target.datasetId);
      const input = e.new as unknown as StepInput;
      const id = e.target.stepId as string;
      ds.steps.push({ ...input, id, seq: e.seq });
      state.nextStep = Math.max(state.nextStep, Number(id.slice(1)) + 1);
      if (input.kind === 'convert_unit') await recheck(state, ds, e.seq);
      return;
    }
    case 'step.remove': {
      const ds = dataset(state, e.target.datasetId);
      const removed = ds.steps.find((s) => s.id === e.target.stepId);
      ds.steps = ds.steps.filter((s) => s.id !== e.target.stepId);
      if (removed?.kind === 'convert_unit') await recheck(state, ds, e.seq);
      return;
    }
    case 'entry.revert':
      await applyRevert(state, e, env);
      return;
    case 'project.area': {
      state.projectArea = e.new as BBox | null;
      for (const ds of state.datasets.values()) await recheck(state, ds, e.seq);
      return;
    }
    case 'export.create': {
      state.exports.push(payload<{ record: ExportRecord }>(e).record);
      return;
    }
    case 'project.save': {
      state.lastSavedAt = e.at;
      state.lastSavedSeq = e.seq;
      return;
    }
  }
}

async function applyRevert(state: ProjectState, e: AuditEntry, env: ReduceEnv): Promise<void> {
  const target = state.log.get(e.target.seq as number);
  if (target === undefined) return;
  state.reverted.add(target.seq);
  switch (target.action) {
    case 'cell.edit': {
      const ds = dataset(state, target.target.datasetId);
      const r = target.target.rowId as number;
      const c = target.target.columnId as string;
      const previous = payload<{ previousEditSeq: number | null }>(target).previousEditSeq;
      if (previous === null) ds.overlay.delete(r, c);
      else ds.overlay.set(r, c, target.old as CellValue, e.seq);
      await recheck(state, ds, e.seq);
      return;
    }
    case 'issue.accept': {
      const ds = dataset(state, target.target.datasetId);
      const st = ds.issues.get(target.target.issueId as string);
      if (st === undefined) return;
      st.acceptedWhole = false;
      for (const [r, seq] of [...st.decidedBy]) {
        if (seq !== target.seq) continue;
        st.accepted.delete(r);
        st.decidedBy.delete(r);
      }
      return;
    }
    case 'rows.exclude': {
      const ds = dataset(state, target.target.datasetId);
      for (const r of payload<{ rows: number[] }>(target).rows) {
        if (ds.excludedBy.get(r) !== target.seq) continue;
        ds.excluded.delete(r);
        ds.excludedBy.delete(r);
      }
      await recheck(state, ds, e.seq);
      return;
    }
    case 'step.apply': {
      const ds = dataset(state, target.target.datasetId);
      ds.steps = ds.steps.filter((s) => s.id !== target.target.stepId);
      await recheck(state, ds, e.seq);
      return;
    }
    case 'detection.override':
      await applyOverride(state, target, target.old as JsonValue, e.seq, env);
      return;
    case 'project.area': {
      state.projectArea = target.old as BBox | null;
      for (const ds of state.datasets.values()) await recheck(state, ds, e.seq);
      return;
    }
    default:
      return;
  }
}
