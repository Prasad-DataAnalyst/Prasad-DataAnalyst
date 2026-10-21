import { describe, expect, it } from 'vitest';
import { EngineError } from '@tw/model';
import { checksumsFile, parseChecksumsFile } from './checksums';
import { sha256Hex } from './sha256';

const A = sha256Hex('a');
const B = sha256Hex('b');

function thrown(action: () => unknown): EngineError {
  try {
    action();
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    return e as EngineError;
  }
  throw new Error('expected an EngineError, but nothing was thrown');
}

describe('checksumsFile', () => {
  it("writes '<hex>  <path>' lines sorted by path", () => {
    expect(
      checksumsFile([
        { path: 'b.csv', sha256: B },
        { path: 'a.csv', sha256: A },
      ]),
    ).toBe(`${A}  a.csv\n${B}  b.csv\n`);
  });

  it('writes an empty file for no entries', () => {
    expect(checksumsFile([])).toBe('');
  });

  it('does not reorder the caller array', () => {
    const entries = [
      { path: 'b', sha256: B },
      { path: 'a', sha256: A },
    ];
    checksumsFile(entries);
    expect(entries.map((e) => e.path)).toEqual(['b', 'a']);
  });

  it.each([
    ['an empty path', ''],
    ['a line break', 'a\nb.csv'],
    ['a carriage return', 'a\rb.csv'],
    ['a backslash', 'a\\b.csv'],
    ['a NUL character', 'a\u0000b.csv'],
  ])('refuses %s in a path', (_label, path) => {
    expect(thrown(() => checksumsFile([{ path, sha256: A }])).code).toBe('INVALID_INPUT');
  });

  it('refuses a path with a lone surrogate, which has no UTF-8 form', () => {
    expect(thrown(() => checksumsFile([{ path: 'a\ud800.csv', sha256: A }])).code).toBe('INVALID_INPUT');
  });

  it('refuses a digest that is not 64 lowercase hex characters', () => {
    expect(thrown(() => checksumsFile([{ path: 'a', sha256: A.toUpperCase() }])).code).toBe('INVALID_INPUT');
    expect(thrown(() => checksumsFile([{ path: 'a', sha256: 'abc' }])).code).toBe('INVALID_INPUT');
  });

  it('refuses a path listed twice', () => {
    const entries = [
      { path: 'a', sha256: A },
      { path: 'a', sha256: B },
    ];
    expect(thrown(() => checksumsFile(entries)).message).toContain('listed twice');
  });
});

describe('parseChecksumsFile', () => {
  it('keeps file order', () => {
    expect(parseChecksumsFile(`${B}  b\n${A}  a\n`)).toEqual([
      { path: 'b', sha256: B },
      { path: 'a', sha256: A },
    ]);
  });

  it('accepts CRLF line ends, blank lines, a byte-order mark, upper-case hex and binary mode', () => {
    const text = `${String.fromCharCode(0xfeff)}${A.toUpperCase()}  a.csv\r\n\r\n${B} *b.bin\r\n`;
    expect(parseChecksumsFile(text)).toEqual([
      { path: 'a.csv', sha256: A },
      { path: 'b.bin', sha256: B },
    ]);
  });

  it('reads back every path checksumsFile writes, including Unicode line and paragraph separators', () => {
    // JavaScript's '.' does not match U+2028 or U+2029, but sha256sum treats them as ordinary bytes.
    const entries = [
      { path: 'line sep.csv', sha256: A },
      { path: 'para sep.csv', sha256: B },
      { path: 'next\u0085line.csv', sha256: A },
    ];
    const parsed = parseChecksumsFile(checksumsFile(entries));
    expect(new Map(parsed.map((e) => [e.path, e.sha256]))).toEqual(new Map(entries.map((e) => [e.path, e.sha256])));
  });

  it('keeps spaces and asterisks that belong to the path', () => {
    expect(parseChecksumsFile(`${A}   leading space.txt\n${B}  *star.txt\n`)).toEqual([
      { path: ' leading space.txt', sha256: A },
      { path: '*star.txt', sha256: B },
    ]);
  });

  it.each([
    ['a short digest', `abc  a.csv\n`],
    ['a single space before the path and no mode marker', `${A} a.csv\n`],
    ['a missing path', `${A}  \n`],
    ['a BSD-style line', `SHA256 (a.csv) = ${A}\n`],
  ])('refuses %s with the line number', (_label, text) => {
    const error = thrown(() => parseChecksumsFile(`${B}  ok.csv\n${text}`));
    expect(error.code).toBe('PARSE_FAILED');
    expect(error.detail).toEqual({ line: 2 });
  });

  it('refuses CR-only line ends instead of reading the whole file as one path', () => {
    const error = thrown(() => parseChecksumsFile(`${A}  a.csv\r${B}  b.csv\r`));
    expect(error.code).toBe('PARSE_FAILED');
    expect(error.detail).toEqual({ line: 1 });
  });

  it('refuses names escaped with a backslash by GNU sha256sum', () => {
    expect(thrown(() => parseChecksumsFile(`\\${A}  a\\\\b.csv\n`)).message).toContain('escaped');
  });

  it('refuses a path listed twice', () => {
    expect(thrown(() => parseChecksumsFile(`${A}  a\n${B}  a\n`)).message).toContain('listed twice');
  });
});
