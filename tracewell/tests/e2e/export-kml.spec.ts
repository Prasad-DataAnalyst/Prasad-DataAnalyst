import { expect, test } from './fixtures';
import { expectAllChecksPassed, expectOracleAgrees } from './export-shared';

test('a KML package for Google Earth passes every check and an independent reader agrees with it', async ({
  app,
  page,
}) => {
  await app.open();
  await app.importFixture('geojson_wells_points_wgs84.geojson');
  await app.runChecks();
  const { path } = await app.exportProfile('kml');
  await expectAllChecksPassed(page, 'kml');
  const facts = expectOracleAgrees(path, 'check_kml.py') as {
    root: string;
    documents: number;
    placemarks: number;
    with_geometry: number;
    manifestRows: number;
  };
  expect(facts.root).toBe('{http://www.opengis.net/kml/2.2}kml');
  expect(facts.documents).toBe(1);
  expect(facts.placemarks).toBe(facts.manifestRows);
  expect(facts.with_geometry).toBe(facts.manifestRows);
});
