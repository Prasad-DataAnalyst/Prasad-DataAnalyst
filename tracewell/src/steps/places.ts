/**
 * Places: a geometry transformed position by position (the coordinate transformation step), and
 * where a view's rows are as WGS 84 longitude and latitude (the map).
 *
 * In a transformed geometry every position's longitude and latitude, or easting and northing, are
 * transformed; a third ordinate, such as a height, is kept as it is. A bounding box is left out,
 * since it no longer bounds the geometry. A geometry with a position the transformation cannot
 * place becomes no geometry. geodesy.rs in the native engine walks a geometry the same way, and
 * its getPlaces gives the same answer as placesOf.
 */
import {
  EngineError,
  isGeometryCell,
  type CellValue,
  type Geometry,
  type GeometryCell,
  type PlacesWindow,
} from '@tw/model';
import { crsTransformer, isGeometry, type CrsTransformer } from '@tw/geo';
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

/**
 * Where the rows of a view are, in WGS 84 longitude and latitude, for the map: each row's geometry
 * of a valid shape, or the point of its coordinate columns, transformed from the view's CRS when it
 * is another. The first `limit` placed rows are given, in row order.
 */
export function placesOf(view: View, limit: number): Places {
  const code = view.schema.crs?.value.code;
  const crs = code === undefined || code === 'unknown' ? null : code;
  const nothing = (reason: string, fix: string): Places => ({
    crs,
    source: null,
    transformed: false,
    unplaced: { reason, fix },
    rows: view.rowCount,
    placed: 0,
    features: [],
    truncated: false,
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
  const features: Places['features'] = [];
  let placed = 0;
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
    if (g === null) continue;
    placed++;
    if (features.length < limit) features.push({ rowId: r, geometry: g });
  }
  return {
    crs,
    source: 'geometry' in src ? { geometry: src.geometry.id } : { x: src.x.id, y: src.y.id },
    transformed: t.operations.length > 0,
    unplaced: null,
    rows: view.rowCount,
    placed,
    features,
    truncated: placed > features.length,
  };
}
