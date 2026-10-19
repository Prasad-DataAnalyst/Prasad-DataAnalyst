/**
 * Internal helper (not exported from the module): runtime lists of a string union's members that
 * the compiler proves complete, so validation code cannot drift from the types it validates.
 */

type Complete<T extends string, L extends readonly T[]> = [T] extends [L[number]] ? L : never;

/**
 * `members<Severity>()(['error', 'warning', 'note'])` returns the list unchanged; leaving out a
 * member of the union, or naming a value outside it, is a compile error.
 */
export function members<T extends string>() {
  return <const L extends readonly [T, ...T[]]>(list: L & Complete<T, L>): L => list;
}
