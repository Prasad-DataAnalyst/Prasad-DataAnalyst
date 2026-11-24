/** Where the GeoJSON and KML profiles take each row's place from. */
import type { View } from '@tw/table';

/** The geometry column when the view shows it, else the latitude and longitude columns, else none. */
export function geometrySource(view: View): 'column' | 'latlon' | null {
  if (view.schema.geometryColumn !== null && view.columnIds().includes(view.schema.geometryColumn)) return 'column';
  const roles = view.schema.columns.map((c) => c.role.value);
  return roles.includes('latitude') && roles.includes('longitude') ? 'latlon' : null;
}
