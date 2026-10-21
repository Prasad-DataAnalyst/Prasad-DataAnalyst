/**
 * Per-quantity knowledge: which quantities convert into each other, the physical bounds that rule
 * TW-DQ-005 checks, and the default target units of the SI and Oilfield unit systems.
 */
import type { QuantityKind, UnitDef } from '@tw/model';
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

const AMOUNT: PhysicalBounds = { min: 0, source: 'An amount of material or energy cannot be negative.' };

const FLOW: PhysicalBounds = {
  min: 0,
  source:
    'A produced, delivered or injected amount per unit of time cannot be negative; ' +
    'flow in the opposite direction is reported in its own column.',
};

const QUANTITIES: Readonly<Record<QuantityKind, QuantitySpec>> = {
  length: { label: 'length', family: 'length', bounds: null, defaults: { SI: 'm', Oilfield: 'ft' } },
  area: {
    label: 'area',
    family: 'area',
    bounds: { min: 0, source: 'An area cannot be negative.' },
    defaults: { SI: 'm2', Oilfield: 'acre' },
  },
  volume: { label: 'volume', family: 'volume', bounds: AMOUNT, defaults: { SI: 'm3', Oilfield: 'bbl' } },
  std_volume: {
    label: 'standard volume',
    family: 'std_volume',
    bounds: AMOUNT,
    defaults: { SI: 'Sm3', Oilfield: 'Mscf' },
  },
  mass: { label: 'mass', family: 'mass', bounds: AMOUNT, defaults: { SI: 'kg', Oilfield: 'lb' } },
  time: { label: 'time', family: 'time', bounds: null, defaults: { SI: null, Oilfield: null } },
  temperature: {
    label: 'temperature',
    family: 'temperature',
    bounds: {
      min: 0,
      source: 'No temperature is below absolute zero, 0 K (SI Brochure, 9th edition (2019), section 2.3.1).',
    },
    defaults: { SI: 'degC', Oilfield: 'degF' },
  },
  temperature_diff: {
    label: 'temperature difference',
    family: 'temperature_diff',
    bounds: null,
    defaults: { SI: 'delta_degC', Oilfield: 'delta_degF' },
  },
  pressure_abs: {
    label: 'absolute pressure',
    family: 'pressure_abs',
    bounds: { min: 0, source: 'Absolute pressure is measured from a perfect vacuum, so it cannot be negative.' },
    defaults: { SI: 'kPa', Oilfield: 'psia' },
  },
  pressure_gauge: {
    label: 'gauge pressure',
    family: 'pressure_gauge',
    bounds: null,
    defaults: { SI: 'kPag', Oilfield: 'psig' },
  },
  pressure_diff: {
    label: 'pressure difference',
    family: 'pressure_diff',
    bounds: null,
    defaults: { SI: 'delta_kPa', Oilfield: 'delta_psi' },
  },
  energy: { label: 'energy', family: 'energy', bounds: AMOUNT, defaults: { SI: 'GJ', Oilfield: 'MMBtu' } },
  power: { label: 'power', family: 'power', bounds: null, defaults: { SI: 'kW', Oilfield: 'hp' } },
  density: {
    label: 'density',
    family: 'density',
    bounds: { min: 0, source: 'Density, a mass per volume, cannot be negative.' },
    defaults: { SI: 'kg/m3', Oilfield: 'lb/ft3' },
  },
  mass_rate: { label: 'mass flow rate', family: 'mass_rate', bounds: FLOW, defaults: { SI: 'kg/s', Oilfield: 'lb/h' } },
  volume_rate: {
    label: 'volume flow rate',
    family: 'volume_rate',
    bounds: FLOW,
    defaults: { SI: 'm3/d', Oilfield: 'bbl/d' },
  },
  std_volume_rate: {
    label: 'standard volume flow rate',
    family: 'std_volume_rate',
    bounds: FLOW,
    defaults: { SI: 'Sm3/d', Oilfield: 'Mscf/d' },
  },
  energy_rate: {
    label: 'energy flow rate',
    family: 'power',
    bounds: FLOW,
    defaults: { SI: 'GJ/d', Oilfield: 'MMBtu/d' },
  },
  fraction: {
    label: 'fraction',
    family: 'fraction',
    bounds: { min: 0, max: 1, source: 'A fraction lies between 0 and 1 (0 % and 100 %).' },
    defaults: { SI: null, Oilfield: null },
  },
  velocity: { label: 'velocity', family: 'velocity', bounds: null, defaults: { SI: 'm/s', Oilfield: 'ft/s' } },
  dimensionless: {
    label: 'dimensionless number',
    family: 'dimensionless',
    bounds: null,
    defaults: { SI: null, Oilfield: null },
  },
};

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
