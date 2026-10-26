import { describe, expect, it } from 'vitest';
import { issueId, renderMessage, systemIssue } from './index';

describe('issueId', () => {
  it('is stable and independent of column order', () => {
    const a = issueId({ ruleId: 'TW-DQ-003', datasetId: 'd1', columns: ['c0', 'c1'] });
    expect(issueId({ ruleId: 'TW-DQ-003', datasetId: 'd1', columns: ['c1', 'c0'] })).toBe(a);
    expect(a).toMatch(/^I-[0-9a-f]{12}$/);
  });
  it('differs by rule, dataset and columns', () => {
    const base = { ruleId: 'TW-DQ-001', datasetId: 'd1', columns: ['c2'] };
    const id = issueId(base);
    expect(issueId({ ...base, ruleId: 'TW-DQ-004' })).not.toBe(id);
    expect(issueId({ ...base, datasetId: 'd2' })).not.toBe(id);
    expect(issueId({ ...base, columns: ['c3'] })).not.toBe(id);
  });
});

describe('renderMessage', () => {
  it('fills known placeholders and leaves unknown ones visible', () => {
    expect(renderMessage('{count} rows in {column} ({other})', { count: 3, column: 'Oil' })).toBe(
      '3 rows in Oil ({other})',
    );
  });
  it('does not read inherited properties', () => {
    expect(renderMessage('{toString}', {})).toBe('{toString}');
  });
});

describe('systemIssue', () => {
  it('builds a dataset-scope draft from the system pack', () => {
    const d = systemIssue('TW-PRJ-002', 'd1', 'entry 4 was changed', { brokenAt: 4 });
    expect(d).toMatchObject({
      ruleId: 'TW-PRJ-002',
      severity: 'error',
      scope: 'dataset',
      rows: [],
      detail: { brokenAt: 4 },
    });
    expect(d.message).toContain('entry 4 was changed');
  });
  it('refuses an unknown rule', () => {
    expect(() => systemIssue('TW-DQ-001', 'd1', 'x')).toThrow(/no system rule/);
  });
});
