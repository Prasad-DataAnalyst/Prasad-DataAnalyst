/**
 * Unit conversion (SAD section 7.5). Every conversion goes through SI with the registry factors:
 * y = ((x * fromFactor + fromOffset) - toOffset) / toFactor. Conversions whose result depends on
 * something the data does not say (the atmospheric pressure, the measured or reference conditions)
 * are refused with a reason and a fix instead of being guessed.
 */
import {
  canonicalNumber,
  EngineError,
  type ConversionMethod,
  type QuantityKind,
  type UnitConvention,
  type UnitDef,
  type UnitInfo,
} from '@tw/model';
import { quantityLabel, sameFamily } from './quantities';
import { allUnits, getUnit, REGISTRY_VERSION, unitInfo } from './registry';

export type ConvertCheck =
  | { ok: true }
  | {
      ok: false;
      code: 'UNIT_UNKNOWN' | 'UNIT_DIMENSION' | 'UNIT_CONVENTION' | 'UNIT_GAUGE_ABSOLUTE';
      message: string;
      fix: string;
    };

type Refusal = Extract<ConvertCheck, { ok: false }>;
type Pair = { ok: true; from: UnitDef; to: UnitDef };

const CONVENTION_TEXT: Readonly<Record<UnitConvention, string>> = {
  gauge: 'gauge, relative to the local atmospheric pressure',
  'std-60F-14.696psia': '60 °F and 14.696 psia',
  'std-15C-101.325kPa': '15 °C and 101.325 kPa',
  'std-0C-101.325kPa': '0 °C and 101.325 kPa',
};

function refuse(code: Refusal['code'], message: string, fix: string): Refusal {
  return { ok: false, code, message, fix };
}

/** The other units `u` converts to, as a list for a fix text. */
function alternatives(u: UnitDef): string[] {
  return compatibleUnits(u.code)
    .map((info) => info.code)
    .filter((code) => code !== u.code);
}

/** 'Choose a unit <qualifier>: a, b, c', or a note that `u` has no alternatives. */
function chooseFrom(u: UnitDef, qualifier: string): string {
  const others = alternatives(u);
  return others.length === 0
    ? `No other unit ${qualifier} is in the registry, so keep ${u.code}`
    : `Choose a unit ${qualifier}: ${others.join(', ')}`;
}

function unknownUnit(code: string): Refusal {
  return refuse(
    'UNIT_UNKNOWN',
    `"${code}" is not a unit code in the Tracewell unit registry ${REGISTRY_VERSION}.`,
    "Choose a unit from the registry's list, or first set the column's unit to a unit from that list.",
  );
}

function pressureKind(u: UnitDef): 'gauge' | 'absolute' {
  return u.quantity === 'pressure_gauge' ? 'gauge' : 'absolute';
}

const WITH_ARTICLE = { gauge: 'a gauge', absolute: 'an absolute' } as const;

/** True when one unit has quantity x and the other quantity y. */
function isPair(a: UnitDef, b: UnitDef, x: QuantityKind, y: QuantityKind): boolean {
  return (a.quantity === x && b.quantity === y) || (a.quantity === y && b.quantity === x);
}

function gaugeAbsolute(from: UnitDef, to: UnitDef): Refusal {
  const fromKind = pressureKind(from);
  const toKind = pressureKind(to);
  return refuse(
    'UNIT_GAUGE_ABSOLUTE',
    `${from.code} is ${WITH_ARTICLE[fromKind]} pressure and ${to.code} is ${WITH_ARTICLE[toKind]} pressure. ` +
      'Converting between them needs the local atmospheric pressure, which Tracewell does not assume.',
    `${chooseFrom(from, `that is also ${fromKind}`)}. If the values are really ${toKind} readings, change the ` +
      `column's unit to ${to.code} instead of converting.`,
  );
}

function conditionsOf(u: UnitDef): string {
  return u.convention === null ? 'no stated reference conditions' : CONVENTION_TEXT[u.convention];
}

function actualStandard(from: UnitDef, to: UnitDef): Refusal {
  const fromActual = from.convention === null;
  const [actual, standard] = fromActual ? [from, to] : [to, from];
  const really = fromActual ? 'already at standard conditions' : 'really at the measured conditions';
  return refuse(
    'UNIT_CONVENTION',
    `${actual.code} measures volume at the conditions where it was measured and ${standard.code} measures ` +
      `volume at ${conditionsOf(standard)}. Converting needs the measured pressure and temperature, which ` +
      'Tracewell does not assume.',
    `${chooseFrom(from, 'of the same kind')}. If the values are ${really}, change the column's unit to ` +
      `${to.code} instead of converting.`,
  );
}

/** Why two quantities that look alike still differ; empty when nothing needs saying. */
function differenceNote(a: UnitDef, b: UnitDef): string {
  const kinds = new Set([a.quantity, b.quantity]);
  if (kinds.has('temperature') && kinds.has('temperature_diff')) {
    return ' A temperature difference has no zero offset: 10 °C warmer is 10 K warmer, but 10 °C is 283.15 K.';
  }
  // Only against a pressure: next to a length or a temperature the note would explain nothing.
  if (kinds.has('pressure_diff') && (kinds.has('pressure_abs') || kinds.has('pressure_gauge'))) {
    return ' A pressure difference is not measured from vacuum or from the atmosphere, so it is not a pressure.';
  }
  return '';
}

function dimension(from: UnitDef, to: UnitDef): Refusal {
  const fromKind = quantityLabel(from.quantity);
  return refuse(
    'UNIT_DIMENSION',
    `${from.code} measures ${fromKind} and ${to.code} measures ${quantityLabel(to.quantity)}, so one cannot be ` +
      `converted to the other.${differenceNote(from, to)}`,
    `${chooseFrom(from, `of ${fromKind}`)}.`,
  );
}

function convention(from: UnitDef, to: UnitDef): Refusal {
  return refuse(
    'UNIT_CONVENTION',
    `${from.code} is a ${quantityLabel(from.quantity)} at ${conditionsOf(from)} and ${to.code} is at ` +
      `${conditionsOf(to)}. Changing the reference conditions needs a correction for the fluid, which ` +
      'Tracewell does not apply silently.',
    `${chooseFrom(from, `at ${conditionsOf(from)}`)}. Conversions between reference conditions are not ` +
      'supported in this version.',
  );
}

function refusalFor(from: UnitDef, to: UnitDef): Refusal | null {
  if (isPair(from, to, 'pressure_abs', 'pressure_gauge')) return gaugeAbsolute(from, to);
  if (isPair(from, to, 'volume', 'std_volume') || isPair(from, to, 'volume_rate', 'std_volume_rate')) {
    return actualStandard(from, to);
  }
  if (!sameFamily(from.quantity, to.quantity)) return dimension(from, to);
  if (from.convention !== to.convention) return convention(from, to);
  return null;
}

function evaluate(from: string, to: string): Pair | Refusal {
  const a = getUnit(from);
  if (a === undefined) return unknownUnit(from);
  const b = getUnit(to);
  if (b === undefined) return unknownUnit(to);
  return refusalFor(a, b) ?? { ok: true, from: a, to: b };
}

/** Whether `from` converts to `to` (both registry codes), and if not why and how to fix it. */
export function checkConvertible(from: string, to: string): ConvertCheck {
  const result = evaluate(from, to);
  return result.ok ? { ok: true } : result;
}

/** The units `code` converts to, including itself: the same dimension and the same convention. */
export function compatibleUnits(code: string): UnitInfo[] {
  const u = getUnit(code);
  if (u === undefined) return [];
  return allUnits()
    .filter((v) => sameFamily(u.quantity, v.quantity) && v.convention === u.convention)
    .map(unitInfo);
}

/** `expr + value`, written `expr - |value|` for a negative value; expr itself when value is 0. */
function plus(expr: string, value: number): string {
  if (value === 0) return expr;
  return value > 0 ? `${expr} + ${canonicalNumber(value)}` : `${expr} - ${canonicalNumber(-value)}`;
}

/** The formula as applyConversion evaluates it, left to right, e.g. 'y = x * 6894.757293168362 / 1000'. */
function formulaText(fromFactor: number, fromOffset: number, toFactor: number, toOffset: number): string {
  if (fromFactor === toFactor && fromOffset === toOffset) return 'y = x';
  const scaled = fromFactor === 1 ? 'x' : `x * ${canonicalNumber(fromFactor)}`;
  const shifted = plus(plus(scaled, fromOffset), -toOffset);
  if (toFactor === 1) return `y = ${shifted}`;
  const dividend = shifted === scaled ? shifted : `(${shifted})`;
  return `y = ${dividend} / ${canonicalNumber(toFactor)}`;
}

function citation(from: UnitDef, to: UnitDef): string {
  return from.source === to.source ? from.source : `${from.code}: ${from.source} | ${to.code}: ${to.source}`;
}

/**
 * The method that converts `from` to `to`, recorded with the conversion in the audit log.
 * Throws EngineError with the ConvertCheck code, message and fix when the conversion is refused.
 */
export function conversionMethod(from: string, to: string): ConversionMethod {
  const result = evaluate(from, to);
  if (!result.ok) throw new EngineError(result.code, result.message, result.fix, { from, to });
  const { factor: fromFactor, offset: fromOffset } = result.from.toSI;
  const { factor: toFactor, offset: toOffset } = result.to.toSI;
  return {
    from: result.from.code,
    to: result.to.code,
    fromFactor,
    fromOffset,
    toFactor,
    toOffset,
    formula: formulaText(fromFactor, fromOffset, toFactor, toOffset),
    source: citation(result.from, result.to),
    registryVersion: REGISTRY_VERSION,
  };
}

/**
 * y = ((x * fromFactor + fromOffset) - toOffset) / toFactor. Units with identical factor and offset
 * (such as psi and psia) return x unchanged, so a no-op conversion never perturbs a value.
 */
export function applyConversion(m: ConversionMethod, x: number): number {
  if (m.fromFactor === m.toFactor && m.fromOffset === m.toOffset) return x;
  return (x * m.fromFactor + m.fromOffset - m.toOffset) / m.toFactor;
}
