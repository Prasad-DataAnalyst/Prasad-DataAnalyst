/**
 * Recipes (FR-RCP-01..03): the steps from Check to Export, saved so next month's file goes
 * through them again. A recipe holds no data: column names, types and units, the rule packs, the
 * processing and extraction steps, the export profile, and the issues of the run it was saved
 * from as rule IDs, column names and counts, so a later run can show only what is new or changed.
 * Applying one records it in the audit log; the steps and checks it runs are ordinary entries, so
 * a project replays without the recipe file.
 */
import type { ColumnId, DatasetId, IsoUtc, StepId } from './ids';
import type { ExportProfileId } from './export';
import type { RulePackRef, Severity } from './rules';
import type { StepInput } from './steps';
import type { LogicalType } from './values';

/** 'rcp_' + the first 12 hex characters of the SHA-256 of the recipe's name. */
export type RecipeId = string;

/** A column the steps use, found in a dataset by name. */
export interface RecipeColumn {
  /** The key the steps use for it: the column's ID where the recipe was saved. */
  key: ColumnId;
  name: string;
  type: LogicalType;
  unit: string | null;
}

/** An issue of the run a recipe was saved from: what it was about and how many rows, no values. */
export interface RecipeBaselineIssue {
  ruleId: string;
  /** Column names in the issue's order; empty for a finding about the whole dataset. */
  columns: string[];
  severity: Severity;
  flagged: number;
}

export interface Recipe {
  format: 'tracewell-recipe';
  formatVersion: 1;
  id: RecipeId;
  name: string;
  /** 1 when first saved; one more each time it is saved again from a dataset it was run on. */
  version: number;
  savedAt: IsoUtc;
  savedBy: string;
  appVersion: string;
  columns: RecipeColumn[];
  /** The rule packs to check with, or null when the recipe runs no checks. */
  check: { packs: RulePackRef[] } | null;
  /** In order; their column IDs are keys of `columns`, or a key with a unit suffix ('c4~kPa'). */
  steps: StepInput[];
  export: { profile: ExportProfileId; neutralizeFormulas: boolean } | null;
  baseline: { rows: number; issues: RecipeBaselineIssue[] } | null;
}

/** How a recipe would run on a dataset, before anything is changed. */
export interface RecipePlan {
  recipe: Recipe;
  datasetId: DatasetId;
  /** Each recipe column and the dataset column it maps to, or null when the dataset lacks it. */
  columns: { key: ColumnId; name: string; columnId: ColumnId | null; problem: string | null }[];
  /** One plain-language description per step, as it would be applied. */
  steps: string[];
  /** Everything that stops the recipe from running; empty when it fits. */
  problems: string[];
  fits: boolean;
}

/** An issue compared with the recipe's baseline: 'changed' when its count differs. */
export type IssueDelta = 'new' | 'changed' | 'unchanged';

export interface RecipeRun {
  datasetId: DatasetId;
  recipeId: RecipeId;
  name: string;
  version: number;
  steps: StepId[];
  checked: boolean;
  /** Counts of issues by comparison with the baseline; null when the recipe has none. */
  delta: { new: number; changed: number; unchanged: number; resolved: RecipeBaselineIssue[] } | null;
  export: Recipe['export'];
}

/** A recipe as saved: the document, its suggested file name and its bytes (UTF-8 JSON). */
export interface SavedRecipe {
  recipe: Recipe;
  fileName: string;
  bytes: Uint8Array;
}
