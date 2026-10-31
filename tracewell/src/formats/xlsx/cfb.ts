/**
 * The OLE compound file container (MS-CFB) that holds a legacy Excel workbook: a small file system of
 * fixed-size sectors, chained through an allocation table, with a directory of named streams.
 * Only reading is supported. Every sector number is checked and every chain is bounded by the number
 * of sectors in the file, so a damaged or hostile file ends in an error, never in a loop or a read
 * outside the bytes.
 */
import { damagedWorkbook } from './errors';

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;
const HEADER_DIFAT = 109;
const DIRECTORY_ENTRY = 128;

export interface CfbEntry {
  name: string;
  /** 1 storage, 2 stream, 5 root. */
  type: number;
  start: number;
  size: number;
}

export function isCompoundFile(bytes: Uint8Array): boolean {
  return bytes.length >= 512 && SIGNATURE.every((b, i) => bytes[i] === b);
}

export class CompoundFile {
  readonly entries: readonly CfbEntry[];
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #sectorSize: number;
  readonly #miniSectorSize: number;
  readonly #miniCutoff: number;
  readonly #fat: Uint32Array;
  readonly #miniFat: Uint32Array;
  #miniStream: Uint8Array | null = null;

  constructor(bytes: Uint8Array) {
    if (!isCompoundFile(bytes)) throw damagedWorkbook('the file is not an OLE compound file.');
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sectorShift = this.#u16(0x1e);
    const miniShift = this.#u16(0x20);
    if ((sectorShift !== 9 && sectorShift !== 12) || miniShift !== 6) {
      throw damagedWorkbook(`the compound file has sectors of 2^${sectorShift} bytes, which is not valid.`);
    }
    this.#sectorSize = 1 << sectorShift;
    this.#miniSectorSize = 1 << miniShift;
    this.#miniCutoff = this.#u32(0x38);
    this.#fat = this.#readFat();
    this.#miniFat = this.#words(this.#chain(this.#u32(0x3c), FREE));
    this.entries = this.#readDirectory();
  }

  /** The bytes of the first stream with one of these names (compared without case), or null. */
  stream(...names: string[]): Uint8Array | null {
    const wanted = names.map((n) => n.toLowerCase());
    const entry = this.entries.find((e) => e.type === 2 && wanted.includes(e.name.toLowerCase()));
    return entry === undefined ? null : this.#read(entry);
  }

  has(name: string): boolean {
    return this.entries.some((e) => e.name.toLowerCase() === name.toLowerCase());
  }

  #u16(at: number): number {
    if (at + 2 > this.#bytes.length) throw damagedWorkbook('the compound file is cut short.');
    return this.#view.getUint16(at, true);
  }

  #u32(at: number): number {
    if (at + 4 > this.#bytes.length) throw damagedWorkbook('the compound file is cut short.');
    return this.#view.getUint32(at, true);
  }

  /** Sectors after the header sector; a last sector cut short still counts. */
  get #sectorCount(): number {
    return Math.max(0, Math.ceil((this.#bytes.length - this.#sectorSize) / this.#sectorSize));
  }

  #sector(n: number): Uint8Array {
    if (n >= this.#sectorCount) {
      throw damagedWorkbook(`the compound file refers to sector ${n}, which it does not have.`);
    }
    const start = (n + 1) * this.#sectorSize;
    return this.#bytes.subarray(start, Math.min(start + this.#sectorSize, this.#bytes.length));
  }

  #words(bytes: Uint8Array): Uint32Array {
    const out = new Uint32Array(Math.floor(bytes.length / 4));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, true);
    return out;
  }

  /** The FAT sectors named by the header and the DIFAT chain, joined. */
  #readFat(): Uint32Array {
    const count = this.#u32(0x2c);
    const ids: number[] = [];
    for (let i = 0; i < Math.min(count, HEADER_DIFAT); i++) ids.push(this.#u32(0x4c + i * 4));
    let next = this.#u32(0x44);
    const perDifat = this.#sectorSize / 4 - 1;
    for (let guard = 0; ids.length < count && next !== END_OF_CHAIN && next !== FREE; guard++) {
      if (guard > this.#sectorCount) throw damagedWorkbook('the compound file allocation table loops.');
      const words = this.#words(this.#sector(next));
      for (let i = 0; i < perDifat && ids.length < count; i++) ids.push(words[i] as number);
      next = words[perDifat] as number;
    }
    if (ids.length < count) throw damagedWorkbook('the compound file allocation table is incomplete.');
    const fat = new Uint32Array(count * (this.#sectorSize / 4));
    ids.forEach((id, i) => fat.set(this.#words(this.#sector(id)), i * (this.#sectorSize / 4)));
    return fat;
  }

  /** The sectors of a chain, joined; `none` is the start value that means an empty chain. */
  #chain(start: number, none: number): Uint8Array {
    const parts: Uint8Array[] = [];
    let n = start;
    for (let guard = 0; n !== END_OF_CHAIN && n !== none; guard++) {
      if (guard > this.#sectorCount || n >= this.#fat.length) {
        throw damagedWorkbook('a sector chain in the compound file is broken or loops.');
      }
      parts.push(this.#sector(n));
      n = this.#fat[n] as number;
    }
    return concat(parts);
  }

  #readDirectory(): CfbEntry[] {
    const dir = this.#chain(this.#u32(0x30), FREE);
    const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    const entries: CfbEntry[] = [];
    for (let at = 0; at + DIRECTORY_ENTRY <= dir.length; at += DIRECTORY_ENTRY) {
      const nameBytes = Math.min(view.getUint16(at + 0x40, true), 64);
      const units: number[] = [];
      for (let i = 0; i + 2 <= nameBytes - 2; i += 2) units.push(view.getUint16(at + i, true));
      const low = view.getUint32(at + 0x78, true);
      const high = view.getUint32(at + 0x7c, true);
      entries.push({
        name: String.fromCharCode(...units),
        type: view.getUint8(at + 0x42),
        start: view.getUint32(at + 0x74, true),
        // Version 3 files leave the high half undefined; no stream here is anywhere near 4 GiB.
        size: this.#sectorSize === 512 ? low : high * 2 ** 32 + low,
      });
    }
    if (entries[0]?.type !== 5) throw damagedWorkbook('the compound file has no root entry.');
    return entries;
  }

  #read(entry: CfbEntry): Uint8Array {
    if (entry.size > this.#bytes.length * 2) {
      throw damagedWorkbook(`the stream "${entry.name}" claims ${entry.size} bytes, more than the file holds.`);
    }
    const data =
      entry.size < this.#miniCutoff ? this.#readMini(entry.start, entry.size) : this.#chain(entry.start, FREE);
    if (data.length < entry.size) throw damagedWorkbook(`the stream "${entry.name}" is cut short.`);
    return data.subarray(0, entry.size);
  }

  #readMini(start: number, size: number): Uint8Array {
    if (size === 0) return new Uint8Array(0);
    if (this.#miniStream === null) {
      const root = this.entries[0] as CfbEntry;
      this.#miniStream = this.#chain(root.start, FREE);
    }
    const parts: Uint8Array[] = [];
    let n = start;
    const limit = this.#miniStream.length / this.#miniSectorSize;
    for (let guard = 0; n !== END_OF_CHAIN; guard++) {
      if (guard > limit || n >= this.#miniFat.length || n >= limit) {
        throw damagedWorkbook('a mini-sector chain in the compound file is broken or loops.');
      }
      parts.push(this.#miniStream.subarray(n * this.#miniSectorSize, (n + 1) * this.#miniSectorSize));
      n = this.#miniFat[n] as number;
    }
    return concat(parts);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
