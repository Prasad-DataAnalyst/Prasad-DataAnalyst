// Public entry point of the detect module, imported elsewhere as '@tw/detect': column planning
// from header cells and sample rows (types, null markers, units, roles, date formats, timezones),
// per-column value parsers, and the assumption list for the audit log. Everything else in this
// folder is internal.

export type { DetectOptions } from './options';
export { DEFAULT_NULL_MARKERS, detectNullMarkers, isBelowDetectionLimit } from './markers';
export { detectColumns } from './columns';
export { flattenHeader } from './names';
export { inferType } from './types';
export { detectLatLonCrs, detectRole } from './roles';
export type { ParseResult } from './parser';
export { makeParser } from './parser';
export { parseNumber } from './numbers';
export { parseDate, parseDateTime } from './dates';
export { collectAssumptions } from './assumptions';
export { unitQuantity } from './unit-lookup';
