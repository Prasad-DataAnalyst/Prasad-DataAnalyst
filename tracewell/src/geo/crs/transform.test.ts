import { describe, expect, it } from 'vitest';
import { crsDefinition, crsTransformer, supportedCrs } from './transform';

describe('CRS registry', () => {
  it('knows the geographic and projected systems it lists, and nothing else', () => {
    const all = supportedCrs();
    expect(all.length).toBe(8 + 2 + 120 + 11 + 11 + 23 + 22 + 11);
    expect(all.slice(0, 3).map((c) => c.code)).toEqual(['EPSG:4171', 'EPSG:4230', 'EPSG:4258']);
    expect(crsDefinition('EPSG:32631')?.name).toBe('WGS 84 / UTM zone 31N');
    expect(crsDefinition('EPSG:32760')?.name).toBe('WGS 84 / UTM zone 60S');
    expect(crsDefinition('EPSG:23031')?.name).toBe('ED50 / UTM zone 31N');
    expect(crsDefinition('EPSG:28350')?.name).toBe('GDA94 / MGA zone 50');
    expect(crsDefinition('EPSG:27700')?.datum.toWgs84?.code).toBe('EPSG:1314');
    expect(crsDefinition('OGC:CRS84')?.kind).toBe('geographic');
    for (const unknown of ['EPSG:32661', 'EPSG:23027', 'EPSG:9999', 'unknown', 'EPSG:4326x']) {
      expect(crsDefinition(unknown), unknown).toBeNull();
    }
    expect(() => crsTransformer('EPSG:4326', 'EPSG:9999')).toThrow(/EPSG:9999 is not a coordinate reference system/);
  });
});

describe('transformations', () => {
  it('places the origin of a UTM zone at its false easting', () => {
    const t = crsTransformer('EPSG:4326', 'EPSG:32631');
    expect(t.operations.map((o) => o.method)).toEqual(['Transverse Mercator (EPSG method 9807)']);
    expect(t.accuracy).toBe(0);
    const [e, n] = t.forward(3, 0) as [number, number];
    expect([Math.abs(e - 500000) < 1e-6, Math.abs(n) < 1e-6]).toEqual([true, true]);
    expect(crsTransformer('EPSG:4326', 'EPSG:32731').forward(3, -1e-9)?.[1]).toBeCloseTo(10000000, 3);
  });

  it('changes datum through WGS 84 with the recorded transformations, and says so', () => {
    const t = crsTransformer('EPSG:23031', 'EPSG:27700');
    expect(t.operations.map((o) => `${o.code} ${o.name}`)).toEqual([
      'EPSG:23031 ED50 / UTM zone 31N, to latitude and longitude',
      'EPSG:1133 ED50 to WGS 84 (1)',
      'EPSG:1314 OSGB36 to WGS 84 (6), reversed',
      'EPSG:27700 OSGB36 / British National Grid',
    ]);
    expect(t.accuracy).toBe(12);
  });

  it('moves ED50 points by the stated translations: about 100 m north-east of WGS 84 in the North Sea', () => {
    const [lon, lat] = crsTransformer('EPSG:4230', 'EPSG:4326').forward(2, 56) as [number, number];
    // At 56N 2E the 3-parameter shift moves a point about 0.0012 degrees west and 0.0011 south.
    expect(lon).toBeLessThan(2);
    expect(lat).toBeLessThan(56);
    expect(Math.hypot((lon - 2) * 111320 * Math.cos((56 * Math.PI) / 180), (lat - 56) * 111320)).toBeGreaterThan(100);
    expect(Math.hypot((lon - 2) * 111320 * Math.cos((56 * Math.PI) / 180), (lat - 56) * 111320)).toBeLessThan(200);
  });

  it('closes round trips to a few centimetres across datums and to under a millimetre within one', () => {
    const pairs: [string, string, number, number, number][] = [
      ['EPSG:4326', 'EPSG:27700', -1.5, 53, 0.05],
      ['EPSG:4326', 'EPSG:23031', 3.5, 57, 0.05],
      ['EPSG:4326', 'EPSG:2154', 2.3, 48.8, 0.05],
      ['EPSG:4326', 'EPSG:26715', -93, 45, 0.05],
      ['EPSG:4326', 'EPSG:28350', 116, -32, 0.05],
      ['EPSG:4326', 'EPSG:32631', 3.5, 57, 0.001],
    ];
    for (const [a, b, lon, lat, tol] of pairs) {
      const there = crsTransformer(a, b).forward(lon, lat) as [number, number];
      const back = crsTransformer(b, a).forward(...there) as [number, number];
      const metres = Math.hypot((back[0] - lon) * 111320 * Math.cos((lat * Math.PI) / 180), (back[1] - lat) * 111320);
      expect(metres, `${a} to ${b}`).toBeLessThan(tol);
    }
  });

  it('gives the input back unchanged between two forms of one system', () => {
    expect(crsTransformer('EPSG:4326', 'OGC:CRS84').forward(1.123456789012345, 57.98765432109876)).toEqual([
      1.123456789012345, 57.98765432109876,
    ]);
    expect(crsTransformer('EPSG:4326', 'EPSG:4326').forward(181, 0)).toBeNull();
    expect(crsTransformer('EPSG:27700', 'EPSG:27700').forward(123456.789, 654321.012)).toEqual([
      123456.789, 654321.012,
    ]);
    expect(crsTransformer('EPSG:27700', 'EPSG:27700').operations).toEqual([]);
  });

  it('refuses a point no system can hold', () => {
    const t = crsTransformer('EPSG:4326', 'EPSG:32631');
    expect(t.forward(3, 91)).toBeNull();
    expect(t.forward(Number.NaN, 0)).toBeNull();
    expect(t.forward(200, 10)).toBeNull();
  });
});
