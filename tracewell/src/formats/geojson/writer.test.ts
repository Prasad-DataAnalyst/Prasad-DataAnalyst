import { describe, expect, it } from 'vitest';
import { canonicalJson, type JsonValue } from '@tw/model';
import { readGeoJsonAll, writeGeoJson, type GeoJsonFeatureOut } from './index';

const FEATURES: GeoJsonFeatureOut[] = [
  {
    geometry: { type: 'Point', coordinates: [1.8901000000000001, 58.4412, -91.2] },
    properties: { well_id: 'NS-W01', 'TD (m)': 3520.5, active: true, note: null, platform: 'Alfa Øst "B"' },
  },
  {
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [1.79, 57.49],
          [1.81, 57.49],
          [1.81, 57.51],
          [1.79, 57.49],
        ],
      ],
    },
    properties: { well_id: 'NS-W02', 'TD (m)': 1e-7, active: false, note: 'line\nbreak', platform: '' },
  },
  {
    geometry: {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [2, 57] },
        {
          type: 'LineString',
          coordinates: [
            [2, 57],
            [2.5, 57.5],
          ],
        },
      ],
    },
    properties: { well_id: 'NS-W03', 'TD (m)': 123456789012345680000, active: true, note: null, platform: 'x' },
  },
  { geometry: null, properties: {} },
];

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

describe('writeGeoJson', () => {
  it('round-trips geometry and properties exactly through readGeoJsonAll', () => {
    const back = readGeoJsonAll(writeGeoJson(FEATURES));
    expect(canonicalJson(back.features as unknown as JsonValue)).toBe(canonicalJson(FEATURES as unknown as JsonValue));
    expect(back.crs).toBeNull();
  });

  it('writes no crs member and parses with JSON.parse as a FeatureCollection', () => {
    const doc = JSON.parse(decode(writeGeoJson(FEATURES, { name: 'wells' }))) as Record<string, unknown>;
    expect(doc['type']).toBe('FeatureCollection');
    expect(doc['name']).toBe('wells');
    expect('crs' in doc).toBe(false);
    expect(doc['features']).toHaveLength(FEATURES.length);
  });

  it('writes 0.1 + 0.2 at full precision as 0.30000000000000004', () => {
    const text = decode(
      writeGeoJson([{ geometry: { type: 'Point', coordinates: [0.1 + 0.2, -0] }, properties: { v: 0.1 + 0.2 } }]),
    );
    expect(text).toContain('"coordinates":[0.30000000000000004,0]');
    expect(text).toContain('"v":0.30000000000000004');
  });

  it('puts one feature on each line, ending each with a newline', () => {
    const text = decode(writeGeoJson(FEATURES.slice(0, 2)));
    const lines = text.split('\n');
    expect(lines[0]).toBe('{"type":"FeatureCollection","features":[');
    expect(lines[1]?.startsWith('{"type":"Feature","geometry":{"type":"Point","coordinates":[')).toBe(true);
    expect(lines[1]?.endsWith('},')).toBe(true);
    expect(lines[2]?.endsWith('}}')).toBe(true);
    expect(lines.slice(3)).toEqual([']}', '']);
  });

  it('keeps property order as given', () => {
    const text = decode(writeGeoJson([{ geometry: null, properties: { z: 1, a: 2 } }]));
    expect(text).toContain('"properties":{"z":1,"a":2}');
  });

  it('writes an empty collection', () => {
    const text = decode(writeGeoJson([]));
    expect(JSON.parse(text)).toEqual({ type: 'FeatureCollection', features: [] });
    expect(readGeoJsonAll(writeGeoJson([])).features).toEqual([]);
  });

  it('refuses numbers that are not finite', () => {
    expect(() => writeGeoJson([{ geometry: null, properties: { v: Number.NaN } }])).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }) as Error,
    );
  });
});

describe('readGeoJsonAll', () => {
  const bytes = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

  it('returns the legacy crs member as written', () => {
    const crs = { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::27700' } };
    expect(readGeoJsonAll(bytes({ type: 'FeatureCollection', crs, features: [] })).crs).toEqual(crs);
  });

  it('reads a single Feature and a bare Geometry as one feature, keeping nested properties as values', () => {
    const feature = readGeoJsonAll(bytes({ type: 'Feature', geometry: null, properties: { o: { a: [1] } } }));
    expect(feature.features).toEqual([{ geometry: null, properties: { o: { a: [1] } } }]);
    const point = { type: 'Point', coordinates: [1, 2] };
    expect(readGeoJsonAll(bytes(point)).features).toEqual([{ geometry: point, properties: {} }]);
  });

  it('refuses malformed JSON and non-GeoJSON objects', () => {
    expect(() => readGeoJsonAll(new TextEncoder().encode('{"type":'))).toThrow(
      expect.objectContaining({ code: 'PARSE_FAILED' }) as Error,
    );
    expect(() => readGeoJsonAll(bytes({ type: 'Topology' }))).toThrow(
      expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' }) as Error,
    );
    expect(() => readGeoJsonAll(bytes([]))).toThrow(expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' }) as Error);
  });
});
