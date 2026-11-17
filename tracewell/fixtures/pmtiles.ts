/**
 * A PMTiles archive (version 3) built in memory for the map tests: one zoom-0 raster tile, a PNG of
 * a single colour, so a basemap can be read from a local file without any real map data. Nothing
 * is compressed: the PNG holds stored DEFLATE blocks and the archive's directory and metadata are
 * plain, which every reader accepts.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
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

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typed = concat([new TextEncoder().encode(type), data]);
  return concat([u32be(data.length), typed, u32be(crc32(typed))]);
}

/** zlib data of stored (uncompressed) DEFLATE blocks. */
function zlibStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let at = 0; at < data.length || at === 0; at += 65535) {
    const block = data.subarray(at, Math.min(data.length, at + 65535));
    const last = at + 65535 >= data.length;
    const len = block.length;
    parts.push(new Uint8Array([last ? 1 : 0, len & 0xff, len >>> 8, ~len & 0xff, (~len >>> 8) & 0xff]), block);
    if (last) break;
  }
  let a = 1;
  let b = 0;
  for (const x of data) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  parts.push(u32be(((b << 16) | a) >>> 0));
  return concat(parts);
}

/** A PNG of one colour, `size` pixels square. */
export function solidPng(rgb: [number, number, number], size = 256): Uint8Array {
  const header = new Uint8Array(13);
  header.set(u32be(size), 0);
  header.set(u32be(size), 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const at = y * (1 + size * 3);
    for (let x = 0; x < size; x++) rows.set(rgb, at + 1 + x * 3);
  }
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlibStored(rows)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

/** A PMTiles archive holding one zoom-0 PNG tile of one colour, with `attribution` in its metadata. */
export function rasterPmtiles(rgb: [number, number, number], attribution = 'Test tiles'): Uint8Array {
  const tile = solidPng(rgb);
  // One entry: tile 0, run length 1, its length, offset 0 (written as offset + 1).
  const directory = new Uint8Array([...varint(1), ...varint(0), ...varint(1), ...varint(tile.length), ...varint(1)]);
  const metadata = new TextEncoder().encode(JSON.stringify({ name: 'Test basemap', attribution }));
  const header = new Uint8Array(127);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode('PMTiles'), 0);
  header[7] = 3;
  const rootAt = 127;
  const metadataAt = rootAt + directory.length;
  const tilesAt = metadataAt + metadata.length;
  const u64 = (at: number, n: number) => view.setBigUint64(at, BigInt(n), true);
  u64(8, rootAt);
  u64(16, directory.length);
  u64(24, metadataAt);
  u64(32, metadata.length);
  u64(40, tilesAt);
  u64(48, 0);
  u64(56, tilesAt);
  u64(64, tile.length);
  u64(72, 1);
  u64(80, 1);
  u64(88, 1);
  header[96] = 1; // clustered
  header[97] = 1; // internal compression: none
  header[98] = 1; // tile compression: none
  header[99] = 2; // tile type: PNG
  header[100] = 0; // min zoom
  header[101] = 0; // max zoom
  view.setInt32(102, -180e7, true);
  view.setInt32(106, -85e7, true);
  view.setInt32(110, 180e7, true);
  view.setInt32(114, 85e7, true);
  header[118] = 0;
  view.setInt32(119, 0, true);
  view.setInt32(123, 0, true);
  return concat([header, directory, metadata, tile]);
}
