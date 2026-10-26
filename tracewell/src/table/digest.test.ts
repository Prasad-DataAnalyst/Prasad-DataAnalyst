import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CellValue } from '@tw/model';
import { columnDigest, Overlay, RowSet, View, viewDigest } from './index';
import { columnSchema, datasetOf } from './__fixtures__/tables';

interface VectorFile {
  vectors: { name: string; cells: string; sha256: string }[];
}

const VECTORS = JSON.parse(
  readFileSync(new URL('./__fixtures__/digest-vectors.json', import.meta.url), 'utf8'),
) as VectorFile;

function byName(name: string): string {
  const v = VECTORS.vectors.find((x) => x.name === name);
  if (v === undefined) throw new Error(`missing vector ${name}`);
  return v.sha256;
}

describe('columnDigest', () => {
  it.each(VECTORS.vectors)('matches the shared vector: $name', ({ cells, sha256 }) => {
    expect(columnDigest(JSON.parse(cells) as CellValue[])).toBe(sha256);
  });

  it('is order-sensitive', () => {
    expect(columnDigest(['a', 'b'])).toBe(byName('ascending order'));
    expect(columnDigest(['b', 'a'])).toBe(byName('descending order'));
    expect(columnDigest(['a', 'b'])).not.toBe(columnDigest(['b', 'a']));
  });

  it("tells the string '1' from the number 1", () => {
    expect(columnDigest(['1'])).toBe(byName('the string 1'));
    expect(columnDigest([1])).toBe(byName('the number 1'));
    expect(columnDigest(['1'])).not.toBe(columnDigest([1]));
  });

  it('gives the same digest across block boundaries as a one-shot hash', () => {
    const values = Array.from({ length: 30_000 }, (_, i) => (i % 3 === 0 ? `é\u{1F600}${i}` : i / 3));
    const viaGenerator = columnDigest(
      (function* () {
        yield* values;
      })(),
    );
    expect(columnDigest(values)).toBe(viaGenerator);
    expect(columnDigest(values.slice(0, -1))).not.toBe(viaGenerator);
  });
});

describe('viewDigest', () => {
  function view(unit: string, edits?: Overlay, excluded?: number[]): View {
    const columns = [
      columnSchema('c0', 'string', { name: 'Well' }),
      columnSchema('c1', 'number', { name: 'Pressure', unit }),
    ];
    const ds = datasetOf(columns, [
      ['A', 1],
      ['B', 2],
    ]);
    return new View(ds, {
      overlay: edits ?? new Overlay(),
      excluded: RowSet.of(2, excluded ?? []),
      derived: [],
      hidden: [],
      rowFilter: null,
      columnOrder: null,
    });
  }

  it('describes each visible column and the view', () => {
    const d = viewDigest(view('psia'));
    expect(d.rowCount).toBe(2);
    expect(d.columns.map(({ id, name, unit, type }) => ({ id, name, unit, type }))).toEqual([
      { id: 'c0', name: 'Well', unit: null, type: 'string' },
      { id: 'c1', name: 'Pressure', unit: 'psia', type: 'number' },
    ]);
    expect(d.columns[0]?.sha256).toBe(columnDigest(['A', 'B']));
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a unit label changes', () => {
    const a = viewDigest(view('psia'));
    const b = viewDigest(view('kPa'));
    expect(a.columns[1]?.sha256).toBe(b.columns[1]?.sha256);
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('follows edits and exclusions', () => {
    const edits = new Overlay();
    edits.set(1, 'c1', 3, 1);
    expect(viewDigest(view('psia', edits)).columns[1]?.sha256).toBe(columnDigest([1, 3]));
    const excluded = viewDigest(view('psia', undefined, [0]));
    expect(excluded.rowCount).toBe(1);
    expect(excluded.columns[0]?.sha256).toBe(columnDigest(['B']));
  });
});
