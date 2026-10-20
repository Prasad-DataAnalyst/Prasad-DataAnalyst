/**
 * Longitude/latitude range checks (TW-GEO-002) and the swap heuristic (TW-GEO-003). Values are
 * read as WGS84 degrees; no CRS transformation takes place.
 */
import type { BBox, Geometry } from '@tw/model';
import { bboxContains } from './bbox';
import { positionsOf } from './positions';

/** Whether both values are finite and within -180..180 (longitude) and -90..90 (latitude), inclusive. */
export function inLonLatRange(lon: number, lat: number): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
}

/**
 * Whether every position of the geometry is in range. A position without a finite longitude and
 * latitude is not. An empty geometry has no position out of range, so it passes.
 */
export function geometryInRange(g: Geometry): boolean {
  for (const [lon, lat] of positionsOf(g)) {
    if (lon === undefined || lat === undefined || !inLonLatRange(lon, lat)) return false;
  }
  return true;
}

/**
 * Whether a longitude/latitude pair was probably entered the wrong way round. True when:
 * - the latitude is impossible (|lat| > 90) but the pair is valid once swapped (|lon| <= 90 and
 *   |lat| <= 180), or
 * - a project area is set, the point lies outside it, and the swapped point lies inside it.
 */
export function likelySwapped(lon: number, lat: number, ctx?: { projectArea?: BBox | null }): boolean {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  if (Math.abs(lat) > 90) return Math.abs(lon) <= 90 && Math.abs(lat) <= 180;
  const area = ctx?.projectArea;
  return area != null && !bboxContains(area, lon, lat) && bboxContains(area, lat, lon);
}
