/**
 * Cell lineage (SAD section 9.3): where a value came from. The source locator and the original
 * text, how the text was parsed, then every audit entry that changed the cell, in order, with the
 * conversion method of each unit conversion.
 */
import { importerFor } from '@tw/ingest';
import {
  EngineError,
  rawToText,
  type AuditEntry,
  type CellLineage,
  type ColumnId,
  type ColumnSchema,
  type OverridableProperty,
  type RowId,
} from '@tw/model';
import { locator } from '@tw/table';
import { changesRows, originalSource } from './reducer';
import type { DatasetState, ProjectState } from './state';
import { workingView } from './views';
import { requireVisibleColumn, rootColumn } from './windows';

function actorName(e: AuditEntry): string {
  return e.actor.kind === 'user' ? e.actor.name : `system (${e.actor.component})`;
}

function parseMethod(c: ColumnSchema): string {
  switch (c.type.value) {
    case 'number':
    case 'integer':
      return `${c.type.value}, decimal separator '${c.decimalSeparator?.value ?? '.'}'`;
    case 'date':
      return `date, ${c.dateFormat?.value ?? 'iso'} format`;
    case 'datetime':
      return `datetime, ${c.timezone?.value ?? 'naive-assumed-utc'}`;
    case 'boolean':
      return 'boolean, true/false';
    case 'geometry':
      return 'GeoJSON geometry';
    case 'string':
      return 'text as written';
  }
}

/** The original text of one field, read again from the original file (values are stored parsed). */
async function sourceText(
  state: ProjectState,
  ds: DatasetState,
  rowId: RowId,
  plan: ColumnSchema,
): Promise<string | null> {
  const kept = ds.dataset.column(plan.id).raw(rowId);
  if (kept !== undefined) return kept;
  const srcLoc = ds.dataset.srcLoc(rowId);
  const ctx = { signal: new AbortController().signal, onBytes: () => undefined, note: () => undefined };
  for await (const batch of importerFor(ds.spec.options.format).read(originalSource(state, ds), ds.spec.options, ctx)) {
    const row = batch.rows.find((r) => r.srcLoc === srcLoc);
    if (row === undefined) continue;
    if (plan.id === ds.dataset.schema.geometryColumn && row.geometry !== undefined) {
      return row.geometry === null ? null : JSON.stringify(row.geometry);
    }
    const field = row.fields[plan.sourceIndex];
    return field === undefined ? null : rawToText(field);
  }
  return null;
}

/** The conversion steps a column's values went through, from its source column onwards. */
function conversionSteps(ds: DatasetState, columnId: ColumnId): Set<string> {
  const view = workingView(ds);
  const steps = new Set<string>();
  for (let schema = view.columnSchema(columnId); schema.derivedFrom !== undefined;) {
    steps.add(schema.derivedFrom.step);
    schema = view.columnSchema(schema.derivedFrom.column);
  }
  return steps;
}

function touches(e: AuditEntry, ds: DatasetState, rowId: RowId, root: ColumnId, steps: Set<string>): boolean {
  const t = e.target;
  if (t.datasetId !== ds.id) return false;
  switch (e.action) {
    case 'source.add':
      return true;
    case 'cell.edit':
      return t.rowId === rowId && t.columnId === root;
    case 'detection.override': {
      const { property } = e.payload as { property: OverridableProperty };
      return t.columnId === root || changesRows(property) || property === 'crs';
    }
    case 'step.apply':
    case 'step.remove':
      return t.stepId !== undefined && steps.has(t.stepId);
    case 'rows.exclude': {
      const rows = (e.payload as { rows?: unknown } | undefined)?.rows;
      return Array.isArray(rows) && rows.includes(rowId);
    }
    default:
      return false;
  }
}

export async function explainCell(
  state: ProjectState,
  ds: DatasetState,
  rowId: RowId,
  columnId: ColumnId,
): Promise<CellLineage> {
  if (!Number.isSafeInteger(rowId) || rowId < 0 || rowId >= ds.dataset.rowCount) {
    throw new EngineError(
      'NOT_FOUND',
      `Dataset ${ds.id} has no row ${String(rowId)}.`,
      'Choose a row shown in the data grid.',
    );
  }
  const view = workingView(ds);
  requireVisibleColumn(view, columnId);
  const steps = conversionSteps(ds, columnId);
  const root = rootColumn(view, columnId);
  const plan = ds.dataset.schema.columns.find((c) => c.id === root) as ColumnSchema;
  const data = ds.dataset.column(root);
  const original = state.originals.get(ds.fileId);

  const touched = new Set<number>();
  const history: CellLineage['history'] = [];
  for (const e of state.log.entries()) {
    const isRevert = e.action === 'entry.revert' && e.target.seq !== undefined && touched.has(e.target.seq);
    if (!isRevert && !touches(e, ds, rowId, root, steps)) continue;
    touched.add(e.seq);
    // The import entry is the cell's origin, shown as `source` rather than as a change.
    if (e.action === 'source.add') continue;
    history.push({
      seq: e.seq,
      at: e.at,
      actor: actorName(e),
      action: e.action,
      old: e.old,
      new: e.new,
      reason: e.reason,
      ...(e.method === undefined ? {} : { method: { ...e.method } }),
    });
  }

  return {
    datasetId: ds.id,
    rowId,
    columnId,
    source: {
      fileId: ds.fileId,
      fileName: original?.info.name ?? ds.spec.fileName,
      locator: locator(ds.dataset.schema, ds.dataset.srcLoc(rowId), plan),
      rawText: await sourceText(state, ds, rowId, plan),
    },
    parse: {
      type: plan.type.value,
      method: parseMethod(plan),
      nullMarker: data.nullMarker(rowId) ?? null,
      ok: data.parseOk(rowId),
    },
    history,
    current: view.value(rowId, columnId),
  };
}
