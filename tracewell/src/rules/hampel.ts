/**
 * Robust time-series tests: the Hampel identifier (Hampel 1974; Pearson 2002) and flatline runs.
 * Both take values already in series order.
 */
import type { CellValue } from '@tw/model';
import { median } from './series';

/** The MAD-to-standard-deviation factor for normally distributed data. */
export const MAD_SCALE = 1.4826;

/**
 * Indexes of outliers. `window` is the full window length (7 = 3 values each side); values with
 * fewer than half a window of neighbours on either side, nulls, and windows whose MAD is 0 are not
 * tested. Nulls are left out of the series before the windows are formed.
 */
export function hampelOutliers(values: (number | null)[], window: number, k: number): number[] {
  const half = Math.floor(window / 2);
  const present: { index: number; value: number }[] = [];
  values.forEach((v, index) => {
    if (v !== null && Number.isFinite(v)) present.push({ index, value: v });
  });
  const out: number[] = [];
  for (let i = half; i < present.length - half; i++) {
    const win = present.slice(i - half, i + half + 1).map((p) => p.value);
    const med = median(win);
    const mad = median(win.map((v) => Math.abs(v - med)));
    const centre = present[i] as { index: number; value: number };
    if (mad > 0 && Math.abs(centre.value - med) > k * MAD_SCALE * mad) out.push(centre.index);
  }
  return out;
}

function sameValue(a: CellValue, b: CellValue): boolean {
  if (a === null || b === null) return false;
  if (typeof a === 'number' && typeof b === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b));
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Inclusive [start, end] index ranges of runs of at least `minRun` identical values; a null ends a run. */
export function flatlineRuns(values: CellValue[], minRun: number): [number, number][] {
  const runs: [number, number][] = [];
  let start = 0;
  for (let i = 1; i <= values.length; i++) {
    if (i < values.length && sameValue(values[i] as CellValue, values[i - 1] as CellValue)) continue;
    if (values[start] !== null && i - start >= minRun) runs.push([start, i - 1]);
    start = i;
  }
  return runs;
}
