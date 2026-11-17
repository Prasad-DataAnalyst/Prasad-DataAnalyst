/**
 * The map view's data and style, as plain functions so they can be tested without a browser: the
 * places as GeoJSON, their bounds, a graticule for a map without a basemap, the box a drag draws,
 * the filter a drawn box makes, and the layers of a basemap read from a PMTiles file.
 */
import type { Geometry, PlacesWindow, Predicate, RowId } from '@tw/model';

/** [west, south, east, north] in degrees. */
export type LonLatBox = [number, number, number, number];

export interface PlaceFeature {
  type: 'Feature';
  id: RowId;
  properties: { rowId: RowId };
  geometry: Geometry;
}

export interface PlaceCollection {
  type: 'FeatureCollection';
  features: PlaceFeature[];
}

/** Each placed row as a GeoJSON feature carrying its row ID. */
export function placesCollection(p: PlacesWindow | null): PlaceCollection {
  return {
    type: 'FeatureCollection',
    features: (p?.features ?? []).map((f) => ({
      type: 'Feature',
      id: f.rowId,
      properties: { rowId: f.rowId },
      geometry: f.geometry,
    })),
  };
}

function eachPosition(c: unknown, visit: (x: number, y: number) => void): void {
  if (!Array.isArray(c)) return;
  if (typeof c[0] === 'number' && typeof c[1] === 'number') {
    visit(c[0], c[1]);
    return;
  }
  for (const item of c) eachPosition(item, visit);
}

function eachGeometryPosition(g: Geometry, visit: (x: number, y: number) => void): void {
  if (g.type === 'GeometryCollection') {
    for (const member of g.geometries) eachGeometryPosition(member, visit);
  } else {
    eachPosition(g.coordinates, visit);
  }
}

/** The smallest box around every position of the places, or null when there are none. */
export function boundsOf(p: PlacesWindow | null): LonLatBox | null {
  let box: LonLatBox | null = null;
  for (const f of p?.features ?? []) {
    eachGeometryPosition(f.geometry, (x, y) => {
      box =
        box === null
          ? [x, y, x, y]
          : [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
    });
  }
  return box;
}

/** Web Mercator stops short of the poles; lines beyond this latitude would not be drawn. */
const MERCATOR_LIMIT = 85;

/** Meridians and parallels every `step` degrees, so a map without a basemap still shows where it is. */
export function graticule(step = 10): {
  type: 'FeatureCollection';
  features: { type: 'Feature'; properties: { kind: 'meridian' | 'parallel' }; geometry: Geometry }[];
} {
  const features: ReturnType<typeof graticule>['features'] = [];
  for (let lon = -180; lon <= 180; lon += step) {
    features.push({
      type: 'Feature',
      properties: { kind: 'meridian' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [lon, -MERCATOR_LIMIT],
          [lon, MERCATOR_LIMIT],
        ],
      },
    });
  }
  for (let lat = -80; lat <= 80; lat += step) {
    features.push({
      type: 'Feature',
      properties: { kind: 'parallel' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-180, lat],
          [180, lat],
        ],
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6 + 0;
}

function clamp(x: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, x));
}

/**
 * The box between two corners of a drag, as [west, south, east, north], to six decimals (about
 * 0.1 m). Corners on a repeated copy of the world are held to the one between -180 and 180.
 */
export function boxBetween(a: [number, number], b: [number, number]): LonLatBox {
  const [x1, x2] = [clamp(a[0], -180, 180), clamp(b[0], -180, 180)];
  const [y1, y2] = [clamp(a[1], -90, 90), clamp(b[1], -90, 90)];
  return [round6(Math.min(x1, x2)), round6(Math.min(y1, y2)), round6(Math.max(x1, x2)), round6(Math.max(y1, y2))];
}

/** A drawn box as GeoJSON, to show while it is drawn and until it is applied. */
export function boxFeature(box: LonLatBox): { type: 'Feature'; properties: object; geometry: Geometry } {
  const [w, s, e, n] = box;
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    },
  };
}

/**
 * The filter a drawn box makes: rows whose geometry meets it, or whose point is in it. A box is
 * drawn in WGS 84 longitude and latitude, so data in another CRS is not filtered by it: the
 * reason says to transform the coordinates first.
 */
export function areaPredicate(p: PlacesWindow, box: LonLatBox): { predicate: Predicate } | { reason: string } {
  if (p.source === null) return { reason: p.unplaced?.reason ?? 'The data has no coordinates to filter by.' };
  if (p.transformed) {
    return {
      reason: `The data is in ${p.crs ?? 'another coordinate reference system'}, and a drawn area is in WGS 84 longitude and latitude. Transform the coordinates to EPSG:4326 first (Data › Transform coordinates).`,
    };
  }
  return 'geometry' in p.source
    ? { predicate: { bbox: box, geometry: p.source.geometry } }
    : { predicate: { bbox: box, lat: p.source.y, lon: p.source.x } };
}

/** What kind of tiles a PMTiles archive holds (its header's tile type). */
export type TileKind = 'vector' | 'raster' | 'unsupported';

export function tileKind(tileType: number): TileKind {
  if (tileType === 1) return 'vector';
  if (tileType === 2 || tileType === 3 || tileType === 4) return 'raster';
  return 'unsupported';
}

/** A basemap layer, in the form of the map style specification. */
export type BasemapLayer =
  | { id: string; type: 'raster'; source: 'basemap' }
  | {
      id: string;
      type: 'fill';
      source: 'basemap';
      'source-layer': string;
      filter: unknown[];
      paint: Record<string, unknown>;
    }
  | {
      id: string;
      type: 'line';
      source: 'basemap';
      'source-layer': string;
      filter: unknown[];
      paint: Record<string, unknown>;
    };

/**
 * The layers that draw a basemap: one raster layer, or for vector tiles a fill for the polygons and
 * a line for the lines of every source layer the archive lists. Any vector schema draws, plainly,
 * since no style is assumed; layers whose names say water are drawn as water.
 */
export function basemapLayers(kind: TileKind, vectorLayers: string[], colours: MapColours): BasemapLayer[] {
  if (kind === 'raster') return [{ id: 'basemap-raster', type: 'raster', source: 'basemap' }];
  if (kind !== 'vector') return [];
  const out: BasemapLayer[] = [];
  for (const name of vectorLayers) {
    const water = /water|ocean|sea|lake|river/i.test(name);
    out.push({
      id: `basemap-fill-${name}`,
      type: 'fill',
      source: 'basemap',
      'source-layer': name,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': water ? colours.water : colours.land, 'fill-opacity': 0.9 },
    });
    out.push({
      id: `basemap-line-${name}`,
      type: 'line',
      source: 'basemap',
      'source-layer': name,
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': water ? colours.water : colours.lines, 'line-width': 0.75 },
    });
  }
  return out;
}

/**
 * The colours the map draws with, from the theme's tokens. Red, amber and green mean status in the
 * workbench, so a selected place is drawn larger and in the text colour, not in a status colour.
 */
export interface MapColours {
  background: string;
  land: string;
  water: string;
  lines: string;
  places: string;
  selected: string;
  area: string;
}

export const LIGHT_COLOURS: MapColours = {
  background: '#e9eef3',
  land: '#f6f7f9',
  water: '#c9dcea',
  lines: '#b4bcc6',
  places: '#0f4c81',
  selected: '#1b2430',
  area: '#0f4c81',
};

/** The theme's colours, from its custom properties where they are set. */
export function themeColours(read: (name: string) => string): MapColours {
  const token = (name: string, fallback: string) => read(name).trim() || fallback;
  return {
    background: token('--tw-bg', LIGHT_COLOURS.background),
    land: token('--tw-surface', LIGHT_COLOURS.land),
    water: LIGHT_COLOURS.water,
    lines: token('--tw-border', LIGHT_COLOURS.lines),
    places: token('--tw-accent', LIGHT_COLOURS.places),
    selected: token('--tw-text', LIGHT_COLOURS.selected),
    area: token('--tw-accent', LIGHT_COLOURS.area),
  };
}
