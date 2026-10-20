/**
 * Internal helper (not exported from the module): what counts as a JSON value, shared by the
 * canonical encoder and the schemas so that both draw the line in the same place.
 */
import type { JsonValue } from './ids';

/**
 * True for objects created by a literal, JSON.parse or structuredClone, in any realm. Dates, Maps,
 * typed arrays and class instances are refused because Object.keys would silently treat them as {}.
 */
export function isPlainObject(v: object): v is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * Checks a value in place, without copying it. Copying through ordinary property assignment would
 * drop an own '__proto__' key, and the copy would then no longer hash as the original was written.
 * Undefined members and array holes are refused: JSON cannot hold them, and keeping them would let
 * the same document hash differently before and after a JSON round trip.
 */
export function isJsonValue(v: unknown): v is JsonValue {
  return check(v, new Set<object>());
}

function check(v: unknown, ancestors: Set<object>): boolean {
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(v);
    case 'object':
      return v === null || checkContainer(v, ancestors);
    default:
      return false;
  }
}

function checkContainer(v: object, ancestors: Set<object>): boolean {
  if (ancestors.has(v)) return false;
  ancestors.add(v);
  try {
    if (Array.isArray(v)) return checkArray(v, ancestors);
    return isPlainObject(v) && Object.keys(v).every((key) => check(v[key], ancestors));
  } finally {
    ancestors.delete(v);
  }
}

function checkArray(items: readonly unknown[], ancestors: Set<object>): boolean {
  for (let i = 0; i < items.length; i++) {
    if (!(i in items) || !check(items[i], ancestors)) return false;
  }
  return true;
}
