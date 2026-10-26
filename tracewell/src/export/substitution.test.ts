import { describe, expect, it } from 'vitest';
import { EXCEL_MAX_DATA_ROWS } from '@tw/model';
import { datasetOf, viewOf } from './__fixtures__/input';
import { planExport } from './index';

describe('format-limit substitutions', () => {
  it('delivers more than the Excel row limit as CSV plus a summary workbook', () => {
    const rows = Array.from({ length: EXCEL_MAX_DATA_ROWS + 1 }, (_, i) => [i]);
    const view = viewOf(datasetOf([{ name: 'n', type: 'integer', role: 'measure' }], rows, null));
    const plan = planExport(view, 'excel', null);
    expect(plan.substitutions).toHaveLength(1);
    expect(plan.substitutions[0]?.ruleId).toBe('TW-EXP-002');
    expect(plan.dataFiles).toEqual([
      { path: 'data.csv', kind: 'csv', columns: ['c0'] },
      { path: 'data.xlsx', kind: 'xlsx', columns: [] },
    ]);
  });

  it('moves a column with text longer than an Excel cell to a CSV side file', () => {
    const view = viewOf(
      datasetOf(
        [
          { name: 'id', type: 'string', role: 'id' },
          { name: 'long', type: 'string', role: 'text' },
        ],
        [
          ['a', 'x'.repeat(40_000)],
          ['b', 'short'],
        ],
        null,
      ),
    );
    const plan = planExport(view, 'excel', null);
    expect(plan.substitutions[0]?.what).toContain('long');
    expect(plan.dataFiles).toEqual([
      { path: 'data.xlsx', kind: 'xlsx', columns: ['c0'] },
      { path: 'data-long-text.csv', kind: 'csv', columns: ['c1'] },
    ]);
  });

  it('needs no substitution for an ordinary dataset', () => {
    const view = viewOf(datasetOf());
    expect(planExport(view, 'excel', view.schema.crs).substitutions).toEqual([]);
  });
});
