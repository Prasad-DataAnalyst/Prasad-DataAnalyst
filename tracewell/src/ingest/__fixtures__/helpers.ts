/** Shared helpers for the ingest tests. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_DIR } from '@tw/fixtures';
import { parseChecksumsFile } from '@tw/io';
import type { ColumnPlan } from '@tw/model';
import { Overlay, RowSet, View, type Dataset } from '@tw/table';
import type { ImportContext } from '../import';

export const DETECTIONS = [
  'dateFormat',
  'decimalSeparator',
  'nullMarkers',
  'role',
  'timezone',
  'type',
  'unit',
] as const;

export function summary(plan: ColumnPlan) {
  const assumed = DETECTIONS.filter((p) => plan[p]?.assumed === true);
  return {
    name: plan.name,
    type: plan.type.value,
    unit: plan.unit.value,
    role: plan.role.value,
    ...(assumed.length > 0 ? { assumed: [...assumed].sort() } : {}),
  };
}

export function plainView(ds: Dataset): View {
  return new View(ds, {
    overlay: new Overlay(),
    excluded: new RowSet(ds.rowCount),
    derived: [],
    hidden: [],
    rowFilter: null,
    columnOrder: null,
  });
}

export function context(over: Partial<ImportContext> = {}): ImportContext {
  return {
    signal: new AbortController().signal,
    memoryBudgetBytes: 512 * 1024 ** 2,
    onProgress: () => undefined,
    ...over,
  };
}

export function fixtureSums(): Map<string, string> {
  const text = readFileSync(join(FIXTURES_DIR, 'SHA256SUMS'), 'utf8');
  return new Map(parseChecksumsFile(text).map((e) => [e.path.replace(/^.*\//, ''), e.sha256]));
}
