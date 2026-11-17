// Public entry point of the geo module, imported elsewhere as '@tw/geo': GeoJSON geometry
// validation, bounding boxes, longitude/latitude range checks and the swap heuristic, point
// construction, coordinate transformation between the systems of the CRS registry, and the ESRI
// WKT of each of those systems.

export type { GeometryProblem, GeometryProblemCode } from './types';
export { geometryProblems, isGeometry } from './validate';
export { bboxContains, bboxIntersectsGeometry, geometryBbox } from './bbox';
export { geometryInRange, inLonLatRange, likelySwapped } from './range';
export { pointFromLatLon, positionsOf } from './positions';
export {
  CRS_REGISTRY_SOURCE,
  CRS_REGISTRY_VERSION,
  crsDefinition,
  crsTransformer,
  supportedCrs,
  type CrsDefinition,
  type CrsOperation,
  type CrsTransformer,
} from './crs/transform';
export { esriWkt } from './crs/wkt';
