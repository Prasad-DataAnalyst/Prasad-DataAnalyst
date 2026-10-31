/**
 * The stub engine: a deterministic EngineImpl over one canned dataset, so the UI can be built and
 * exercised before, and independently of, the real engine. It keeps the protocol's behaviour
 * (jobs with progress and cancel, reasons, the audit chain, revert, read-only projects) while its
 * data, hashes and verification results are canned. It must never be used to produce real output.
 */
import {
  EngineError,
  type AuditEntry,
  type AuditQuery,
  type CellLineage,
  type ChainReport,
  type ColumnId,
  type ColumnOverride,
  type ColumnStats,
  type DatasetHealth,
  type DatasetId,
  type DatasetSummary,
  type Decision,
  type ExportProfileId,
  type ExportProfileStatus,
  type ExportRequest,
  type FileInput,
  type FileTarget,
  type FormatOptions,
  type ImportPreview,
  type ImportRequestOptions,
  type Issue,
  type IssueId,
  type IssueOccurrence,
  type IssueQuery,
  type JobHandle,
  type JobId,
  type JobOutcome,
  type JsonValue,
  type MappingTemplate,
  type OverridableProperty,
  type Page,
  type PageRequest,
  type ProjectOpenReport,
  type ProjectSummary,
  type QuantityKind,
  type Recipe,
  type RecipePlan,
  type RecipeRun,
  type RecoveryInfo,
  type RowId,
  type RowWindow,
  type RowWindowRequest,
  type RulePack,
  type SavedRecipe,
  type StepId,
  type StepInput,
  type StepPreview,
  type TableSchema,
  type TemplateId,
  type UnitInfo,
  type UserProfile,
} from '@tw/model';
import { Listeners } from './messages';
import { PROTOCOL_VERSION, type EngineEvent, type EngineImpl, type EngineInfo } from './protocol';
import {
  isSourceOptions,
  SOURCE_FILE,
  STUB_ENGINE_NAME,
  STUB_ENGINE_VERSION,
  STUB_MEMORY_BUDGET,
  STUB_PROFILES,
  stubHex,
} from './stub-data';
import { decide, requireReason, type ProjectChange } from './stub-decisions';
import { openReport, planExport, planSave, profileStatuses } from './stub-export';
import { StubJobs } from './stub-jobs';
import { planOverride } from './stub-overrides';
import { StubClock, StubProject } from './stub-project';
import {
  datasetHealth,
  importPreview,
  lineage,
  listAudit,
  listIssues,
  listOccurrences,
  listUnits,
  rowWindow,
} from './stub-queries';
import { planStep, previewStep, removeStep } from './stub-steps';
import { columnStats, findColumn, rowCount, workingView } from './stub-view';

const STUB_PROFILE: UserProfile = { id: 'u_prasad', name: 'Prasad', role: 'Analyst' };
const CANNED_PROJECT = 'Well test review';
const CANNED_DATASET = 'well_daily';
const EVERYTHING: ProjectChange[] = ['project', 'datasets', 'schema', 'issues', 'audit', 'steps', 'exports'];
const OVERRIDE_ORDER = ['name', 'type', 'unit', 'role', 'nullMarkers', 'dateFormat', 'timezone'] as const;

function invalid(message: string, fix: string): EngineError {
  return new EngineError('INVALID_INPUT', message, fix);
}

/** The name of a file passed by reference; the stub never reads the file itself. */
/** The recipe in a file of bytes; the stub reads no other kind of file. */
function stubRecipe(file: FileInput): Recipe {
  const fix = 'Choose a .twr file saved by Tracewell.';
  if (file?.kind !== 'bytes') throw invalid('The stub reads recipes from bytes only.', fix);
  try {
    const doc = JSON.parse(new TextDecoder().decode(file.bytes)) as Recipe;
    if (doc.format === 'tracewell-recipe') return doc;
  } catch {
    // Reported below.
  }
  throw new EngineError('FORMAT_UNSUPPORTED', `${fileName(file)} is not a Tracewell recipe.`, fix);
}

function fileName(file: FileInput): string {
  const name: unknown =
    file.kind === 'path'
      ? file.path.split(/[\\/]/).pop()
      : file.kind === 'blob' || file.kind === 'bytes'
        ? file.name
        : undefined;
  if (typeof name !== 'string' || name.trim() === '') {
    throw invalid('The file has no name.', 'Pass a file input with a name, as the file picker provides.');
  }
  return name;
}

function withoutExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * The stub has only its canned file, read one way. Other reading options would need the file read
 * again, so they are refused rather than silently ignored, as re-read overrides are.
 */
function requireSourceOptions(options: FormatOptions | undefined): void {
  if (options !== undefined && !isSourceOptions(options)) {
    throw invalid(
      'The stub engine can only read the file with the options it detected; other options need the file read again.',
      'Import with the detected options from the preview, or use the full engine.',
    );
  }
}

function requireStage(stage: unknown): 'working' | 'output' {
  if (stage === 'working' || stage === 'output') return stage;
  throw invalid(`The stage ${String(stage)} does not exist.`, "Ask for the 'working' or the 'output' stage.");
}

function requireProjectOptions(o: { name: string; profile: UserProfile; unitSystem?: 'SI' | 'Oilfield' }): void {
  if (typeof o.name !== 'string' || o.name.trim() === '' || o.name.length > 200) {
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

/** Import-time overrides as single-property changes, in a fixed order so dependent ones (unit after type) work. */
function overrideList(
  overrides: ColumnOverride[],
): { columnId: ColumnId; property: OverridableProperty; value: JsonValue }[] {
  return overrides.flatMap((o) =>
    OVERRIDE_ORDER.flatMap((property) => {
      const value = o[property];
      return value === undefined ? [] : [{ columnId: o.columnId, property, value: value as JsonValue }];
    }),
  );
}

/**
 * Returns a stub engine holding a deterministic canned project: one dataset of 10 rows with
 * 3 issues (an error, a warning and a note). Every call gives the same IDs, times and hashes.
 * Opening a file whose name contains "tamper" gives a read-only project, for UI development.
 */
export function createStubEngine(): EngineImpl {
  return new StubEngine();
}

class StubEngine implements EngineImpl {
  private readonly listeners = new Listeners();
  private readonly clock = new StubClock();
  private readonly jobs = new StubJobs((e) => this.listeners.emit(e));
  private projectCount = 0;
  private previewCount = 0;
  private project: StubProject;
  private templates: MappingTemplate[] = [];

  constructor() {
    this.project = this.cannedProject(CANNED_PROJECT);
  }

  on(cb: (e: EngineEvent) => void): () => void {
    return this.listeners.add(cb);
  }

  async hello(): Promise<EngineInfo> {
    return {
      name: STUB_ENGINE_NAME,
      version: STUB_ENGINE_VERSION,
      protocol: PROTOCOL_VERSION,
      capabilities: {
        // Any file is accepted and answered with the canned CSV, so every picker filter can be exercised.
        formats: ['csv', 'tsv', 'xlsx', 'geojson'],
        exportProfiles: STUB_PROFILES.map((p) => p.id),
        memoryBudgetBytes: STUB_MEMORY_BUDGET,
        spillToDisk: false,
        crsTransform: false,
      },
    };
  }

  async newProject(o: { name: string; profile: UserProfile; unitSystem?: 'SI' | 'Oilfield' }): Promise<ProjectSummary> {
    requireProjectOptions(o);
    this.project = this.emptyProject(o.name.trim(), { ...o.profile }, o.unitSystem ?? 'SI');
    this.changed(EVERYTHING);
    return this.project.summary();
  }

  async getProject(): Promise<ProjectSummary> {
    return this.project.summary();
  }

  async openProject(file: FileInput): Promise<JobHandle> {
    const name = fileName(file);
    return this.jobs.start({
      kind: 'open',
      phase: `Opening ${name}`,
      unit: 'items',
      total: 8,
      run: (): ProjectOpenReport => {
        const project = this.cannedProject(withoutExtension(name));
        const report = openReport(project, name);
        this.project = project;
        this.changed(EVERYTHING);
        this.log(report.readOnly ? 'warn' : 'info', `Opened ${name}${report.readOnly ? ' read-only' : ''}.`);
        return report;
      },
    });
  }

  async saveProject(target?: FileTarget): Promise<JobHandle> {
    const project = this.writable();
    const save = planSave(project, target);
    return this.jobs.start({
      kind: 'save',
      phase: 'Writing the project file',
      unit: 'items',
      total: project.audit.length,
      run: () => {
        this.requireCurrent(project);
        const result = save();
        this.changed(['project', 'audit']);
        this.log('info', `Saved ${result.fileName}.`);
        return result;
      },
    });
  }

  async sniff(file: FileInput, o?: { options?: FormatOptions; template?: TemplateId | null }): Promise<ImportPreview> {
    // The stub has one canned reading of its file; other settings are refused, as on import.
    requireSourceOptions(o?.options);
    return importPreview(this.project, fileName(file), `pv${++this.previewCount}`);
  }

  async importFile(file: FileInput, o?: ImportRequestOptions): Promise<JobHandle> {
    const project = this.writable();
    const source = fileName(file);
    requireSourceOptions(o?.options);
    const name = o?.name?.trim() || withoutExtension(source);
    const overrides = overrideList(o?.columnOverrides ?? []);
    const reason =
      overrides.length === 0 ? '' : requireReason(o?.overrideReason ?? '', 'override detections on import');
    // A dry run on a throwaway draft, so a bad override is reported before the job starts.
    const scratch = project.draftDataset(name);
    for (const x of overrides) planOverride(scratch, x.columnId, x.property, x.value).apply(0);
    return this.jobs.start({
      kind: 'import',
      phase: `Reading ${source}`,
      unit: 'bytes',
      total: SOURCE_FILE.size,
      run: (): DatasetSummary => {
        this.requireCurrent(project);
        const ds = project.draftDataset(name);
        project.addDataset(ds);
        for (const x of overrides) decide(project, { kind: 'override_detection', datasetId: ds.id, ...x, reason });
        this.changed(['project', 'datasets', 'schema', 'audit'], ds.id);
        this.log('info', `Imported ${source} as ${name}: ${rowCount()} rows, ${ds.columns.length} columns.`);
        return project.datasetSummary(ds);
      },
    });
  }

  async getSchema(datasetId: DatasetId, stage: 'working' | 'output' = 'working'): Promise<TableSchema> {
    return this.project.schema(this.project.dataset(datasetId), requireStage(stage));
  }

  async getRows(q: RowWindowRequest): Promise<RowWindow> {
    requireStage(q.stage);
    return rowWindow(this.project, q);
  }

  async getColumnStats(datasetId: DatasetId, columnId: ColumnId): Promise<ColumnStats> {
    const view = workingView(this.project.dataset(datasetId));
    return structuredClone(columnStats(findColumn(view, columnId), view.rows));
  }

  async explainCell(datasetId: DatasetId, rowId: RowId, columnId: ColumnId): Promise<CellLineage> {
    return lineage(this.project, datasetId, rowId, columnId);
  }

  async runChecks(datasetId: DatasetId): Promise<JobHandle> {
    const project = this.writable();
    const ds = project.dataset(datasetId);
    return this.jobs.start({
      kind: 'check',
      phase: 'Running checks',
      unit: 'rows',
      total: rowCount(),
      run: () => {
        this.requireCurrent(project);
        const summary = project.runChecks(ds);
        this.changed(['project', 'issues', 'audit'], ds.id);
        return summary;
      },
    });
  }

  async listIssues(q: IssueQuery): Promise<Page<Issue>> {
    return listIssues(this.project, q);
  }

  async listOccurrences(issueId: IssueId, p: PageRequest): Promise<Page<IssueOccurrence>> {
    return listOccurrences(this.project, issueId, p);
  }

  async getHealth(datasetId: DatasetId): Promise<DatasetHealth> {
    return datasetHealth(this.project, datasetId);
  }

  async decide(d: Decision): Promise<AuditEntry[]> {
    const applied = decide(this.project, d);
    this.changed(applied.changed, applied.datasetId);
    return applied.entries.map((e) => structuredClone(e));
  }

  async listAudit(q: AuditQuery): Promise<Page<AuditEntry>> {
    return listAudit(this.project, q);
  }

  async verifyAudit(): Promise<ChainReport> {
    return this.project.verify();
  }

  async previewStep(datasetId: DatasetId, s: StepInput): Promise<StepPreview> {
    return structuredClone(previewStep(this.project.dataset(datasetId), s));
  }

  async applyStep(datasetId: DatasetId, s: StepInput, reason: string): Promise<JobHandle> {
    const project = this.writable();
    const ds = project.dataset(datasetId);
    const apply = planStep(project, ds, s, reason);
    return this.jobs.start({
      kind: 'step',
      phase: 'Applying the step',
      unit: 'rows',
      total: rowCount(),
      run: () => {
        this.requireCurrent(project);
        const result = apply();
        this.changed(['steps', 'schema', 'datasets', 'issues', 'audit'], ds.id);
        return result;
      },
    });
  }

  async removeStep(datasetId: DatasetId, stepId: StepId, reason: string): Promise<AuditEntry> {
    const project = this.writable();
    const entry = removeStep(project, project.dataset(datasetId), stepId, reason);
    this.changed(['steps', 'schema', 'datasets', 'issues', 'audit'], datasetId);
    return entry;
  }

  async listUnits(q?: { quantity?: QuantityKind; compatibleWith?: string }): Promise<UnitInfo[]> {
    return listUnits(q);
  }

  async listRulePacks(): Promise<RulePack[]> {
    return structuredClone(this.project.rulePacks());
  }

  async listExportProfiles(datasetId: DatasetId): Promise<ExportProfileStatus[]> {
    return profileStatuses(this.project.dataset(datasetId));
  }

  async exportData(req: ExportRequest): Promise<JobHandle> {
    const project = this.writable();
    const ds = project.dataset(req.datasetId);
    const write = planExport(project, ds, req);
    return this.jobs.start({
      kind: 'export',
      phase: `Exporting ${ds.name}`,
      unit: 'rows',
      total: rowCount(),
      run: () => {
        this.requireCurrent(project);
        const result = write();
        this.changed(['exports', 'audit', 'project'], ds.id);
        this.log('info', `Exported ${ds.name} as ${result.packageName}.`);
        return result;
      },
    });
  }

  async cancelJob(jobId: JobId): Promise<void> {
    this.jobs.cancel(jobId);
  }

  async jobOutcome(jobId: JobId): Promise<JobOutcome<unknown>> {
    return this.jobs.outcome(jobId);
  }

  async listMappingTemplates(): Promise<MappingTemplate[]> {
    return structuredClone([...this.templates].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  }

  /** The stub keeps templates for the session and never applies them to its canned preview. */
  async saveMappingTemplate(o: { datasetId: DatasetId; name: string }): Promise<MappingTemplate> {
    const schema = await this.getSchema(o?.datasetId);
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (name === '') throw new EngineError('INVALID_INPUT', 'A mapping template needs a name.', 'Type a name for it.');
    const template: MappingTemplate = {
      id: `mt_${stubHex(`template:${name}`, 12)}`,
      name,
      savedFrom: { fileName: schema.source.fileName, format: schema.source.format },
      columns: schema.columns
        .filter((c) => c.derivedFrom === undefined)
        .map((c) => ({
          sourceHeader: [...c.sourceHeader],
          name: c.name,
          type: c.type.value,
          unit: c.unit.value,
          role: c.role.value,
          nullMarkers: [...c.nullMarkers.value],
        })),
      savedAt: this.clock.now(),
      savedBy: this.project.profile.name,
    };
    this.templates = [...this.templates.filter((t) => t.id !== template.id), template];
    return structuredClone(template);
  }

  /**
   * The stub saves a recipe without steps or checks, plans every recipe as fitting and runs it
   * without changing anything: enough for the recipe screens to be built against.
   */
  async saveRecipe(o: {
    datasetId: DatasetId;
    name: string;
    export: { profile: ExportProfileId; neutralizeFormulas: boolean } | null;
  }): Promise<SavedRecipe> {
    this.project.dataset(o?.datasetId);
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (name === '') throw new EngineError('INVALID_INPUT', 'A recipe needs a name.', 'Type a name for it.');
    const recipe: Recipe = {
      format: 'tracewell-recipe',
      formatVersion: 1,
      id: `rcp_${stubHex(`recipe:${name}`, 12)}`,
      name,
      version: 1,
      savedAt: this.clock.now(),
      savedBy: this.project.profile.name,
      appVersion: '0.1.0',
      columns: [],
      check: null,
      steps: [],
      export: o.export,
      baseline: null,
    };
    const bytes = new TextEncoder().encode(`${JSON.stringify(recipe, null, 2)}\n`);
    return { recipe, fileName: `${name} v1.twr`, bytes };
  }

  async planRecipe(datasetId: DatasetId, file: FileInput): Promise<RecipePlan> {
    this.project.dataset(datasetId);
    const recipe = stubRecipe(file);
    return { recipe, datasetId, columns: [], steps: [], problems: [], fits: true };
  }

  async applyRecipe(datasetId: DatasetId, file: FileInput, reason: string): Promise<JobHandle> {
    requireReason(reason, 'run a recipe');
    this.project.dataset(datasetId);
    const recipe = stubRecipe(file);
    return this.jobs.start({
      kind: 'recipe',
      phase: 'Running the recipe',
      unit: 'items',
      total: 1,
      run: (): RecipeRun => ({
        datasetId,
        recipeId: recipe.id,
        name: recipe.name,
        version: recipe.version,
        steps: [],
        checked: false,
        delta: null,
        export: recipe.export,
      }),
    });
  }

  /** The stub keeps no recovery journal, so there is never unsaved work to recover. */
  async recoveryInfo(): Promise<RecoveryInfo | null> {
    return null;
  }

  async recoverProject(): Promise<JobHandle> {
    throw new EngineError('NOT_FOUND', 'There is no unsaved work to recover.', 'Start a new project or open one.');
  }

  async discardRecovery(): Promise<void> {}

  async deleteMappingTemplate(id: TemplateId): Promise<void> {
    if (!this.templates.some((t) => t.id === id)) {
      throw new EngineError(
        'NOT_FOUND',
        `There is no mapping template ${String(id)}.`,
        'Choose a template from the list.',
      );
    }
    this.templates = this.templates.filter((t) => t.id !== id);
  }

  private emptyProject(name: string, profile: UserProfile, unitSystem: 'SI' | 'Oilfield'): StubProject {
    const id = `p_${stubHex(`project:${++this.projectCount}:${name}`, 16)}`;
    return new StubProject(this.clock, id, name, profile, unitSystem);
  }

  private cannedProject(name: string): StubProject {
    const project = this.emptyProject(name, { ...STUB_PROFILE }, 'SI');
    const ds = project.draftDataset(CANNED_DATASET);
    project.addDataset(ds);
    project.runChecks(ds);
    return project;
  }

  private writable(): StubProject {
    this.project.assertWritable();
    return this.project;
  }

  /** A job started on a project that has since been replaced must not touch the new one. */
  private requireCurrent(project: StubProject): void {
    if (project !== this.project) {
      throw new EngineError(
        'CANCELLED',
        'The project was closed before the operation finished.',
        'Run the operation again on the project that is open now.',
      );
    }
    project.assertWritable();
  }

  private changed(what: ProjectChange[], datasetId?: DatasetId): void {
    const event: EngineEvent =
      datasetId === undefined ? { type: 'project.changed', what } : { type: 'project.changed', what, datasetId };
    this.listeners.emit(event);
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.listeners.emit({ type: 'log', level, message, at: this.clock.now() });
  }
}
