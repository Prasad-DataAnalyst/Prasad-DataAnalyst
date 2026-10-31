/** Mapping templates (FR-IMP-06): saved from a dataset, applied to the next file with its columns. */
import { describe, expect, it } from 'vitest';
import { fixtureBytes, type FixtureName } from '@tw/fixtures';
import type { FileInput } from '@tw/model';
import { awaitJob, columnId, importFixture, newEngine, withProject } from './__fixtures__/session';
import { memoryTemplateStore, parseTemplateFile, templateFile, type TemplateStore } from './template-store';
import type { LocalEngine } from './engine';

const GOLDEN: FixtureName = 'csv_well_daily_golden.csv';

function file(name: FixtureName): FileInput {
  return { kind: 'bytes', bytes: fixtureBytes(name), name };
}

/** An engine with the golden dataset read as the user wants it, saved as the template "Daily wells". */
async function savedTemplate(store: TemplateStore): Promise<LocalEngine> {
  const engine = await withProject(newEngine({ templates: store }));
  const ds = await importFixture(engine, GOLDEN);
  const reason = 'Field data dictionary, March 2026';
  await engine.decide({
    kind: 'override_detection',
    datasetId: ds.id,
    columnId: await columnId(engine, ds.id, 'date'),
    property: 'timezone',
    value: 'utc',
    reason,
  });
  await engine.decide({
    kind: 'override_detection',
    datasetId: ds.id,
    columnId: await columnId(engine, ds.id, 'Pressure'),
    property: 'name',
    value: 'BHP',
    reason,
  });
  await engine.saveMappingTemplate({ datasetId: ds.id, name: 'Daily wells' });
  return engine;
}

describe('mapping templates', () => {
  it('saves how each source column is read, without data', async () => {
    const store = memoryTemplateStore();
    const engine = await savedTemplate(store);
    const [t] = await engine.listMappingTemplates();
    expect(t).toMatchObject({
      name: 'Daily wells',
      savedFrom: { fileName: GOLDEN, format: 'csv' },
      savedBy: 'Prasad',
    });
    expect(t?.savedAt).toMatch(/^2026-10-19T08:00:\d\d\.000Z$/);
    expect(t?.id).toMatch(/^mt_[0-9a-f]{12}$/);
    expect(t?.columns.map((c) => c.sourceHeader[0])).toEqual([
      'well_id',
      'date',
      'latitude',
      'longitude',
      'Pressure (psia)',
      'Temperature (degF)',
      'Oil (bbl/d)',
      'Gas (Mscf/d)',
      'Water cut (%)',
    ]);
    expect(t?.columns[1]).toMatchObject({ name: 'date', type: 'datetime', timezone: 'utc' });
    expect(t?.columns[4]).toMatchObject({ name: 'BHP', unit: 'psia', role: 'measure' });
    expect(await store.load()).toEqual([t]);
  });

  it('applies itself to the next file with the same columns, in the preview and on import', async () => {
    const store = memoryTemplateStore();
    await savedTemplate(store);
    const engine = await withProject(newEngine({ templates: store }));

    const preview = await engine.sniff(file(GOLDEN));
    expect(preview.template?.name).toBe('Daily wells');
    expect(preview.template?.overrides).toEqual([
      { columnId: 'c1', timezone: 'utc' },
      { columnId: 'c4', name: 'BHP' },
    ]);
    const date = preview.columns[1];
    expect(date?.timezone).toMatchObject({ value: 'utc', assumed: false, method: 'mapping-template' });
    expect(date?.timezone?.evidence).toBe('From the mapping template "Daily wells".');
    expect(preview.columns[4]?.name).toBe('BHP');
    // The template settled the only assumption detection made.
    expect(preview.assumptions.filter((a) => a.property === 'timezone')).toEqual([]);

    const ds = await awaitJob<{ id: string }>(engine, await engine.importFile(file(GOLDEN)));
    const schema = await engine.getSchema(ds.id);
    expect(schema.columns[1]?.timezone?.value).toBe('utc');
    expect(schema.columns[4]?.name).toBe('BHP');
    const overrides = (await engine.listAudit({ action: ['detection.override'] })).items;
    expect(overrides).toHaveLength(2);
    const id = preview.template?.id ?? '';
    expect(overrides.map((e) => e.reason)).toEqual([
      `Mapping template "Daily wells" (${id}).`,
      `Mapping template "Daily wells" (${id}).`,
    ]);
  });

  it('is left out on request, and never applied to a file that lacks one of its columns', async () => {
    const store = memoryTemplateStore();
    await savedTemplate(store);
    const engine = await withProject(newEngine({ templates: store }));
    expect((await engine.sniff(file(GOLDEN), { template: null })).template).toBeNull();
    expect((await engine.sniff(file('csv_null_markers.csv'))).template).toBeNull();

    const [t] = await engine.listMappingTemplates();
    await expect(engine.sniff(file('csv_null_markers.csv'), { template: t?.id ?? '' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('does not fit this file'),
    });
    const ds = await awaitJob<{ id: string }>(engine, await engine.importFile(file(GOLDEN), { template: null }));
    expect((await engine.getSchema(ds.id)).columns[4]?.name).toBe('Pressure');
    expect((await engine.listAudit({ action: ['detection.override'] })).items).toEqual([]);
  });

  it('replaces a template saved under the same name, and deletes one by ID', async () => {
    const store = memoryTemplateStore();
    const engine = await savedTemplate(store);
    // Imported without the template, so the second save is of the dataset as detected.
    const ds = await awaitJob<{ id: string }>(engine, await engine.importFile(file(GOLDEN), { template: null }));
    await engine.saveMappingTemplate({ datasetId: ds.id, name: '  Daily wells ' });
    const all = await engine.listMappingTemplates();
    expect(all).toHaveLength(1);
    expect(all[0]?.columns[4]?.name).toBe('Pressure');
    await engine.deleteMappingTemplate(all[0]?.id ?? '');
    expect(await engine.listMappingTemplates()).toEqual([]);
    await expect(engine.deleteMappingTemplate('mt_000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(engine.saveMappingTemplate({ datasetId: ds.id, name: ' ' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('stores templates as a document whose invalid entries are left out', async () => {
    const store = memoryTemplateStore();
    await savedTemplate(store);
    const [t] = await store.load();
    const text = templateFile([t as never, { ...(t as object), id: 'not-an-id' } as never]);
    expect(parseTemplateFile(text)).toEqual([t]);
    expect(parseTemplateFile('{')).toEqual([]);
    expect(parseTemplateFile('{"format":"something-else","templates":[]}')).toEqual([]);
  });
});
