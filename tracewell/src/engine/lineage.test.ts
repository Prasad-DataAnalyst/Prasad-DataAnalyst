/** explainCell traces a value from its source text through every change to its current value. */
import { describe, expect, it } from 'vitest';
import { awaitJob, columnId, importFixture, withProject } from './__fixtures__/session';

describe('lineage', () => {
  it('explains an edited and converted cell from source text to current value', async () => {
    const engine = await withProject();
    const ds = await importFixture(engine, 'csv_null_markers.csv');
    const pressure = await columnId(engine, ds.id, 'Pressure');
    await engine.decide({
      kind: 'edit_cell',
      datasetId: ds.id,
      rowId: 3,
      columnId: pressure,
      value: { text: '1508.6' },
      reason: 'Gauge re-read on site',
    });
    await awaitJob(
      engine,
      await engine.applyStep(
        ds.id,
        { kind: 'convert_unit', columnId: pressure, toUnit: 'kPa', mode: 'replace' },
        'Report in kPa',
      ),
    );
    const derived = `${pressure}~kPa`;
    const lineage = await engine.explainCell(ds.id, 3, derived);
    expect(lineage.source).toMatchObject({
      fileName: 'csv_null_markers.csv',
      locator: 'line 5, field 3',
      rawText: '1508.1',
    });
    expect(lineage.parse).toMatchObject({ type: 'number', ok: true, nullMarker: null });
    expect(lineage.parse.method).toContain('number');
    expect(lineage.history.map((h) => h.action)).toEqual(['cell.edit', 'step.apply']);
    expect(lineage.history[0]).toMatchObject({
      old: 1508.1,
      new: 1508.6,
      reason: 'Gauge re-read on site',
      actor: 'Prasad',
    });
    expect(lineage.history[1]?.method).toMatchObject({ from: 'psia', to: 'kPa' });
    expect(lineage.current).toBeCloseTo(1508.6 * 6.894757293168361, 6);
  });

  it('shows the null marker a missing value came from', async () => {
    const engine = await withProject();
    const ds = await importFixture(engine, 'csv_null_markers.csv');
    const pressure = await columnId(engine, ds.id, 'Pressure');
    const lineage = await engine.explainCell(ds.id, 1, pressure);
    expect(lineage.source.rawText).toBe('-999.25');
    expect(lineage.parse.nullMarker).toBe('-999.25');
    expect(lineage.current).toBeNull();
    expect(lineage.history).toEqual([]);
  });

  it('refuses a row or column that does not exist', async () => {
    const engine = await withProject();
    const ds = await importFixture(engine, 'csv_null_markers.csv');
    await expect(engine.explainCell(ds.id, 10_000, 'c2')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(engine.explainCell(ds.id, 0, 'c99')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
