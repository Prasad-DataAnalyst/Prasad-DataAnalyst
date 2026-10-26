/** Small JSON value guards shared by the reader, the CRS detection and the read-back parser. */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The RFC 7946 geometry type names. */
export const GEOMETRY_TYPES: ReadonlySet<string> = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

/** True for an object with a string `type`; whether it is a valid geometry is the rules module's job. */
export function isGeometryLike(v: unknown): v is Record<string, unknown> & { type: string } {
  return isRecord(v) && typeof v['type'] === 'string';
}
