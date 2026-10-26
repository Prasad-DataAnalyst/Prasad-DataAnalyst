/** Exports of real messy fixtures pass every read-back check, or are refused with a reason. */
import { describe, expect, it } from 'vitest';
import { fixtureSource, type FixtureName } from '@tw/fixtures';
import { buildExport } from '@tw/export';
import { importSource, previewSource } from '@tw/ingest';
import { sha256Hex } from '@tw/io';
import type { Step } from '@tw/model';
import { buildOutputView, describeStep } from '@tw/steps';
import { Overlay, RowSet } from '@tw/table';

async function load(name: FixtureName) {
  const src = fixtureSource(name);
  const preview = await previewSource(src);
  return importSource(src, 'd1', preview.spec, {
    signal: new AbortController().signal,
    memoryBudgetBytes: 512 * 1024 ** 2,
    onProgress: () => undefined,
  });
}

function input(outcome: Awaited<ReturnType<typeof load>>, profile: 'csv' | 'excel' | 'geojson', steps: Step[] = []) {
  const ds = outcome.dataset;
  const st = { overlay: new Overlay(), excluded: new RowSet(ds.rowCount), steps };
  const view = buildOutputView(ds, st);
  return {
    exportId: 'e_00000001',
    baseName: ds.schema.name,
    profile,
    at: '2026-03-01T12:00:00.000Z',
    appVersion: '0.1.0',
    owner: 'Prasad',
    project: { id: 'p_00000000000000aa', name: 'Conformance' },
    view,
    crs: ds.schema.crs,
    sources: [
      {
        fileId: outcome.sha256,
        name: outcome.spec.fileName,
        size: outcome.spec.size,
        mediaType: 'text/plain',
        addedSeq: 2,
      },
    ],
    rulePacks: [{ id: 'tracewell.generic-dq', version: '0.1.0', sha256: sha256Hex('pack') }],
    unitRegistry: { version: '2026.1', sha256: sha256Hex('registry') },
    steps,
    stepDescriptions: steps.map((s) => describeStep(s, ds.schema)),
    excludedRows: 0,
    assumptions: outcome.assumptions,
    issues: [],
    audit: [],
    auditHead: { seq: 1, hash: sha256Hex('head') },
  };
}

const CTX = { signal: new AbortController().signal, onProgress: () => undefined };

describe('exports of messy fixtures', () => {
  it('csv_well_daily_golden.csv after psia→kPa and a January filter passes every check in every profile', async () => {
    const outcome = await load('csv_well_daily_golden.csv');
    const pressure = outcome.dataset.schema.columns.find((c) => c.unit.value === 'psia');
    const time = outcome.dataset.schema.columns.find((c) => c.role.value === 'time');
    if (pressure === undefined || time === undefined) throw new Error('fixture columns missing');
    const steps: Step[] = [
      { id: 's1', seq: 5, kind: 'convert_unit', columnId: pressure.id, toUnit: 'kPa', mode: 'replace' },
      {
        id: 's2',
        seq: 6,
        kind: 'filter',
        predicate: {
          column: time.id,
          op: 'between',
          low: { datetime: '2026-01-01T00:00:00.000Z' },
          high: { datetime: '2026-01-31T23:59:59.999Z' },
        },
      },
    ];
    for (const profile of ['csv', 'excel', 'geojson'] as const) {
      const result = await buildExport(input(outcome, profile, steps), CTX);
      expect(
        result.validation.checks.filter((c) => !c.ok),
        profile,
      ).toEqual([]);
      expect(result.manifest.dataset.rowCount, profile).toBe(94);
    }
    const csv = await buildExport(input(outcome, 'csv', steps), CTX);
    expect(csv.manifest.dataset.columns.map((c) => c.header)).toContain('Pressure [kPa]');
  });

  it('geojson_wells_points_wgs84.geojson exports as GeoJSON', async () => {
    const result = await buildExport(input(await load('geojson_wells_points_wgs84.geojson'), 'geojson'), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('geojson_legacy_crs_27700.geojson is refused for GeoJSON with the TW-EXP-003 reason', async () => {
    await expect(
      buildExport(input(await load('geojson_legacy_crs_27700.geojson'), 'geojson'), CTX),
    ).rejects.toMatchObject({
      code: 'EXPORT_REFUSED',
      message: expect.stringContaining('TW-EXP-003'),
    });
  });

  it.each([
    'csv_semicolon_decimalcomma_cp1252.csv',
    'xlsx_merged_two_row_header_units.xlsx',
    'csv_quoted_newlines_ragged.csv',
    'geojson_mixed_geometry_nested_props.geojson',
  ] as const)('%s exports to CSV and Excel with every check passing', async (name) => {
    const outcome = await load(name);
    for (const profile of ['csv', 'excel'] as const) {
      const result = await buildExport(input(outcome, profile), CTX);
      expect(
        result.validation.checks.filter((c) => !c.ok),
        `${name} ${profile}`,
      ).toEqual([]);
    }
  });
});
