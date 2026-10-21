/** Walking the positions of a geometry, and building a point from latitude and longitude. */
import { EngineError, type Geometry, type Position } from '@tw/model';

function* walk(g: Geometry): Generator<Position, void, undefined> {
  switch (g.type) {
    case 'Point':
      // An empty Point (RFC 7946 allows one) has no position at all.
      if (g.coordinates.length > 0) yield g.coordinates;
      return;
    case 'MultiPoint':
    case 'LineString':
      yield* g.coordinates;
      return;
    case 'MultiLineString':
    case 'Polygon':
      for (const part of g.coordinates) yield* part;
      return;
    case 'MultiPolygon':
      for (const polygon of g.coordinates) for (const ring of polygon) yield* ring;
      return;
    case 'GeometryCollection':
      for (const member of g.geometries) yield* walk(member);
      return;
  }
}

/**
 * Every position of a geometry in document order, members of a collection included. Ring
 * closing positions are included as stored. The positions are the geometry's own arrays, not
 * copies, so callers must not change them.
 */
export function positionsOf(g: Geometry): Iterable<Position> {
  // Not the generator itself, which runs once: each loop over the result starts a fresh walk.
  return { [Symbol.iterator]: () => walk(g) };
}

/**
 * A GeoJSON Point from a latitude and a longitude; note the argument order, which is the reverse
 * of the RFC 7946 position order [longitude, latitude]. Out-of-range values are kept as given so
 * that the range and swap checks can report them; only non-finite values are refused.
 */
export function pointFromLatLon(lat: number, lon: number): Geometry {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new EngineError(
      'INVALID_INPUT',
      `A point needs a finite latitude and longitude, but got latitude ${String(lat)} and longitude ${String(lon)}.`,
      'Leave the geometry empty for rows whose latitude or longitude is missing or not a number.',
    );
  }
  return { type: 'Point', coordinates: [lon, lat] };
}
