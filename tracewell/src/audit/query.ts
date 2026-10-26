/** Filtering and paging of audit entries for the Audit panel and the engine API. */
import { EngineError, type AuditEntry, type AuditQuery, type Page } from '@tw/model';

export const AUDIT_PAGE_DEFAULT = 100;
export const AUDIT_PAGE_MAX = 1000;

export function queryEntries(entries: readonly AuditEntry[], q: AuditQuery): Page<AuditEntry> {
  const offset = checkedCount('offset', q.offset ?? 0, Number.MAX_SAFE_INTEGER);
  const limit = checkedCount('limit', q.limit ?? AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX);
  const matched = entries.filter((e) => matches(e, q));
  if (q.order === 'desc') matched.reverse();
  return { items: matched.slice(offset, offset + limit), total: matched.length, offset };
}

// An absent or empty action list means "any action": the panel sends [] when no chip is selected.
function matches(e: AuditEntry, q: AuditQuery): boolean {
  if (q.action !== undefined && q.action.length > 0 && !q.action.includes(e.action)) return false;
  if (q.datasetId !== undefined && e.target.datasetId !== q.datasetId) return false;
  if (q.rowId !== undefined && e.target.rowId !== q.rowId) return false;
  if (q.columnId !== undefined && e.target.columnId !== q.columnId) return false;
  if (q.fromSeq !== undefined && e.seq < q.fromSeq) return false;
  return true;
}

function checkedCount(name: string, value: number, max: number): number {
  if (Number.isSafeInteger(value) && value >= 0 && value <= max) return value;
  throw new EngineError(
    'INVALID_INPUT',
    `The audit query ${name} must be a whole number from 0 to ${max}; got ${value}.`,
    `Pass a ${name} between 0 and ${max}.`,
    { [name]: Number.isFinite(value) ? value : String(value), max },
  );
}
