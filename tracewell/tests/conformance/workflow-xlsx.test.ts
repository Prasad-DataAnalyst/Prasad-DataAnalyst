/** A workbook with a merged two-row header: import, check, override a unit, export as CSV. */
import { expect } from 'vitest';
import { fixtureExpectation } from '@tw/fixtures';
import type { ExportResult } from '@tw/model';
import { defineConformance, importFixture, newProject, ruleCounts, runChecks } from './harness';

defineConformance('workflow-xlsx: merged header workbook through to a validated CSV package', async (engine) => {
  await newProject(engine);
  const ds = await importFixture(engine, 'xlsx_merged_two_row_header_units.xlsx');
  const issues = await runChecks(engine, ds.id);
  expect(ruleCounts(issues)).toEqual(fixtureExpectation('xlsx_merged_two_row_header_units.xlsx').issues);
  const schema = await engine.getSchema(ds.id);
  const measured = schema.columns.find((c) => c.unit.value !== null && c.type.value === 'number');
  if (measured === undefined) throw new Error('the workbook has no measured column');
  const [entry] = await engine.decide({
    kind: 'override_detection',
    datasetId: ds.id,
    columnId: measured.id,
    property: 'unit',
    value: measured.unit.value === 'kPa' ? 'bar' : 'kPa',
    reason: 'Unit confirmed with the data owner',
  });
  expect(entry).toMatchObject({ action: 'detection.override', old: measured.unit.value });
  const result = await engine.awaitJob<ExportResult>(await engine.exportData({ datasetId: ds.id, profile: 'csv' }));
  expect(result.ok).toBe(true);
  expect(result.validation.checks.every((c) => c.ok)).toBe(true);
});
