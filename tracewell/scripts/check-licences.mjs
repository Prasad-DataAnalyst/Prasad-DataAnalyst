// @ts-check
/**
 * Licence gate for the shipped dependency tree (SAD sections 2.2, 12 and 14).
 *
 * Reads `npm ls --omit=dev --all --json --long`, looks up the licence of every installed production
 * package and fails when one is not on the permissive allow-list. Development tools are not shipped
 * and are reviewed when they are adopted.
 *
 * Usage: node scripts/check-licences.mjs        (exit code 0 when every licence is allowed, 1 otherwise)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryScript } from './is-entry.mjs';

export const ALLOWED = [
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'MPL-2.0',
  '(MIT OR Apache-2.0)',
  'Apache-2.0 OR MIT',
];

/** Single SPDX identifiers on the allow-list, used to evaluate compound expressions. */
const ALLOWED_IDS = new Set(ALLOWED.filter((entry) => /^[\w.+-]+$/.test(entry)));

/**
 * Further permissive licences found in the native engine's Rust crates. None of them asks for more
 * than a notice; each was reviewed when the crate was adopted (SAD section 14).
 */
export const RUST_ALSO_ALLOWED = [
  'Zlib',
  'Unlicense',
  'CC0-1.0',
  'BSL-1.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'CDLA-Permissive-2.0',
];
const RUST_IDS = new Set([...ALLOWED_IDS, ...RUST_ALSO_ALLOWED]);

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * @typedef {{ name?: string; version?: string; license?: unknown; licenses?: unknown }} PackageJson
 * @typedef {{ name: string; version: string; licence: string; allowed: boolean }} LicenceVerdict
 * @typedef {{ version?: string; required?: string; missing?: boolean; path?: string; license?: unknown; dependencies?: Record<string, NpmLsNode> }} NpmLsNode
 * @typedef {{ name: string; version: string; path?: string | undefined; license?: unknown; missing?: boolean }} InstalledPackage
 */

/**
 * Text of one licence entry, which may be an SPDX string or a legacy `{ type, url }` object.
 * @param {unknown} entry
 * @returns {string | null}
 */
function licenceText(entry) {
  if (typeof entry === 'string') return entry.trim() || null;
  if (entry && typeof entry === 'object' && 'type' in entry && typeof entry.type === 'string') {
    return entry.type.trim() || null;
  }
  return null;
}

/**
 * The licence a package declares, as an SPDX-style expression. A legacy `licenses` array lists
 * alternatives the user may choose from, so it becomes an OR expression.
 * @param {PackageJson} pkg
 * @returns {string}
 */
export function declaredLicence(pkg) {
  const single = licenceText(pkg.license);
  if (single) return single;
  if (Array.isArray(pkg.licenses)) {
    const ids = pkg.licenses.map(licenceText).filter((id) => id !== null);
    if (ids.length === 1) return /** @type {string} */ (ids[0]);
    if (ids.length > 1) return `(${ids.join(' OR ')})`;
  }
  return 'UNKNOWN';
}

/**
 * @param {string} expression
 * @returns {string[]}
 */
function tokenizeExpression(expression) {
  return expression.match(/\(|\)|[^\s()]+/g) ?? [];
}

/**
 * Evaluates an SPDX expression against the allow-list: OR needs one allowed side, AND needs both.
 * `WITH` exceptions and `+` suffixes are refused unless listed literally, because they change terms.
 * @param {string} expression
 * @returns {boolean}
 */
export function isAllowedExpression(expression, ids = ALLOWED_IDS) {
  if (ALLOWED.includes(expression)) return true;
  const tokens = tokenizeExpression(expression);
  let position = 0;

  /** @returns {boolean} */
  function parseOr() {
    let allowed = parseAnd();
    while (tokens[position]?.toUpperCase() === 'OR') {
      position++;
      const right = parseAnd();
      allowed = allowed || right;
    }
    return allowed;
  }
  /** @returns {boolean} */
  function parseAnd() {
    let allowed = parseTerm();
    while (tokens[position]?.toUpperCase() === 'AND') {
      position++;
      const right = parseTerm();
      allowed = allowed && right;
    }
    return allowed;
  }
  /** @returns {boolean} */
  function parseTerm() {
    const token = tokens[position++];
    if (token === '(') {
      const allowed = parseOr();
      if (tokens[position++] !== ')') throw new Error(`unbalanced parentheses in "${expression}"`);
      return allowed;
    }
    if (token === undefined || token === ')') throw new Error(`incomplete licence expression "${expression}"`);
    if (tokens[position]?.toUpperCase() === 'WITH') {
      position += 2;
      return false;
    }
    return ids.has(token);
  }

  try {
    const allowed = parseOr();
    return position === tokens.length && allowed;
  } catch {
    return false;
  }
}

/**
 * The licence classifier: what a package declares and whether that is on the allow-list.
 * @param {PackageJson} pkg
 * @returns {LicenceVerdict}
 */
export function classifyPackage(pkg) {
  const licence = declaredLicence(pkg);
  return {
    name: pkg.name ?? '(unnamed)',
    version: pkg.version ?? '(unknown)',
    licence,
    allowed: isAllowedExpression(licence),
  };
}

/**
 * Flattens the `npm ls --json --long` tree into one entry per name@version. A required package
 * that is not installed is kept (flagged `missing`) so the gate cannot pass on an empty tree;
 * an empty entry is an unmet optional peer, which is never shipped.
 *
 * npm prints a repeated package once in full and elsewhere as a "deduped" entry without its
 * dependencies, and the deduped copy can come first. Every occurrence is therefore descended into;
 * stopping at the first one would let the full copy's dependencies skip the gate.
 * @param {NpmLsNode} tree
 * @returns {InstalledPackage[]}
 */
export function installedPackages(tree) {
  /** @type {Map<string, InstalledPackage>} */
  const found = new Map();
  /** Nodes on the current path, so a cyclic tree cannot recurse forever. */
  const ancestors = new Set();
  /** @param {NpmLsNode} node */
  const visit = (node) => {
    ancestors.add(node);
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (child.missing) {
        const version = child.required ?? '(any)';
        found.set(`${name}@${version}`, { name, version, missing: true });
        continue;
      }
      if (!child.version) continue;
      const key = `${name}@${child.version}`;
      if (!found.has(key)) found.set(key, { name, version: child.version, path: child.path, license: child.license });
      if (!ancestors.has(child)) visit(child);
    }
    ancestors.delete(node);
  };
  visit(tree);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/**
 * Prefers the package's own package.json, because npm's summary does not report legacy
 * `licenses` arrays.
 * @param {InstalledPackage} installed
 * @returns {LicenceVerdict}
 */
function verdictFor(installed) {
  if (installed.missing) {
    return { name: installed.name, version: installed.version, licence: 'NOT INSTALLED (run npm ci)', allowed: false };
  }
  const manifest = installed.path ? join(installed.path, 'package.json') : null;
  if (manifest && existsSync(manifest)) {
    const pkg = /** @type {PackageJson} */ (JSON.parse(readFileSync(manifest, 'utf8')));
    return classifyPackage({ ...pkg, name: installed.name, version: installed.version });
  }
  return classifyPackage({ name: installed.name, version: installed.version, license: installed.license });
}

/**
 * Runs npm ls. npm exits non-zero when the tree has problems but still prints the JSON tree,
 * which is what this check needs.
 * @param {string} root
 * @returns {NpmLsNode}
 */
function readProductionTree(root) {
  const args = ['ls', '--omit=dev', '--all', '--json', '--long'];
  try {
    const options = { cwd: root, encoding: /** @type {const} */ ('utf8'), maxBuffer: 256 * 1024 * 1024 };
    return JSON.parse(execFileSync('npm', args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
    if (stdout.trim().startsWith('{')) return JSON.parse(stdout);
    throw error;
  }
}

/**
 * @param {LicenceVerdict[]} verdicts
 * @returns {string}
 */
export function formatReport(verdicts) {
  const offenders = verdicts.filter((v) => !v.allowed);
  if (offenders.length === 0) {
    return `licences: ${verdicts.length} production packages and crates, all on the allow-list.`;
  }
  return [
    `licences: ${offenders.length} of ${verdicts.length} production packages failed the licence gate:`,
    ...offenders.map((v) => `  ${v.name}@${v.version}: ${v.licence}`),
    `Allowed: ${ALLOWED.join(', ')}. Replace the package or record a licence review before adopting it.`,
  ].join('\n');
}

/**
 * A crate's licence as an SPDX expression: Cargo still accepts the old 'MIT/Apache-2.0' form,
 * where the slash means OR.
 * @param {string | null | undefined} licence
 * @returns {string}
 */
export function crateLicence(licence) {
  return (licence ?? '').replace(/\s*\/\s*/g, ' OR ').trim();
}

/**
 * Verdicts for the crates a native build compiles (cargo metadata's resolved graph).
 * @param {{ packages: { id: string; name: string; version: string; license?: string | null }[]; resolve?: { nodes: { id: string }[] } | null }} metadata
 * @returns {LicenceVerdict[]}
 */
export function classifyCrates(metadata) {
  const built = new Set((metadata.resolve?.nodes ?? []).map((n) => n.id));
  return metadata.packages
    .filter((p) => built.size === 0 || built.has(p.id))
    .filter((p) => p.name !== 'tracewell-engine')
    .map((p) => {
      const licence = crateLicence(p.license);
      return {
        name: `crate ${p.name}`,
        version: p.version,
        licence: licence || 'NONE',
        allowed: licence !== '' && isAllowedExpression(licence, RUST_IDS),
      };
    });
}

/**
 * The native engine's crates, when the crate and cargo are present; otherwise none.
 * @param {string} root
 * @returns {LicenceVerdict[]}
 */
function rustVerdicts(root) {
  const manifest = join(root, 'crates', 'tracewell-engine', 'Cargo.toml');
  if (!existsSync(manifest)) return [];
  try {
    const out = execFileSync('cargo', ['metadata', '--format-version', '1', '--manifest-path', manifest], {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return classifyCrates(JSON.parse(out.toString()));
  } catch (e) {
    return [
      {
        name: 'crates/tracewell-engine',
        version: '-',
        licence: `UNREADABLE (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`,
        allowed: false,
      },
    ];
  }
}

/**
 * @param {string} [root]
 * @returns {number} process exit code
 */
export function main(root = DEFAULT_ROOT) {
  const verdicts = [...installedPackages(readProductionTree(root)).map(verdictFor), ...rustVerdicts(root)];
  const text = formatReport(verdicts);
  const failed = verdicts.some((v) => !v.allowed);
  if (failed) console.error(text);
  else console.log(text);
  return failed ? 1 : 0;
}

if (isEntryScript(import.meta.url)) {
  process.exitCode = main();
}
