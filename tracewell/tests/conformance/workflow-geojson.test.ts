/** GeoJSON: invalid geometries are found and excluded; data that is not WGS84 is not offered as GeoJSON. */
import { expect } from 'vitest';
import { fixtureExpectation } from '@tw/fixtures';
import type { ExportResult } from '@tw/model';
import { defineConformance, importFixture, newProject, runChecks } from './harness';

defineConformance('workflow-geojson: exclude invalid geometries and export valid GeoJSON', async (engine) => {
  await newProject(engine);
  const ds = await importFixture(engine, 'geojson_invalid_geometries.geojson');
  const issues = await runChecks(engine, ds.id);
  const invalid = issues.filter((i) => i.ruleId === 'TW-GEO-001');
  const flagged = invalid.reduce((n, i) => n + i.counts.flagged, 0);
  expect(flagged).toBe(fixtureExpectation('geojson_invalid_geometries.geojson').issues['TW-GEO-001']);
  for (const i of invalid) {
    await engine.decide({
      kind: 'exclude_rows',
      datasetId: ds.id,
      rows: { issueId: i.id },
      reason: 'Geometry cannot be repaired',
    });
  }
  const after = (await engine.listIssues({ datasetId: ds.id, ruleId: 'TW-GEO-001' })).items;
  expect(after.every((i) => i.status === 'resolved')).toBe(true);
  const result = await engine.awaitJob<ExportResult>(await engine.exportData({ datasetId: ds.id, profile: 'geojson' }));
  expect(result.ok).toBe(true);
  expect(result.manifest.excludedRows).toBe(flagged);
});

defineConformance('workflow-geojson: a legacy British National Grid file is not offered as GeoJSON', async (engine) => {
  await newProject(engine);
  const ds = await importFixture(engine, 'geojson_legacy_crs_27700.geojson');
  const profiles = await engine.listExportProfiles(ds.id);
  const geojson = profiles.find((p) => p.profile.id === 'geojson');
  expect(geojson?.available).toBe(false);
  expect(geojson?.reason).toContain('TW-EXP-003');
  expect(geojson?.fix).toBeTruthy();
  await expect(engine.exportData({ datasetId: ds.id, profile: 'geojson' })).rejects.toMatchObject({
    code: 'EXPORT_REFUSED',
  });
  expect(profiles.find((p) => p.profile.id === 'csv')?.available).toBe(true);
});
