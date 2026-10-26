/** Column selection for a rule: every filter given must match ('all' matches every column). */
import type { ColumnSchema, ColumnSelector, TableSchema } from '@tw/model';

export function selectColumns(sel: ColumnSelector, schema: TableSchema): ColumnSchema[] {
  if ('dataset' in sel) return [];
  return schema.columns.filter((c) => {
    if (sel.roles !== undefined && !sel.roles.includes(c.role.value)) return false;
    if (sel.types !== undefined && !sel.types.includes(c.type.value)) return false;
    if (sel.quantities !== undefined && (c.quantity === null || !sel.quantities.includes(c.quantity))) return false;
    return sel.all === true || sel.roles !== undefined || sel.types !== undefined || sel.quantities !== undefined;
  });
}
