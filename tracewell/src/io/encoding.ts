/**
 * Text encoding sniffing and decoding (FR-IMP-07/08). Sniffing never blocks: when the bytes prove
 * nothing it falls back to windows-1252 and says so through a low-confidence, assumed detection.
 *
 * Order of evidence: byte-order mark, then the zero-byte pattern of UTF-16 without a mark, then
 * strict UTF-8 validation, then the windows-1252 fallback.
 */
import { detection, type Detection, type TextEncodingName } from '@tw/model';
import { formatCount, invalidArgument } from './errors';
import { decodeWindows1252 } from './windows1252';

export type EncodingDetection = Detection<TextEncodingName> & { bomLength: number };

interface Bom {
  bytes: readonly number[];
  encoding: TextEncodingName;
  label: string;
}

const BOMS: readonly Bom[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8', label: 'UTF-8 byte-order mark (EF BB BF)' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le', label: 'UTF-16 little-endian byte-order mark (FF FE)' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be', label: 'UTF-16 big-endian byte-order mark (FE FF)' },
];

/**
 * UTF-16 text without a mark that is mostly ASCII has a zero in one byte of nearly every pair. The
 * thresholds leave room for non-ASCII characters while ruling out ordinary 8-bit text.
 */
const UTF16_MIN_ZERO_SHARE = 0.5;
const UTF16_MAX_OTHER_ZERO_SHARE = 0.1;
const UTF16_MIN_PAIRS = 2;

function withBom(encoding: TextEncodingName, bomLength: number, d: Detection<TextEncodingName>): EncodingDetection {
  return { ...d, value: encoding, bomLength };
}

export function sniffEncoding(head: Uint8Array): EncodingDetection {
  return sniffBom(head) ?? sniffUtf16(head) ?? sniffUtf8(head) ?? fallback(head);
}

function sniffBom(head: Uint8Array): EncodingDetection | null {
  const bom = BOMS.find((b) => b.bytes.every((byte, i) => head[i] === byte));
  if (bom === undefined) return null;
  const evidence = `The file starts with the ${bom.label}.`;
  return withBom(bom.encoding, bom.bytes.length, detection(bom.encoding, 'high', 'bom', evidence));
}

function sniffUtf16(head: Uint8Array): EncodingDetection | null {
  const pairs = Math.floor(head.length / 2);
  if (pairs < UTF16_MIN_PAIRS) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < pairs * 2; i += 2) {
    if (head[i] === 0) evenZeros++;
    if (head[i + 1] === 0) oddZeros++;
  }
  const looksLike = (zeros: number, other: number): boolean =>
    zeros / pairs >= UTF16_MIN_ZERO_SHARE && other / pairs <= UTF16_MAX_OTHER_ZERO_SHARE;
  // Little-endian ASCII puts the zero second (41 00); big-endian puts it first (00 41).
  const encoding: TextEncodingName | null = looksLike(oddZeros, evenZeros)
    ? 'utf-16le'
    : looksLike(evenZeros, oddZeros)
      ? 'utf-16be'
      : null;
  if (encoding === null) return null;
  const zeros = encoding === 'utf-16le' ? oddZeros : evenZeros;
  const share = Math.round((zeros / pairs) * 100);
  const evidence =
    `There is no byte-order mark, but ${share}% of the ${formatCount(pairs)} byte pairs read have a zero ` +
    `${encoding === 'utf-16le' ? 'second' : 'first'} byte, the pattern of ${encoding.toUpperCase()} text.`;
  return withBom(encoding, 0, detection(encoding, 'medium', 'utf16-zero-pattern', evidence));
}

function sniffUtf8(head: Uint8Array): EncodingDetection | null {
  const scan = scanUtf8(head);
  if (scan.invalidAt >= 0) return null;
  if (head.length === 0) {
    return withBom(
      'utf-8',
      0,
      detection('utf-8', 'high', 'empty', 'The file is empty, so any encoding reads it the same.'),
    );
  }
  if (scan.multiByte === 0 && scan.cutOffAt >= 0) return cutOffOnly(head, scan.cutOffAt);
  if (scan.multiByte === 0) {
    const evidence = `The first ${formatCount(head.length)} bytes are plain ASCII, which reads the same in UTF-8.`;
    return withBom('utf-8', 0, detection('utf-8', 'high', 'ascii', evidence));
  }
  const evidence =
    `The first ${formatCount(head.length)} bytes are valid UTF-8 and contain ` +
    `${formatCount(scan.multiByte)} multi-byte characters.`;
  return withBom('utf-8', 0, detection('utf-8', 'high', 'utf8-valid', evidence));
}

/**
 * ASCII followed by the start of a multi-byte sequence at the very end proves nothing: it is UTF-8
 * if the file goes on past the bytes read, but if the file ends there it is not UTF-8 at all (a
 * windows-1252 file ending in, say, 'a-acute' looks exactly like this). UTF-8 stays the better guess
 * for a head cut from a longer file, so it is applied, but marked as assumed.
 */
function cutOffOnly(head: Uint8Array, at: number): EncodingDetection {
  const evidence =
    `The bytes read are plain ASCII except for an incomplete multi-byte sequence at offset ${formatCount(at)}, ` +
    'the very end. UTF-8 is assumed; if the file ends there, it is not UTF-8 and is probably windows-1252.';
  return withBom('utf-8', 0, detection('utf-8', 'medium', 'utf8-cut-off', evidence));
}

function fallback(head: Uint8Array): EncodingDetection {
  const at = scanUtf8(head).invalidAt;
  const byte = (head[at] ?? 0).toString(16).toUpperCase().padStart(2, '0');
  const evidence =
    `Byte 0x${byte} at offset ${formatCount(at)} is not valid UTF-8 and there is no byte-order mark, ` +
    'so windows-1252 (Western European) is assumed.';
  return withBom('windows-1252', 0, detection('windows-1252', 'low', 'fallback-windows-1252', evidence, 'default'));
}

interface Utf8Scan {
  /** Offset of the first byte that breaks UTF-8, or -1 when the bytes are valid. */
  invalidAt: number;
  /** Count of complete characters encoded in more than one byte. */
  multiByte: number;
  /** Offset of a valid but incomplete sequence cut off by the end of the bytes, or -1. */
  cutOffAt: number;
}

/**
 * Strict UTF-8 validation per Unicode Table 3-7: no overlong forms, no surrogates, nothing above
 * U+10FFFF. A sequence cut off by the end of the buffer is accepted when its bytes so far are
 * valid, because the head handed to sniffEncoding is usually a slice of a longer file.
 */
function scanUtf8(bytes: Uint8Array): Utf8Scan {
  let multiByte = 0;
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i] ?? 0;
    if (lead < 0x80) {
      i++;
      continue;
    }
    const length = sequenceLength(bytes, i);
    if (length === 0) return { invalidAt: i, multiByte, cutOffAt: -1 };
    if (i + length > bytes.length) return { invalidAt: -1, multiByte, cutOffAt: i };
    multiByte++;
    i += length;
  }
  return { invalidAt: -1, multiByte, cutOffAt: -1 };
}

/** Allowed range of the second byte for each lead byte; later bytes are always 0x80-0xBF. */
function secondByteRange(lead: number): [number, number, number] | null {
  if (lead >= 0xc2 && lead <= 0xdf) return [2, 0x80, 0xbf];
  if (lead === 0xe0) return [3, 0xa0, 0xbf];
  if (lead === 0xed) return [3, 0x80, 0x9f];
  if (lead >= 0xe1 && lead <= 0xef) return [3, 0x80, 0xbf];
  if (lead === 0xf0) return [4, 0x90, 0xbf];
  if (lead >= 0xf1 && lead <= 0xf3) return [4, 0x80, 0xbf];
  if (lead === 0xf4) return [4, 0x80, 0x8f];
  return null;
}

/**
 * Length of the valid multi-byte sequence starting at `i`, or 0 when it is invalid. A sequence cut
 * off by the end of `bytes` whose bytes so far are valid still reports its full length.
 */
function sequenceLength(bytes: Uint8Array, i: number): number {
  const range = secondByteRange(bytes[i] ?? 0);
  if (range === null) return 0;
  const [length, low, high] = range;
  for (let k = 1; k < length && i + k < bytes.length; k++) {
    const b = bytes[i + k] ?? 0;
    const [min, max] = k === 1 ? [low, high] : [0x80, 0xbf];
    if (b < min || b > max) return 0;
  }
  return length;
}

// ---------------------------------------------------------------------------------------------
// Decoding

interface ChunkDecoder {
  /** Decodes the next chunk; `final` flushes a sequence left incomplete at the end as U+FFFD. */
  decode(chunk: Uint8Array, final: boolean): string;
}

function chunkDecoder(encoding: TextEncodingName): ChunkDecoder {
  if (encoding === 'windows-1252') return { decode: (chunk) => decodeWindows1252(chunk) };
  // ignoreBOM: the caller decides how many mark bytes to skip; a mark it keeps stays in the text.
  const decoder = new TextDecoder(encoding, { ignoreBOM: true });
  return { decode: (chunk, final) => decoder.decode(chunk, { stream: !final }) };
}

function checkBomLength(bomLength: number): void {
  if (!Number.isInteger(bomLength) || bomLength < 0) {
    throw invalidArgument(`The byte-order mark length ${String(bomLength)} is not a whole number of bytes.`, {
      bomLength: String(bomLength),
    });
  }
}

/**
 * Decodes a whole buffer after skipping `bomLength` bytes. Invalid sequences become U+FFFD, so a
 * damaged byte stays visible in the text rather than stopping the import.
 */
export function decodeAll(bytes: Uint8Array, encoding: TextEncodingName, bomLength: number): string {
  checkBomLength(bomLength);
  return chunkDecoder(encoding).decode(bytes.subarray(Math.min(bomLength, bytes.length)), true);
}

/**
 * Streaming form of decodeAll: the concatenated output equals decodeAll of the concatenated input,
 * however the chunks split multi-byte characters, surrogate pairs or the byte-order mark.
 */
export function decodeStream(
  stream: ReadableStream<Uint8Array>,
  encoding: TextEncodingName,
  bomLength: number,
): ReadableStream<string> {
  checkBomLength(bomLength);
  const decoder = chunkDecoder(encoding);
  let toSkip = bomLength;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, string>({
      transform(chunk, controller) {
        const skip = Math.min(toSkip, chunk.byteLength);
        toSkip -= skip;
        const text = decoder.decode(chunk.subarray(skip), false);
        if (text !== '') controller.enqueue(text);
      },
      flush(controller) {
        const text = decoder.decode(new Uint8Array(0), true);
        if (text !== '') controller.enqueue(text);
      },
    }),
  );
}
