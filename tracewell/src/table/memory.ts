/**
 * Memory estimates for the import budget (SAD section 8.4). These are deliberately simple,
 * slightly pessimistic constants for V8: the budget only has to stop an import before the tab
 * runs out of memory, not account for every byte.
 */
import type { Geometry, Position } from '@tw/model';

/** A string's header in V8, on top of two bytes a character (the worst case of its two encodings). */
export const STRING_BYTES = 16;

/** One entry of a sparse raw-text map: map slot, key and string header. */
export const RAW_ENTRY_BYTES = 48;

const OBJECT_BYTES = 32;
const ARRAY_BYTES = 16;

function positionBytes(p: Position): number {
  return ARRAY_BYTES + 8 * p.length;
}

function nestedBytes(v: Position | readonly unknown[]): number {
  if (v.length === 0 || typeof v[0] === 'number') return positionBytes(v as Position);
  let n = ARRAY_BYTES + 8 * v.length;
  for (const item of v) n += nestedBytes(item as Position | readonly unknown[]);
  return n;
}

/** Bytes held by a GeoJSON geometry object and its coordinate arrays. */
export function geometryBytes(g: Geometry): number {
  if (g.type === 'GeometryCollection') {
    let n = OBJECT_BYTES + ARRAY_BYTES;
    for (const member of g.geometries) n += geometryBytes(member);
    return n;
  }
  return OBJECT_BYTES + nestedBytes(g.coordinates);
}
