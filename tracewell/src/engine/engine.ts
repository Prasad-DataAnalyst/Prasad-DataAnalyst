/**
 * LocalEngine: the TypeScript engine behind the engine protocol (SAD section 4). Every change is a
 * validated audit draft that is appended and then applied by the same reducer that replays a saved
 * project, so the audit log is the single source of truth. Changes run one at a time, in the order
 * they were asked for; reads answer at once from the current state.
 */
import { AuditLog } from '@tw/audit';
import { PROTOCOL_VERSION, type EngineEvent, type EngineImpl, type EngineInfo } from '@tw/engine-api';
import { buildExport, EXPORT_PROFILES, planExport, profileStatuses, type ExportInput } from '@tw/export';
import { applyTemplate, creditTemplate, importSource, matchTemplate, previewSource, templateColumns } from '@tw/ingest';
import { blobSource, bytesSource, sha256Hex } from '@tw/io';
import {
  EngineError,
  schemas,
  type Actor,
  type AuditDraft,
  type AuditEntry,
  type AuditQuery,
  type ByteSource,
  type CellLineage,
  type ChainReport,
  type CheckSummary,
  type Clock,
  type ColumnId,
  type ColumnOverride,
  type ColumnPlan,
  type ColumnStats,
  type ConversionMethod,
  type DatasetHealth,
  type DatasetId,
  type DatasetSummary,
  type Decision,
  type ExportProfileId,
  type ExportProfileStatus,
  type ExportRecord,
  type ExportRequest,
  type ExportResult,
  type FileInput,
  type FileTarget,
  type FormatOptions,
  type IdSource,
  type ImportPreview,
  type ImportRequestOptions,
  type Issue,
  type IssueDraft,
  type IssueId,
  type IssueOccurrence,
  type IssueQuery,
  type JobHandle,
  type JobId,
  type JobOutcome,
  type JobProgress,
  type JsonValue,
  type MappingTemplate,
  type OverridableProperty,
  type Page,
  type PageRequest,
  type ProjectOpenReport,
  type ProjectSummary,
  type QuantityKind,
  type RecipePlan,
  type RecipeRun,
  type RecoveryInfo,
  type RowId,
  type RowWindow,
  type RowWindowRequest,
  type RulePack,
  type RulePackRef,
  type SavedRecipe,
  type SaveResult,
  type Severity,
  type SourceFormat,
  type Step,
  type StepId,
  type StepInput,
  type StepPreview,
  type StepResult,
  type TableSchema,
  type TemplateApplied,
  type TemplateId,
  type UnitInfo,
  type UserProfile,
} from '@tw/model';
import { suggestedFileName } from '@tw/project';
import { BUILTIN_PACK_JSON, GENERIC_DQ, SYSTEM_RULES, rulePackRef } from '@tw/rules';
import { conversionFor, describeStep, previewStep, validateStep } from '@tw/steps';
import { REGISTRY_JSON, REGISTRY_VERSION } from '@tw/units';
import { checkOverrideValue, datasetOf, decisionDraft, requireReason, requireStepsBuild } from './decisions';
import { toIssue } from './issues-state';
import { JobManager } from './jobs';
import {
  baselineOf,
  buildRecipe,
  columnNamer,
  deltaOf,
  parseRecipe,
  planRecipe,
  recipeBytes,
  recipeFileName,
  resolvedSince,
} from './recipes';
import type { JournalStore } from './journal-store';
import { memoryTemplateStore, type TemplateStore } from './template-store';
import { explainCell } from './lineage';
import { datasetDigests, openJournal, openProjectBytes, projectBytes } from './project-io';
import { datasetHealth, listIssues, listOccurrences, listUnits } from './queries';
import { applyEntry, checkDrafts, overrideOutcome, type Prepared } from './reducer';
import { emptyProject, type DatasetState, type ProjectState } from './state';
import { outputView, viewFor, workingView } from './views';
import { columnStats, invalid, requireStage, rowWindow } from './windows';

export const ENGINE_NAME = 'tracewell-ts';

const DEFAULT_MEMORY_BUDGET = 1_500_000_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 100;
const FORMATS: SourceFormat[] = ['csv', 'tsv', 'xlsx', 'geojson', 'json', 'parquet'];
const OVERRIDE_ORDER = ['name', 'type', 'unit', 'role', 'nullMarkers', 'dateFormat', 'timezone'] as const;
const CSV_SETTINGS: OverridableProperty[] = ['encoding', 'delimiter', 'decimalSeparator', 'headerRows', 'skipLines'];
const MEDIA_TYPES: Record<SourceFormat, string> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  geojson: 'application/geo+json',
  json: 'application/json',
  parquet: 'application/vnd.apache.parquet',
};

type Change = Extract<EngineEvent, { type: 'project.changed' }>['what'][number];
const EVERYTHING: Change[] = ['project', 'datasets', 'schema', 'issues', 'audit', 'steps', 'exports'];

export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  /**
   * A source over the file that reads only the ranges asked for. Previews use it, so the preview
   * of a file of any size reads at most PREVIEW_MAX_BYTES (SAD decision D-12).
   */
  open?(path: string): Promise<ByteSource>;
}

/** The most a file read whole can hold: the largest typed array JavaScript engines allow. */
const MAX_WHOLE_FILE_BYTES = 2 ** 31 - 1;

export interface LocalEngineOptions {
  appVersion: string;
  /** The registered owner of this copy, recorded in every export manifest. */
  owner: string;
  /** The only clock the engine reads; the app wiring passes the system clock, tests a fixed one. */
  clock: Clock;
  /** The only source of random IDs the engine uses. */
  ids: IdSource;
  memoryBudgetBytes?: number;
  progressIntervalMs?: number;
  /** Enables file inputs and targets of kind 'path' (desktop and Node). */
  fs?: FileSystem;
  /** Where the user's mapping templates are kept; memory for this session when left out. */
  templates?: TemplateStore;
  /** Where this session's recovery journal is kept (FR-PRJ-03); nothing is journalled without one. */
  journal?: JournalStore;
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function userActor(p: UserProfile): Actor {
  return { kind: 'user', profileId: p.id, name: p.name, role: 'Analyst' };
}

function requireProjectOptions(o: { name: string; profile: UserProfile; unitSystem?: 'SI' | 'Oilfield' }): void {
  if (typeof o?.name !== 'string' || o.name.trim() === '' || o.name.trim().length > 200) {
    throw invalid('A project name must be text of 1 to 200 characters.', 'Type a name for the project.');
  }
  const p = o.profile as Partial<UserProfile> | undefined;
  if (
    typeof p?.id !== 'string' ||
    p.id === '' ||
    typeof p.name !== 'string' ||
    p.name.trim() === '' ||
    p.role !== 'Analyst'
  ) {
    throw invalid('The user profile is incomplete.', 'Pass a profile with an id, a name and the role Analyst.');
  }
  if (o.unitSystem !== undefined && o.unitSystem !== 'SI' && o.unitSystem !== 'Oilfield') {
    throw invalid(`The unit system ${String(o.unitSystem)} is not supported.`, 'Choose SI or Oilfield.');
  }
}

/** Reading settings the user chose that differ from the detected ones, as single overrides. */
function optionChanges(
  detected: FormatOptions,
  chosen: FormatOptions,
): { columnId: undefined; property: OverridableProperty; value: JsonValue }[] {
  const pick = (o: FormatOptions): Record<string, unknown> =>
    (o.format === 'csv' || o.format === 'tsv' ? o.csv : o.format === 'xlsx' ? o.xlsx : {}) as unknown as Record<
      string,
      unknown
    >;
  const properties: OverridableProperty[] =
    chosen.format === 'xlsx'
      ? ['sheet', 'tableIndex']
      : chosen.format === 'csv' || chosen.format === 'tsv'
        ? CSV_SETTINGS
        : [];
  const a = pick(detected);
  const b = pick(chosen);
  return properties
    .filter((p) => a[p] !== b[p])
    .map((p) => ({ columnId: undefined, property: p, value: b[p] as JsonValue }));
}

/** The media type of an original: a workbook in an OLE compound file is a legacy .xls. */
function mediaTypeOf(format: SourceFormat, bytes: Uint8Array): string {
  if (format === 'xlsx' && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return 'application/vnd.ms-excel';
  }
  return MEDIA_TYPES[format];
}

/** The rule packs this engine checks with. */
function builtinPacks(): RulePackRef[] {
  return [
    rulePackRef(GENERIC_DQ, BUILTIN_PACK_JSON['tracewell.generic-dq']),
    rulePackRef(SYSTEM_RULES, BUILTIN_PACK_JSON['tracewell.system']),
  ];
}

function overrideList(
  overrides: ColumnOverride[],
): { columnId: ColumnId; property: OverridableProperty; value: JsonValue }[] {
  if (!Array.isArray(overrides)) throw invalid('Column overrides must be a list.', 'Pass a list of column overrides.');
  return overrides.flatMap((o) =>
    OVERRIDE_ORDER.flatMap((property) => {
      const value = o[property];
      return value === undefined ? [] : [{ columnId: o.columnId, property, value: value as JsonValue }];
    }),
  );
}

export class LocalEngine implements EngineImpl {
  private readonly listeners = new Set<{ cb: (e: EngineEvent) => void }>();
  private readonly jobs: JobManager;
  private readonly memoryBudgetBytes: number;
  private readonly templates: TemplateStore;
  /** Journal writes, one after another, so the last one written is the latest state. */
  private journalWrites: Promise<void> = Promise.resolve();
  private journalFailed = false;
  private state: ProjectState | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: LocalEngineOptions) {
    this.memoryBudgetBytes = o.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET;
    this.templates = o.templates ?? memoryTemplateStore();
    this.jobs = new JobManager(o.clock, o.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS, (e) => this.emit(e));
  }

  on(cb: (e: EngineEvent) => void): () => void {
    const entry = { cb };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  async hello(): Promise<EngineInfo> {
    return {
      name: ENGINE_NAME,
      version: this.o.appVersion,
      protocol: PROTOCOL_VERSION,
      capabilities: {
        formats: [...FORMATS],
        exportProfiles: EXPORT_PROFILES.map((p) => p.id),
        memoryBudgetBytes: this.memoryBudgetBytes,
        spillToDisk: false,
        crsTransform: false,
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Project

  async newProject(o: { name: string; profile: UserProfile; unitSystem?: 'SI' | 'Oilfield' }): Promise<ProjectSummary> {
    requireProjectOptions(o);
    return this.exclusive(async () => {
      const profile: UserProfile = { id: o.profile.id, name: o.profile.name.trim(), role: 'Analyst' };
      const state = emptyProject(this.o.ids.newProjectId());
      state.profile = profile;
      await this.commit(state, {
        action: 'project.create',
        target: {},
        new: { name: o.name.trim(), unitSystem: o.unitSystem ?? 'SI' },
        payload: asJson({ profile }),
      });
      this.state = state;
      this.changed(EVERYTHING);
      return this.summary(state);
    });
  }

  async getProject(): Promise<ProjectSummary> {
    return this.summary(this.project());
  }

  async openProject(file: FileInput): Promise<JobHandle> {
    const name = this.fileName(file);
    return this.jobs.start('open', (ctx) =>
      this.exclusive(async () => {
        ctx.progress({ phase: `Reading ${name}`, done: 0, unit: 'items' });
        const bytes = await this.readAll(file);
        const opened = await openProjectBytes(bytes, name, {
          memoryBudgetBytes: this.memoryBudgetBytes,
          signal: ctx.signal,
          onProgress: (done, total) => ctx.progress({ phase: `Rebuilding ${name}`, done, total, unit: 'items' }),
        });
        ctx.checkCancelled();
        this.state = opened.state;
        this.changed(EVERYTHING);
        this.log(opened.readOnly ? 'warn' : 'info', `Opened ${name}${opened.readOnly ? ' read-only' : ''}.`);
        const report: ProjectOpenReport = {
          project: this.summary(opened.state),
          readOnly: opened.readOnly,
          checks: opened.checks,
        };
        return report;
      }),
    );
  }

  async saveProject(target?: FileTarget): Promise<JobHandle> {
    this.writable();
    this.requireTarget(target);
    return this.jobs.start('save', (ctx) =>
      this.exclusive(async () => {
        const state = this.writable();
        ctx.progress({ phase: 'Writing the project file', done: 0, total: 2, unit: 'items' });
        const digests = datasetDigests(state);
        ctx.checkCancelled();
        const fileName = suggestedFileName(state.name);
        await this.commit(state, {
          action: 'project.save',
          target: {},
          new: { fileName },
          payload: asJson({ datasets: digests }),
        });
        const bytes = projectBytes(state, this.o.appVersion, digests);
        ctx.progress({ phase: 'Writing the project file', done: 2, total: 2, unit: 'items' });
        const result: SaveResult = { fileName, size: bytes.byteLength, sha256: sha256Hex(bytes) };
        if (target?.kind === 'path') await this.fs().writeFile(target.path, bytes);
        else result.bytes = bytes;
        this.changed(['project', 'audit']);
        this.log('info', `Saved ${fileName}.`);
        return result;
      }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Import

  async sniff(file: FileInput, o?: { options?: FormatOptions; template?: TemplateId | null }): Promise<ImportPreview> {
    const src = await this.source(file);
    const settings = {
      ...(o?.options === undefined ? {} : { options: o.options }),
      memoryBudgetBytes: this.memoryBudgetBytes,
    };
    const detected = await previewSource(src, settings);
    const applied = await this.templateFor(detected.columns, o?.template);
    const preview =
      applied === null || applied.overrides.length === 0
        ? detected
        : await previewSource(src, { ...settings, columnOverrides: applied.overrides });
    const { spec: _spec, ...rest } = preview;
    if (applied === null) return { ...rest, template: null };
    return { ...rest, columns: creditTemplate(rest.columns, applied), template: applied };
  }

  /**
   * The mapping template for a file's detected columns: the chosen one (refused when it does not
   * fit), none when `choice` is null, or the one that fits when it is left out.
   */
  private async templateFor(
    plans: ColumnPlan[],
    choice: TemplateId | null | undefined,
  ): Promise<TemplateApplied | null> {
    if (choice === null) return null;
    const templates = await this.templates.load();
    if (choice === undefined) {
      const fitting = matchTemplate(templates, plans);
      return fitting === null ? null : applyTemplate(fitting, plans);
    }
    const chosen = templates.find((t) => t.id === choice);
    if (chosen === undefined) {
      throw new EngineError(
        'NOT_FOUND',
        `There is no mapping template ${String(choice)}.`,
        'Choose a template from the list, or import without one.',
      );
    }
    const applied = applyTemplate(chosen, plans);
    if (applied === null) {
      throw new EngineError(
        'INVALID_INPUT',
        `The mapping template "${chosen.name}" does not fit this file: some of its columns are not in it.`,
        'Import without the template, or choose one saved from a file with the same columns.',
        { templateId: chosen.id },
      );
    }
    return applied;
  }

  /**
   * Imports with the detected settings, then records each setting and column changed by the
   * mapping template and then by the user as its own `detection.override` entry, so the audit log
   * shows what was detected, what the template set and what the user chose.
   */
  async importFile(file: FileInput, o?: ImportRequestOptions): Promise<JobHandle> {
    this.writable();
    const name = this.fileName(file);
    const overrides = overrideList(o?.columnOverrides ?? []);
    for (const x of overrides) checkOverrideValue(x.property, x.value);
    return this.jobs.start('import', (ctx) =>
      this.exclusive(async () => {
        const state = this.writable();
        ctx.progress({ phase: `Reading ${name}`, done: 0, unit: 'bytes' });
        const bytes = await this.readAll(file);
        const src = bytesSource(bytes, name);
        const budget = { memoryBudgetBytes: this.memoryBudgetBytes };
        const detected = await previewSource(src, budget);
        const chosen =
          o?.options === undefined ? detected : await previewSource(src, { ...budget, options: o.options });
        const datasetId = `d${state.nextDataset}`;
        const applied = await this.templateFor(chosen.spec.columns, o?.template);
        const templateChanges = overrideList(applied?.overrides ?? []);
        const changes = [
          ...optionChanges(detected.spec.options, chosen.spec.options),
          ...overrides.map((x) => ({ ...x, columnId: x.columnId as ColumnId | undefined })),
        ];
        const reason = changes.length === 0 ? '' : requireReason(o?.overrideReason);
        for (const x of overrides) {
          if (!chosen.spec.columns.some((c) => c.id === x.columnId)) {
            throw new EngineError(
              'NOT_FOUND',
              `The file has no column ${String(x.columnId)}.`,
              'Choose a column shown in the preview.',
            );
          }
        }
        // The spec is stored in the audit log, so the import reads exactly what a replay will read.
        const spec = roundTrip({ ...detected.spec, datasetName: o?.name?.trim() || detected.spec.datasetName });
        const outcome = await importSource(src, datasetId, spec, {
          signal: ctx.signal,
          memoryBudgetBytes: this.memoryBudgetBytes,
          onProgress: (p) => ctx.progress({ ...p, phase: `Importing ${name}` }),
        });
        ctx.checkCancelled();

        const fileId = outcome.sha256;
        if (!state.originals.has(fileId)) {
          const mediaType = mediaTypeOf(outcome.spec.options.format, bytes);
          state.originals.set(fileId, {
            info: { fileId, name, size: bytes.byteLength, mediaType, addedSeq: 0 },
            bytes,
          });
        }
        const mediaType =
          state.originals.get(fileId)?.info.mediaType ?? mediaTypeOf(outcome.spec.options.format, bytes);
        await this.commit(
          state,
          {
            action: 'source.add',
            target: { datasetId, fileId },
            new: { name: outcome.spec.datasetName, fileName: name },
            payload: asJson({ spec: outcome.spec, mediaType }),
          },
          { datasetId, outcome },
        );
        if (outcome.assumptions.length > 0) {
          await this.commit(
            state,
            {
              action: 'detection.assume',
              target: { datasetId },
              payload: asJson({ assumptions: outcome.assumptions }),
            },
            undefined,
            { kind: 'system', component: 'detector' },
          );
        }
        for (const x of templateChanges) {
          const d: Decision = {
            kind: 'override_detection',
            datasetId,
            columnId: x.columnId,
            property: x.property,
            value: x.value,
            reason: `Mapping template "${applied?.name ?? ''}" (${applied?.id ?? ''}).`,
          };
          await this.commitDraft(state, decisionDraft(state, d));
        }
        for (const x of changes) {
          const d: Decision = {
            kind: 'override_detection',
            datasetId,
            ...(x.columnId === undefined ? {} : { columnId: x.columnId }),
            property: x.property,
            value: x.value,
            reason,
          };
          await this.commitDraft(state, decisionDraft(state, d));
        }
        const ds = datasetOf(state, datasetId);
        this.changed(['project', 'datasets', 'schema', 'audit'], datasetId);
        this.log('info', `Imported ${name} as ${ds.dataset.schema.name}: ${ds.dataset.rowCount} rows.`);
        return this.datasetSummary(ds);
      }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Crash recovery (FR-PRJ-03)

  /**
   * Work an earlier session left unsaved: the latest journal of a session that has ended, when it
   * holds audit entries after the project's last save. Journals with nothing unsaved are deleted.
   */
  async recoveryInfo(): Promise<RecoveryInfo | null> {
    const store = this.o.journal;
    if (store === undefined) return null;
    for (;;) {
      const found = await store.findOrphan();
      if (found === null) return null;
      const entries = AuditLog.fromJsonl(found.projectId, found.auditJsonl).log.entries();
      const lastSave = entries.map((e) => e.action).lastIndexOf('project.save');
      // A project that was only created holds nothing worth recovering.
      const unsaved = entries.slice(lastSave + 1).filter((e) => e.action !== 'project.create').length;
      if (unsaved > 0) {
        return {
          projectId: found.projectId,
          name: found.name,
          updatedAt: found.updatedAt,
          entries: entries.length,
          unsaved,
        };
      }
      await store.dropOrphan();
    }
  }

  /** Result: ProjectOpenReport. Rebuilds the unsaved project and makes it this session's project. */
  async recoverProject(): Promise<JobHandle> {
    return this.jobs.start('open', (ctx) =>
      this.exclusive(async () => {
        const store = this.o.journal;
        const found = store === undefined ? null : await store.findOrphan();
        if (store === undefined || found === null) {
          throw new EngineError(
            'NOT_FOUND',
            'There is no unsaved work to recover.',
            'Start a new project or open one.',
          );
        }
        ctx.progress({ phase: `Recovering ${found.name}`, done: 0, unit: 'items' });
        const opened = await openJournal(found, {
          memoryBudgetBytes: this.memoryBudgetBytes,
          signal: ctx.signal,
          onProgress: (done, total) => ctx.progress({ phase: `Rebuilding ${found.name}`, done, total, unit: 'items' }),
        });
        ctx.checkCancelled();
        this.state = opened.state;
        // Journalled again by this session before the old journal goes.
        this.changed(EVERYTHING);
        await this.journalWrites;
        await store.dropOrphan();
        this.log(
          opened.readOnly ? 'warn' : 'info',
          `Recovered ${found.name} as it was at ${found.updatedAt}${opened.readOnly ? ', read-only' : ''}.`,
        );
        const report: ProjectOpenReport = {
          project: this.summary(opened.state),
          readOnly: opened.readOnly,
          checks: opened.checks,
        };
        return report;
      }),
    );
  }

  /** Deletes the unsaved work recoveryInfo found; it cannot be recovered afterwards. */
  async discardRecovery(): Promise<void> {
    const store = this.o.journal;
    if (store === undefined) return;
    if ((await store.findOrphan()) !== null) await store.dropOrphan();
  }

  // -------------------------------------------------------------------------------------------
  // Mapping templates (FR-IMP-06)

  async listMappingTemplates(): Promise<MappingTemplate[]> {
    const templates = await this.templates.load();
    return templates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async saveMappingTemplate(o: { datasetId: DatasetId; name: string }): Promise<MappingTemplate> {
    const state = this.project();
    const ds = datasetOf(state, o?.datasetId);
    const name = typeof o.name === 'string' ? o.name.normalize('NFC').trim() : '';
    if (name === '' || name.length > 200) {
      throw invalid('A mapping template name must be text of 1 to 200 characters.', 'Type a name for the template.');
    }
    const schema = viewFor(ds, 'working').schema;
    const columns = templateColumns(schema);
    if (columns.length === 0) {
      throw invalid(
        `${schema.name} has no columns read from its source file, so there is nothing to save.`,
        'Save a template from a dataset imported from a file.',
      );
    }
    const template: MappingTemplate = {
      id: `mt_${sha256Hex(name).slice(0, 12)}`,
      name,
      savedFrom: { fileName: schema.source.fileName, format: schema.source.format },
      columns,
      savedAt: this.o.clock.now().toISOString(),
      savedBy: state.profile.name,
    };
    const checked = schemas.mappingTemplate.safeParse(template);
    if (!checked.success) {
      throw new EngineError(
        'INTERNAL',
        `The mapping template "${name}" could not be saved: ${checked.error.issues[0]?.message ?? 'it is not valid'}.`,
        'Report this problem; no template was saved.',
      );
    }
    const kept = (await this.templates.load()).filter((t) => t.id !== template.id);
    await this.templates.save([...kept, template]);
    this.log('info', `Saved the mapping template "${name}" from ${schema.name} (${columns.length} columns).`);
    return structuredClone(template);
  }

  async deleteMappingTemplate(id: TemplateId): Promise<void> {
    const templates = await this.templates.load();
    const gone = templates.find((t) => t.id === id);
    if (gone === undefined) {
      throw new EngineError(
        'NOT_FOUND',
        `There is no mapping template ${String(id)}.`,
        'Choose a template from the list.',
      );
    }
    await this.templates.save(templates.filter((t) => t !== gone));
    this.log('info', `Deleted the mapping template "${gone.name}".`);
  }

  // -------------------------------------------------------------------------------------------
  // Recipes (FR-RCP-01..03)

  async saveRecipe(o: {
    datasetId: DatasetId;
    name: string;
    export: { profile: ExportProfileId; neutralizeFormulas: boolean } | null;
  }): Promise<SavedRecipe> {
    const state = this.project();
    const ds = datasetOf(state, o?.datasetId);
    const name = typeof o.name === 'string' ? o.name.normalize('NFC').trim() : '';
    if (name === '' || name.length > 200) {
      throw invalid('A recipe name must be text of 1 to 200 characters.', 'Type a name for the recipe.');
    }
    const exported = o.export ?? null;
    if (
      exported !== null &&
      (!EXPORT_PROFILES.some((p) => p.id === exported.profile) || typeof exported.neutralizeFormulas !== 'boolean')
    ) {
      throw invalid(
        `The export profile ${String(exported.profile)} does not exist.`,
        'Choose a listed export profile, or none.',
      );
    }
    if (!ds.checked && ds.steps.length === 0 && exported === null) {
      throw invalid(
        `${ds.dataset.schema.name} has not been checked and has no steps, so a recipe of it would do nothing.`,
        'Run checks or apply a step first, then save the recipe.',
      );
    }
    const issues = [...ds.issues].map(([id, st]) => toIssue(id, st, ds));
    const recipe = buildRecipe(ds, issues, {
      name,
      version: ds.recipe?.name === name ? ds.recipe.version + 1 : 1,
      savedAt: this.o.clock.now().toISOString(),
      savedBy: state.profile.name,
      appVersion: this.o.appVersion,
      export: exported === null ? null : { profile: exported.profile, neutralizeFormulas: exported.neutralizeFormulas },
    });
    const checked = schemas.recipe.safeParse(recipe);
    if (!checked.success) {
      throw new EngineError(
        'INTERNAL',
        `The recipe "${name}" could not be saved: ${checked.error.issues[0]?.message ?? 'it is not valid'}.`,
        'Report this problem; no recipe was saved.',
      );
    }
    this.log('info', `Saved the recipe "${name}" version ${recipe.version} from ${ds.dataset.schema.name}.`);
    return { recipe, fileName: recipeFileName(recipe), bytes: recipeBytes(recipe) };
  }

  async planRecipe(datasetId: DatasetId, file: FileInput): Promise<RecipePlan> {
    const ds = this.dataset(datasetId);
    const recipe = parseRecipe(await this.readAll(file), this.fileName(file));
    return planRecipe(recipe, ds, builtinPacks()).plan;
  }

  /**
   * Records the recipe, applies its steps and runs its checks, each as its own audit entry with
   * the user's reason, then compares the issues with the recipe's baseline. A recipe that does not
   * fit the dataset is refused before anything is recorded.
   */
  async applyRecipe(datasetId: DatasetId, file: FileInput, reason: string): Promise<JobHandle> {
    const text = requireReason(reason);
    datasetOf(this.writable(), datasetId);
    return this.jobs.start('recipe', (ctx) =>
      this.exclusive(async () => {
        const state = this.writable();
        const ds = datasetOf(state, datasetId);
        const recipe = parseRecipe(await this.readAll(file), this.fileName(file));
        const { plan, steps } = planRecipe(recipe, ds, builtinPacks());
        if (!plan.fits) {
          throw new EngineError(
            'INVALID_INPUT',
            `The recipe "${recipe.name}" does not fit ${ds.dataset.schema.name}: ${plan.problems[0] ?? ''}`,
            'Set the dataset up as the recipe expects (column names, types and units), or choose another recipe.',
            { problems: plan.problems },
          );
        }
        await this.commit(state, {
          action: 'recipe.apply',
          target: { datasetId },
          reason: text,
          payload: asJson({ recipe, columns: plan.columns }),
        });
        const stepIds: StepId[] = [];
        for (const [i, input] of steps.entries()) {
          ctx.checkCancelled();
          ctx.progress({
            phase: `Applying step ${i + 1} of ${steps.length}`,
            done: i,
            total: steps.length,
            unit: 'items',
          });
          const { step } = await this.commitStep(
            state,
            ds,
            input,
            `Recipe "${recipe.name}" v${recipe.version}: ${text}`,
          );
          stepIds.push(step.id);
        }
        if (recipe.check !== null) await this.checkNow(state, ds, ctx);
        const result: RecipeRun = {
          datasetId,
          recipeId: recipe.id,
          name: recipe.name,
          version: recipe.version,
          steps: stepIds,
          checked: recipe.check !== null,
          delta: null,
          export: recipe.export,
        };
        if (recipe.baseline !== null && recipe.check !== null) {
          const name = columnNamer(ds);
          const issues = [...ds.issues].map(([id, st]) => toIssue(id, st, ds));
          const states = issues.map((i) => deltaOf(i, i.columns.map(name), recipe.baseline?.issues ?? []).state);
          result.delta = {
            new: states.filter((s) => s === 'new').length,
            changed: states.filter((s) => s === 'changed').length,
            unchanged: states.filter((s) => s === 'unchanged').length,
            resolved: resolvedSince(baselineOf(ds, issues), recipe.baseline.issues),
          };
        }
        this.changed(['project', 'steps', 'schema', 'datasets', 'issues', 'audit'], datasetId);
        this.log('info', `Ran the recipe "${recipe.name}" version ${recipe.version} on ${ds.dataset.schema.name}.`);
        return result;
      }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Reading data

  async getSchema(datasetId: DatasetId, stage: 'working' | 'output' = 'working'): Promise<TableSchema> {
    return structuredClone(viewFor(this.dataset(datasetId), requireStage(stage)).schema);
  }

  async getRows(q: RowWindowRequest): Promise<RowWindow> {
    return rowWindow(this.dataset(q?.datasetId), q);
  }

  async getColumnStats(datasetId: DatasetId, columnId: ColumnId): Promise<ColumnStats> {
    return columnStats(this.dataset(datasetId), columnId);
  }

  async explainCell(datasetId: DatasetId, rowId: RowId, columnId: ColumnId): Promise<CellLineage> {
    const state = this.project();
    return structuredClone(await explainCell(state, datasetOf(state, datasetId), rowId, columnId));
  }

  // -------------------------------------------------------------------------------------------
  // Checks and issues

  async runChecks(datasetId: DatasetId): Promise<JobHandle> {
    datasetOf(this.writable(), datasetId);
    return this.jobs.start('check', (ctx) =>
      this.exclusive(async () => {
        const state = this.writable();
        const ds = datasetOf(state, datasetId);
        const started = this.o.clock.now().getTime();
        const { drafts, packs } = await this.checkNow(state, ds, ctx);
        const bySeverity: Record<Severity, number> = { error: 0, warning: 0, note: 0 };
        const byRule: Record<string, number> = {};
        for (const d of drafts) {
          bySeverity[d.severity]++;
          byRule[d.ruleId] = (byRule[d.ruleId] ?? 0) + 1;
        }
        this.changed(['project', 'issues', 'audit'], datasetId);
        const summary: CheckSummary = {
          datasetId,
          packs,
          issues: drafts.length,
          bySeverity,
          byRule,
          durationMs: Math.max(0, this.o.clock.now().getTime() - started),
        };
        return summary;
      }),
    );
  }

  /** Runs the built-in rule packs on a dataset and records the run. */
  private async checkNow(
    state: ProjectState,
    ds: DatasetState,
    ctx: { signal: AbortSignal; progress(p: JobProgress): void; checkCancelled(): void },
  ): Promise<{ drafts: IssueDraft[]; packs: RulePackRef[] }> {
    const drafts = await checkDrafts(state, ds, ctx.signal, (done, total) =>
      ctx.progress({ phase: 'Running checks', done, total, unit: 'items' }),
    );
    ctx.checkCancelled();
    const packs = builtinPacks();
    await this.commit(
      state,
      { action: 'check.run', target: { datasetId: ds.id }, payload: asJson({ packs }) },
      { datasetId: ds.id, drafts },
    );
    return { drafts, packs };
  }

  async listIssues(q: IssueQuery): Promise<Page<Issue>> {
    return listIssues(this.project(), q ?? {});
  }

  async listOccurrences(issueId: IssueId, p: PageRequest): Promise<Page<IssueOccurrence>> {
    return listOccurrences(this.project(), issueId, p);
  }

  async getHealth(datasetId: DatasetId): Promise<DatasetHealth> {
    return datasetHealth(this.project(), datasetId);
  }

  async decide(d: Decision): Promise<AuditEntry[]> {
    this.writable();
    return this.exclusive(async () => {
      const state = this.writable();
      const entry = await this.commitDraft(state, decisionDraft(state, d));
      this.changed(
        EVERYTHING.filter((w) => w !== 'exports'),
        entry.target.datasetId,
      );
      return [structuredClone(entry)];
    });
  }

  async listAudit(q: AuditQuery): Promise<Page<AuditEntry>> {
    return structuredClone(this.project().log.query(q ?? {}));
  }

  async verifyAudit(): Promise<ChainReport> {
    return this.project().log.verify();
  }

  // -------------------------------------------------------------------------------------------
  // Steps

  async previewStep(datasetId: DatasetId, s: StepInput): Promise<StepPreview> {
    const ds = this.dataset(datasetId);
    return structuredClone(previewStep(ds.dataset, ds, s));
  }

  async applyStep(datasetId: DatasetId, s: StepInput, reason: string): Promise<JobHandle> {
    const text = requireReason(reason);
    this.validStep(datasetOf(this.writable(), datasetId), s);
    return this.jobs.start('step', (ctx) =>
      this.exclusive(async () => {
        const state = this.writable();
        const ds = datasetOf(state, datasetId);
        ctx.checkCancelled();
        const { input, step, entry, description, method } = await this.commitStep(state, ds, s, text);
        const result: StepResult = {
          step: structuredClone(step),
          audit: structuredClone(entry),
          description,
          outputRows: outputView(ds).rowCount,
        };
        if (method !== undefined && input.kind === 'convert_unit') {
          const view = workingView(ds);
          let converted = 0;
          let nullsSkipped = 0;
          for (const r of view.rows()) {
            const v = view.value(r, input.columnId);
            if (typeof v === 'number') converted++;
            else if (v === null) nullsSkipped++;
          }
          Object.assign(result, { method, converted, nullsSkipped });
        }
        this.changed(['project', 'steps', 'schema', 'datasets', 'issues', 'audit'], datasetId);
        return result;
      }),
    );
  }

  /** Validates a step against the dataset as it stands and records it. */
  private async commitStep(
    state: ProjectState,
    ds: DatasetState,
    s: StepInput,
    reason: string,
  ): Promise<{
    input: StepInput;
    step: Step;
    entry: AuditEntry;
    description: string;
    method: ConversionMethod | undefined;
  }> {
    const { input, schema } = this.validStep(ds, s);
    const stepId = `s${state.nextStep}`;
    const method = input.kind === 'convert_unit' ? conversionFor(input, schema) : undefined;
    const description = describeStep(input, schema);
    const entry = await this.commit(state, {
      action: 'step.apply',
      target: { datasetId: ds.id, stepId, ...(input.kind === 'convert_unit' ? { columnId: input.columnId } : {}) },
      new: asJson(input),
      reason,
      ...(method === undefined ? {} : { method }),
      payload: { description },
    });
    const step = ds.steps.find((x) => x.id === stepId);
    if (step === undefined)
      throw new EngineError('INTERNAL', `Step ${stepId} was not applied.`, 'Apply the step again.');
    return { input, step, entry, description, method };
  }

  async removeStep(datasetId: DatasetId, stepId: StepId, reason: string): Promise<AuditEntry> {
    const text = requireReason(reason);
    this.writable();
    return this.exclusive(async () => {
      const state = this.writable();
      const ds = datasetOf(state, datasetId);
      const step = ds.steps.find((x) => x.id === stepId);
      if (step === undefined) {
        throw new EngineError(
          'NOT_FOUND',
          `Dataset ${datasetId} has no step ${String(stepId)}.`,
          'Choose a listed step.',
        );
      }
      requireStepsBuild(
        ds,
        ds.steps.filter((x) => x.id !== stepId),
        `Removing step ${stepId}`,
      );
      const { id: _id, seq: _seq, ...input } = step;
      const entry = await this.commit(state, {
        action: 'step.remove',
        target: { datasetId, stepId },
        old: asJson(input),
        reason: text,
      });
      this.changed(['project', 'steps', 'schema', 'datasets', 'issues', 'audit'], datasetId);
      return structuredClone(entry);
    });
  }

  async listUnits(q?: { quantity?: QuantityKind; compatibleWith?: string }): Promise<UnitInfo[]> {
    return listUnits(q);
  }

  async listRulePacks(): Promise<RulePack[]> {
    return structuredClone([GENERIC_DQ, SYSTEM_RULES]);
  }

  // -------------------------------------------------------------------------------------------
  // Export

  async listExportProfiles(datasetId: DatasetId): Promise<ExportProfileStatus[]> {
    const ds = this.dataset(datasetId);
    return structuredClone(profileStatuses(outputView(ds), ds.dataset.schema.crs));
  }

  async exportData(req: ExportRequest): Promise<JobHandle> {
    const ds = datasetOf(this.writable(), req?.datasetId);
    if (!EXPORT_PROFILES.some((p) => p.id === req.profile)) {
      throw invalid(
        `The export profile ${String(req.profile)} does not exist.`,
        'Choose Excel, CSV, Parquet or GeoJSON.',
      );
    }
    this.requireTarget(req.target);
    const plan = planExport(outputView(ds), req.profile, ds.dataset.schema.crs);
    if (!plan.available) {
      throw new EngineError(
        'EXPORT_REFUSED',
        plan.reason ?? 'This export is not available.',
        plan.fix ?? 'Choose another export profile.',
        {
          profile: req.profile,
        },
      );
    }
    return this.jobs.start('export', (ctx) =>
      this.exclusive(async () => {
        const state = this.writable();
        const current = datasetOf(state, req.datasetId);
        const input = this.exportInput(state, current, req);
        const result: ExportResult = await buildExport(input, {
          signal: ctx.signal,
          onProgress: (p) => ctx.progress(p),
        });
        ctx.checkCancelled();
        if (result.ok && result.packageSha256 !== null) {
          const record: ExportRecord = {
            exportId: result.exportId,
            profile: req.profile,
            datasetId: current.id,
            packageName: result.packageName,
            packageSha256: result.packageSha256,
            createdAt: input.at,
            ok: true,
          };
          await this.commit(state, {
            action: 'export.create',
            target: { datasetId: current.id },
            new: { packageName: result.packageName },
            payload: asJson({ record }),
          });
          if (req.target?.kind === 'path' && result.bytes !== undefined) {
            await this.fs().writeFile(req.target.path, result.bytes);
            delete result.bytes;
            result.path = req.target.path;
          }
          this.changed(['project', 'exports', 'audit'], current.id);
          this.log('info', `Exported ${current.dataset.schema.name} as ${result.packageName}.`);
        } else {
          const failed = result.validation.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
          this.log(
            'error',
            `The export of ${current.dataset.schema.name} failed read-back (TW-EXP-001): ${failed.join('; ')}`,
          );
        }
        return result;
      }),
    );
  }

  async cancelJob(jobId: JobId): Promise<void> {
    this.jobs.cancel(jobId);
  }

  async jobOutcome(jobId: JobId): Promise<JobOutcome<unknown>> {
    return this.jobs.outcome(jobId);
  }

  // -------------------------------------------------------------------------------------------
  // Internals

  /** Runs changes one at a time, in call order; a failed change does not stop the ones after it. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private project(): ProjectState {
    if (this.state === null) {
      throw new EngineError('NOT_FOUND', 'No project is open.', 'Create a new project or open a .twp project file.');
    }
    return this.state;
  }

  private writable(): ProjectState {
    const state = this.project();
    if (state.readOnly) {
      throw new EngineError(
        'READ_ONLY_PROJECT',
        'This project opened read-only because its integrity checks failed, so it cannot be changed.',
        'Review the Open report and the project issues. To continue working, import the original files into a new project.',
      );
    }
    return state;
  }

  private dataset(id: DatasetId | undefined): DatasetState {
    return datasetOf(this.project(), id as DatasetId);
  }

  /** Appends a draft and applies it, so the log and the state never disagree. */
  private async commit(
    state: ProjectState,
    draft: AuditDraft,
    prepared?: Prepared,
    actor?: Actor,
  ): Promise<AuditEntry> {
    const entry = state.log.append(draft, this.o.clock.now().toISOString(), actor ?? userActor(state.profile));
    await applyEntry(state, entry, {
      memoryBudgetBytes: this.memoryBudgetBytes,
      signal: new AbortController().signal,
      ...(prepared === undefined ? {} : { prepared }),
    });
    return entry;
  }

  /**
   * Commits a decision's draft. An override reads the file again; that is done before the entry is
   * appended, so a file that cannot be read that way leaves no entry behind.
   */
  private async commitDraft(state: ProjectState, draft: AuditDraft): Promise<AuditEntry> {
    const seq = state.log.head.seq + 1;
    const env = { memoryBudgetBytes: this.memoryBudgetBytes, signal: new AbortController().signal };
    let target: AuditEntry | undefined;
    let value: JsonValue | undefined;
    if (draft.action === 'detection.override') {
      value = draft.new;
    } else if (draft.action === 'entry.revert') {
      target = state.log.get(draft.target.seq as number);
      if (target?.action === 'detection.override') value = target.old;
    }
    if (value === undefined) return this.commit(state, draft);
    const source = draft.action === 'detection.override' ? draft : (target as AuditEntry);
    const ds = datasetOf(state, source.target.datasetId as DatasetId);
    const { property } = source.payload as { property: OverridableProperty };
    const outcome = await overrideOutcome(state, ds, { property, columnId: source.target.columnId, value, seq }, env);
    return this.commit(state, draft, { datasetId: ds.id, outcome });
  }

  private validStep(ds: DatasetState, s: StepInput): { input: StepInput; schema: TableSchema } {
    const kind = (s as { kind?: unknown } | undefined)?.kind;
    if (kind !== 'convert_unit' && kind !== 'filter' && kind !== 'select_columns') {
      throw invalid(
        `The step kind ${String(kind)} does not exist.`,
        'Choose a unit conversion, a filter or a column selection.',
      );
    }
    const input = roundTrip(s);
    // A conversion reads the working view (every column); filters and selections the output so far.
    const schema = input.kind === 'convert_unit' ? workingView(ds).schema : outputView(ds).schema;
    const valid = validateStep(input, schema);
    if (!valid.ok) throw EngineError.from(valid.error);
    return { input, schema };
  }

  private exportInput(state: ProjectState, ds: DatasetState, req: ExportRequest): ExportInput {
    const view = outputView(ds);
    const original = state.originals.get(ds.fileId);
    return {
      exportId: this.o.ids.newExportId(),
      baseName: req.baseName?.trim() || ds.dataset.schema.name,
      neutralizeFormulas: req.neutralizeFormulas === true,
      profile: req.profile,
      at: this.o.clock.now().toISOString(),
      appVersion: this.o.appVersion,
      owner: this.o.owner,
      project: { id: state.id, name: state.name },
      view,
      crs: ds.dataset.schema.crs,
      sources: original === undefined ? [] : [{ ...original.info }],
      rulePacks: ds.checkPacks,
      unitRegistry: { version: REGISTRY_VERSION, sha256: sha256Hex(REGISTRY_JSON) },
      steps: ds.steps,
      stepDescriptions: this.stepDescriptions(state, ds),
      excludedRows: ds.excluded.size,
      assumptions: ds.assumptions,
      issues: [...ds.issues].map(([id, st]) => toIssue(id, st, ds)),
      audit: state.log.entries(),
      auditHead: state.log.head,
    };
  }

  /** Each step described as it was applied, from its own audit entry. */
  private stepDescriptions(state: ProjectState, ds: DatasetState): string[] {
    return ds.steps.map((s) => {
      const recorded = (state.log.get(s.seq)?.payload as { description?: unknown } | undefined)?.description;
      return typeof recorded === 'string' ? recorded : describeStep(s, workingView(ds).schema);
    });
  }

  private datasetSummary(ds: DatasetState): DatasetSummary {
    const schema = ds.dataset.schema;
    return {
      id: ds.id,
      name: schema.name,
      source: { ...schema.source },
      rowCount: ds.dataset.rowCount,
      outputRowCount: outputView(ds).rowCount,
      columnCount: workingView(ds).schema.columns.length,
      assumptions: ds.assumptions.length,
      partial: schema.partial,
      steps: structuredClone(ds.steps),
    };
  }

  private summary(state: ProjectState): ProjectSummary {
    const head = state.log.head;
    return {
      id: state.id,
      name: state.name,
      createdAt: state.createdAt,
      profile: { ...state.profile },
      unitSystem: state.unitSystem,
      projectArea: state.projectArea === null ? null : [...state.projectArea],
      readOnly: state.readOnly,
      dirty: head.seq > 0 && state.lastSavedSeq !== head.seq,
      lastSavedAt: state.lastSavedAt,
      originals: [...state.originals.values()].map((o) => ({ ...o.info })),
      datasets: [...state.datasets.values()].map((ds) => this.datasetSummary(ds)),
      exports: state.exports.map((e) => ({ ...e })),
      rulePacks: state.rulePacks.map((r) => ({ ...r })),
      auditHead: { ...head },
    };
  }

  private fileName(file: FileInput): string {
    const name: unknown =
      file?.kind === 'path'
        ? file.path.split(/[\\/]/).pop()
        : file?.kind === 'blob' || file?.kind === 'bytes'
          ? file.name
          : undefined;
    if (typeof name !== 'string' || name.trim() === '') {
      throw invalid('The file has no name.', 'Pass a file input with a name, as the file picker provides.');
    }
    if (file.kind === 'path' && this.o.fs === undefined) this.fs();
    return name;
  }

  private fs(): FileSystem {
    if (this.o.fs === undefined) {
      throw invalid(
        'This edition cannot read or write files by path.',
        'Choose the file with the file picker instead.',
      );
    }
    return this.o.fs;
  }

  private requireTarget(target: FileTarget | undefined): void {
    if (target === undefined || target.kind === 'return-bytes') return;
    if (target.kind === 'path' && typeof target.path === 'string' && target.path !== '') {
      this.fs();
      return;
    }
    throw invalid('The save target is not valid.', "Pass { kind: 'return-bytes' } or a file path.");
  }

  private async source(file: FileInput): Promise<ByteSource> {
    const name = this.fileName(file);
    if (file.kind === 'blob') return blobSource(file.blob, name);
    if (file.kind === 'path' && this.o.fs?.open !== undefined) return this.o.fs.open(file.path);
    return bytesSource(await this.readAll(file), name);
  }

  private async readAll(file: FileInput): Promise<Uint8Array> {
    if (file.kind === 'bytes') {
      if (!(file.bytes instanceof Uint8Array))
        throw invalid('The file bytes are missing.', 'Pass the file contents as bytes.');
      return file.bytes;
    }
    if (file.kind === 'blob') return new Uint8Array(await file.blob.arrayBuffer());
    const fs = this.fs();
    const size = fs.open === undefined ? 0 : (await fs.open(file.path)).size;
    if (size > MAX_WHOLE_FILE_BYTES) {
      throw new EngineError(
        'MEMORY_BUDGET',
        `The file ${this.fileName(file)} is ${size} bytes, more than this edition can hold in memory.`,
        'Open it with the desktop edition, which reads files of any size.',
        { size, limit: MAX_WHOLE_FILE_BYTES },
      );
    }
    return fs.readFile(file.path);
  }

  private emit(e: EngineEvent): void {
    for (const { cb } of [...this.listeners]) {
      try {
        cb(e);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  private changed(what: Change[], datasetId?: DatasetId): void {
    this.emit(
      datasetId === undefined ? { type: 'project.changed', what } : { type: 'project.changed', what, datasetId },
    );
    this.journal();
  }

  /**
   * Writes the recovery journal after a change: the audit log as it now stands and the originals.
   * A read-only project records nothing new, so it has nothing to journal.
   */
  private journal(): void {
    const store = this.o.journal;
    const state = this.state;
    if (store === undefined || state === null || state.readOnly) return;
    const record = {
      projectId: state.id,
      name: state.name,
      updatedAt: this.o.clock.now().toISOString(),
      auditJsonl: state.log.toJsonl(),
      originals: [...state.originals.values()].map((o) => ({ info: { ...o.info }, bytes: o.bytes })),
    };
    this.journalWrites = this.journalWrites
      .then(() => store.write(record))
      .then(
        () => {
          this.journalFailed = false;
        },
        (e: unknown) => {
          // Said once, not after every change, until a write succeeds again.
          if (!this.journalFailed) {
            this.log('warn', `Unsaved work could not be journalled for recovery: ${EngineError.from(e).message}`);
          }
          this.journalFailed = true;
        },
      );
  }

  /** Resolves once every journal write so far has finished (for tests and an orderly close). */
  journalIdle(): Promise<void> {
    return this.journalWrites;
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'log', level, message, at: this.o.clock.now().toISOString() });
  }
}
