import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Buffer } from 'node:buffer';
import { deflateSync, Inflate } from 'fflate';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { EngineError, utf8 } from '@tw/model';
import { checksumsFile, parseChecksumsFile } from './checksums';
import { sha256Hex } from './sha256';
import { readZip, type ZipReader } from './zip-read';
import { writeZip, type ZipEntryInput } from './zip-write';
import {
  centralRecords,
  padCompressedData,
  patchBoth,
  PYTHON_AVAILABLE,
  rawData,
  renameBoth,
  runPython,
  toZip64,
  withU16,
  withU32,
} from './__fixtures__/zip-tools';

const MiB = 1024 * 1024;
const PINNED_ZIP_SHA256 = 'dd519279b456306a1a178acca4aa50307242fc6358ed88b29c0840367441b56d';

const scratch = mkdtempSync(join(tmpdir(), 'tracewell-io-zip-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function noise(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

const SAMPLE: ZipEntryInput[] = [
  { path: 'mimetype', data: utf8('application/vnd.tracewell.project+zip'), store: true },
  { path: 'manifest.json', data: utf8('{"format":"tracewell-project","formatVersion":"0.1"}') },
  { path: 'originals/ab12/wells daily.csv', data: utf8('well,rate\nA-1,42\n'.repeat(500)), store: true },
  { path: 'data/donn\u00e9es/\u6cb9\u4e95.csv', data: utf8('x\n1\n') },
  { path: 'empty.txt', data: new Uint8Array(0) },
  { path: 'empty-stored.txt', data: new Uint8Array(0), store: true },
  { path: 'noise.bin', data: noise(100_000, 11) },
];

function thrown(action: () => unknown): EngineError {
  try {
    action();
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    return e as EngineError;
  }
  throw new Error('expected an EngineError, but nothing was thrown');
}

function contents(reader: ZipReader): Record<string, string> {
  return Object.fromEntries(reader.paths().map((p) => [p, sha256Hex(reader.read(p))]));
}

interface PythonEntry {
  name: string;
  method: number;
  size: number;
  csize: number;
  date: number[];
  sha256: string;
}

/** Lists an archive with Python's zipfile module, which also tests every entry's CRC. */
function pythonList(zip: Uint8Array): { bad: string | null; entries: PythonEntry[] } {
  const path = join(scratch, `list-${sha256Hex(zip).slice(0, 12)}.zip`);
  writeFileSync(path, zip);
  const out = runPython(
    [
      'import hashlib, json, sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1]) as z:',
      '    bad = z.testzip()',
      '    entries = [{"name": i.filename, "method": i.compress_type, "size": i.file_size,',
      '                "csize": i.compress_size, "date": list(i.date_time),',
      '                "sha256": hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist()]',
      'print(json.dumps({"bad": bad, "entries": entries}))',
    ],
    [path],
  );
  return JSON.parse(new TextDecoder().decode(out)) as { bad: string | null; entries: PythonEntry[] };
}

describe('writeZip and readZip', () => {
  it('round-trip paths and bytes', () => {
    const reader = readZip(writeZip(SAMPLE));
    expect(reader.paths()).toEqual(SAMPLE.map((e) => e.path));
    for (const entry of SAMPLE) {
      expect(reader.has(entry.path)).toBe(true);
      expect(reader.size(entry.path)).toBe(entry.data.length);
      expect(reader.read(entry.path)).toEqual(entry.data);
    }
  });

  it('give byte-identical output for the same input on two calls', () => {
    const first = writeZip(SAMPLE);
    const second = writeZip(SAMPLE.map((e) => ({ ...e, data: e.data.slice() })));
    expect(second).toEqual(first);
    expect(sha256Hex(second)).toBe(sha256Hex(first));
  });

  it('give the same bytes in every time zone and on every machine (pinned digest)', () => {
    // Pinned so that a change of output, such as one from a new fflate release, is a deliberate
    // decision: exports and .twp files are meant to be byte-identical for the same inputs (NFR-06).
    const entries: ZipEntryInput[] = [
      { path: 'mimetype', data: utf8('application/vnd.tracewell.project+zip'), store: true },
      { path: 'data/wells.csv', data: utf8('well,rate\r\nA-1,42\r\n'.repeat(100)) },
      { path: 'données.txt', data: utf8('Temp °C') },
    ];
    const before = process.env.TZ;
    const digests = ['UTC', 'Pacific/Kiritimati', 'America/St_Johns'].map((zone) => {
      process.env.TZ = zone;
      return sha256Hex(writeZip(entries));
    });
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
    expect(new Set(digests)).toEqual(new Set([PINNED_ZIP_SHA256]));
  });

  it('keep the caller order by default and sort by code point when asked', () => {
    const entries: ZipEntryInput[] = [
      { path: 'b.txt', data: utf8('b') },
      { path: 'a/z.txt', data: utf8('z') },
      { path: '\u{1f6e2}.txt', data: utf8('emoji') },
      { path: '\uff21.txt', data: utf8('fullwidth A') },
      { path: 'A.txt', data: utf8('A') },
    ];
    expect(readZip(writeZip(entries)).paths()).toEqual(entries.map((e) => e.path));
    // U+FF21 sorts before U+1F6E2 by code point, although its UTF-16 code unit is larger.
    expect(readZip(writeZip(entries, { sort: true })).paths()).toEqual([
      'A.txt',
      'a/z.txt',
      'b.txt',
      '\uff21.txt',
      '\u{1f6e2}.txt',
    ]);
  });

  it('store STORED entries verbatim and deflate the others', () => {
    const zip = writeZip(SAMPLE);
    for (const record of centralRecords(zip)) {
      const input = SAMPLE.find((e) => e.path === record.name);
      expect(input).toBeDefined();
      if (input?.store === true) {
        expect(record.method).toBe(0);
        expect(record.compressedSize).toBe(input.data.length);
        expect(rawData(zip, record)).toEqual(input.data);
      } else {
        expect(record.method).toBe(8);
      }
    }
    const csv = centralRecords(zip).find((r) => r.name === 'manifest.json');
    expect(csv && csv.compressedSize).toBeGreaterThan(0);
  });

  it('dates every entry 1980-01-01 00:00:00 and writes no extra fields', () => {
    const zip = writeZip(SAMPLE);
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (const record of centralRecords(zip)) {
      expect(v.getUint16(record.at + 12, true)).toBe(0);
      expect(v.getUint16(record.at + 14, true)).toBe(0x21);
      expect(v.getUint16(record.at + 30, true)).toBe(0);
    }
  });

  it('marks only non-ASCII names as UTF-8', () => {
    const zip = writeZip(SAMPLE);
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const flags = Object.fromEntries(centralRecords(zip).map((r) => [r.name, v.getUint16(r.at + 8, true)]));
    expect(flags['manifest.json']).toBe(0);
    expect(flags['data/donn\u00e9es/\u6cb9\u4e95.csv']).toBe(0x0800);
  });

  it('writes and reads an empty archive', () => {
    const zip = writeZip([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip).paths()).toEqual([]);
  });

  it.each([
    ['an empty path', ''],
    ['an absolute path', '/etc/passwd'],
    ['a drive letter', 'C:/data.csv'],
    ['a backslash', 'data\\wells.csv'],
    ['a parent segment', 'data/../wells.csv'],
    ['a dot segment', './wells.csv'],
    ['an empty segment', 'data//wells.csv'],
    ['a directory path', 'data/'],
    ['a NUL character', 'wells\u0000.csv'],
    ['a lone high surrogate', 'wells\ud800.csv'],
    ['a lone low surrogate', '\udc00wells.csv'],
  ])('refuses %s', (_label, path) => {
    expect(thrown(() => writeZip([{ path, data: utf8('x') }])).code).toBe('INVALID_INPUT');
  });

  it('writes 65,534 entries but refuses 65,535, which would need ZIP64', () => {
    const entries = Array.from({ length: 65_535 }, (_, i) => ({ path: `f${i}`, data: new Uint8Array(0), store: true }));
    const zip = writeZip(entries.slice(0, 65_534));
    expect(readZip(zip, { maxEntries: 65_534 }).paths()).toHaveLength(65_534);
    expect(thrown(() => writeZip(entries)).code).toBe('INVALID_INPUT');
  });

  it('refuses duplicate paths', () => {
    const entries = [
      { path: 'a.txt', data: utf8('1') },
      { path: 'a.txt', data: utf8('2') },
    ];
    expect(thrown(() => writeZip(entries)).message).toContain('more than once');
  });

  it('never writes an archive its own reader refuses: distinct lone surrogates would both become U+FFFD', () => {
    const entries = [
      { path: 'a\ud800', data: utf8('1') },
      { path: 'a\udbff', data: utf8('2') },
    ];
    expect(thrown(() => writeZip(entries)).code).toBe('INVALID_INPUT');
  });

  it('deflates with fflate at level 6', () => {
    const zip = writeZip(SAMPLE);
    for (const record of centralRecords(zip).filter((r) => r.method === 8)) {
      const input = SAMPLE.find((e) => e.path === record.name);
      expect(rawData(zip, record)).toEqual(deflateSync(input?.data ?? new Uint8Array(0), { level: 6 }));
    }
  });

  it('reads an archive that sits inside a larger buffer (a non-zero byte offset)', () => {
    const zip = writeZip(SAMPLE);
    const padded = new Uint8Array(zip.length + 64).fill(0x50);
    padded.set(zip, 32);
    const reader = readZip(padded.subarray(32, 32 + zip.length));
    expect(contents(reader)).toEqual(contents(readZip(zip)));
    expect(contents(readZip(toZip64(padded.subarray(32, 32 + zip.length))))).toEqual(contents(reader));
  });
});

describe.skipIf(!PYTHON_AVAILABLE)('interoperability with Python zipfile', () => {
  it('opens writeZip output with every CRC, size, method and date as written', () => {
    const listing = pythonList(writeZip(SAMPLE));
    expect(listing.bad).toBeNull();
    expect(listing.entries.map((e) => e.name)).toEqual(SAMPLE.map((e) => e.path));
    listing.entries.forEach((entry, i) => {
      const input = SAMPLE[i];
      expect(entry.sha256).toBe(sha256Hex(input?.data ?? new Uint8Array(0)));
      expect(entry.size).toBe(input?.data.length);
      expect(entry.method).toBe(input?.store === true ? 0 : 8);
      expect(entry.date).toEqual([1980, 1, 1, 0, 0, 0]);
    });
  });

  it('reads archives Python writes to a pipe, with data descriptors and a directory entry', () => {
    const zip = runPython([
      'import sys, zipfile',
      'with zipfile.ZipFile(sys.stdout.buffer, "w", compression=zipfile.ZIP_DEFLATED) as z:',
      '    z.writestr("dir/", b"")',
      '    z.writestr("dir/rates.csv", b"well,rate\\n" * 2000)',
      '    z.writestr(zipfile.ZipInfo("stored.bin"), bytes(range(256)) * 4, compress_type=zipfile.ZIP_STORED)',
      '    z.writestr("caf\\u00e9.txt", "Temp \\u00b0C".encode("utf-8"))',
    ]);
    const reader = readZip(zip);
    expect(reader.paths()).toEqual(['dir/rates.csv', 'stored.bin', 'caf\u00e9.txt']);
    expect(new TextDecoder().decode(reader.read('dir/rates.csv'))).toBe('well,rate\n'.repeat(2000));
    expect(reader.read('stored.bin')).toEqual(Uint8Array.from({ length: 1024 }, (_, i) => i % 256));
    expect(reader.readText('caf\u00e9.txt')).toBe('Temp \u00b0C');
  });

  it('finds the data after a local header extra field that the central directory does not repeat', () => {
    // force_zip64 puts a ZIP64 extra field in each local header only, so the data offset depends
    // on the local extra length; written to a pipe, the sizes also move to ZIP64 data descriptors.
    const zip = runPython([
      'import sys, zipfile',
      'with zipfile.ZipFile(sys.stdout.buffer, "w", compression=zipfile.ZIP_DEFLATED) as z:',
      '    for name, method in (("rates.csv", zipfile.ZIP_DEFLATED), ("raw.bin", zipfile.ZIP_STORED)):',
      '        info = zipfile.ZipInfo(name)',
      '        info.compress_type = method',
      '        with z.open(info, "w", force_zip64=True) as f:',
      '            f.write(b"well,rate\\n" * 300)',
    ]);
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(v.getUint16(28, true), 'the first local header has an extra field').toBeGreaterThan(0);
    const reader = readZip(zip);
    expect(reader.paths()).toEqual(['rates.csv', 'raw.bin']);
    for (const path of reader.paths()) expect(reader.readText(path)).toBe('well,rate\n'.repeat(300));
  });

  it('accepts the ZIP64 rewriter used below as a valid archive', () => {
    const listing = pythonList(toZip64(writeZip(SAMPLE)));
    expect(listing.bad).toBeNull();
    expect(listing.entries.map((e) => e.sha256)).toEqual(SAMPLE.map((e) => sha256Hex(e.data)));
  });
});

describe('readZip structure handling', () => {
  it('reads ZIP64 end records and ZIP64 extra fields', () => {
    const reader = readZip(toZip64(writeZip(SAMPLE)));
    expect(contents(reader)).toEqual(contents(readZip(writeZip(SAMPLE))));
  });

  it('reads a name without the UTF-8 flag that is not UTF-8 as CP437', () => {
    const zip = writeZip([{ path: 'caf?.txt', data: utf8('x') }]);
    const [record] = centralRecords(zip);
    if (record === undefined) throw new Error('no entry');
    const patched = renameBoth(zip, record, Uint8Array.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74]));
    expect(readZip(patched).paths()).toEqual(['caf\u00e9.txt']);
  });

  it('reads entry text as UTF-8 without a byte-order mark', () => {
    const text = 'Temp \u00b0C';
    const zip = writeZip([{ path: 'a.txt', data: Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(text)]) }]);
    expect(readZip(zip).readText('a.txt')).toBe(text);
  });

  it('refuses entry text that is not UTF-8', () => {
    const zip = writeZip([{ path: 'a.txt', data: Uint8Array.from([0x61, 0xff]) }]);
    expect(thrown(() => readZip(zip).readText('a.txt')).code).toBe('PROJECT_INVALID');
  });

  it('reports a missing entry as NOT_FOUND', () => {
    const reader = readZip(writeZip(SAMPLE));
    expect(reader.has('nope.txt')).toBe(false);
    expect(thrown(() => reader.read('nope.txt')).code).toBe('NOT_FOUND');
    expect(thrown(() => reader.size('nope.txt')).code).toBe('NOT_FOUND');
  });

  it('returns a fresh array on every read, so callers may transfer or change it', () => {
    const reader = readZip(writeZip(SAMPLE));
    const first = reader.read('mimetype');
    first.fill(0);
    expect(new TextDecoder().decode(reader.read('mimetype'))).toBe('application/vnd.tracewell.project+zip');
  });

  it('returns a fresh array for a stored entry of an archive held in a Node Buffer', () => {
    // Buffer#slice returns a view sharing the archive's memory, unlike Uint8Array#slice.
    const reader = readZip(Buffer.from(writeZip(SAMPLE)));
    reader.read('mimetype').fill(0);
    expect(new TextDecoder().decode(reader.read('mimetype'))).toBe('application/vnd.tracewell.project+zip');
  });

  it('refuses bytes that are not a ZIP archive', () => {
    const error = thrown(() => readZip(utf8('well,rate\nA-1,42\n'.repeat(10))));
    expect(error.code).toBe('FORMAT_UNSUPPORTED');
    expect(error.message).toContain('not a ZIP archive');
  });

  it('refuses a truncated archive', () => {
    const zip = writeZip(SAMPLE);
    const error = thrown(() => readZip(zip.subarray(0, zip.length - 30)));
    expect(['FORMAT_UNSUPPORTED', 'PROJECT_INVALID']).toContain(error.code);
  });

  it('refuses an archive whose central directory points outside the file', () => {
    const zip = writeZip(SAMPLE);
    expect(thrown(() => readZip(withU32(zip, zip.length - 22 + 16, zip.length))).code).toBe('PROJECT_INVALID');
  });

  it('refuses encrypted entries', () => {
    const zip = writeZip(SAMPLE);
    const record = centralRecords(zip)[1];
    if (record === undefined) throw new Error('no entry');
    const error = thrown(() => readZip(patchBoth(zip, record, 'flags', 0x0001)));
    expect(error.code).toBe('FORMAT_UNSUPPORTED');
    expect(error.message).toContain('encrypted');
  });

  it('refuses compression methods other than STORED and DEFLATE', () => {
    const zip = writeZip(SAMPLE);
    const record = centralRecords(zip)[1];
    if (record === undefined) throw new Error('no entry');
    const error = thrown(() => readZip(patchBoth(zip, record, 'method', 12)));
    expect(error.code).toBe('FORMAT_UNSUPPORTED');
    expect(error.detail).toMatchObject({ method: 12 });
  });

  it('refuses duplicate entry names', () => {
    const zip = writeZip([
      { path: 'a.txt', data: utf8('1') },
      { path: 'b.txt', data: utf8('2') },
    ]);
    const second = centralRecords(zip)[1];
    if (second === undefined) throw new Error('no entry');
    const error = thrown(() => readZip(renameBoth(zip, second, utf8('a.txt'))));
    expect(error.code).toBe('PROJECT_INVALID');
    expect(error.message).toContain('more than once');
  });

  it('refuses a local header whose name differs from the central directory', () => {
    const zip = writeZip([{ path: 'a.txt', data: utf8('1') }]);
    const [record] = centralRecords(zip);
    if (record === undefined) throw new Error('no entry');
    const patched = zip.slice();
    patched.set(utf8('b'), record.localAt + 30);
    expect(thrown(() => readZip(patched)).code).toBe('PROJECT_INVALID');
  });

  it('finds the end record behind an archive comment, even one that contains a fake end signature', () => {
    const zip = writeZip(SAMPLE);
    // The comment holds a decoy end record that claims a 100-byte comment running past the file.
    const decoy = new Uint8Array(22);
    new DataView(decoy.buffer).setUint32(0, 0x06054b50, true);
    new DataView(decoy.buffer).setUint16(20, 100, true);
    const comment = Uint8Array.from([...utf8('note '), ...decoy, ...utf8(' end')]);
    const withComment = new Uint8Array(zip.length + comment.length);
    withComment.set(zip);
    withComment.set(comment, zip.length);
    new DataView(withComment.buffer).setUint16(zip.length - 2, comment.length, true);
    expect(contents(readZip(withComment))).toEqual(contents(readZip(zip)));
  });

  it('refuses a multi-disk archive', () => {
    const zip = writeZip(SAMPLE);
    const error = thrown(() => readZip(withU16(zip, zip.length - 22 + 4, 1)));
    expect(error.code).toBe('FORMAT_UNSUPPORTED');
    expect(error.message).toContain('multi-disk');
  });

  it('refuses a name flagged as UTF-8 that is not valid UTF-8', () => {
    const zip = writeZip([{ path: 'caf?.txt', data: utf8('x') }]);
    const [record] = centralRecords(zip);
    if (record === undefined) throw new Error('no entry');
    const renamed = renameBoth(zip, record, Uint8Array.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74]));
    expect(thrown(() => readZip(patchBoth(renamed, record, 'flags', 0x0800))).code).toBe('PROJECT_INVALID');
  });

  it('refuses a stored entry whose compressed and uncompressed sizes differ', () => {
    const zip = writeZip(SAMPLE);
    const record = centralRecords(zip).find((r) => r.name === 'mimetype');
    if (record === undefined) throw new Error('no entry');
    const error = thrown(() => readZip(patchBoth(zip, record, 'size', record.size + 1)));
    expect(error.code).toBe('PROJECT_INVALID');
    expect(error.message).toContain('different compressed and uncompressed sizes');
  });

  it('refuses a size marked as ZIP64 without a ZIP64 extra field', () => {
    const zip = writeZip(SAMPLE);
    const record = centralRecords(zip).find((r) => r.name === 'manifest.json');
    if (record === undefined) throw new Error('no entry');
    const error = thrown(() => readZip(withU32(zip, record.at + 24, 0xffffffff)));
    expect(error.code).toBe('PROJECT_INVALID');
    expect(error.message).toContain('ZIP64 extra field');
  });

  it.each([
    ['deflated', 'manifest.json'],
    ['stored', 'originals/ab12/wells daily.csv'],
  ])('detects a changed byte in %s data by its CRC-32', (_kind, path) => {
    const zip = writeZip(SAMPLE);
    const record = centralRecords(zip).find((r) => r.name === path);
    if (record === undefined) throw new Error('no entry');
    const data = rawData(zip, record);
    const patched = zip.slice();
    const at = data.byteOffset - zip.byteOffset + Math.floor(data.length / 2);
    patched[at] = (patched[at] ?? 0) ^ 0x01;
    const reader = readZip(patched);
    expect(thrown(() => reader.read(path)).code).toBe('PROJECT_INVALID');
    expect(reader.read('mimetype')).toEqual(SAMPLE[0]?.data);
  });
});

describe('readZip guards (zip bombs)', () => {
  const zeros = writeZip([{ path: 'zeros.bin', data: new Uint8Array(10 * MiB) }]);

  it('compresses the 10 MB bomb entry to a few kilobytes', () => {
    expect(zeros.length).toBeLessThan(64 * 1024);
  });

  it('rejects a 10 MB entry of zeros when maxInflatedBytes is 1 MB, with a clear error', () => {
    const error = thrown(() => readZip(zeros, { maxInflatedBytes: MiB }));
    expect(error.code).toBe('PROJECT_INVALID');
    expect(error.message).toBe('The archive would expand to 10,485,760 bytes, more than the limit of 1,048,576 bytes.');
    expect(error.fix).toContain('zip bombs');
    expect(error.detail).toEqual({ reason: 'inflated-size', declaredBytes: 10 * MiB, limit: MiB });
  });

  it('reads the same entry under the default cap', () => {
    // Compared by digest: a deep equality over ten million elements takes over a minute.
    expect(sha256Hex(readZip(zeros).read('zeros.bin'))).toBe(sha256Hex(new Uint8Array(10 * MiB)));
  });

  it('stops inflating an entry that expands beyond a falsely small declared size', () => {
    const [record] = centralRecords(zeros);
    if (record === undefined) throw new Error('no entry');
    const lying = patchBoth(zeros, record, 'size', 1000);
    const reader = readZip(lying, { maxInflatedBytes: MiB });
    expect(reader.size('zeros.bin')).toBe(1000);
    const error = thrown(() => reader.read('zeros.bin'));
    expect(error.code).toBe('PROJECT_INVALID');
    expect(error.detail).toMatchObject({ reason: 'entry-oversize', declaredBytes: 1000 });
  });

  it('refuses an entry that expands to less than its declared size', () => {
    const [record] = centralRecords(zeros);
    if (record === undefined) throw new Error('no entry');
    const reader = readZip(patchBoth(zeros, record, 'size', 10 * MiB + 1));
    expect(thrown(() => reader.read('zeros.bin')).detail).toMatchObject({ actualBytes: 10 * MiB });
  });

  describe('an entry whose compressed size runs far past the end of its DEFLATE stream', () => {
    const data = utf8('well,rate\nA-1,42\n');
    const padded = padCompressedData(writeZip([{ path: 'a.csv', data }]), 8 * MiB);

    /** Counts the input slices handed to the inflater while `action` runs. */
    function pushesDuring(action: () => void): number {
      const push = vi.spyOn(Inflate.prototype, 'push');
      try {
        action();
        return push.mock.calls.length;
      } finally {
        push.mockRestore();
      }
    }

    it('is read without decoding or re-copying the bytes after the stream ends', () => {
      // Bytes pushed after the end were appended to, and copied with, everything still pending on
      // every push, so the cost grew with the square of their length: a CPU bomb in a few MB.
      let read: Uint8Array | undefined;
      const pushes = pushesDuring(() => {
        read = readZip(padded).read('a.csv');
      });
      expect(read).toEqual(data);
      expect(pushes).toBeLessThanOrEqual(2);
    });

    it('is reported as too short just as quickly when it declares more bytes than the stream holds', () => {
      const [record] = centralRecords(padded);
      if (record === undefined) throw new Error('no entry');
      const reader = readZip(patchBoth(padded, record, 'size', data.length + 1));
      let error: EngineError | undefined;
      const pushes = pushesDuring(() => {
        error = thrown(() => reader.read('a.csv'));
      });
      expect(error?.code).toBe('PROJECT_INVALID');
      expect(error?.detail).toMatchObject({ actualBytes: data.length });
      expect(pushes).toBeLessThanOrEqual(2);
    });
  });

  it('rejects more entries than maxEntries', () => {
    const many = writeZip(Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.txt`, data: utf8(String(i)) })));
    expect(readZip(many, { maxEntries: 5 }).paths()).toHaveLength(5);
    const error = thrown(() => readZip(many, { maxEntries: 4 }));
    expect(error.code).toBe('PROJECT_INVALID');
    expect(error.detail).toEqual({ reason: 'entry-count', entries: 5, limit: 4 });
  });

  it.each([-1, 1.5, Number.NaN])('refuses the cap %s', (cap) => {
    expect(thrown(() => readZip(zeros, { maxInflatedBytes: cap })).code).toBe('INVALID_INPUT');
  });
});

describe('checksum files', () => {
  const files: Record<string, Uint8Array> = {
    'README.txt': utf8('How to verify: sha256sum -c CHECKSUMS.sha256\n'),
    'data/wells.csv': utf8('well,rate\r\nA-1,42\r\n'),
    'name with spaces.txt': utf8('spaces'),
    'donn\u00e9es.csv': utf8('x\n'),
    'manifest.json': utf8('{}'),
  };
  const entries = Object.entries(files).map(([path, data]) => ({ path, sha256: sha256Hex(data) }));

  it('round-trip through checksumsFile and parseChecksumsFile, sorted by path', () => {
    const text = checksumsFile(entries);
    const parsed = parseChecksumsFile(text);
    expect(parsed.map((e) => e.path)).toEqual([
      'README.txt',
      'data/wells.csv',
      'donn\u00e9es.csv',
      'manifest.json',
      'name with spaces.txt',
    ]);
    expect(new Map(parsed.map((e) => [e.path, e.sha256]))).toEqual(new Map(entries.map((e) => [e.path, e.sha256])));
    expect(text.split('\n')[0]).toBe(`${sha256Hex(files['README.txt'] ?? '')}  README.txt`);
    expect(text.endsWith('\n')).toBe(true);
  });

  const sha256sum = spawnSync('sha256sum', ['--version']).status === 0;

  it.skipIf(!sha256sum)('writes a file that `sha256sum -c` accepts, and that catches a changed file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracewell-io-sums-'));
    try {
      for (const [path, data] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), data);
      }
      writeFileSync(join(dir, 'CHECKSUMS.sha256'), checksumsFile(entries));
      const ok = spawnSync('sha256sum', ['-c', '--strict', 'CHECKSUMS.sha256'], { cwd: dir });
      expect(ok.status, ok.stderr.toString()).toBe(0);
      expect(ok.stdout.toString()).toContain('data/wells.csv: OK');
      expect(ok.stdout.toString()).toContain('name with spaces.txt: OK');

      writeFileSync(join(dir, 'data/wells.csv'), 'tampered');
      const bad = spawnSync('sha256sum', ['-c', 'CHECKSUMS.sha256'], { cwd: dir });
      expect(bad.status).not.toBe(0);
      expect(bad.stdout.toString()).toContain('data/wells.csv: FAILED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
