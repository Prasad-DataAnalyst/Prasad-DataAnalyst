/**
 * Self-test of scripts/check-hygiene.mjs (SAD section 2.2, "Authorship"). The forbidden words
 * themselves never appear here: a synthetic token is hashed at test time instead.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_TOKEN_HASHES,
  MAX_TEXT_BYTES,
  decodeText,
  findForbidden,
  formatReport,
  scanTree,
  sha256Hex,
  tokenMatcher,
  tokenize,
} from '../../scripts/check-hygiene.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** A made-up word that no real text contains. */
const PROBE = 'zqxprobetoken';
const WITH_PROBE = [...FORBIDDEN_TOKEN_HASHES, sha256Hex(PROBE)];

describe('forbidden token list', () => {
  it('holds only SHA-256 hashes, unique and sorted, so the words themselves never appear', () => {
    expect(FORBIDDEN_TOKEN_HASHES.length).toBeGreaterThanOrEqual(40);
    for (const hash of FORBIDDEN_TOKEN_HASHES) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(FORBIDDEN_TOKEN_HASHES).size).toBe(FORBIDDEN_TOKEN_HASHES.length);
    expect([...FORBIDDEN_TOKEN_HASHES].sort()).toEqual(FORBIDDEN_TOKEN_HASHES);
  });

  it('does not flag the owner, the product or the domain vocabulary', () => {
    const isForbidden = tokenMatcher(FORBIDDEN_TOKEN_HASHES);
    const text = 'Prasad (Prasad-DataAnalyst) Tracewell cursor Microsoft Excel QGIS meta phi LNG psia kPa';
    expect(findForbidden(text, isForbidden)).toEqual([]);
  });
});

describe('tokenising and hashing', () => {
  it('hashes tokens as lower-case UTF-8 SHA-256', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('lower-cases words and splits identifiers at case and digit boundaries', () => {
    const tokens = tokenize('OpenThing ABCWidget_x9 naïveValue');
    for (const token of ['openthing', 'open', 'thing', 'abcwidget', 'abc', 'widget', 'x9', 'x', '9']) {
      expect(tokens).toContain(token);
    }
    expect(tokens).toContain('naïve');
    expect(tokens).toContain('naïvevalue');
  });

  it('flags a synthetic token whose hash is added at test time', () => {
    const isForbidden = tokenMatcher(WITH_PROBE);
    const lines = ['const ok = 1;', `const x = '${PROBE.toUpperCase()}';`, 'class UseZqxprobetokenClient {}'];
    const text = lines.join('\n');
    expect(findForbidden(text, isForbidden)).toEqual([
      { line: 2, column: 12 },
      { line: 3, column: 7 },
    ]);
    expect(findForbidden(text, tokenMatcher(FORBIDDEN_TOKEN_HASHES))).toEqual([]);
  });

  it('counts lines the same for LF, CRLF and CR endings', () => {
    const isForbidden = tokenMatcher(WITH_PROBE);
    for (const eol of ['\n', '\r\n', '\r']) {
      expect(findForbidden(`a${eol}b${eol}${PROBE}`, isForbidden)).toEqual([{ line: 3, column: 1 }]);
    }
  });

  it('decodes UTF-16 text and skips binary content', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from(new TextEncoder().encode('hi')).flatMap((b) => [b, 0])]);
    expect(decodeText(utf16)).toBe('hi');
    expect(decodeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBeNull();
    expect(decodeText(new TextEncoder().encode('plain'))).toBe('plain');
  });

  it('is not fooled by invisible format characters or compatibility forms inside a word', () => {
    const isForbidden = tokenMatcher(WITH_PROBE);
    const disguised = [
      'zqx​probetoken', // zero-width space
      'zqxprobe­token', // soft hyphen, invisible unless the line breaks there
      'zqx⁠probetoken', // word joiner
      '﻿zqxprobetoken', // a byte order mark pasted mid-file
      'ｚｑｘprobetoken', // fullwidth letters
    ];
    for (const word of disguised) {
      expect(findForbidden(`const a = '${word}';`, isForbidden), JSON.stringify(word)).toEqual([
        { line: 1, column: 12 },
      ]);
      expect(tokenize(word), JSON.stringify(word)).toContain(PROBE);
    }
  });

  it('decodes UTF-16 text that has no byte order mark instead of skipping it as binary', () => {
    const text = `name\tvalue\n${PROBE}\t1\n`;
    const ascii = Array.from(new TextEncoder().encode(text));
    const le = new Uint8Array(ascii.flatMap((b) => [b, 0]));
    const be = new Uint8Array(ascii.flatMap((b) => [0, b]));
    expect(decodeText(le)).toBe(text);
    expect(decodeText(be)).toBe(text);
    // Binary content with scattered NUL bytes is still skipped.
    expect(
      decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2, 3, 0])),
    ).toBeNull();
  });

  it('names the files it could not scan because of their size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-hygiene-'));
    try {
      writeFileSync(join(dir, 'big.csv'), 'a'.repeat(MAX_TEXT_BYTES + 1));
      writeFileSync(join(dir, 'small.txt'), 'ok\n');
      const report = scanTree(dir, WITH_PROBE, ['big.csv', 'small.txt']);
      expect(report.oversized).toEqual(['big.csv']);
      expect(report.filesSkipped).toBe(1);
      const text = formatReport(report);
      expect(text).toContain('not scanned (over 2 MiB): big.csv');
      expect(text).toMatch(/no forbidden names\.$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks file paths as well as contents', () => {
    const report = scanTree(ROOT, WITH_PROBE, [`docs/${PROBE}-notes.md`]);
    expect(report.hits).toEqual([{ file: `docs/${PROBE}-notes.md`, line: 0, column: 0 }]);
    expect(formatReport(report)).toContain(`docs/${PROBE}-notes.md (file path)`);
  });
});

describe('repository', () => {
  it('a clean tree passes', () => {
    const report = scanTree(ROOT, FORBIDDEN_TOKEN_HASHES);
    expect(report.filesScanned).toBeGreaterThan(0);
    expect(formatReport(report)).toMatch(/no forbidden names\.$/);
  });
});
