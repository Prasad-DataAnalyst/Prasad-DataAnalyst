// @ts-check
/**
 * Repository hygiene check (SAD section 2.2, "Authorship").
 *
 * Tracewell's code, documents and commits are in the owner's name only, so the names of AI
 * assistants, AI models and AI vendors must not appear anywhere in the repository. The forbidden
 * words are stored only as SHA-256 hashes of their lower-case form, so this file never contains
 * the words it looks for.
 *
 * Usage: node scripts/check-hygiene.mjs        (exit code 0 when clean, 1 on any hit)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryScript } from './is-entry.mjs';

/** SHA-256 of each forbidden lower-case token. */
export const FORBIDDEN_TOKEN_HASHES = [
  '053ea4804ef1bb33d4a3d6fb024a614b6d257cebc2bc7cd915da9c9522f37ffc',
  '06e88eae7ee0b406c300f8036e529f63be2b48fb1a44ac487737501d8734e648',
  '0ac0192d441f96da3a4a3174330c3a74e034a3a4704fded0e87515d1a97c19dc',
  '0b79cf2de0ee6b8ee227d9ebfe69b91aa92b1d2509641c4b743518447dbc4c68',
  '0c32f6ed7ab6498676c7dbb1add1c11baa444e5d9290e532f67a2eaf3f60280e',
  '0e3ef6d103af163dcdffe26b76485f38af7f1d697ce05034c107de73eff16afb',
  '194cbf5c4433b278166f7eca3fbab6c639a862ea7dcb10250fdb7dc2c129693a',
  '3ea125d0bff386e6754b3782b300016fc79a9cf8f8669c0a5c3db64467ddb681',
  '3fb22a5597fb91ee4f9abbf30ea69d318be150e0fcf3ca1db8ca334b520d2894',
  '419833c75dd65fb3ac77e05c276bb477aa5586e754d2f90d583cfbf97642793e',
  '45d780f82c9247fc1142f8b60c12b6c6cd3d9f23dd836cfa6e84c498d2f83292',
  '5792d2981981be5a2677cd353db6f55cd9d2779570061ae8d86176635b3cc745',
  '57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93',
  '5a5110ebe1544b31e6d4207a419bc1deb148735f89ae984ff0a2ab809b51f1df',
  '5d0c0ab127fdea24d94e7e3326b6ceb965ab82ad897f9de1bd6b1a9a23f87578',
  '5d72436256ada53828b51895a94bb8489e9f1ac4fe937a8024ef1594e7045ff6',
  '5d7269a515e497bd4e14a9cbbf1ffcfbf24a6cfaf4500b9ef5a6d40e870f1a88',
  '5e650e77fb06e0a8f0c97359e939b86df7940dd1a48d567d8c96d61229e88ebc',
  '60965168ce762e949600281ba6d01fee136e5b6e8257b1f216f9025ed324474c',
  '67f2d22514622d1be30c14ee9f3cb104503a159a33a656ca91a1953aa9616429',
  '6a0adb4b6acf50826838f3853ddd0930d2048e7d8cea775d11fd7ee3c08362e3',
  '6f7ac1823da81d2e52d1a1549ee69c85bbf8bb56d06682849e7c09da2785ce3b',
  '6fcba5d96a4fadfdd63064cf21da843c31de9a702bbee7fe306d4754fc9dd262',
  '72e8088a05b38ae3cffbc126c1c2095046c7700edab31ce35867ce8ee3ac8932',
  '751a16d8cb41ea83c7b7c76d8deaa859cb1d10760163b5f184be6a79ed913c85',
  '7764735c5d4d88ae3ef1c0d6c0a5769e4187c341895db19a82ba7d4e17b8c914',
  '7d3194f79e645c42e4396dda38be04766810ec6a00d00aced3ffc2a0a1f1a9ef',
  '81ed341348bed14c507f31afb5d1afed2262e97378012e59f5e9e03e4e6ecd38',
  '88935407039ab8e18cf2f7bd1611c314e5187d99403ccb7c2d44dcded189c862',
  '9058f79c893a1d7e20b13009b95b9cf3211478a91a47e2ad65bdfedad6fc98f4',
  '90642c3dd333bc0e602c9fa887ab0f0482886d0ed52ce8762a27a5f901528fcc',
  '920510199770f4d65cb8aaa2cd12bdb2b8c37f5b3907c50a734a0e3409da2823',
  '938973a5d41077ec2deb8f4320e4f0206000a785d30d63cfda66723c67ed245a',
  '97f128115e33c7693db6156c493d1fcbe0ebf4a870b6b49cd4b6b865233f7725',
  'a4c745facd3a921565e2c12d2db6a4021d4764f633a18400634d68df575ffb35',
  'a8182c1c17bb2847d2d9849572ad3ce9612e58fe1fa2df2d92ebc59500e3b3da',
  'add92b9cde2bdbf3daaf65a0db79e9b1a7fa428b71b4d6ce38c742eb6dca0c1c',
  'b46573f3283d5eb9274cb9a227e37a9a00a4b04b73e40700901c1160346cdd96',
  'b5d641b432cca81e57b5bb5b73c53e64c50d44dce93595a85d1d8885f48548e8',
  'c70eca6b0f88f44d81a41311647e50fda1ac454ec04ffd442b0eb4743a993131',
  'c857d09db23e6822e3600bc06ad8d58f92ed62bc8efd81c753f77048662cb97d',
  'c97504235ab15009f6c5f11ba890007a5f3fdd20c9e57b53ea74855033572ddf',
  'c9ad8f2cc1294afa0ef22fc2c019ff7243cdd272b2147ddca3f34c5036b05768',
  'd203a277f19a8f7d78fe8e9a621534b2cbd8ef1f0d809908ffc481e778858872',
  'd931372ba7f836a0bf8405601b0a293927ba20bf368f12b2cf3affc384c8a9da',
  'da3084449e366e06cc31a70addbea9fbd5077beb2993b57441711ff5c538cad8',
  'e12ce8285efc67c6d93d3a122e2589ed95089bcbb775ba5634d94e2b8385db07',
  'e408ee3d83092ec7f7418c8430df349d62d43b57195888fb7609daf4ff22b368',
  'ebde709e306badca2f843f1ef91c7fb216a99aa4417b32fe911e15acfff8bedd',
  'fc5a1047f5919892fcdf8aa79ea5d6bb6531b5c176939ef0110906cb225941c1',
];

/** Files above this size are generated data, not authored text, and are skipped. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Names are at most a few camelCase parts long ("Abc" + "XYZ"), so longer joins are not needed. */
const MAX_JOINED_PARTS = 4;

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * A word as it appears in the text. Combining marks and invisible format characters (zero-width
 * space, soft hyphen, word joiner, BOM, bidi controls) stay inside the run, so they cannot split a
 * name into harmless-looking halves; normalizeRun then removes them.
 */
const RUN = /[\p{L}\p{N}\p{M}\p{Cf}]+/gu;
const WALK_SKIP = new Set(['.git', 'node_modules', 'dist', 'coverage', 'test-results', 'playwright-report', 'target']);

/**
 * @typedef {{ file: string; line: number; column: number }} Hit   line 0 means the file path itself
 * @typedef {{ filesScanned: number; filesSkipped: number; oversized: string[]; hits: Hit[] }} HygieneReport
 */

/** @param {string} text */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Splits one alphanumeric run at case and letter/digit boundaries: "XyzABCWidget2" gives
 * "Xyz", "ABC", "Widget", "2".
 * @param {string} run
 * @returns {string[]}
 */
function splitParts(run) {
  return run.match(/\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{N}+|[^\p{Lu}\p{Ll}\p{N}]+/gu) ?? [run];
}

/**
 * Compatibility forms (fullwidth letters, ligatures) become their plain letters and invisible
 * format characters are dropped, so a disguised name hashes like the plain one.
 * @param {string} run
 * @returns {string}
 */
function normalizeRun(run) {
  return run.normalize('NFKC').replace(/\p{Cf}/gu, '');
}

/**
 * Candidate tokens of one alphanumeric run, lower-cased: the run itself plus every contiguous join
 * of up to MAX_JOINED_PARTS of its parts. Joins catch a name embedded in an identifier such as
 * "someNameClient", which a plain word split would miss.
 * @param {string} rawRun
 * @returns {string[]}
 */
export function runTokens(rawRun) {
  const run = normalizeRun(rawRun);
  if (run === '') return [];
  const tokens = new Set([run.toLowerCase()]);
  const parts = splitParts(run);
  for (let start = 0; start < parts.length; start++) {
    let joined = '';
    for (let end = start; end < Math.min(parts.length, start + MAX_JOINED_PARTS); end++) {
      joined += parts[end];
      tokens.add(joined.toLowerCase());
    }
  }
  return [...tokens];
}

/**
 * Lower-cased word tokens of a text (see runTokens), in order of first appearance.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const tokens = new Set();
  for (const run of text.match(RUN) ?? []) {
    for (const token of runTokens(run)) tokens.add(token);
  }
  return [...tokens];
}

/**
 * Builds a matcher that hashes each distinct token once, because the same identifiers repeat
 * thousands of times across a tree.
 * @param {Iterable<string>} hashes
 * @returns {(token: string) => boolean}
 */
export function tokenMatcher(hashes) {
  const forbidden = new Set(hashes);
  /** @type {Map<string, boolean>} */
  const cache = new Map();
  return (token) => {
    let hit = cache.get(token);
    if (hit === undefined) {
      hit = forbidden.has(sha256Hex(token));
      cache.set(token, hit);
    }
    return hit;
  };
}

/**
 * Positions (1-based line and column) of every alphanumeric run that contains a forbidden token.
 * @param {string} text
 * @param {(token: string) => boolean} isForbidden
 * @returns {{ line: number; column: number }[]}
 */
export function findForbidden(text, isForbidden) {
  /** @type {{ line: number; column: number }[]} */
  const hits = [];
  text.split(/\r\n|\r|\n/).forEach((lineText, index) => {
    for (const match of lineText.matchAll(RUN)) {
      if (runTokens(match[0]).some(isForbidden)) hits.push({ line: index + 1, column: match.index + 1 });
    }
  });
  return hits;
}

/**
 * UTF-16 without a byte order mark: mostly-Latin text has a NUL in nearly every high byte and
 * almost none in the low bytes. Binary formats scatter their NULs, so they do not match.
 * @param {Uint8Array} head the first bytes of the file
 * @returns {'utf-16le' | 'utf-16be' | null}
 */
function sniffUtf16(head) {
  const pairs = Math.floor(head.length / 2);
  if (pairs < 2) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < pairs * 2; i += 2) {
    if (head[i] === 0) evenZeros++;
    if (head[i + 1] === 0) oddZeros++;
  }
  const mostly = (/** @type {number} */ n) => n >= pairs * 0.4;
  const rarely = (/** @type {number} */ n) => n <= pairs * 0.02;
  if (mostly(oddZeros) && rarely(evenZeros)) return 'utf-16le';
  if (mostly(evenZeros) && rarely(oddZeros)) return 'utf-16be';
  return null;
}

/**
 * Decodes a file as text, or returns null for binary content. UTF-16 files, with or without a
 * BOM, are decoded so they cannot hide words; other bytes are read as UTF-8, where stray legacy
 * bytes become U+FFFD without affecting ASCII words.
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const head = bytes.subarray(0, 8192);
  if (!head.includes(0)) return new TextDecoder('utf-8').decode(bytes);
  const utf16 = sniffUtf16(head);
  return utf16 ? new TextDecoder(utf16).decode(bytes) : null;
}

/**
 * Git-tracked files plus untracked files that are not ignored, so a name is caught before it is
 * ever committed. Falls back to a directory walk when the tree is not a git checkout.
 * @param {string} root
 * @returns {string[]} paths relative to root, with forward slashes
 */
export function listFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...new Set(out.toString('utf8').split('\0').filter(Boolean))].sort();
  } catch {
    return walk(root, '').sort();
  }
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {string[]}
 */
function walk(root, rel) {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return WALK_SKIP.has(entry.name) ? [] : walk(root, path);
    return entry.isFile() ? [path] : [];
  });
}

/**
 * Reads a file for scanning. A tracked file that was deleted from the working tree is "missing".
 * @param {string} absolutePath
 * @returns {{ status: 'text'; text: string } | { status: 'binary' | 'oversized' | 'missing' }}
 */
function readForScan(absolutePath) {
  try {
    if (statSync(absolutePath).size > MAX_TEXT_BYTES) return { status: 'oversized' };
    const text = decodeText(readFileSync(absolutePath));
    return text === null ? { status: 'binary' } : { status: 'text', text };
  } catch {
    return { status: 'missing' };
  }
}

/**
 * Scans the tree under root. File paths are checked too, so a file name cannot carry a name.
 * @param {string} root
 * @param {Iterable<string>} hashes
 * @param {string[]} [files] relative paths; defaults to listFiles(root)
 * @returns {HygieneReport}
 */
export function scanTree(root, hashes, files = listFiles(root)) {
  const isForbidden = tokenMatcher(hashes);
  /** @type {Hit[]} */
  const hits = [];
  /** @type {string[]} */
  const oversized = [];
  let filesSkipped = 0;
  for (const file of files) {
    if (tokenize(file).some(isForbidden)) hits.push({ file, line: 0, column: 0 });
    const content = readForScan(join(root, file));
    if (content.status !== 'text') {
      filesSkipped++;
      if (content.status === 'oversized') oversized.push(file);
      continue;
    }
    for (const position of findForbidden(content.text, isForbidden)) hits.push({ file, ...position });
  }
  return { filesScanned: files.length - filesSkipped, filesSkipped, oversized, hits };
}

/**
 * @param {HygieneReport} report
 * @returns {string}
 */
export function formatReport(report) {
  const summary = `${report.filesScanned} files scanned, ${report.filesSkipped} skipped (binary or over 2 MiB)`;
  // Large files are named rather than silently passed, so a big text file cannot hide a name unseen.
  const notices =
    report.oversized.length > 0 ? [`hygiene: not scanned (over 2 MiB): ${report.oversized.join(', ')}`] : [];
  if (report.hits.length === 0) return [...notices, `hygiene: ${summary}; no forbidden names.`].join('\n');
  const lines = report.hits.map((h) => (h.line === 0 ? `${h.file} (file path)` : `${h.file}:${h.line}:${h.column}`));
  return [
    ...notices,
    `hygiene: ${report.hits.length} forbidden name(s) found; ${summary}.`,
    ...lines,
    'Remove the name or reword the text: Tracewell is authored by Prasad (Prasad-DataAnalyst) only.',
  ].join('\n');
}

/**
 * @param {string} [root]
 * @returns {number} process exit code
 */
export function main(root = DEFAULT_ROOT) {
  const report = scanTree(root, FORBIDDEN_TOKEN_HASHES);
  const text = formatReport(report);
  if (report.hits.length > 0) {
    console.error(text);
    return 1;
  }
  console.log(text);
  return 0;
}

if (isEntryScript(import.meta.url)) {
  process.exitCode = main();
}
