import { describe, expect, it } from 'vitest';
import type { PlacesWindow } from '@tw/model';
import {
  LIGHT_COLOURS,
  areaPredicate,
  basemapLayers,
  boundsOf,
  boxBetween,
  boxFeature,
  graticule,
  placesCollection,
  themeColours,
  tileKind,
} from './map-style';

const base: PlacesWindow = {
  datasetId: 'd1',
  stage: 'working',
  crs: 'OGC:CRS84',
  source: { geometry: 'c3' },
  transformed: false,
  unplaced: null,
  rows: 3,
  placed: 2,
  features: [
    { rowId: 0, geometry: { type: 'Point', coordinates: [2.5, 56] } },
    {
      rowId: 2,
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          {
            type: 'LineString',
            coordinates: [
              [-1, 50, 7],
              [3, 61],
            ],
          },
        ],
      },
    },
  ],
  truncated: false,
};

describe('map style', () => {
  it('turns places into features that carry their row', () => {
    expect(placesCollection(base).features.map((f) => [f.id, f.properties.rowId, f.geometry.type])).toEqual([
      [0, 0, 'Point'],
      [2, 2, 'GeometryCollection'],
    ]);
    expect(placesCollection(null).features).toEqual([]);
  });

  it('bounds every position, nested ones and heights included', () => {
    expect(boundsOf(base)).toEqual([-1, 50, 3, 61]);
    expect(boundsOf({ ...base, features: [] })).toBeNull();
  });

  it('draws a graticule that stays inside Web Mercator', () => {
    const g = graticule(30);
    expect(g.features.filter((f) => f.properties.kind === 'meridian')).toHaveLength(13);
    expect(g.features.filter((f) => f.properties.kind === 'parallel')).toHaveLength(6);
    const latitudes = g.features.flatMap((f) =>
      f.geometry.type === 'LineString' ? f.geometry.coordinates.map((c) => Math.abs(c[1] as number)) : [],
    );
    expect(Math.max(...latitudes)).toBe(85);
  });

  it('makes a box from a drag in any direction, held to one world and rounded', () => {
    expect(boxBetween([3.123456789, 61], [-1, 50.0000004])).toEqual([-1, 50, 3.123457, 61]);
    expect(boxBetween([190, -95], [170, 10])).toEqual([170, -90, 180, 10]);
    expect(boxFeature([0, 1, 2, 3]).geometry).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [0, 1],
          [2, 1],
          [2, 3],
          [0, 3],
          [0, 1],
        ],
      ],
    });
  });

  it('filters by a drawn box only data in WGS 84', () => {
    expect(areaPredicate(base, [0, 50, 3, 62])).toEqual({ predicate: { bbox: [0, 50, 3, 62], geometry: 'c3' } });
    expect(areaPredicate({ ...base, source: { x: 'c2', y: 'c1' } }, [0, 50, 3, 62])).toEqual({
      predicate: { bbox: [0, 50, 3, 62], lat: 'c1', lon: 'c2' },
    });
    const grid = areaPredicate({ ...base, crs: 'EPSG:27700', transformed: true }, [0, 50, 3, 62]);
    expect('reason' in grid && grid.reason).toContain('EPSG:27700');
    const none = areaPredicate(
      { ...base, source: null, unplaced: { reason: 'Not known.', fix: 'Set it.' } },
      [0, 50, 3, 62],
    );
    expect(none).toEqual({ reason: 'Not known.' });
  });

  it('draws any basemap: raster, or every vector layer with water as water', () => {
    expect([1, 2, 3, 4, 5, 0].map(tileKind)).toEqual([
      'vector',
      'raster',
      'raster',
      'raster',
      'unsupported',
      'unsupported',
    ]);
    expect(basemapLayers('raster', [], LIGHT_COLOURS)).toEqual([
      { id: 'basemap-raster', type: 'raster', source: 'basemap' },
    ]);
    const layers = basemapLayers('vector', ['earth', 'water'], LIGHT_COLOURS);
    expect(layers.map((l) => l.id)).toEqual([
      'basemap-fill-earth',
      'basemap-line-earth',
      'basemap-fill-water',
      'basemap-line-water',
    ]);
    expect(layers[2]).toMatchObject({ paint: { 'fill-color': LIGHT_COLOURS.water } });
    expect(basemapLayers('unsupported', ['x'], LIGHT_COLOURS)).toEqual([]);
  });

  it('reads the theme, falling back where a token is not set', () => {
    const tokens: Record<string, string> = { '--tw-accent': ' #5fa3e0 ' };
    expect(themeColours((n) => tokens[n] ?? '')).toMatchObject({
      places: '#5fa3e0',
      background: LIGHT_COLOURS.background,
    });
  });
});
