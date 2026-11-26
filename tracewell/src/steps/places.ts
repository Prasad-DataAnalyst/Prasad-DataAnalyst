/**
 * Places: a geometry transformed position by position (the coordinate transformation step), and
 * where a view's rows are as WGS 84 longitude and latitude (the map).
 *
 * In a transformed geometry every position's longitude and latitude, or easting and northing, are
 * transformed; a third ordinate, such as a height, is kept as it is. A bounding box is left out,
 * since it no longer bounds the geometry. A geometry with a position the transformation cannot
 * place becomes no geometry. geodesy.rs in the native engine walks a geometry the same way, and
 * its getPlaces and getDensity give the same answers as placesOf and densityOf.
 */
import {
  EngineError,
  isGeometryCell,
  type CellValue,
  type DensityGrid,
  type Geometry,
  type GeometryCell,
  type PlacesWindow,
} from '@tw/model';
import { crsTransformer, isGeometry, mercatorCell, positionsOf, type CrsTransformer } from '@tw/geo';
import type { View } from '@tw/table';
import { coordinateSource, pairName } from './views';

const FAILED = Symbol('failed');

function coordinates(c: unknown, t: CrsTransformer): unknown {
  if (!Array.isArray(c)) return c;
  if (c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number') {
    const p = t.forward(c[0], c[1]);
    return p === null ? FAILED : [p[0], p[1], ...(c.slice(2) as unknown[])];
  }
  const out: unknown[] = [];
  for (const item of c as unknown[]) {
    const m = coordinates(item, t);
    if (m === FAILED) return FAILED;
    out.push(m);
  }
  return out;
}

function geometry(g: unknown, t: CrsTransformer): unknown {
  if (typeof g !== 'object' || g === null || Array.isArray(g)) return g;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(g)) {
    if (k === 'bbox') continue;
    if (k === 'coordinates') {
      const m = coordinates(v, t);
      if (m === FAILED) return FAILED;
      out[k] = m;
    } else if (k === 'geometries' && Array.isArray(v)) {
      const members: unknown[] = [];
      for (const member of v as unknown[]) {
        const m = geometry(member, t);
        if (m === FAILED) return FAILED;
        members.push(m);
      }
      out[k] = members;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function transformGeometry(v: CellValue, t: CrsTransformer): CellValue {
  if (!isGeometryCell(v)) return null;
  const g = geometry(v.geometry, t);
  return g === FAILED ? null : ({ geometry: g } as CellValue);
}

type Places = Omit<PlacesWindow, 'datasetId' | 'stage'>;
type Density = Omit<DensityGrid, 'datasetId' | 'stage' | 'level'>;
type Box = [number, number, number, number];

/** What the walk over a view's places found before any row: the CRS, the source, or why not. */
interface Placing {
  crs: string | null;
  source: PlacesWindow['source'];
  transformed: boolean;
  unplaced: { reason: string; fix: string } | null;
}

/**
 * Walks the rows of a view that have a place, in row order, handing each one's WGS 84 geometry
 * on: its geometry of a valid shape, or the point of its coordinate columns, transformed from the
 * view's CRS when it is another.
 */
function walkPlaces(view: View, visit: (rowId: number, g: Geometry) => void): Placing {
  const code = view.schema.crs?.value.code;
  const crs = code === undefined || code === 'unknown' ? null : code;
  const nothing = (reason: string, fix: string): Placing => ({
    crs,
    source: null,
    transformed: false,
    unplaced: { reason, fix },
  });
  if (crs === null) {
    return nothing(
      'The coordinate reference system of the data is not known, so its rows cannot be placed on the map.',
      'Set the coordinate reference system of the dataset first.',
    );
  }
  let t: CrsTransformer;
  try {
    t = crsTransformer(crs, 'EPSG:4326');
  } catch (e) {
    const err = EngineError.from(e);
    return nothing(err.message, err.fix);
  }
  const geographic = t.from.kind === 'geographic';
  const src = coordinateSource(view.schema, geographic);
  if (src === null) {
    const pair = pairName(geographic);
    return nothing(
      `The data has no geometry column and no numeric ${pair} columns, so its rows cannot be placed on the map.`,
      `Set the ${pair} roles on the coordinate columns first.`,
    );
  }
  for (const r of view.rows()) {
    let g: Geometry | null = null;
    if ('geometry' in src) {
      const v = view.value(r, src.geometry.id);
      if (isGeometryCell(v) && isGeometry(v.geometry)) {
        const moved = transformGeometry(v, t);
        if (moved !== null) g = (moved as GeometryCell).geometry;
      }
    } else {
      const x = view.value(r, src.x.id);
      const y = view.value(r, src.y.id);
      const p = typeof x === 'number' && typeof y === 'number' ? t.forward(x, y) : null;
      if (p !== null) g = { type: 'Point', coordinates: [p[0], p[1]] };
    }
    if (g !== null) visit(r, g);
  }
  return {
    crs,
    source: 'geometry' in src ? { geometry: src.geometry.id } : { x: src.x.id, y: src.y.id },
    transformed: t.operations.length > 0,
    unplaced: null,
  };
}

/** [west, south, east, north] of a geometry's positions, folded as Math.min and Math.max fold. */
function boxOf(g: Geometry): Box | null {
  let box: Box | null = null;
  for (const p of positionsOf(g)) {
    const x = p[0];
    const y = p[1];
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    box =
      box === null
        ? [x, y, x, y]
        : [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
  }
  return box;
}

/** A row's point for the density view: a point's position, or the centre of the geometry's box. */
function pointOf(g: Geometry): [number, number] | null {
  if (g.type === 'Point') {
    const [x, y] = g.coordinates;
    return typeof x === 'number' && typeof y === 'number' ? [x, y] : null;
  }
  const b = boxOf(g);
  return b === null ? null : [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/**
 * Where the rows of a view are, in WGS 84 longitude and latitude, for the map: the first `limit`
 * placed rows in row order, or with `bbox` the first of those whose box meets it.
 */
export function placesOf(view: View, limit: number, bbox?: Box): Places {
  const features: Places['features'] = [];
  let placed = 0;
  let matched = 0;
  const placing = walkPlaces(view, (r, g) => {
    placed++;
    if (bbox !== undefined) {
      const b = boxOf(g);
      if (b === null || b[2] < bbox[0] || b[0] > bbox[2] || b[3] < bbox[1] || b[1] > bbox[3]) return;
    }
    matched++;
    if (features.length < limit) features.push({ rowId: r, geometry: g });
  });
  return {
    ...placing,
    rows: view.rowCount,
    placed,
    matched,
    features,
    truncated: matched > features.length,
  };
}

/**
 * How many placed rows of a view fall in each cell of the Web Mercator grid of `level`, counting
 * each row at its point, only points in `bbox` when it is given (the map's density view).
 */
export function densityOf(view: View, level: number, bbox?: Box): Density {
  const counts = new Map<number, number>();
  const n = 2 ** level;
  let placed = 0;
  let counted = 0;
  let bounds: Box | null = null;
  const placing = walkPlaces(view, (_r, g) => {
    placed++;
    const p = pointOf(g);
    if (p === null) return;
    const [x, y] = p;
    if (bbox !== undefined && (x < bbox[0] || x > bbox[2] || y < bbox[1] || y > bbox[3])) return;
    counted++;
    bounds =
      bounds === null
        ? [x, y, x, y]
        : [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x), Math.max(bounds[3], y)];
    const [cx, cy] = mercatorCell(x, y, level);
    const key = cy * n + cx;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  const cells = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, count]) => ({ x: key % n, y: Math.floor(key / n), count }));
  const { crs, transformed, unplaced } = placing;
  return { crs, transformed, unplaced, rows: view.rowCount, placed, counted, bounds, cells };
}
