/**
 * Internal helper (not exported from the module): what counts as a JSON value, shared by the
 * canonical encoder and the schemas so that both draw the line in the same place.
 */
import type { JsonValue } from './ids';

/**
 * Arrays and objects nested deeper than this are refused. JSON.parse accepts far deeper text, and
 * the recursive encoder and validators would then overflow the stack: a RangeError that looks like
 * an engine fault and whose depth differs between runtimes. A fixed limit makes the refusal clean
 * and the same everywhere; real documents nest a few levels deep.
 */
export const MAX_JSON_DEPTH = 256;

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
  // The open containers are exactly the ancestors, so their count is the nesting depth.
  if (ancestors.has(v) || ancestors.size >= MAX_JSON_DEPTH) return false;
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

/**
 * True when arrays and objects in `v` nest at most `limit` levels deep (a scalar is 0 levels, `[]`
 * is 1). Any input is accepted, so a document can be measured before anything recursive walks it.
 * A cycle counts as infinitely deep. Heights are remembered per object, so shared sub-objects are
 * measured once and the walk stays linear in the number of objects.
 */
export function withinDepth(v: unknown, limit: number = MAX_JSON_DEPTH): boolean {
  return height(v, limit, new Map<object, number>(), new Set<object>()) <= limit;
}

/** Exact height of `v`, or Infinity once it cannot fit in `room` levels or contains a cycle. */
function height(v: unknown, room: number, known: Map<object, number>, open: Set<object>): number {
  if (typeof v !== 'object' || v === null) return 0;
  const remembered = known.get(v);
  if (remembered !== undefined) return remembered;
  if (room <= 0 || open.has(v)) return Infinity;
  open.add(v);
  let tallest = 0;
  for (const child of Array.isArray(v) ? (v as unknown[]) : Object.values(v)) {
    tallest = Math.max(tallest, height(child, room - 1, known, open));
    if (tallest === Infinity) break;
  }
  open.delete(v);
  // An Infinity is never read back: every caller stops at once and passes it up to the verdict.
  known.set(v, tallest + 1);
  return tallest + 1;
}
