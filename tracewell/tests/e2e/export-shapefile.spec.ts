import { expect, test } from './fixtures';
import { expectAllChecksPassed, expectOracleAgrees } from './export-shared';

test('a Shapefile package passes every check and an independent reader agrees with it', async ({ app, page }) => {
  await app.open();
  await app.importFixture('geojson_wells_points_wgs84.geojson');
  await app.runChecks();
  const { path } = await app.exportProfile('shapefile');
  await expectAllChecksPassed(page, 'shapefile');
  const facts = expectOracleAgrees(path, 'check_shapefile.py') as {
    file_code: number;
    version: number;
    shape_type: number;
    length_ok: boolean;
    records: number;
    numbered: boolean;
    dbf_records: number;
    field_names: string[];
    fields_listed: string[];
    prj: string;
    cpg: string;
    manifestRows: number;
  };
  expect([facts.file_code, facts.version, facts.shape_type, facts.length_ok, facts.numbered]).toEqual([
    9994,
    1000,
    1,
    true,
    true,
  ]);
  expect(facts.records).toBe(facts.manifestRows);
  expect(facts.dbf_records).toBe(facts.manifestRows);
  expect(facts.field_names).toEqual(facts.fields_listed);
  expect(facts.field_names.every((n) => n.length <= 10)).toBe(true);
  expect(facts.prj).toMatch(/^GEOGCS\["GCS_WGS_1984",DATUM\["D_WGS_1984"/);
  expect(facts.cpg).toBe('UTF-8');
});
