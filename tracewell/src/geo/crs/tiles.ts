/**
 * The Web Mercator tile grid the map's density view counts in. A cell is found with the exact
 * elementary functions (exact.ts), so both engines put every point in the same cell; geodesy.rs
 * in the native engine computes mercator_cell with the same operations in the same order.
 */
import { asinh, tan } from './exact';

/** The latitude Web Mercator reaches, atan(sinh(π)) in degrees; beyond it a point is at the edge. */
export const MERCATOR_MAX_LATITUDE = 85.0511287798066;

/**
 * The cell [x, y] holding a WGS 84 point in the grid of 2^level by 2^level cells, x eastwards
 * from the antimeridian and y southwards from the top edge, as map tiles are numbered.
 */
export function mercatorCell(lon: number, lat: number, level: number): [number, number] {
  const n = 2 ** level;
  const x = Math.floor(((lon + 180) / 360) * n);
  const phi = (Math.min(Math.max(lat, -MERCATOR_MAX_LATITUDE), MERCATOR_MAX_LATITUDE) * Math.PI) / 180;
  const y = Math.floor(((1 - asinh(tan(phi)) / Math.PI) / 2) * n);
  return [Math.min(Math.max(x, 0), n - 1), Math.min(Math.max(y, 0), n - 1)];
}
