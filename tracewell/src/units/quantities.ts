/**
 * Per-quantity knowledge: which quantities convert into each other, the physical bounds that rule
 * TW-DQ-005 checks, and the default target units of the SI and Oilfield unit systems. The table is
 * one JSON file, quantities-2026.1.json, so both engines check the same bounds.
 */
import { EngineError, type QuantityKind, type UnitDef } from '@tw/model';
import quantitiesText from './quantities-2026.1.json?raw';
import { getUnit } from './registry';

export type UnitSystem = 'SI' | 'Oilfield';

export interface PhysicalBounds {
  min?: number;
  max?: number;
  /** Why the bound holds, shown with the issue. */
  source: string;
}

interface QuantitySpec {
  /** Plain-language name used in messages, e.g. 'absolute pressure'. */
  label: string;
  /**
   * Quantities of one family have the same dimension and convert into each other. Power and energy
   * rate are both joules per second, so a kW column can be shown in MMBtu/d; every other quantity
   * is its own family.
   */
  family: QuantityKind;
  /** Bounds in SI units; null when every finite value is physically possible. */
  bounds: PhysicalBounds | null;
  /** Default target unit per unit system; null when the quantity does not depend on the system. */
  defaults: Record<UnitSystem, string | null>;
}

const QUANTITY_KINDS: readonly QuantityKind[] = [
  'length',
  'area',
  'volume',
  'std_volume',
  'mass',
  'time',
  'temperature',
  'temperature_diff',
  'pressure_abs',
  'pressure_gauge',
  'pressure_diff',
  'energy',
  'power',
  'density',
  'mass_rate',
  'volume_rate',
  'std_volume_rate',
  'energy_rate',
  'fraction',
  'velocity',
  'dimensionless',
];

function broken(message: string): EngineError {
  return new EngineError(
    'INTERNAL',
    `The quantity table is invalid: ${message}`,
    'The quantity table shipped with Tracewell is damaged; reinstall Tracewell or restore the file.',
  );
}

function isUnitOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function checkedBounds(q: string, b: unknown): PhysicalBounds | null {
  if (b === null) return null;
  const o = b as Record<string, unknown>;
  const ok =
    typeof o === 'object' &&
    typeof o['source'] === 'string' &&
    (o['min'] === undefined || typeof o['min'] === 'number') &&
    (o['max'] === undefined || typeof o['max'] === 'number');
  if (!ok) throw broken(`the bounds of ${q} are not a source with an optional min and max.`);
  return Object.freeze({ ...(o as unknown as PhysicalBounds) });
}

/**
 * Parses and checks the quantity table: every quantity kind once, with a label, a family that is
 * itself a quantity kind, bounds and both default units. The native engine reads the same file.
 */
export function loadQuantities(text: string): Readonly<Record<QuantityKind, QuantitySpec>> {
  const json = JSON.parse(text) as { quantities?: Record<string, Record<string, unknown>> };
  const table = json.quantities ?? {};
  const keys = Object.keys(table);
  if (keys.length !== QUANTITY_KINDS.length || !QUANTITY_KINDS.every((k) => Object.hasOwn(table, k))) {
    throw broken(`it must list exactly these quantities: ${QUANTITY_KINDS.join(', ')}.`);
  }
  const out = {} as Record<QuantityKind, QuantitySpec>;
  for (const q of QUANTITY_KINDS) {
    const spec = table[q] as Record<string, unknown>;
    const defaults = spec['defaults'] as Record<string, unknown> | undefined;
    if (
      typeof spec['label'] !== 'string' ||
      !QUANTITY_KINDS.includes(spec['family'] as QuantityKind) ||
      defaults === undefined ||
      !isUnitOrNull(defaults['SI']) ||
      !isUnitOrNull(defaults['Oilfield'])
    ) {
      throw broken(`the entry for ${q} needs a label, a family and SI and Oilfield defaults.`);
    }
    out[q] = Object.freeze({
      label: spec['label'],
      family: spec['family'] as QuantityKind,
      bounds: checkedBounds(q, spec['bounds']),
      defaults: Object.freeze({ SI: defaults['SI'], Oilfield: defaults['Oilfield'] }),
    });
  }
  return Object.freeze(out);
}

const QUANTITIES = loadQuantities(quantitiesText);

/**
 * The spec of `q`, or undefined when `q` is not a quantity kind. Quantity kinds and unit systems
 * also arrive from persisted documents, so a stray string such as 'toString' must not reach an
 * inherited property of the table.
 */
function specOf(q: QuantityKind): QuantitySpec | undefined {
  return Object.hasOwn(QUANTITIES, q) ? QUANTITIES[q] : undefined;
}

export function quantityLabel(q: QuantityKind): string {
  return QUANTITIES[q].label;
}

/** True when values of the two quantities can be converted into each other (same dimension). */
export function sameFamily(a: QuantityKind, b: QuantityKind): boolean {
  return QUANTITIES[a].family === QUANTITIES[b].family;
}

/**
 * A bound expressed in a unit, rounded to 15 significant digits so that, for example, absolute
 * zero reads -459.67 °F rather than -459.66999999999996. The rounding moves a bound by less than
 * 1e-15 relative, far below any measurement resolution.
 */
function boundIn(unit: UnitDef, si: number): number {
  return Number(((si - unit.toSI.offset) / unit.toSI.factor).toPrecision(15));
}

/**
 * The physical bounds of quantity `q` expressed in `unit` (a registry code), for rule TW-DQ-005.
 * Null when the quantity has no bounds or is unknown, the unit is unknown, or the unit measures
 * another quantity.
 */
export function physicalBounds(q: QuantityKind, unit: string): PhysicalBounds | null {
  const bounds = specOf(q)?.bounds;
  const u = getUnit(unit);
  if (bounds == null || u === undefined || !sameFamily(u.quantity, q)) return null;
  const result: PhysicalBounds = { source: bounds.source };
  if (bounds.min !== undefined) result.min = boundIn(u, bounds.min);
  if (bounds.max !== undefined) result.max = boundIn(u, bounds.max);
  return result;
}

/**
 * The unit a quantity is converted to by default in a project's unit system, or null when the
 * quantity does not depend on the system (time, fractions), has no unit, or the quantity or system
 * is unknown.
 */
export function defaultTargetUnit(q: QuantityKind, system: UnitSystem): string | null {
  const defaults = specOf(q)?.defaults;
  return defaults !== undefined && Object.hasOwn(defaults, system) ? defaults[system] : null;
}
