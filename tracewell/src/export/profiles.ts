/** Export profiles are named by destination, not format (SAD section 10.1). */
import type { ColumnSchema, ExportProfile } from '@tw/model';

export const EXPORT_PROFILES: readonly ExportProfile[] = Object.freeze([
  {
    id: 'excel',
    label: 'Microsoft Excel',
    destinations: ['Microsoft Excel', 'LibreOffice Calc', 'Google Sheets'],
    dataExtension: '.xlsx',
    description:
      'A workbook with a Data sheet (numbers stored as numbers, real dates, one header row, frozen header, filters), ' +
      'a Report sheet describing the sources, rules and steps, and a Log sheet with the audit log.',
  },
  {
    id: 'csv',
    label: 'Databases, Python, R, BI tools (CSV)',
    destinations: ['Power BI', 'Tableau', 'Python (pandas)', 'R', 'SQL databases'],
    dataExtension: '.csv',
    description:
      'UTF-8 CSV without a byte-order mark: comma-separated, ISO dates, "." as decimal separator, header "Name [unit]".',
  },
  {
    id: 'geojson',
    label: 'QGIS / ArcGIS / web maps (GeoJSON)',
    destinations: ['QGIS', 'ArcGIS', 'Google Earth', 'Web maps'],
    dataExtension: '.geojson',
    description:
      'An RFC 7946 GeoJSON FeatureCollection in WGS84 longitude/latitude, built from the geometry column or the latitude and longitude columns.',
  },
]);

/** 'Pressure [kPa]', or just the name when the column has no unit. */
export function headerFor(col: Pick<ColumnSchema, 'name' | 'unit'>): string {
  const unit = col.unit.value;
  return unit === null ? col.name : `${col.name} [${unit}]`;
}

/** The inverse of headerFor: only a trailing ' [unit]' is read as the unit. */
export function parseHeader(h: string): { name: string; unit: string | null } {
  const m = /^(.*) \[([^[\]]+)\]$/s.exec(h);
  return m === null ? { name: h, unit: null } : { name: m[1] as string, unit: m[2] as string };
}
