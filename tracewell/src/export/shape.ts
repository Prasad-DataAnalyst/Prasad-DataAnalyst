/** What a data file must contain: the output view's row count and per-column digests. */
import type { ColumnId, ColumnSchema, ExportColumn } from '@tw/model';
import { columnDigest, type View } from '@tw/table';
import { headerFor } from './profiles';
import { exportable } from './values';

export interface ExpectedShape {
  rowCount: number;
  columns: ExportColumn[];
}

export function exportColumn(view: View, col: ColumnSchema): ExportColumn {
  const values = function* () {
    for (const r of view.rows()) yield exportable(view.value(r, col.id));
  };
  return {
    id: col.id,
    name: col.name,
    header: headerFor(col),
    type: col.type.value,
    unit: col.unit.value,
    sha256: columnDigest(values()),
  };
}

export function expectedShape(view: View, columns?: ColumnId[]): ExpectedShape {
  const ids = columns ?? view.columnIds();
  return { rowCount: view.rowCount, columns: ids.map((id) => exportColumn(view, view.columnSchema(id))) };
}
