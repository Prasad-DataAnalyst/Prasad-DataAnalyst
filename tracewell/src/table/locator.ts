/**
 * Human-readable source locators (SAD sections 7.1 and 9.3): 'line 1042, field 3' for delimited
 * text, 'Sheet1!C17' for workbooks and 'feature 12, property "rate"' for GeoJSON.
 */
import type { ColumnSchema, TableSchema } from '@tw/model';

/** 0 -> 'A', 25 -> 'Z', 26 -> 'AA', 51 -> 'AZ' (bijective base 26, as spreadsheets number columns). */
export function columnLetters(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Sheet names other than plain words are quoted, with apostrophes doubled, as in a spreadsheet formula. */
function sheetRef(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/**
 * The locator of a row, or of one cell when `column` is given. For workbooks the column's
 * `sourceIndex` is read as its 0-based sheet column, and `srcLoc` is the 1-based sheet row.
 */
export function locator(schema: TableSchema, srcLoc: number, column?: ColumnSchema): string {
  switch (schema.source.format) {
    case 'csv':
    case 'tsv':
      return column === undefined ? `line ${srcLoc}` : `line ${srcLoc}, field ${column.sourceIndex + 1}`;
    case 'xlsx': {
      const sheet = sheetRef(schema.source.sheet ?? 'Sheet1');
      return column === undefined ? `${sheet} row ${srcLoc}` : `${sheet}!${columnLetters(column.sourceIndex)}${srcLoc}`;
    }
    case 'geojson':
      return column === undefined ? `feature ${srcLoc}` : `feature ${srcLoc}, ${geoJsonMember(schema, column)}`;
  }
}

function geoJsonMember(schema: TableSchema, column: ColumnSchema): string {
  if (column.id === schema.geometryColumn) return 'geometry';
  const property = column.sourceHeader[0] ?? column.name;
  return `property ${JSON.stringify(property)}`;
}
