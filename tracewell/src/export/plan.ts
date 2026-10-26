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
import type { View } from '@tw/table';
import { EXPORT_PROFILES } from './profiles';
import { textOf } from './values';

export interface ExportPlan {
  profile: ExportProfileId;
  available: boolean;
  reason?: string;
  fix?: string;
  substitutions: Substitution[];
  dataFiles: { path: string; kind: 'csv' | 'xlsx' | 'geojson'; columns: ColumnId[] }[];
}

const WGS84 = new Set(['OGC:CRS84', 'EPSG:4326']);

export function geometrySource(view: View): 'column' | 'latlon' | null {
  if (view.schema.geometryColumn !== null && view.columnIds().includes(view.schema.geometryColumn)) return 'column';
  const roles = view.schema.columns.map((c) => c.role.value);
  return roles.includes('latitude') && roles.includes('longitude') ? 'latlon' : null;
}

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
      fix: 'Coordinate transformation is not available in this edition. Export as CSV or Excel instead, or transform the data to WGS84 before importing it.',
    };
  }
  return {
    ...base,
    available: true,
    dataFiles: [{ path: 'data.geojson', kind: 'geojson', columns: view.columnIds() }],
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
    case 'geojson':
      return geojsonPlan(view, crs);
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
