/**
 * Byte copying that behaves the same for every Uint8Array. `slice()` is not enough: on a Node
 * Buffer (which tests and the conformance suite read files into) it returns a view that shares
 * memory, so a caller changing or transferring the "copy" would change the original too.
 */

/** A plain Uint8Array holding a copy of bytes[from, to). */
export function copyBytes(bytes: Uint8Array, from = 0, to = bytes.byteLength): Uint8Array {
  const out = new Uint8Array(Math.max(0, to - from));
  out.set(bytes.subarray(from, to));
  return out;
}
