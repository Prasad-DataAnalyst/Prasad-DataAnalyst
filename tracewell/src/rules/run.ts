/**
 * The rule runner: selects columns, runs each rule's check over the working view, honours cancel
 * and reports progress. Rules of kind 'system' are raised by the engine itself and skipped here.
 */
import { EngineError, type ColumnId, type DatasetId, type IssueDraft, type JsonValue, type RulePack } from '@tw/model';
import { CHECKS } from './checks';
import type { RuleContext } from './context';
import { renderMessage } from './message';
import { findRule, SYSTEM_RULES } from './packs';
import { selectColumns } from './select';

function cancelled(): EngineError {
  return new EngineError('CANCELLED', 'The check run was cancelled.', 'Run the checks again when you are ready.');
}

/** Lets queued messages (such as a cancel request) through between rules. */
function yieldToEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function runRules(
  packs: RulePack[],
  ctx: RuleContext,
  only?: { columns?: ColumnId[] },
): Promise<IssueDraft[]> {
  const rules = packs.flatMap((pack) =>
    pack.rules.filter((r) => r.check.kind !== 'system').map((rule) => ({ pack, rule })),
  );
  const out: IssueDraft[] = [];
  let done = 0;
  for (const { pack, rule } of rules) {
    if (ctx.signal.aborted) throw cancelled();
    const datasetRule = 'dataset' in rule.appliesTo;
    let columns = selectColumns(rule.appliesTo, ctx.view.schema);
    if (only?.columns !== undefined && !datasetRule) columns = columns.filter((c) => only.columns?.includes(c.id));
    if (datasetRule || columns.length > 0) out.push(...CHECKS[rule.check.kind](rule, pack, columns, ctx));
    done++;
    ctx.onProgress(done, rules.length);
    await yieldToEvents();
  }
  if (ctx.signal.aborted) throw cancelled();
  return out;
}

/** An issue raised by the engine for a system rule (project, export or import findings). */
export function systemIssue(
  ruleId: string,
  datasetId: DatasetId,
  message: string,
  detail?: Record<string, JsonValue>,
): IssueDraft {
  const found = findRule([SYSTEM_RULES], ruleId);
  if (found === undefined) {
    throw new EngineError(
      'NOT_FOUND',
      `There is no system rule ${ruleId}.`,
      'Use a rule ID from the tracewell.system pack.',
      {
        ruleId,
      },
    );
  }
  const { rule, pack } = found;
  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    packId: pack.id,
    severity: rule.severity,
    category: rule.category,
    datasetId,
    columns: [],
    scope: 'dataset',
    rows: [],
    message: renderMessage(rule.message, { detail: message, count: 1, column: 'the dataset', unit: '' }),
    ...(detail === undefined ? {} : { detail }),
  };
}
