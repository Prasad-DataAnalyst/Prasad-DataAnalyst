/**
 * The messy-file library (SAD section 13.2), imported elsewhere as '@tw/fixtures': the committed
 * fixtures in fixtures/messy and the result importing and checking each one must give. For Node
 * only (tests, the conformance suite and tools): files are read from disk synchronously.
 *
 * fixtures/README.md describes what each fixture breaks and how the expectations are counted.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ByteSource } from '@tw/model';
import { bytesSource } from '@tw/io';
import { parseExpectation, type FixtureExpectation } from './expectation';
import { FIXTURE_NAMES, type FixtureName } from './names';

export type { FixtureDetections, FixtureExpectation } from './expectation';
export type { FixtureName } from './names';
export { FIXTURE_NAMES } from './names';

/** Absolute path of fixtures/messy. */
export const FIXTURES_DIR: string = fileURLToPath(new URL('./messy', import.meta.url));

const KNOWN: ReadonlySet<string> = new Set(FIXTURE_NAMES);

function checkedName(name: FixtureName): FixtureName {
  // The type already forbids other names; this guards callers that build names at run time.
  if (!KNOWN.has(name)) throw new Error(`"${String(name)}" is not a fixture; FIXTURE_NAMES lists them.`);
  return name;
}

/** Absolute path of a fixture in fixtures/messy. */
export function fixturePath(name: FixtureName): string {
  return join(FIXTURES_DIR, checkedName(name));
}

/** The fixture's bytes: a new array on every call, so a test may change it freely. */
export function fixtureBytes(name: FixtureName): Uint8Array {
  // Copied into a fresh ArrayBuffer: a small Node Buffer may be a view of a shared pool.
  return new Uint8Array(readFileSync(fixturePath(name)));
}

/** A ByteSource over the fixture's bytes, named after the fixture. */
export function fixtureSource(name: FixtureName): ByteSource {
  return bytesSource(fixtureBytes(name), name);
}

/** The parsed and checked `<name>.expected.json`. Throws when it is missing or malformed. */
export function fixtureExpectation(name: FixtureName): FixtureExpectation {
  const file = `${checkedName(name)}.expected.json`;
  const text = readFileSync(join(FIXTURES_DIR, file), 'utf8');
  try {
    return parseExpectation(JSON.parse(text), name);
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}
