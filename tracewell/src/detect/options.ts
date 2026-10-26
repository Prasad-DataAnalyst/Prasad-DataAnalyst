/** Settings detection needs from the file's dialect, found earlier by the format reader. */
export interface DetectOptions {
  decimalSeparator: '.' | ',';
  thousandsSeparator: '' | ',' | '.' | ' ';
  /** True for GeoJSON: rows carry a geometry, planned as one extra column after the properties. */
  geometryColumn?: boolean;
}

/** Type inference and role detection look at no more rows than this (SAD section 7.2). */
export const SAMPLE_LIMIT = 10_000;
