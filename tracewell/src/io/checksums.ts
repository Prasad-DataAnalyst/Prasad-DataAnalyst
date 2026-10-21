/**
 * CHECKSUMS.sha256 files in the format of GNU `sha256sum`, so anyone can verify a package or a
 * `.twp` with `sha256sum -c CHECKSUMS.sha256` (SAD sections 10.4 and 11, RB-PKG-CHECKSUMS).
 *
 * GNU sha256sum escapes names containing a backslash or a line break with a leading backslash;
 * such names are refused here instead, so every line is a plain '<hex>  <path>'.
 */
import { EngineError, type Sha256Hex } from '@tw/model';
import { invalidArgument } from './errors';
import { comparePaths, hasLoneSurrogate } from './paths';

export interface ChecksumEntry {
  path: string;
  sha256: Sha256Hex;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
/**
 * Hash, a space, then ' ' (text mode, which this module writes) or '*' (binary mode), then the path.
 * The path is "anything but CR" rather than '.', which would also refuse U+2028 and U+2029 that
 * sha256sum treats as ordinary bytes. Lines are split at LF, and a stray CR (an old Mac file) fails.
 */
const LINE = /^([0-9A-Fa-f]{64}) ([ *])([^\r]+)$/;
const UNWRITABLE_PATH = /[\n\r\\]/;

/** '<hex>  <path>\n' per entry, sorted by path in Unicode code point order. */
export function checksumsFile(entries: { path: string; sha256: Sha256Hex }[]): string {
  const seen = new Set<string>();
  for (const entry of entries) checkEntry(entry, seen);
  return [...entries]
    .sort((a, b) => comparePaths(a.path, b.path))
    .map((e) => `${e.sha256}  ${e.path}\n`)
    .join('');
}

function checkEntry(entry: ChecksumEntry, seen: Set<string>): void {
  const { path, sha256 } = entry;
  if (path === '' || UNWRITABLE_PATH.test(path) || path.includes('\u0000') || hasLoneSurrogate(path)) {
    throw invalidArgument(
      `The path "${path}" cannot be listed in a checksum file: it is empty or contains a line break, ` +
        'a backslash, a NUL character or a lone surrogate (which has no UTF-8 form).',
      { path },
    );
  }
  if (!SHA256_HEX.test(sha256)) {
    throw invalidArgument(`The SHA-256 of "${path}" is not 64 lowercase hex characters.`, { path, sha256 });
  }
  if (seen.has(path)) throw invalidArgument(`The path "${path}" is listed twice.`, { path });
  seen.add(path);
}

/**
 * Parses a checksum file in file order. Accepts CRLF line endings, blank lines, a leading
 * byte-order mark, upper-case hex (returned in lower case) and the binary-mode '*' marker.
 * Throws EngineError('PARSE_FAILED') for any other line, an escaped name or a repeated path.
 */
export function parseChecksumsFile(text: string): { path: string; sha256: Sha256Hex }[] {
  const entries: ChecksumEntry[] = [];
  const seen = new Set<string>();
  const lines = withoutBom(text).split('\n');
  lines.forEach((raw, index) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') return;
    const entry = parseLine(line, index + 1);
    if (seen.has(entry.path)) throw unparsable(`the path "${entry.path}" is listed twice`, index + 1);
    seen.add(entry.path);
    entries.push(entry);
  });
  return entries;
}

/** Editors on Windows may save the file with a byte-order mark (U+FEFF). */
function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseLine(line: string, lineNumber: number): ChecksumEntry {
  if (line.startsWith('\\')) {
    throw unparsable('the file name is escaped with a backslash, which is not supported', lineNumber);
  }
  const match = LINE.exec(line);
  if (match === null) throw unparsable("it is not '<64 hex characters>  <path>'", lineNumber);
  const [, hex = '', , path = ''] = match;
  return { path, sha256: hex.toLowerCase() };
}

function unparsable(why: string, lineNumber: number): EngineError {
  return new EngineError(
    'PARSE_FAILED',
    `Line ${lineNumber} of the checksum file cannot be read: ${why}.`,
    "Restore the checksum file from the original package; each line must be '<SHA-256 hex>  <path>'.",
    { line: lineNumber },
  );
}
