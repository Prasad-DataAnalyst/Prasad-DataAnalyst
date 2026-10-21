/**
 * What a header's words say about the reference of a pressure or temperature unit. A unit alone
 * cannot say everything: 'Gauge pressure (kPa)' puts an absolute unit in a header that says gauge,
 * and 'Delta T (°C)' puts a temperature in a header that says difference. Converting such a column
 * as the unit alone suggests would be silently wrong (the atmosphere ignored, or an offset added to
 * a difference), so the detection drops below high confidence and names the unit to set instead.
 */
import type { QuantityKind, UnitDef } from '@tw/model';
import { lookupKey } from './names';
import { quantityLabel } from './quantities';
import { allUnits } from './registry';

export interface ReferenceNote {
  /** True when the header leaves the reference in doubt, so the detection must not be high. */
  doubt: boolean;
  /** Text for the end of the evidence, starting with a space; empty when nothing needs saying. */
  note: string;
}

const NOTHING: ReferenceNote = { doubt: false, note: '' };

/** 'DP' is a differential pressure here; next to a temperature it is usually the dew point. */
const PRESSURE_WORDS: ReadonlyMap<string, QuantityKind> = new Map([
  ['absolute', 'pressure_abs'],
  ['abs', 'pressure_abs'],
  ['gauge', 'pressure_gauge'],
  ['gage', 'pressure_gauge'],
  ['differential', 'pressure_diff'],
  ['difference', 'pressure_diff'],
  ['diff', 'pressure_diff'],
  ['delta', 'pressure_diff'],
  ['δ', 'pressure_diff'],
  ['dp', 'pressure_diff'],
  ['δp', 'pressure_diff'],
]);

const TEMPERATURE_WORDS: ReadonlyMap<string, QuantityKind> = new Map([
  ['differential', 'temperature_diff'],
  ['difference', 'temperature_diff'],
  ['diff', 'temperature_diff'],
  ['delta', 'temperature_diff'],
  ['δ', 'temperature_diff'],
  ['dt', 'temperature_diff'],
  ['δt', 'temperature_diff'],
]);

const WORDS_FOR: Partial<Record<QuantityKind, ReadonlyMap<string, QuantityKind>>> = {
  pressure_abs: PRESSURE_WORDS,
  pressure_gauge: PRESSURE_WORDS,
  pressure_diff: PRESSURE_WORDS,
  temperature: TEMPERATURE_WORDS,
  temperature_diff: TEMPERATURE_WORDS,
};

/** '(g)' or '[g]' written apart from the unit, as in 'Pressure (kPa) (g)'. */
const GAUGE_MARK = /[([{（［｛]\s*g\s*[)\]}）］｝]/iu;

/** The quantities the header's words point to, each with the first word that says so, in header order. */
function statedQuantities(header: string, words: ReadonlyMap<string, QuantityKind>): Map<QuantityKind, string> {
  const stated = new Map<QuantityKind, string>();
  for (const word of header.replace(/∆/gu, 'Δ').split(/[^\p{L}\p{N}]+/u)) {
    const quantity = words.get(word.toLowerCase());
    if (quantity !== undefined && !stated.has(quantity)) stated.set(quantity, word);
  }
  const mark = words === PRESSURE_WORDS ? GAUGE_MARK.exec(header) : null;
  if (mark !== null && !stated.has('pressure_gauge')) stated.set('pressure_gauge', mark[0]);
  return stated;
}

/** 'a', 'a or b', 'a, b or c'. */
function either(codes: readonly string[]): string {
  return codes.length < 2 ? (codes[0] ?? '') : `${codes.slice(0, -1).join(', ')} or ${codes.at(-1) ?? ''}`;
}

/** The unit of `quantity` that matches `unit` best (kPa → kPag, degC → delta_degC), or the choices. */
function suggestion(unit: UnitDef, quantity: QuantityKind): string {
  const candidates = allUnits().filter((u) => u.quantity === quantity);
  const sameScale = candidates.filter((u) => u.toSI.factor === unit.toSI.factor);
  const twin = sameScale.find((u) => u.code.includes(unit.code)) ?? sameScale[0];
  return twin?.code ?? either(candidates.map((u) => u.code));
}

function conflict(unit: UnitDef, quantity: QuantityKind, word: string): ReferenceNote {
  const wanted = quantityLabel(quantity);
  return {
    doubt: true,
    note:
      ` The header also says "${word}", which points to ${wanted}, while ${unit.code} measures ` +
      `${quantityLabel(unit.quantity)}. If the values are ${wanted}, set the unit to ${suggestion(unit, quantity)}.`,
  };
}

/**
 * The gauge unit to suggest when the unit text leaves the pressure reference unstated, else null.
 * psi and bar are customarily written psia/psig and bara/barg, so the bare spelling is a real
 * omission and gauge readings are as common as absolute ones. The registry reads both as absolute.
 * SI pascals are absolute unless stated otherwise, so 'kPa' is not doubted.
 */
function unstatedGauge(raw: string, unit: UnitDef): string | null {
  if (unit.code === 'psi') return 'psig';
  return unit.code === 'bar' && lookupKey(raw) === 'bar' ? 'barg' : null;
}

/** Whether the words of `header` put the reference of `unit` (written `raw`) in doubt, and why. */
export function referenceNote(header: string, raw: string, unit: UnitDef): ReferenceNote {
  const words = WORDS_FOR[unit.quantity];
  const stated = words === undefined ? new Map<QuantityKind, string>() : statedQuantities(header, words);
  const [first] = stated;
  if (first !== undefined && !stated.has(unit.quantity)) return conflict(unit, first[0], first[1]);
  const gauge = unstatedGauge(raw, unit);
  if (gauge === null) return NOTHING;
  const absolute = stated.get('pressure_abs');
  if (absolute !== undefined) {
    return { doubt: false, note: ` The header says "${absolute}", so "${raw}" is read as an absolute pressure.` };
  }
  return {
    doubt: true,
    note:
      ` "${raw}" does not say whether the pressure is gauge or absolute, so it is read as absolute.` +
      ` If the readings are gauge, set the unit to ${gauge}.`,
  };
}
