// Public entry point of the geo module, imported elsewhere as '@tw/geo': spatial helpers without
// CRS transformation. GeoJSON geometry validation, bounding boxes, longitude/latitude range checks
// and the swap heuristic, and point construction.

export type { GeometryProblem, GeometryProblemCode } from './types';
export { geometryProblems, isGeometry } from './validate';
export { bboxContains, bboxIntersectsGeometry, geometryBbox } from './bbox';
export { geometryInRange, inLonLatRange, likelySwapped } from './range';
export { pointFromLatLon, positionsOf } from './positions';
