/**
 * What geometry validation reports (rule TW-GEO-001, SAD section 7.8).
 *
 * - EMPTY: the geometry has no coordinates (or no member geometries), or a member polygon of a
 *   MultiPolygon has no rings. RFC 7946 lets readers treat such a geometry as null.
 * - NON_FINITE: an ordinate is not a finite number (NaN, Infinity, null, a string).
 * - TOO_FEW_POSITIONS: a line with fewer than 2 positions, or a ring with fewer than 4 positions
 *   or fewer than 3 distinct corners.
 * - RING_NOT_CLOSED: a ring whose last position differs from its first.
 * - SELF_INTERSECTION: a ring that crosses, touches or doubles back on itself.
 * - BAD_STRUCTURE: not a GeoJSON geometry object: unknown type, missing or malformed members.
 * - SKIPPED_TOO_LARGE: a note, not a defect. The ring has too many vertices for the
 *   self-intersection test, so that one test was not run.
 */
export type GeometryProblemCode =
  | 'EMPTY'
  | 'NON_FINITE'
  | 'TOO_FEW_POSITIONS'
  | 'RING_NOT_CLOSED'
  | 'SELF_INTERSECTION'
  | 'BAD_STRUCTURE'
  | 'SKIPPED_TOO_LARGE';

export interface GeometryProblem {
  code: GeometryProblemCode;
  /** A plain-language sentence that stands on its own (it does not repeat the path). */
  message: string;
  /**
   * Where the problem is, relative to the geometry object, for example 'coordinates[0]' or
   * 'geometries[1].coordinates'. The empty string means the value itself.
   */
  path: string;
}
