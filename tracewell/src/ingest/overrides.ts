/**
 * Column overrides from the import preview or a later `detection.override` decision. Each changes
 * only how a column is interpreted; the original bytes never change. Values set here are the
 * user's, so they are never shown as assumed.
 */
import { EngineError, type ColumnOverride, type ColumnPlan, type Detection } from '@tw/model';
import { unitQuantity } from '@tw/detect';
import type { ImportSpec } from './spec';

function userValue<T>(value: T): Detection<T> {
  return {
    value,
    confidence: 'high',
    assumed: false,
    source: 'user',
    method: 'user-override',
    evidence: 'Set by the user.',
  };
}

function applyOne(plan: ColumnPlan, o: ColumnOverride): ColumnPlan {
  const next: ColumnPlan = { ...plan };
  if (o.name !== undefined) {
    const name = o.name.trim();
    if (name === '') {
      throw new EngineError('INVALID_INPUT', `The new name for column ${plan.id} is empty.`, 'Type a column name.', {
        columnId: plan.id,
      });
    }
    next.name = name;
  }
  if (o.type !== undefined) next.type = userValue(o.type);
  if (o.unit !== undefined) {
    if (o.unit === null) {
      next.unit = userValue(null);
      next.quantity = null;
    } else {
      const unit = unitQuantity(o.unit);
      if (unit === null) {
        throw new EngineError(
          'UNIT_UNKNOWN',
          `The unit "${o.unit}" is not in the unit registry.`,
          'Choose a unit from the list, or leave the column without a unit.',
          { unit: o.unit },
        );
      }
      next.unit = userValue(unit.code);
      next.quantity = unit.quantity;
    }
  }
  if (o.role !== undefined) next.role = userValue(o.role);
  if (o.nullMarkers !== undefined) next.nullMarkers = userValue([...o.nullMarkers]);
  if (o.dateFormat !== undefined) next.dateFormat = userValue(o.dateFormat);
  if (o.timezone !== undefined) next.timezone = userValue(o.timezone);
  return next;
}

export function applyOverrides(
  spec: Omit<ImportSpec, 'fileId'>,
  overrides: ColumnOverride[],
): Omit<ImportSpec, 'fileId'> {
  const known = new Set(spec.columns.map((c) => c.id));
  for (const o of overrides) {
    if (!known.has(o.columnId)) {
      throw new EngineError(
        'NOT_FOUND',
        `There is no column ${o.columnId} in this import.`,
        'Refresh the preview and choose a listed column.',
        { columnId: o.columnId },
      );
    }
  }
  const columns = spec.columns.map((plan) =>
    overrides.filter((o) => o.columnId === plan.id).reduce((p, o) => applyOne(p, o), plan),
  );
  return { ...spec, columns };
}
