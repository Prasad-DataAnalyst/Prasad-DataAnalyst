import { describe, expect, it } from 'vitest';
import REFERENCE from './__fixtures__/esri-wkt.json';
import { esriWkt, wktNumber } from './wkt';

describe('ESRI WKT', () => {
  it.each(Object.entries(REFERENCE.wkt))('%s is the text ESRI publishes', (code, text) => {
    expect(esriWkt(code)).toBe(text);
  });

  it('describes CRS84 as WGS 84 and nothing outside the registry', () => {
    expect(esriWkt('OGC:CRS84')).toBe(REFERENCE.wkt['EPSG:4326']);
    expect(esriWkt('EPSG:3857')).toBeNull();
    expect(esriWkt('EPSG:32661')).toBeNull();
    expect(esriWkt('unknown')).toBeNull();
  });

  it('writes numbers as ESRI does', () => {
    const clarke = 6378206.4 / (6378206.4 - 6356583.8);
    expect([6378137, -2, 0.9996012717, clarke, Math.PI / 180].map(wktNumber)).toEqual([
      '6378137.0',
      '-2.0',
      '0.9996012717',
      '294.978698213898',
      '0.0174532925199433',
    ]);
  });
});
