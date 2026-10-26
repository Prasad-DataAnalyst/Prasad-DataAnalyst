/**
 * Unit lookup for modules that may not depend on the unit registry themselves (ingest applies a
 * user's unit override and needs the canonical code and quantity of the unit chosen).
 */
import type { QuantityKind } from '@tw/model';
import { getUnit } from '@tw/units';

export function unitQuantity(code: string): { code: string; quantity: QuantityKind } | null {
  const unit = getUnit(code);
  return unit === undefined ? null : { code: unit.code, quantity: unit.quantity };
}
