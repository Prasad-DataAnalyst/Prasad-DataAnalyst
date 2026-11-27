import { describe, expect, it } from 'vitest';
import { fixtureBytes, fixtureSource } from '@tw/fixtures';
import type { ByteSource, FormatOptions, RawRow } from '@tw/model';
import { GPKG_UNDEFINED_SRS, gpkgGeometry, writeGeoPackage, type GpkgSrs } from './gpkg';
import { geopackageImporter } from './importer';
import { writeSqlite } from './sqlite';

function source(bytes: Uint8Array, name = 'layer.gpkg'): ByteSource {
  return {
    name,
    size: bytes.byteLength,
    slice: (start, end) => Promise.resolve(bytes.slice(start, end)),
    stream: () => new Blob([bytes as BlobPart]).stream(),
  };
}

async function readAll(src: ByteSource, options: FormatOptions): Promise<RawRow[]> {
  const rows: RawRow[] = [];
  const ctx = { signal: new AbortController().signal, onBytes: () => undefined, note: () => undefined };
  for await (const batch of geopackageImporter.read(src, options, ctx)) rows.push(...batch.rows);
  return rows;
}

/** A GeoPackage of one point layer in the given system, as the product writes one. */
function onePoint(srs: GpkgSrs[], srsId: number): Uint8Array {
  return writeGeoPackage(
    {
      table: 'data',
      identifier: 'Wells',
      lastChange: '2026-11-01T00:00:00.000Z',
      srs,
      srsId,
      fidColumn: 'fid',
      geometryColumn: 'geom',
      geometryType: 'POINT',
      z: 0,
      extent: [1, 2, 1, 2],
      columns: [{ name: 'name', type: 'TEXT' }],
      features: 1,
    },
    [{ geometry: { type: 'Point', coordinates: [1, 2] }, z: false, values: ['A'] }],
  );
}

describe('geopackageImporter', () => {
  it('reads a layer SQLite wrote: feature IDs, typed fields, heights, a null geometry and a long record', async () => {
    const sniff = await geopackageImporter.sniff(fixtureSource('gpkg_wells_points_wgs84.gpkg'));
    expect(sniff.format).toBe('geopackage');
    expect(sniff.options).toEqual({ format: 'geopackage', geopackage: { layer: 'wells', geometry: 'geom' } });
    expect(sniff.header).toEqual([
      ['well_id', 'operator', 'spud_date', 'last_test', 'tvd_m', 'slots', 'online', 'remarks', 'photo'],
    ]);
    expect(sniff.detections['crs']).toMatchObject({
      value: { code: 'EPSG:4326', source: 'geopackage-srs' },
      confidence: 'high',
      evidence: 'gpkg_spatial_ref_sys gives the layer the coordinate reference system EPSG:4326 (WGS 84 geodetic).',
    });
    expect(sniff.detections['encoding']).toMatchObject({ value: 'utf-8', method: 'sqlite-header' });
    expect(sniff.detections['rowCount']?.value).toBe(39);
    expect(sniff.detections['geometryTypes']?.value).toEqual(['Point']);
    const rows = sniff.sampleRows;
    // Feature 7 was deleted: the rows keep the feature IDs SQLite gave them.
    expect(rows.map((r) => r.srcLoc).slice(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 8, 9]);
    expect(rows[0]?.fields).toEqual([
      'NS-A01',
      'Forties Oil',
      '2011-02-02',
      '2025-02-02T01:30:00.000Z',
      125.5,
      1,
      true,
      'Workover 1',
      null,
    ]);
    // 250 is a whole number SQLite stored as an integer in the REAL column: it reads as a real.
    expect(rows[1]?.fields[4]).toBe(250);
    expect(rows.find((r) => r.srcLoc === 5)?.fields[8]).toBe('000102030405060708090a0b0c0d0e0f');
    expect(rows.find((r) => r.srcLoc === 9)?.geometry).toEqual({ type: 'Point', coordinates: [1.45, 57.18, -1200.5] });
    expect(rows.find((r) => r.srcLoc === 17)?.geometry).toBeNull();
    expect(String(rows.find((r) => r.srcLoc === 13)?.fields[7]).length).toBeGreaterThan(3000);
    expect(rows.find((r) => r.srcLoc === 25)?.fields[6]).toBeNull();
    expect(await readAll(fixtureSource('gpkg_wells_points_wgs84.gpkg'), sniff.options)).toEqual(rows);
  });

  it('reads UTF-16 text, big-endian geometries, records older than a column, and another layer when asked', async () => {
    const src = fixtureSource('gpkg_licence_blocks_bng.gpkg');
    const sniff = await geopackageImporter.sniff(src);
    expect(sniff.detections['encoding']).toMatchObject({ value: 'utf-16le' });
    expect(sniff.detections['layer']).toMatchObject({
      value: 'blocks',
      evidence: 'The GeoPackage holds 2 tables of data: blocks (features), operators (attributes); blocks is read.',
    });
    expect(sniff.detections['crs']?.value).toEqual({ code: 'EPSG:27700', source: 'geopackage-srs' });
    expect(sniff.detections['geometryTypes']?.value).toEqual(['Polygon', 'MultiPolygon']);
    expect(sniff.sampleRows.map((r) => r.fields[4])).toEqual([
      'Brent Energy',
      'Øresund Energi ApS',
      'Société des Pétroles',
      null,
      'Forties Oil 北海',
    ]);
    expect(sniff.sampleRows.map((r) => r.fields[5])).toEqual([null, null, null, 'Relinquished in 2020', null]);
    expect(sniff.sampleRows[0]?.geometry).toMatchObject({ type: 'Polygon', coordinates: { length: 2 } });
    const ring = (sniff.sampleRows[4]?.geometry as { coordinates: number[][][] }).coordinates[0];
    expect(ring?.slice(0, 2)).toEqual([
      [450000, 130000, 15],
      [454000, 130000, 15],
    ]);
    const operators = await readAll(src, { format: 'geopackage', geopackage: { layer: 'operators', geometry: null } });
    expect(operators).toEqual([
      { srcLoc: 1, fields: ['Brent Energy', 'GB'] },
      { srcLoc: 2, fields: ['Øresund Energi ApS', 'DK'] },
      { srcLoc: 3, fields: ['Société des Pétroles', 'FR'] },
    ]);
    await expect(
      readAll(src, { format: 'geopackage', geopackage: { layer: 'wells', geometry: null } }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      fix: 'Choose one of its layers: blocks, operators.',
    });
  });

  it('finds the CRS by EPSG code, by the EPSG code its WKT names, and not at all for the undefined systems', async () => {
    const crs = async (srs: GpkgSrs[], id: number) =>
      (await geopackageImporter.sniff(source(onePoint([...GPKG_UNDEFINED_SRS, ...srs], id)))).detections['crs'];
    const esri = { id: 102001, name: 'Canada Albers', organization: 'ESRI', code: 102001, description: null };
    expect(
      await crs([{ ...esri, definition: 'PROJCS["x",GEOGCS["y"],AUTHORITY["EPSG","3347"]]' }], 102001),
    ).toMatchObject({
      value: { code: 'EPSG:3347' },
      confidence: 'high',
      method: 'geopackage-srs-wkt',
    });
    expect(await crs([{ ...esri, definition: 'PROJCS["x",GEOGCS["y"]]' }], 102001)).toMatchObject({
      value: { code: 'unknown' },
      confidence: 'low',
      evidence: 'gpkg_spatial_ref_sys gives the layer the system ESRI:102001 (Canada Albers), which has no EPSG code.',
    });
    expect(await crs([], 0)).toMatchObject({
      value: { code: 'unknown' },
      evidence:
        "The layer's srs_id 0 is the undefined geographic system, so the coordinate reference system is not known.",
    });
    expect(await crs([], 4326)).toMatchObject({ value: { code: 'unknown' }, confidence: 'low' });
  });

  it('refuses an SQLite database that is no GeoPackage, a damaged file and a geometry that does not read', async () => {
    const plain = writeSqlite({ applicationId: 0, userVersion: 0 }, [
      { name: 't', sql: 'CREATE TABLE t (a)', rows: [[1n, ['x']]] },
    ]);
    await expect(geopackageImporter.sniff(source(plain))).rejects.toMatchObject({
      code: 'PARSE_FAILED',
      message:
        'The GeoPackage does not parse: it is an SQLite database without the gpkg_contents table of a GeoPackage.',
    });
    const cut = fixtureBytes('gpkg_wells_points_wgs84.gpkg').slice(0, 3000);
    await expect(geopackageImporter.sniff(source(cut))).rejects.toMatchObject({ code: 'PARSE_FAILED' });
    const bytes = onePoint([gpkgSrs4326()], 4326);
    const blob = gpkgGeometry({ type: 'Point', coordinates: [1, 2] }, 4326, false);
    const at = findLast(bytes, blob);
    bytes[at + 8] = 9; // WKB byte order 9
    await expect(geopackageImporter.sniff(source(bytes))).rejects.toMatchObject({
      message:
        'The GeoPackage does not parse: the geometry of feature 1 does not read: a geometry has the byte order 9.',
    });
  });
});

function gpkgSrs4326(): GpkgSrs {
  return {
    id: 4326,
    name: 'WGS 84 geodetic',
    organization: 'EPSG',
    code: 4326,
    definition: 'GEOGCS["WGS 84"]',
    description: null,
  };
}

function findLast(haystack: Uint8Array, needle: Uint8Array): number {
  for (let i = haystack.length - needle.length; i >= 0; i--) {
    if (needle.every((b, k) => haystack[i + k] === b)) return i;
  }
  throw new Error('not found');
}
