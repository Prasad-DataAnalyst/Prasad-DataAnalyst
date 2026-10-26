import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { flatlineRuns, hampelOutliers } from './index';

const vector = JSON.parse(readFileSync(new URL('./__fixtures__/hampel-series.json', import.meta.url), 'utf8')) as {
  window: number;
  k: number;
  series: (number | null)[];
  outliers: number[];
};

describe('hampelOutliers', () => {
  it('matches the reference Python implementation', () => {
    expect(hampelOutliers(vector.series, vector.window, vector.k)).toEqual(vector.outliers);
  });
  it('does not test edge values or windows with MAD 0', () => {
    expect(hampelOutliers([100, 1, 1, 1, 1, 1, 1, 1, 100], 7, 3)).toEqual([]);
  });
  it('handles short and empty series', () => {
    expect(hampelOutliers([], 7, 3)).toEqual([]);
    expect(hampelOutliers([1, 2, 3], 7, 3)).toEqual([]);
  });
});

describe('flatlineRuns', () => {
  it('finds runs of the minimum length, and a null ends a run', () => {
    expect(flatlineRuns([1, 2, 2, 2, null, 2, 2, 3, 3, 3], 3)).toEqual([
      [1, 3],
      [7, 9],
    ]);
  });
  it('never reports a run of nulls', () => {
    expect(flatlineRuns([null, null, null, null], 2)).toEqual([]);
  });
  it('compares dates by value', () => {
    expect(flatlineRuns([{ date: '2026-01-01' }, { date: '2026-01-01' }], 2)).toEqual([[0, 1]]);
  });
});
