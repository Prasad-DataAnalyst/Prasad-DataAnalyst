/** The test basemap the browser tests load is a valid PMTiles archive with a valid PNG tile. */
import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PMTiles, type RangeResponse, type Source } from 'pmtiles';
import { rasterPmtiles, solidPng } from '@tw/fixtures';
import { tileKind } from './map-style';

class BytesSource implements Source {
  constructor(private readonly bytes: Uint8Array) {}
  getKey(): string {
    return 'test.pmtiles';
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    return { data: this.bytes.slice(offset, offset + length).buffer };
  }
}

describe('the test basemap', () => {
  it('is a PNG whose chunks and image data check out', () => {
    const png = solidPng([10, 20, 30], 4);
    const view = new DataView(png.buffer, png.byteOffset);
    let at = 8;
    const chunks: string[] = [];
    while (at < png.length) {
      const length = view.getUint32(at);
      const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
      const body = png.subarray(at + 4, at + 8 + length);
      expect(view.getUint32(at + 8 + length), type).toBe(crc32(body));
      if (type === 'IDAT') {
        const rows = inflateSync(png.subarray(at + 8, at + 8 + length));
        expect([...rows.subarray(0, 13)]).toEqual([0, 10, 20, 30, 10, 20, 30, 10, 20, 30, 10, 20, 30]);
        expect(rows.length).toBe(4 * 13);
      }
      chunks.push(type);
      at += 12 + length;
    }
    expect(chunks).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it('reads back as a raster archive with one zoom-0 tile and its attribution', async () => {
    const archive = new PMTiles(new BytesSource(rasterPmtiles([200, 220, 240], 'Made for the tests')));
    const header = await archive.getHeader();
    expect(tileKind(header.tileType)).toBe('raster');
    expect([header.minZoom, header.maxZoom, header.numAddressedTiles]).toEqual([0, 0, 1]);
    expect(await archive.getMetadata()).toEqual({ name: 'Test basemap', attribution: 'Made for the tests' });
    const tile = await archive.getZxy(0, 0, 0);
    expect(new Uint8Array(tile?.data ?? new ArrayBuffer(0))).toEqual(solidPng([200, 220, 240]));
    expect(await archive.getZxy(1, 0, 0)).toBeUndefined();
  });
});
