import { describe, expect, it } from 'vitest';
import { MERCATOR_MAX_LATITUDE, mercatorCell } from './tiles';

describe('mercatorCell', () => {
  it('numbers cells as map tiles are numbered, x eastwards and y southwards', () => {
    expect(mercatorCell(0, 0, 0)).toEqual([0, 0]);
    expect(mercatorCell(-0.1, 0.1, 1)).toEqual([0, 0]);
    expect(mercatorCell(0.1, -0.1, 1)).toEqual([1, 1]);
    // Aberdeen at level 10, as the usual tile formula with log(tan + sec) gives it.
    expect(mercatorCell(-2.0943, 57.1497, 10)).toEqual([506, 312]);
  });

  it('keeps points beyond the grid on its edge cells', () => {
    expect(mercatorCell(180, 0, 3)).toEqual([7, 4]);
    expect(mercatorCell(-180, 90, 3)).toEqual([0, 0]);
    expect(mercatorCell(200, -90, 3)).toEqual([7, 7]);
    expect(mercatorCell(0, MERCATOR_MAX_LATITUDE, 22)[1]).toBe(0);
    expect(mercatorCell(0, -MERCATOR_MAX_LATITUDE, 22)[1]).toBe(2 ** 22 - 1);
  });
});
