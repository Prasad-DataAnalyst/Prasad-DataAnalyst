/**
 * The process toolbar's stage states, derived only from the project summary and the open-issue
 * count, so the toolbar always reflects the engine's state rather than what the user clicked.
 */
import type { ProjectSummary } from '@tw/model';
import { STAGES, type Stage, type StageState } from './types';

export function stageStates(p: ProjectSummary | null, issues: { open: number } | null): Record<Stage, StageState> {
  const states = Object.fromEntries(STAGES.map((s) => [s, 'idle'])) as Record<Stage, StageState>;
  if (p === null) return states;

  const datasets = p.datasets;
  if (datasets.length === 0) {
    states.import = 'active';
    return states;
  }
  states.import = datasets.some((d) => d.partial) ? 'attention' : 'done';

  const checked = issues !== null;
  states.check = checked ? 'done' : 'active';
  if (!checked) return states;

  states.review = issues.open > 0 ? 'attention' : 'done';

  const steps = datasets.flatMap((d) => d.steps);
  const processed = steps.some((s) => s.kind === 'convert_unit');
  const extracted = steps.some((s) => s.kind === 'filter' || s.kind === 'select_columns');
  states.process = processed ? 'done' : 'active';
  states.extract = extracted ? 'done' : 'active';
  states.export = p.exports.length > 0 ? 'done' : 'active';
  return states;
}
