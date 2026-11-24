/**
 * Export planning (SAD section 10.1): which data files a profile produces, the format-limit
 * substitutions it needs (TW-EXP-002), and refusals with a fix (TW-EXP-003). Nothing is dropped
 * silently: every substitution is listed in the README, the manifest and the Report sheet.
 */
import {
  EXCEL_MAX_CELL_CHARS,
  EXCEL_MAX_DATA_ROWS,
  type ColumnId,
  type CrsRef,
  type Detection,
  type ExportProfileId,
  type ExportProfileStatus,
  type Substitution,
} from '@tw/model';
import { esriWkt } from '@tw/geo';
import type { View } from '@tw/table';
import { analyseKml, kmlAttributes } from './kml';
import { EXPORT_PROFILES } from './profiles';
import { SHAPEFILE_MAX_BYTES, analyseShapes, dbfFields, shapeSource, shapefileSizes, unfitColumns } from './shapefile';
import { geometrySource } from './source';
import { textOf } from './values';

export { geometrySource } from './source';

export type DataKind = 'csv' | 'xlsx' | 'parquet' | 'geojson' | 'shapefile' | 'kml';

export interface ExportPlan {
  profile: ExportProfileId;
  available: boolean;
  reason?: string;
  fix?: string;
  substitutions: Substitution[];
  dataFiles: { path: string; kind: DataKind; columns: ColumnId[] }[];
}

const WGS84 = new Set(['OGC:CRS84', 'EPSG:4326']);

function longTextColumns(view: View): ColumnId[] {
  const out: ColumnId[] = [];
  for (const c of view.schema.columns) {
    if (c.type.value !== 'string' && c.type.value !== 'geometry') continue;
    for (const r of view.rows()) {
      if (textOf(view.value(r, c.id)).length > EXCEL_MAX_CELL_CHARS) {
        out.push(c.id);
        break;
      }
    }
  }
  return out;
}

function excelPlan(view: View): ExportPlan {
  const all = view.columnIds();
  if (view.rowCount > EXCEL_MAX_DATA_ROWS) {
    return {
      profile: 'excel',
      available: true,
      substitutions: [
        {
          ruleId: 'TW-EXP-002',
          what: `${view.rowCount} data rows`,
          why: `An Excel sheet holds at most ${EXCEL_MAX_DATA_ROWS} data rows below its header.`,
          instead:
            'The data is delivered as data.csv in the package; the workbook keeps the Report and Log sheets and a notice.',
        },
      ],
      dataFiles: [
        { path: 'data.csv', kind: 'csv', columns: all },
        { path: 'data.xlsx', kind: 'xlsx', columns: [] },
      ],
    };
  }
  const long = longTextColumns(view);
  if (long.length > 0) {
    const names = long.map((id) => view.columnSchema(id).name);
    return {
      profile: 'excel',
      available: true,
      substitutions: [
        {
          ruleId: 'TW-EXP-002',
          what: `the column${long.length > 1 ? 's' : ''} ${names.join(', ')}`,
          why: `Some values are longer than the ${EXCEL_MAX_CELL_CHARS} characters an Excel cell can hold.`,
          instead: 'These columns are delivered in data-long-text.csv in the package, row for row with the Data sheet.',
        },
      ],
      dataFiles: [
        { path: 'data.xlsx', kind: 'xlsx', columns: all.filter((c) => !long.includes(c)) },
        { path: 'data-long-text.csv', kind: 'csv', columns: long },
      ],
    };
  }
  return {
    profile: 'excel',
    available: true,
    substitutions: [],
    dataFiles: [{ path: 'data.xlsx', kind: 'xlsx', columns: all }],
  };
}

function geojsonPlan(view: View, crs: Detection<CrsRef> | null): ExportPlan {
  const base = { profile: 'geojson' as const, substitutions: [], dataFiles: [] };
  const source = geometrySource(view);
  if (source === null) {
    return {
      ...base,
      available: false,
      reason: 'The dataset has no geometry column and no latitude and longitude columns.',
      fix: 'Set the latitude and longitude roles on the coordinate columns, or export as CSV or Excel.',
    };
  }
  if (crs === null || !WGS84.has(crs.value.code)) {
    const code = crs?.value.code ?? 'an undeclared coordinate system';
    return {
      ...base,
      available: false,
      reason: `GeoJSON requires WGS84 coordinates (TW-EXP-003); this dataset is in ${code}.`,
      fix: 'Transform the coordinates to EPSG:4326 first (Data › Transform coordinates), or export as CSV or Excel.',
    };
  }
  return {
    ...base,
    available: true,
    dataFiles: [{ path: 'data.geojson', kind: 'geojson', columns: view.columnIds() }],
  };
}

/** The CRS code of the data, or null when it is not known. */
export function knownCrs(crs: Detection<CrsRef> | null): string | null {
  const code = crs?.value.code;
  return code === undefined || code === 'unknown' ? null : code;
}

function shapefilePlan(view: View, crs: Detection<CrsRef> | null): ExportPlan {
  const base = { profile: 'shapefile' as const, substitutions: [], dataFiles: [] };
  const refused = (reason: string, fix: string): ExportPlan => ({ ...base, available: false, reason, fix });
  const code = knownCrs(crs);
  const source = shapeSource(view, code);
  if (source === null) {
    return refused(
      'The dataset has no geometry column and no coordinate columns (longitude and latitude, or easting and northing).',
      'Set the coordinate roles on the coordinate columns, or export as CSV or Excel.',
    );
  }
  if (code === null) {
    return refused(
      'The coordinate reference system of the data is not known, and a Shapefile records it in its .prj file.',
      'Set the coordinate reference system of the dataset first.',
    );
  }
  if (esriWkt(code) === null) {
    return refused(
      `A Shapefile records its coordinate reference system in its .prj file, and ${code} is not one this edition can describe.`,
      'Transform the coordinates to a listed coordinate reference system first (Data › Transform coordinates).',
    );
  }
  const shapes = analyseShapes(view, source);
  if (shapes.problem !== null) {
    return refused(
      shapes.problem,
      'Filter the rows to one kind of geometry, or export as GeoJSON, which holds any mix.',
    );
  }
  const attributes = view
    .columnIds()
    .filter((id) => !('geometry' in source && id === source.geometry))
    .map((id) => view.columnSchema(id));
  const unfit = unfitColumns(view, attributes);
  const fields = dbfFields(
    view,
    attributes.filter((c) => !unfit.includes(c.id)),
  );
  const sizes = shapefileSizes(view, source, shapes, fields);
  const largest = Math.max(sizes.dbf, sizes.shp);
  if (largest > SHAPEFILE_MAX_BYTES) {
    return refused(
      `The Shapefile would hold a file of ${largest} bytes, more than the 2 GB its format can address.`,
      'Filter the rows, or export as GeoJSON or Parquet.',
    );
  }
  const substitutions: Substitution[] = [];
  if (unfit.length > 0) {
    const names = unfit.map((id) => view.columnSchema(id).name);
    substitutions.push({
      ruleId: 'TW-EXP-002',
      what: `the column${unfit.length > 1 ? 's' : ''} ${names.join(', ')}`,
      why: 'Some values do not fit a .dbf field exactly: text longer than 254 bytes or starting or ending with spaces, which readers remove, or numbers too long for the field.',
      instead: 'These columns are delivered in data-long-text.csv in the package, row for row with the Shapefile.',
    });
  }
  if (shapes.bad > 0) {
    substitutions.push({
      ruleId: 'TW-EXP-002',
      what: `${shapes.bad} geometr${shapes.bad > 1 ? 'ies' : 'y'}`,
      why: 'They do not have the shape of a geometry: a misplaced array or an unknown type.',
      instead: 'Their rows have no shape in the Shapefile; their other values are kept.',
    });
  }
  return {
    ...base,
    available: true,
    substitutions,
    dataFiles: [
      { path: 'data.shp', kind: 'shapefile', columns: fields.map((f) => f.column.id) },
      ...(unfit.length > 0 ? [{ path: 'data-long-text.csv', kind: 'csv' as const, columns: unfit }] : []),
    ],
  };
}

function kmlPlan(view: View, crs: Detection<CrsRef> | null): ExportPlan {
  const base = { profile: 'kml' as const, substitutions: [], dataFiles: [] };
  const source = geometrySource(view);
  if (source === null) {
    return {
      ...base,
      available: false,
      reason: 'The dataset has no geometry column and no latitude and longitude columns.',
      fix: 'Set the latitude and longitude roles on the coordinate columns, or export as CSV or Excel.',
    };
  }
  if (crs === null || !WGS84.has(crs.value.code)) {
    return {
      ...base,
      available: false,
      reason: `KML holds WGS 84 longitude and latitude; this dataset is in ${crs?.value.code ?? 'an undeclared coordinate system'}.`,
      fix: 'Transform the coordinates to EPSG:4326 first (Data › Transform coordinates), or export as a Shapefile, which keeps the coordinate reference system of the data.',
    };
  }
  const attributes = kmlAttributes(view, source);
  const a = analyseKml(view, source, attributes);
  const geometries = (n: number) => `${n} geometr${n > 1 ? 'ies' : 'y'}`;
  const substitutions: Substitution[] = [];
  if (a.unfit.length > 0) {
    const names = a.unfit.map((id) => view.columnSchema(id).name);
    substitutions.push({
      ruleId: 'TW-EXP-002',
      what: `the column${a.unfit.length > 1 ? 's' : ''} ${names.join(', ')}`,
      why: 'Some values hold characters XML cannot carry, such as control characters.',
      instead: 'These columns are delivered in data-long-text.csv in the package, row for row with the placemarks.',
    });
  }
  if (a.bad > 0) {
    substitutions.push({
      ruleId: 'TW-EXP-002',
      what: geometries(a.bad),
      why: 'They do not have the shape of a geometry: a misplaced array or an unknown type.',
      instead: 'Their placemarks have no geometry; their other values are kept.',
    });
  }
  if (a.long > 0) {
    substitutions.push({
      ruleId: 'TW-EXP-002',
      what: geometries(a.long),
      why: 'Their positions hold more than three numbers, and a KML position holds longitude, latitude and height.',
      instead: 'Each position keeps its first three numbers; the GeoJSON export keeps them all.',
    });
  }
  return {
    ...base,
    available: true,
    substitutions,
    dataFiles: [
      {
        path: 'data.kml',
        kind: 'kml',
        columns: attributes.filter((c) => !a.unfit.includes(c.id)).map((c) => c.id),
      },
      ...(a.unfit.length > 0 ? [{ path: 'data-long-text.csv', kind: 'csv' as const, columns: a.unfit }] : []),
    ],
  };
}

export function planExport(view: View, profile: ExportProfileId, crs: Detection<CrsRef> | null): ExportPlan {
  switch (profile) {
    case 'excel':
      return excelPlan(view);
    case 'csv':
      return {
        profile,
        available: true,
        substitutions: [],
        dataFiles: [{ path: 'data.csv', kind: 'csv', columns: view.columnIds() }],
      };
    case 'parquet':
      return {
        profile,
        available: true,
        substitutions: [],
        dataFiles: [{ path: 'data.parquet', kind: 'parquet', columns: view.columnIds() }],
      };
    case 'geojson':
      return geojsonPlan(view, crs);
    case 'shapefile':
      return shapefilePlan(view, crs);
    case 'kml':
      return kmlPlan(view, crs);
  }
}

export function profileStatuses(view: View, crs: Detection<CrsRef> | null): ExportProfileStatus[] {
  return EXPORT_PROFILES.map((profile) => {
    const plan = planExport(view, profile.id, crs);
    return {
      profile,
      available: plan.available,
      ...(plan.reason === undefined ? {} : { reason: plan.reason }),
      ...(plan.fix === undefined ? {} : { fix: plan.fix }),
      substitutions: plan.substitutions,
    };
  });
}
