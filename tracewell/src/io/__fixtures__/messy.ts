/**
 * Test-only access to the committed messy-file library (fixtures/messy) for the io tests. Files
 * are read straight from disk rather than through '@tw/fixtures', whose loader is built on top of
 * this module.
 *
 * The library and its SHA256SUMS are delivered by the fixtures module. Until SHA256SUMS exists the
 * tests that need it are skipped; once it exists, a missing fixture is a test failure.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseChecksumsFile } from '../checksums';

export const MESSY_DIR = fileURLToPath(new URL('../../../fixtures/messy/', import.meta.url));
const SUMS_PATH = `${MESSY_DIR}SHA256SUMS`;

/** True once the fixtures module has delivered the library. */
export const MESSY_READY = existsSync(SUMS_PATH);

export function messyPath(name: string): string {
  return `${MESSY_DIR}${name}`;
}

export function messyBytes(name: string): Uint8Array {
  const buffer = readFileSync(messyPath(name));
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** SHA256SUMS as a map from file name to hex digest; './' prefixes are dropped. */
export function messySums(): Map<string, string> {
  const entries = parseChecksumsFile(readFileSync(SUMS_PATH, 'utf8'));
  return new Map(entries.map((e) => [e.path.replace(/^\.\//, ''), e.sha256]));
}
