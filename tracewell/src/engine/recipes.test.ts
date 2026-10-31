/**
 * Recipes (FR-RCP-01..03): saved from one month's dataset, run on the next month's file, with the
 * issues compared against the first run.
 */
import { describe, expect, it } from 'vitest';
import { fixtureBytes } from '@tw/fixtures';
import type { DatasetSummary, FileInput, Recipe, RecipeRun, SaveResult } from '@tw/model';
import { awaitJob, checked, columnId, newEngine, open, withProject } from './__fixtures__/session';
import type { LocalEngine } from './engine';

const GOLDEN = 'csv_well_daily_golden.csv';

/** The golden file as next month's export might send it: Pressure moved last, three readings missing. */
function nextMonth(): Uint8Array {
  const lines = new TextDecoder().decode(fixtureBytes(GOLDEN)).split('\n');
  const moved = lines.map((line, i) => {
    if (line === '') return line;
    const f = line.split(',');
    const [pressure] = f.splice(4, 1);
    return [...f, i >= 1 && i <= 3 ? '' : pressure].join(',');
  });
  return new TextEncoder().encode(moved.join('\n'));
}

function bytesFile(bytes: Uint8Array, name: string): FileInput {
  return { kind: 'bytes', bytes, name };
}

async function importBytes(engine: LocalEngine, bytes: Uint8Array, name: string): Promise<DatasetSummary> {
  return awaitJob<DatasetSummary>(engine, await engine.importFile(bytesFile(bytes, name)));
}

/** This month's dataset with a conversion and a filter, checked, saved as a recipe. */
async function savedRecipe(): Promise<{ recipe: Recipe; bytes: Uint8Array; fileName: string }> {
  const engine = await withProject();
  const ds = await checked(engine, GOLDEN);
  const pressure = await columnId(engine, ds.id, 'Pressure');
  await awaitJob(
    engine,
    await engine.applyStep(
      ds.id,
      { kind: 'convert_unit', columnId: pressure, toUnit: 'kPa', mode: 'add_column' },
      'Report in kPa',
    ),
  );
  await awaitJob(
    engine,
    await engine.applyStep(
      ds.id,
      { kind: 'filter', predicate: { column: `${pressure}~kPa`, op: 'gt', value: 10_000 }, label: 'Producing wells' },
      'Producing wells only',
    ),
  );
  return engine.saveRecipe({
    datasetId: ds.id,
    name: 'Monthly well report',
    export: { profile: 'csv', neutralizeFormulas: true },
  });
}

describe('recipes', () => {
  it('save the steps, checks and export with column names and issue counts, never values', async () => {
    const { recipe, bytes, fileName } = await savedRecipe();
    expect(fileName).toBe('Monthly well report v1.twr');
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(recipe);
    expect(recipe).toMatchObject({
      format: 'tracewell-recipe',
      name: 'Monthly well report',
      version: 1,
      savedBy: 'Prasad',
      columns: [{ key: 'c4', name: 'Pressure', type: 'number', unit: 'psia' }],
      steps: [
        { kind: 'convert_unit', columnId: 'c4', toUnit: 'kPa', mode: 'add_column' },
        { kind: 'filter', predicate: { column: 'c4~kPa', op: 'gt', value: 10_000 }, label: 'Producing wells' },
      ],
      export: { profile: 'csv', neutralizeFormulas: true },
    });
    expect(recipe.id).toMatch(/^rcp_[0-9a-f]{12}$/);
    expect(recipe.check?.packs.map((p) => p.id)).toEqual(['tracewell.generic-dq', 'tracewell.system']);
    expect(recipe.baseline?.rows).toBe(271);
    expect(recipe.baseline?.issues.length).toBeGreaterThan(0);
    // No cell value of the dataset is in the file.
    const text = new TextDecoder().decode(bytes);
    for (const value of ['NS-A01', '1860.0', '57.48213', '2025-12-01']) expect(text).not.toContain(value);
  });

  it("runs on next month's file by column name and shows only what is new or changed", async () => {
    const saved = await savedRecipe();
    const engine = await withProject(newEngine());
    const ds = await importBytes(engine, nextMonth(), 'well_daily_next.csv');
    const file = bytesFile(saved.bytes, saved.fileName);

    const plan = await engine.planRecipe(ds.id, file);
    expect(plan.fits).toBe(true);
    expect(plan.columns).toEqual([{ key: 'c4', name: 'Pressure', columnId: 'c8', problem: null }]);
    expect(plan.steps).toHaveLength(2);
    expect((await engine.listAudit({ action: ['step.apply'] })).items).toEqual([]);

    const run = await awaitJob<RecipeRun>(engine, await engine.applyRecipe(ds.id, file, 'March data, same processing'));
    expect(run).toMatchObject({ name: 'Monthly well report', version: 1, steps: ['s1', 's2'], checked: true });
    expect(run.delta?.new).toBeGreaterThan(0);
    const steps = (await engine.listAudit({ action: ['step.apply'] })).items;
    expect(steps.map((e) => e.target.columnId ?? null)).toEqual(['c8', null]);
    expect(steps.every((e) => e.reason === 'Recipe "Monthly well report" v1: March data, same processing')).toBe(true);

    const all = (await engine.listIssues({ datasetId: ds.id, limit: 500 })).items;
    expect(all.every((i) => i.delta !== undefined)).toBe(true);
    const shown = (await engine.listIssues({ datasetId: ds.id, delta: ['new', 'changed'], limit: 500 })).items;
    expect(shown.length).toBe((run.delta?.new ?? 0) + (run.delta?.changed ?? 0));
    expect(shown.every((i) => i.delta?.state !== 'unchanged')).toBe(true);
    // The three missing pressures are a finding the first month did not have.
    const missing = shown.find((i) => i.ruleId === 'TW-DQ-001' && i.columns.includes('c8'));
    expect(missing).toMatchObject({ delta: { state: 'new', previous: null }, counts: { flagged: 3 } });

    // Saved again from a dataset it ran on, the recipe gets its next version.
    const again = await engine.saveRecipe({ datasetId: ds.id, name: 'Monthly well report', export: null });
    expect(again.recipe.version).toBe(2);
    expect(again.recipe.id).toBe(saved.recipe.id);
  });

  it('replays from the project file without the recipe', async () => {
    const saved = await savedRecipe();
    const engine = await withProject(newEngine());
    const ds = await importBytes(engine, nextMonth(), 'well_daily_next.csv');
    await awaitJob(engine, await engine.applyRecipe(ds.id, bytesFile(saved.bytes, saved.fileName), 'March data'));
    const before = (await engine.listIssues({ datasetId: ds.id, limit: 500 })).items;
    const project = await awaitJob<SaveResult>(engine, await engine.saveProject());
    const { engine: reopened, report } = await open(project.bytes as Uint8Array);
    expect(report.readOnly).toBe(false);
    expect((await reopened.listIssues({ datasetId: ds.id, limit: 500 })).items).toEqual(before);
  });

  it('keeps the imported column when a step converted it in place', async () => {
    const engine = await withProject();
    const ds = await checked(engine, GOLDEN);
    const pressure = await columnId(engine, ds.id, 'Pressure');
    await awaitJob(
      engine,
      await engine.applyStep(ds.id, { kind: 'convert_unit', columnId: pressure, toUnit: 'kPa', mode: 'replace' }, 'kPa'),
    );
    const { recipe, bytes, fileName } = await engine.saveRecipe({ datasetId: ds.id, name: 'In place', export: null });
    expect(recipe.columns).toEqual([{ key: 'c4', name: 'Pressure', type: 'number', unit: 'psia' }]);

    const next = await withProject(newEngine());
    const target = await importBytes(next, nextMonth(), 'next.csv');
    const plan = await next.planRecipe(target.id, bytesFile(bytes, fileName));
    expect(plan).toMatchObject({ fits: true, columns: [{ name: 'Pressure', columnId: 'c8' }] });
  });

  it('refuses a dataset without a recipe column, or with it in another unit, before changing anything', async () => {
    const saved = await savedRecipe();
    const file = bytesFile(saved.bytes, saved.fileName);
    const engine = await withProject(newEngine());
    const other = await importBytes(engine, fixtureBytes('csv_pipe_delimited.csv'), 'other.csv');
    const plan = await engine.planRecipe(other.id, file);
    expect(plan.fits).toBe(false);
    expect(plan.problems[0]).toMatch(/has no column named "Pressure"/);

    const bar = new TextDecoder().decode(nextMonth()).replace('Pressure (psia)', 'Pressure (bar)');
    const inBar = await importBytes(engine, new TextEncoder().encode(bar), 'bar.csv');
    expect((await engine.planRecipe(inBar.id, file)).problems[0]).toMatch(/is in bar here, psia in the recipe/);

    const seq = (await engine.listAudit({ order: 'desc', limit: 1 })).items[0]?.seq;
    await expect(awaitJob(engine, await engine.applyRecipe(inBar.id, file, 'March data'))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect((await engine.listAudit({ order: 'desc', limit: 1 })).items[0]?.seq).toBe(seq);
  });

  it('refuses a file that is not a recipe, was edited by hand or carries extra content', async () => {
    const saved = await savedRecipe();
    const engine = await withProject(newEngine());
    const ds = await importBytes(engine, nextMonth(), 'next.csv');
    const variant = (change: (r: Record<string, unknown>) => void) => {
      const r = structuredClone(saved.recipe) as unknown as Record<string, unknown>;
      change(r);
      return bytesFile(new TextEncoder().encode(JSON.stringify(r)), 'edited.twr');
    };
    await expect(
      engine.planRecipe(ds.id, bytesFile(new TextEncoder().encode('a,b\n1,2\n'), 'x.twr')),
    ).rejects.toMatchObject({
      code: 'FORMAT_UNSUPPORTED',
      message: expect.stringContaining('not JSON text'),
    });
    await expect(
      engine.planRecipe(
        ds.id,
        variant((r) => (r['name'] = 'Renamed')),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('changed by hand'),
    });
    await expect(
      engine.planRecipe(
        ds.id,
        variant((r) => (r['rows'] = [['NS-A01', 1860]])),
      ),
    ).rejects.toMatchObject({
      code: 'FORMAT_UNSUPPORTED',
    });
  });
});
