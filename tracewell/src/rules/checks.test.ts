import { describe, expect, it } from 'vitest';
import type { BBox, CheckKind, CrsRef, IssueDraft } from '@tw/model';
import { ctxOf, day, viewOf, type Cell, type Col } from './__fixtures__/dataset';
import { CHECKS, GENERIC_DQ, SYSTEM_RULES, selectColumns } from './index';
import type { RuleContext } from './context';

const WGS: CrsRef = { code: 'OGC:CRS84', source: 'rfc7946-default' };

function run(
  kind: CheckKind,
  cols: Col[],
  rows: Cell[][],
  o: { crs?: CrsRef | null; ctx?: Partial<RuleContext> } = {},
): IssueDraft[] {
  const found = [...GENERIC_DQ.rules, ...SYSTEM_RULES.rules].find((r) => r.check.kind === kind);
  if (found === undefined) throw new Error(`no rule for ${kind}`);
  const pack = GENERIC_DQ.rules.includes(found) ? GENERIC_DQ : SYSTEM_RULES;
  const view = viewOf(cols, rows, o.crs ?? null);
  return CHECKS[kind](found, pack, selectColumns(found.appliesTo, view.schema), ctxOf(view, o.ctx));
}

const rowsOf = (d: IssueDraft[]) => d.flatMap((x) => x.rows);
const count = (d: IssueDraft[]) => d.reduce((n, x) => n + (x.scope === 'rows' ? x.rows.length : 1), 0);

const ID: Col = { name: 'well_id', type: 'string', role: 'id' };
const DATE: Col = { name: 'date', type: 'date', role: 'time' };
const NUM: Col = { name: 'Oil', type: 'number', role: 'measure', unit: 'm3/d', quantity: 'volume_rate' };

describe('not_null', () => {
  it('flags empty cells and null markers but not failed text', () => {
    const d = run('not_null', [NUM], [[1], [null], [{ marker: '-999.25' }], [{ raw: 'n/a?' }], [2]]);
    expect(rowsOf(d)).toEqual([1, 2]);
    expect(d[0]?.message).toContain('2 rows');
  });
  it('raises nothing for a complete column and skips geometry columns', () => {
    expect(run('not_null', [NUM], [[1], [2]])).toEqual([]);
    expect(run('not_null', [{ name: 'g', type: 'geometry', role: 'geometry' }], [[null]])).toEqual([]);
  });
});

describe('duplicate_rows', () => {
  it('flags every row of each group of identical rows', () => {
    const d = run(
      'duplicate_rows',
      [ID, NUM],
      [
        ['A', 1],
        ['B', 2],
        ['A', 1],
        ['A', 1],
        ['B', 3],
      ],
    );
    expect(rowsOf(d)).toEqual([0, 2, 3]);
  });
  it('treats failed text as part of the row', () => {
    expect(
      run(
        'duplicate_rows',
        [ID, NUM],
        [
          ['A', { raw: 'x' }],
          ['A', { raw: 'y' }],
        ],
      ),
    ).toEqual([]);
  });
});

describe('duplicate_key', () => {
  it('flags rows sharing id and time', () => {
    const d = run(
      'duplicate_key',
      [ID, DATE, NUM],
      [
        ['A', day(1), 1],
        ['A', day(1), 2],
        ['B', day(1), 3],
        ['A', day(2), 4],
      ],
    );
    expect(rowsOf(d)).toEqual([0, 1]);
  });
  it('needs both an id and a time column', () => {
    expect(
      run(
        'duplicate_key',
        [DATE, NUM],
        [
          [day(1), 1],
          [day(1), 2],
        ],
      ),
    ).toEqual([]);
  });
});

describe('type_conformance', () => {
  it('flags failed parses, keeps the raw text, and leaves below-detection-limit text alone', () => {
    const d = run('type_conformance', [NUM], [[1], [{ raw: 'not measured' }], [{ raw: '<0.5' }], [{ raw: '#DIV/0!' }]]);
    expect(rowsOf(d)).toEqual([1, 3]);
    expect(d[0]?.detail).toEqual({ examples: 'not measured, #DIV/0!' });
  });
  it('raises nothing when every value parsed', () => {
    expect(run('type_conformance', [NUM], [[1], [null]])).toEqual([]);
  });
});

describe('below_detection_limit', () => {
  it('flags below-detection-limit text only', () => {
    const d = run('below_detection_limit', [NUM], [[{ raw: '<0.5' }], [{ raw: 'ND' }], [{ raw: 'oops' }], [0]]);
    expect(rowsOf(d)).toEqual([0, 1]);
  });
});

describe('physical_range', () => {
  const T: Col = { name: 'T', type: 'number', role: 'measure', unit: 'degC', quantity: 'temperature' };
  const P: Col = { name: 'P', type: 'number', role: 'measure', unit: 'psia', quantity: 'pressure_abs' };
  const PG: Col = { name: 'PG', type: 'number', role: 'measure', unit: 'psig', quantity: 'pressure_gauge' };
  it('flags −300 °C but not −10 °C', () => {
    expect(rowsOf(run('physical_range', [T], [[-300], [-10], [25]]))).toEqual([0]);
  });
  it('flags a negative absolute pressure', () => {
    expect(rowsOf(run('physical_range', [P], [[-5], [14.7]]))).toEqual([0]);
  });
  it('allows negative gauge pressure', () => {
    expect(run('physical_range', [PG], [[-5], [100]])).toEqual([]);
  });
  it('skips columns without a unit', () => {
    expect(run('physical_range', [{ ...T, unit: null, quantity: null }], [[-1000]])).toEqual([]);
  });
});

describe('null_marker', () => {
  it('flags non-empty null markers only', () => {
    const d = run('null_marker', [NUM], [[{ marker: '-999.25' }], [{ marker: '' }], [{ marker: 'N/A' }], [1]]);
    expect(rowsOf(d)).toEqual([0, 2]);
    expect(d[0]?.message).toContain('-999.25, N/A');
  });
});

describe('unit_known', () => {
  it('raises a column issue for a measure without a unit', () => {
    const d = run('unit_known', [{ ...NUM, unit: null, quantity: null }, NUM], [[1, 2]]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ scope: 'column', columns: ['c0'] });
  });
});

describe('unit_consistent', () => {
  const S: Col = { name: 'Pressure', type: 'string', role: 'text' };
  it("flags '83 kPa' among psi values", () => {
    const d = run('unit_consistent', [S], [['12 psi'], ['13 psi'], ['83 kPa'], ['14 psi']]);
    expect(rowsOf(d)).toEqual([2]);
  });
  it('ignores ordinary text columns', () => {
    expect(run('unit_consistent', [S], [['valve open'], ['closed'], ['3 m from the wellhead']])).toEqual([]);
  });
  it('raises nothing when every value has the same unit', () => {
    expect(run('unit_consistent', [S], [['1 bar'], ['2 bar']])).toEqual([]);
  });
});

describe('ts_duplicate', () => {
  it('groups by id when there is one', () => {
    const d = run(
      'ts_duplicate',
      [ID, DATE],
      [
        ['A', day(1)],
        ['B', day(1)],
        ['A', day(1)],
      ],
    );
    expect(rowsOf(d)).toEqual([0, 2]);
  });
  it('groups by time alone without an id', () => {
    expect(rowsOf(run('ts_duplicate', [DATE], [[day(1)], [day(1)], [day(2)]]))).toEqual([0, 1]);
  });
});

describe('ts_order', () => {
  it('flags rows earlier than the previous row of the same id', () => {
    const d = run(
      'ts_order',
      [ID, DATE],
      [
        ['A', day(2)],
        ['B', day(5)],
        ['A', day(1)],
        ['B', day(6)],
        ['A', day(3)],
      ],
    );
    expect(rowsOf(d)).toEqual([2]);
  });
});

describe('ts_gap', () => {
  it('flags steps longer than 3 times the median step', () => {
    const dates = [1, 2, 3, 4, 9, 10, 11].map((d) => [day(d)]);
    expect(rowsOf(run('ts_gap', [DATE], dates))).toEqual([4]);
  });
  it('ignores duplicate timestamps in the median and never flags them', () => {
    const dates = [1, 1, 2, 3, 3, 4].map((d) => [day(d)]);
    expect(run('ts_gap', [DATE], dates)).toEqual([]);
  });
});

describe('tz_specified', () => {
  it('raises for datetime columns with an assumed time zone', () => {
    const DT: Col = {
      name: 'time',
      type: 'datetime',
      role: 'time',
      timezone: { value: 'naive-assumed-utc', assumed: true },
    };
    expect(count(run('tz_specified', [DT], [[{ datetime: '2026-01-01T00:00:00.000Z' }]]))).toBe(1);
    expect(run('tz_specified', [{ ...DT, timezone: { value: 'utc', assumed: false } }], [[null]])).toEqual([]);
  });
});

describe('date_ambiguous', () => {
  it('raises for an assumed day/month order only', () => {
    const D: Col = { ...DATE, dateFormat: { value: 'dmy', assumed: true } };
    expect(count(run('date_ambiguous', [D], [[day(1)]]))).toBe(1);
    expect(run('date_ambiguous', [{ ...DATE, dateFormat: { value: 'iso', assumed: false } }], [[day(1)]])).toEqual([]);
  });
});

describe('flatline', () => {
  it('flags runs of 6 or more identical values; a null ends a run', () => {
    const values = [1, 5, 5, 5, 5, 5, 5, 2, 7, 7, 7, null, 7, 7, 7];
    const rows = values.map((v, i) => [day(i + 1), v] as Cell[]);
    expect(rowsOf(run('flatline', [DATE, NUM], rows))).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('needs a time column', () => {
    expect(run('flatline', [NUM], [[5], [5], [5], [5], [5], [5]])).toEqual([]);
  });
});

describe('spike', () => {
  it('flags the outlier in a noisy series', () => {
    const values = [10, 10.2, 9.9, 10.1, 10, 10.3, 25, 10.1, 9.8, 10, 10.2, 10.1];
    const rows = values.map((v, i) => [day(i + 1), v] as Cell[]);
    expect(rowsOf(run('spike', [DATE, NUM], rows))).toEqual([6]);
  });
});

describe('geometry checks', () => {
  const G: Col = { name: 'geometry', type: 'geometry', role: 'geometry' };
  const point = (lon: number, lat: number): Cell => ({ geometry: { type: 'Point', coordinates: [lon, lat] } });
  const openRing: Cell = {
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ],
    },
  };

  it('geometry_valid flags an unclosed ring', () => {
    expect(rowsOf(run('geometry_valid', [G], [[point(1, 57)], [openRing]], { crs: WGS }))).toEqual([1]);
  });
  it('geometry_present flags missing geometries', () => {
    expect(rowsOf(run('geometry_present', [G], [[point(1, 57)], [null]], { crs: WGS }))).toEqual([1]);
  });
  it('coord_range flags out-of-range points in WGS84 only', () => {
    expect(rowsOf(run('coord_range', [G], [[point(1, 57)], [point(1, 95)]], { crs: WGS }))).toEqual([1]);
    expect(
      run('coord_range', [G], [[point(1, 95)]], { crs: { code: 'EPSG:27700', source: 'geojson-crs-member' } }),
    ).toEqual([]);
  });
  it('latlon_swapped flags a latitude beyond 90 that is valid once swapped', () => {
    expect(rowsOf(run('latlon_swapped', [G], [[point(57, 2)], [point(2, 120)]], { crs: WGS }))).toEqual([1]);
  });
  it('latlon_swapped and coord_range read latitude and longitude columns', () => {
    const LAT: Col = { name: 'lat', type: 'number', role: 'latitude' };
    const LON: Col = { name: 'lon', type: 'number', role: 'longitude' };
    const crs: CrsRef = { code: 'EPSG:4326', source: 'assumed-latlon' };
    const rows: Cell[][] = [
      [57.1, 1.7],
      [1.7, 157.1],
      [95, 1],
    ];
    expect(rowsOf(run('coord_range', [LAT, LON], rows, { crs }))).toEqual([2]);
    expect(rowsOf(run('latlon_swapped', [LAT, LON], rows, { crs }))).toEqual([2]);
  });
  it('crs_wgs84 raises for another coordinate system', () => {
    const d = run('crs_wgs84', [G], [[point(400000, 500000)]], {
      crs: { code: 'EPSG:27700', source: 'geojson-crs-member' },
    });
    expect(d).toHaveLength(1);
    expect(d[0]?.scope).toBe('dataset');
    expect(run('crs_wgs84', [G], [[point(1, 57)]], { crs: WGS })).toEqual([]);
  });
  it('within_area is skipped without a project area and flags points outside one', () => {
    expect(run('within_area', [G], [[point(1, 57)]], { crs: WGS })).toEqual([]);
    const area: BBox = [0, 56, 2, 58];
    expect(
      rowsOf(run('within_area', [G], [[point(1, 57)], [point(5, 57)]], { crs: WGS, ctx: { projectArea: area } })),
    ).toEqual([1]);
  });
});

describe('import_note', () => {
  it('TW-IMP-005 is raised once when anything was assumed', () => {
    const assumption = {
      datasetId: 'd1',
      columnId: null,
      property: 'encoding',
      value: 'windows-1252',
      confidence: 'low' as const,
      evidence: 'fallback',
    };
    const view = viewOf([NUM], [[1]]);
    const rule = SYSTEM_RULES.rules.find((r) => r.id === 'TW-IMP-005');
    if (rule === undefined) throw new Error('missing rule');
    expect(CHECKS.import_note(rule, SYSTEM_RULES, [], ctxOf(view, { assumptions: [assumption] }))).toHaveLength(1);
    expect(CHECKS.import_note(rule, SYSTEM_RULES, [], ctxOf(view))).toEqual([]);
  });
  it('TW-IMP-001 maps ragged-row notes to rows by source line', () => {
    const view = viewOf([NUM], [[1], [2], [3]]);
    const rule = SYSTEM_RULES.rules.find((r) => r.id === 'TW-IMP-001');
    if (rule === undefined) throw new Error('missing rule');
    const notes = [{ code: 'TW-IMP-001' as const, message: 'short row', srcLoc: 3 }];
    expect(rowsOf(CHECKS.import_note(rule, SYSTEM_RULES, [], ctxOf(view, { importNotes: notes })))).toEqual([1]);
  });
});
