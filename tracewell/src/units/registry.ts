/**
 * The unit registry (SAD section 7.5, FR-PRC-01): one cited JSON file is the single source of every
 * unit, factor and alias. Its exact text is stored in each project and hashed into every manifest,
 * so the registry a result was computed with can always be identified and re-checked.
 */
import { EngineError, schemas, type UnitDef, type UnitInfo } from '@tw/model';
import { lookupKey } from './names';
import registryText from './registry-2026.1.json?raw';

export interface Registry {
  version: string;
  units: readonly UnitDef[];
  byCode: ReadonlyMap<string, UnitDef>;
  /** Codes and aliases by lookup key (see names.ts). */
  byKey: ReadonlyMap<string, UnitDef>;
}

const BROKEN_FIX = 'The unit registry shipped with Tracewell is damaged; reinstall Tracewell or restore the file.';

function broken(message: string): EngineError {
  return new EngineError('INTERNAL', `The unit registry is invalid: ${message}`, BROKEN_FIX);
}

/** Freezes the whole definition, so no caller can change a factor that later conversions rely on. */
function freezeUnit(u: UnitDef): UnitDef {
  Object.freeze(u.aliases);
  Object.freeze(u.toSI);
  return Object.freeze(u);
}

/** Every code and alias must lead to one unit only, after normalisation as well as verbatim. */
function indexByKey(units: readonly UnitDef[]): Map<string, UnitDef> {
  const byKey = new Map<string, UnitDef>();
  for (const unit of units) {
    for (const name of [unit.code, ...unit.aliases]) {
      const key = lookupKey(name);
      if (key === '') throw broken(`the name "${name}" of unit ${unit.code} is empty after normalisation.`);
      const other = byKey.get(key);
      if (other !== undefined && other !== unit) {
        throw broken(`"${name}" (${unit.code}) and a name of ${other.code} are the same after normalisation.`);
      }
      byKey.set(key, unit);
    }
  }
  return byKey;
}

/** Parses and checks registry text. Throws INTERNAL when it is invalid or when a name is ambiguous. */
export function loadRegistry(text: string): Registry {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw broken(e instanceof Error ? e.message : 'it is not JSON.');
  }
  const parsed = schemas.unitRegistry.safeParse(json);
  if (!parsed.success) {
    throw broken(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  }
  const units = Object.freeze(parsed.data.units.map(freezeUnit));
  return {
    version: parsed.data.version,
    units,
    byCode: new Map(units.map((u) => [u.code, u])),
    byKey: indexByKey(units),
  };
}

const REGISTRY = loadRegistry(registryText);

/** Exact text of registry-2026.1.json, as stored in `.twp` files and hashed into manifests. */
export const REGISTRY_JSON: string = registryText;

/** '2026.1'. */
export const REGISTRY_VERSION: string = REGISTRY.version;

/** Every unit, in registry order (grouped by quantity). The array and its units are frozen. */
export function allUnits(): readonly UnitDef[] {
  return REGISTRY.units;
}

/** The unit with exactly this code; aliases and other spellings are not accepted here. */
export function getUnit(code: string): UnitDef | undefined {
  return REGISTRY.byCode.get(code);
}

/**
 * The unit a code or alias names, tolerant of case, spacing and common spellings: 'psia' and
 * 'PSIA', 'm³/d', 'm3/d' and 'm3 per day', 'degF', '°F' and 'deg F'. Short names whose case carries
 * meaning are matched exactly (see names.ts), so 'MM' or 'M' never resolve to millimetre or metre.
 */
export function findUnit(text: string): UnitDef | undefined {
  const key = lookupKey(text);
  return key === '' ? undefined : REGISTRY.byKey.get(key);
}

export function unitInfo(u: UnitDef): UnitInfo {
  return { code: u.code, label: u.label, quantity: u.quantity, convention: u.convention };
}
