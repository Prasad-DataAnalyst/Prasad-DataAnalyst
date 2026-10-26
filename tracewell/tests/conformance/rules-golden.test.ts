/**
 * Golden check results: every messy fixture, imported and checked with tracewell.generic-dq plus
 * the import-note rules and no project area, raises exactly the rule counts in its expectation.
 */
import { describe, expect, it } from 'vitest';
import { FIXTURE_NAMES, fixtureExpectation, fixtureSource } from '@tw/fixtures';
import { importSource, previewSource } from '@tw/ingest';
import { GENERIC_DQ, SYSTEM_RULES, runRules } from '@tw/rules';
import type { IssueDraft } from '@tw/model';
import { Overlay, RowSet, View } from '@tw/table';

export function ruleCounts(drafts: IssueDraft[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of drafts) counts[d.ruleId] = (counts[d.ruleId] ?? 0) + (d.scope === 'rows' ? d.rows.length : 1);
  return counts;
}

describe('rules golden counts for every messy fixture', () => {
  it.each(FIXTURE_NAMES)('%s', async (name) => {
    const src = fixtureSource(name);
    const preview = await previewSource(src);
    const outcome = await importSource(src, 'd1', preview.spec, {
      signal: new AbortController().signal,
      memoryBudgetBytes: 512 * 1024 ** 2,
      onProgress: () => undefined,
    });
    const view = new View(outcome.dataset, {
      overlay: new Overlay(),
      excluded: new RowSet(outcome.dataset.rowCount),
      derived: [],
      hidden: [],
      rowFilter: null,
      columnOrder: null,
    });
    const drafts = await runRules([GENERIC_DQ, SYSTEM_RULES], {
      view,
      importNotes: outcome.notes,
      assumptions: outcome.assumptions,
      projectArea: null,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    expect(ruleCounts(drafts)).toEqual(fixtureExpectation(name).issues);
  });
});
