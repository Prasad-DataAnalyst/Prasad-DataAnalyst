/**
 * A geometry transformed position by position (the coordinate transformation step). Every
 * position's longitude and latitude, or easting and northing, are transformed; a third ordinate,
 * such as a height, is kept as it is. A bounding box is left out, since it no longer bounds the
 * geometry. A geometry with a position the transformation cannot place becomes no geometry.
 * geodesy.rs in the native engine walks a geometry the same way.
 */
import { isGeometryCell, type CellValue } from '@tw/model';
import type { CrsTransformer } from '@tw/geo';

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
