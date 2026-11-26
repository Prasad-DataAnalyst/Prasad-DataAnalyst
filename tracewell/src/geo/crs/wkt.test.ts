import { describe, expect, it } from 'vitest';
import REFERENCE from './__fixtures__/esri-wkt.json';
import { esriWkt, ogcWkt, wktNumber } from './wkt';

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

describe('ogcWkt', () => {
  it('writes OGC WKT 1 with EPSG names and an AUTHORITY for every object, as geodesy.rs does', () => {
    expect(ogcWkt('EPSG:4326')).toBe(
      'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]',
    );
    expect(ogcWkt('OGC:CRS84')).toBe(ogcWkt('EPSG:4326'));
    expect(ogcWkt('EPSG:2154')).toBe(
      'PROJCS["RGF93 v1 / Lambert-93",GEOGCS["RGF93 v1",DATUM["RGF_1993",SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],AUTHORITY["EPSG","6171"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4171"]],PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["latitude_of_origin",46.5],PARAMETER["central_meridian",3],PARAMETER["standard_parallel_1",49],PARAMETER["standard_parallel_2",44],PARAMETER["false_easting",700000],PARAMETER["false_northing",6600000],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","2154"]]',
    );
    expect(ogcWkt('EPSG:32760')).toMatch(/^PROJCS\["WGS 84 \/ UTM zone 60S",GEOGCS\["WGS 84",/);
    expect(
      ogcWkt('EPSG:32760')?.endsWith(
        'PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",177],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",10000000],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","32760"]]',
      ),
    ).toBe(true);
    expect(ogcWkt('EPSG:3857')).toBeNull();
    expect(ogcWkt('ESRI:102001')).toBeNull();
  });
});
