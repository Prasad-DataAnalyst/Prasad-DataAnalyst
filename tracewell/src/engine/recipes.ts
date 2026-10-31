/**
 * Recipes (FR-RCP-01..03), as the engine builds, reads and plans them. A recipe names the columns
 * its steps use, as they were imported (before any step converts or hides them); on another
 * dataset each is found by name among its imported columns and must have the same type and unit,
 * since a threshold or a conversion written for one unit means something else in another. Steps
 * are checked one after another against the dataset as the earlier ones leave it, so a recipe
 * that does not fit is refused before anything changes.
 */
import {
  EngineError,
  schemas,
  type ColumnId,
  type ExportProfileId,
  type Issue,
  type IssueDelta,
  type Predicate,
  type Recipe,
  type RecipeBaselineIssue,
  type RecipeColumn,
  type RecipePlan,
  type RulePackRef,
  type StepInput,
  type TableSchema,
} from '@tw/model';
import { sha256Hex } from '@tw/io';
import { buildOutputView, buildWorkingView, describeStep, validateStep } from '@tw/steps';
import type { DatasetState } from './state';
import { workingView } from './views';

const FILE_EXTENSION = '.twr';

/** The recipe of the same name keeps its ID through every version. */
export function recipeId(name: string): string {
  return `rcp_${sha256Hex(name).slice(0, 12)}`;
}

/** The base column of a column ID: 'c4' for 'c4' and for the converted 'c4~kPa'. */
function baseOf(id: ColumnId): { base: ColumnId; suffix: string } {
  const i = id.indexOf('~');
  return i < 0 ? { base: id, suffix: '' } : { base: id.slice(0, i), suffix: id.slice(i) };
}

function predicateColumns(p: Predicate): ColumnId[] {
  if ('all' in p) return p.all.flatMap(predicateColumns);
  if ('any' in p) return p.any.flatMap(predicateColumns);
  if ('not' in p) return predicateColumns(p.not);
  if ('geometry' in p) return [p.geometry];
  if ('lat' in p) return [p.lat, p.lon];
  return [p.column];
}

function stepColumns(s: StepInput): ColumnId[] {
  switch (s.kind) {
    case 'convert_unit':
      return [s.columnId];
    case 'filter':
      return predicateColumns(s.predicate);
    case 'select_columns':
      return s.columnIds;
  }
}

function mapPredicate(p: Predicate, f: (c: ColumnId) => ColumnId): Predicate {
  if ('all' in p) return { all: p.all.map((x) => mapPredicate(x, f)) };
  if ('any' in p) return { any: p.any.map((x) => mapPredicate(x, f)) };
  if ('not' in p) return { not: mapPredicate(p.not, f) };
  if ('geometry' in p) return { ...p, geometry: f(p.geometry) };
  if ('lat' in p) return { ...p, lat: f(p.lat), lon: f(p.lon) };
  return { ...p, column: f(p.column) };
}

/** The step with every column ID passed through `f`. */
export function mapStepColumns(s: StepInput, f: (c: ColumnId) => ColumnId): StepInput {
  switch (s.kind) {
    case 'convert_unit':
      return { ...s, columnId: f(s.columnId) };
    case 'filter':
      return { ...s, predicate: mapPredicate(s.predicate, f) };
    case 'select_columns':
      return { ...s, columnIds: s.columnIds.map(f) };
  }
}

/** Column names of a dataset's working view, for issue keys and baselines. */
export function columnNamer(ds: DatasetState): (id: ColumnId) => string {
  const view = workingView(ds);
  return (id) => {
    try {
      return view.columnSchema(id).name;
    } catch {
      return id;
    }
  };
}

function issueKey(ruleId: string, columns: readonly string[]): string {
  return `${ruleId}\u0000${columns.join('\u0001')}`;
}

/** The dataset's issues as a baseline: rule, column names, severity and count, no values. */
export function baselineOf(ds: DatasetState, issues: readonly Issue[]): RecipeBaselineIssue[] {
  const name = columnNamer(ds);
  return issues
    .filter((i) => i.datasetId === ds.id)
    .map((i) => ({ ruleId: i.ruleId, columns: i.columns.map(name), severity: i.severity, flagged: i.counts.flagged }))
    .sort((a, b) => (issueKey(a.ruleId, a.columns) < issueKey(b.ruleId, b.columns) ? -1 : 1));
}

export function buildRecipe(
  ds: DatasetState,
  issues: readonly Issue[],
  o: {
    name: string;
    version: number;
    savedAt: string;
    savedBy: string;
    appVersion: string;
    export: { profile: ExportProfileId; neutralizeFormulas: boolean } | null;
  },
): Recipe {
  // The columns as imported: a conversion in place hides the original from the working view.
  const schema = ds.dataset.schema;
  const steps = ds.steps.map(({ id: _id, seq: _seq, ...input }) => input as StepInput);
  const keys = [...new Set(steps.flatMap(stepColumns).map((c) => baseOf(c).base))];
  const columns: RecipeColumn[] = keys.map((key) => {
    const c = schema.columns.find((x) => x.id === key);
    if (c === undefined) {
      throw new EngineError('INTERNAL', `Step column ${key} is not in ${schema.name}.`, 'Report this problem.');
    }
    return { key, name: c.name, type: c.type.value, unit: c.unit.value };
  });
  return {
    format: 'tracewell-recipe',
    formatVersion: 1,
    id: recipeId(o.name),
    name: o.name,
    version: o.version,
    savedAt: o.savedAt,
    savedBy: o.savedBy,
    appVersion: o.appVersion,
    columns,
    check: ds.checked ? { packs: structuredClone(ds.checkPacks) } : null,
    steps,
    export: o.export,
    baseline: ds.checked ? { rows: ds.dataset.rowCount, issues: baselineOf(ds, issues) } : null,
  };
}

export function recipeFileName(recipe: Recipe): string {
  // Characters no file system accepts in a name, and control characters, become '_'.
  const stem = [...recipe.name]
    .map((ch) => (ch < ' ' || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .trim();
  return `${stem || 'recipe'} v${recipe.version}${FILE_EXTENSION}`;
}

export function recipeBytes(recipe: Recipe): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(recipe, null, 2)}\n`);
}

/** Reads a .twr file; anything that is not a valid recipe is refused with what is wrong. */
export function parseRecipe(bytes: Uint8Array, fileName: string): Recipe {
  const fix = 'Choose a .twr file saved by Tracewell, or ask its author to save it again.';
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new EngineError('FORMAT_UNSUPPORTED', `${fileName} is not a Tracewell recipe: it is not JSON text.`, fix);
  }
  const parsed = schemas.recipe.safeParse(doc);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined || first.path.length === 0 ? '' : ` at ${first.path.join('.')}`;
    throw new EngineError(
      'FORMAT_UNSUPPORTED',
      `${fileName} is not a valid Tracewell recipe${where}: ${first?.message ?? 'its structure is wrong'}.`,
      fix,
    );
  }
  if (parsed.data.id !== recipeId(parsed.data.name)) {
    throw new EngineError(
      'FORMAT_UNSUPPORTED',
      `${fileName} has an ID that does not belong to its name "${parsed.data.name}", so it was changed by hand.`,
      fix,
    );
  }
  return parsed.data;
}

/**
 * How the recipe maps onto a dataset, and the steps as they would be applied there. `available`
 * are the rule packs this engine checks with; a recipe checked with others cannot be repeated.
 */
export function planRecipe(
  recipe: Recipe,
  ds: DatasetState,
  available: readonly RulePackRef[],
): { plan: RecipePlan; steps: StepInput[] } {
  const schema = ds.dataset.schema;
  const problems: string[] = [];
  for (const p of recipe.check?.packs ?? []) {
    if (!available.some((a) => a.id === p.id && a.version === p.version && a.sha256 === p.sha256)) {
      problems.push(
        `The recipe checks with the rule pack ${p.id} ${p.version}, which this copy of Tracewell does not have, so its checks cannot be repeated.`,
      );
    }
  }
  const target = new Map<ColumnId, ColumnId>();
  const columns = recipe.columns.map((rc) => {
    const c = schema.columns.find((x) => x.derivedFrom === undefined && x.name === rc.name);
    let problem: string | null = null;
    if (c === undefined) problem = `${schema.name} has no column named "${rc.name}".`;
    else if (c.type.value !== rc.type)
      problem = `"${rc.name}" holds ${c.type.value} values here, ${rc.type} in the recipe.`;
    else if (c.unit.value !== rc.unit) {
      problem = `"${rc.name}" is in ${c.unit.value ?? 'no unit'} here, ${rc.unit ?? 'no unit'} in the recipe; its thresholds and conversions would mean something else.`;
    }
    if (problem !== null) problems.push(problem);
    if (c !== undefined && problem === null) target.set(rc.key, c.id);
    return { key: rc.key, name: rc.name, columnId: c?.id ?? null, problem };
  });
  const steps: StepInput[] = [];
  const descriptions: string[] = [];
  if (problems.length === 0) {
    const map = (id: ColumnId): ColumnId => {
      const { base, suffix } = baseOf(id);
      return `${target.get(base) ?? base}${suffix}`;
    };
    const applied = [...ds.steps];
    for (const [i, raw] of recipe.steps.entries()) {
      const input = mapStepColumns(raw, map);
      const st = { overlay: ds.overlay, excluded: ds.excluded, steps: applied };
      const at: TableSchema =
        input.kind === 'convert_unit'
          ? buildWorkingView(ds.dataset, st).schema
          : buildOutputView(ds.dataset, st).schema;
      const valid = validateStep(input, at);
      if (!valid.ok) {
        problems.push(`Step ${i + 1} cannot be applied: ${valid.error.message}`);
        break;
      }
      descriptions.push(describeStep(input, at));
      steps.push(input);
      applied.push({ ...input, id: `s_plan_${i}`, seq: 1 });
    }
  }
  return {
    plan: {
      recipe,
      datasetId: ds.id,
      columns,
      steps: descriptions,
      problems,
      fits: problems.length === 0,
    },
    steps,
  };
}

/** An issue compared with a baseline: new, changed (another count) or unchanged. */
export function deltaOf(
  issue: Issue,
  names: readonly string[],
  baseline: readonly RecipeBaselineIssue[],
): { state: IssueDelta; previous: number | null } {
  const key = issueKey(issue.ruleId, names);
  const before = baseline.find((b) => issueKey(b.ruleId, b.columns) === key);
  if (before === undefined) return { state: 'new', previous: null };
  return { state: before.flagged === issue.counts.flagged ? 'unchanged' : 'changed', previous: before.flagged };
}

/** Baseline issues no current issue matches: what the new data no longer has. */
export function resolvedSince(
  current: readonly { ruleId: string; columns: readonly string[] }[],
  baseline: readonly RecipeBaselineIssue[],
): RecipeBaselineIssue[] {
  const now = new Set(current.map((c) => issueKey(c.ruleId, c.columns)));
  return baseline.filter((b) => !now.has(issueKey(b.ruleId, b.columns)));
}
