import { describe, expect, it } from 'vitest';
import { TID } from './testids';

/** Every hook with sample arguments, so templated hooks are compared too. */
function values(): string[] {
  return Object.values(TID).map((v) => (typeof v === 'function' ? (v as (a: number, b: string) => string)(1, 'x') : v));
}

describe('TID', () => {
  it('has unique values', () => {
    const all = values();
    expect(new Set(all).size).toBe(all.length);
  });

  it('uses the tw- prefix everywhere', () => {
    expect(values().every((v) => v.startsWith('tw-'))).toBe(true);
  });

  it('builds distinct cell hooks per row and column', () => {
    expect(TID.cell(0, 'c1')).not.toBe(TID.cell(1, 'c1'));
    expect(TID.cell(0, 'c1')).not.toBe(TID.cell(0, 'c2'));
  });
});
