import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EngineError } from '@tw/model';
import { RowSet } from './rowset';

const CAPACITY = 97; // not a multiple of 32, so the tail word is exercised

const rowSet = fc
  .uniqueArray(fc.integer({ min: 0, max: CAPACITY - 1 }), { maxLength: CAPACITY })
  .map((ids) => RowSet.of(CAPACITY, ids));

function sorted(ids: Iterable<number>): number[] {
  return [...ids].sort((a, b) => a - b);
}

describe('RowSet algebra laws', () => {
  it('union and intersect are commutative', () => {
    fc.assert(
      fc.property(rowSet, rowSet, (a, b) => {
        expect(a.union(b).equals(b.union(a))).toBe(true);
        expect(a.intersect(b).equals(b.intersect(a))).toBe(true);
      }),
    );
  });

  it("obeys De Morgan's laws", () => {
    fc.assert(
      fc.property(rowSet, rowSet, (a, b) => {
        expect(a.union(b).complement().equals(a.complement().intersect(b.complement()))).toBe(true);
        expect(a.intersect(b).complement().equals(a.complement().union(b.complement()))).toBe(true);
      }),
    );
  });

  it('minus equals intersect with the complement', () => {
    fc.assert(
      fc.property(rowSet, rowSet, (a, b) => {
        expect(a.minus(b).equals(a.intersect(b.complement()))).toBe(true);
      }),
    );
  });

  it('matches a reference Set for membership, size and order', () => {
    fc.assert(
      fc.property(rowSet, rowSet, (a, b) => {
        const ref = new Set([...a, ...b]);
        const u = a.union(b);
        expect(u.size).toBe(ref.size);
        expect(u.toArray()).toEqual(sorted(ref));
        expect(a.complement().size).toBe(CAPACITY - a.size);
        expect(a.complement().complement().equals(a)).toBe(true);
      }),
    );
  });

  it('fromRanges agrees with toRanges', () => {
    fc.assert(
      fc.property(rowSet, (a) => {
        const { count, ranges } = a.toRanges(CAPACITY);
        expect(count).toBe(a.size);
        expect(RowSet.fromRanges(CAPACITY, ranges).equals(a)).toBe(true);
      }),
    );
  });
});

describe('RowSet basics', () => {
  it('adds, deletes and tracks size', () => {
    const s = new RowSet(40);
    s.add(3);
    s.add(3);
    s.add(39);
    expect(s.size).toBe(2);
    expect(s.has(3)).toBe(true);
    s.delete(3);
    s.delete(3);
    expect(s.size).toBe(1);
    expect(s.has(3)).toBe(false);
    expect(s.has(40)).toBe(false);
    expect(s.has(-1)).toBe(false);
  });

  it('all() fills exactly the capacity and clone() is independent', () => {
    const all = RowSet.all(70);
    expect(all.size).toBe(70);
    expect(all.toArray()).toEqual(Array.from({ length: 70 }, (_, i) => i));
    const copy = all.clone();
    copy.delete(5);
    expect(all.has(5)).toBe(true);
    expect(all.equals(copy)).toBe(false);
  });

  it('refuses rows outside the capacity and mixed capacities', () => {
    expect(() => new RowSet(4).add(4)).toThrow(EngineError);
    expect(() => new RowSet(4).union(new RowSet(5))).toThrow(EngineError);
    expect(() => RowSet.fromRanges(10, [[5, 2]])).toThrow(EngineError);
  });

  it('works with capacity zero', () => {
    const empty = new RowSet(0);
    expect(empty.complement().size).toBe(0);
    expect(empty.toRanges()).toEqual({ count: 0, ranges: [] });
  });
});

describe('RowSet.toRanges', () => {
  it('compresses runs into inclusive ranges', () => {
    const s = RowSet.of(100, [0, 1, 2, 5, 7, 8, 31, 32, 33, 99]);
    expect(s.toRanges()).toEqual({
      count: 10,
      ranges: [
        [0, 2],
        [5, 5],
        [7, 8],
        [31, 33],
        [99, 99],
      ],
    });
  });

  it('builds full words from ranges that cross word boundaries', () => {
    const s = RowSet.fromRanges(200, [[10, 150]]);
    expect(s.size).toBe(141);
    expect(s.toRanges()).toEqual({ count: 141, ranges: [[10, 150]] });
  });

  it('respects maxRanges and keeps the exact count', () => {
    const evens = RowSet.of(
      5000,
      Array.from({ length: 2500 }, (_, i) => i * 2),
    );
    const capped = evens.toRanges(3);
    expect(capped.count).toBe(2500);
    expect(capped.ranges).toEqual([
      [0, 0],
      [2, 2],
      [4, 4],
    ]);
    const defaulted = evens.toRanges();
    expect(defaulted.count).toBe(2500);
    expect(defaulted.ranges).toHaveLength(1000);
  });
});
