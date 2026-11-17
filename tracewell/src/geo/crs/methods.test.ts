/**
 * The worked examples of IOGP Geomatics Guidance Note 7-2 (September 2019), to the precision the
 * note prints them.
 */
import { describe, expect, it } from 'vitest';
import {
  ellipsoid,
  fromGeocentric,
  helmert,
  lambertConic1,
  lambertConic2,
  lccForward,
  lccReverse,
  tmForward,
  tmReverse,
  toGeocentric,
  transverseMercator,
} from './methods';

const D = Math.PI / 180;
const dms = (d: number, m: number, s: number) => (d + m / 60 + s / 3600) * D;
/** Degrees, minutes and seconds to the thousandth of a second, as the note prints them. */
const toDms = (rad: number) => {
  const ms = Math.round(Math.abs(rad / D) * 3600000);
  const s = (ms % 60000) / 1000;
  return `${Math.floor(ms / 3600000)}°${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}'${s.toFixed(3).padStart(6, '0')}"`;
};
/** Within a centimetre of a value the note prints: some of its final values are a few millimetres
 * off its own intermediate values, which this code matches to every printed digit. */
const nearly = (got: number[], printed: number[]) =>
  got.forEach((v, i) => expect(Math.abs(v - (printed[i] as number))).toBeLessThan(0.01));
const US_FOOT = 1200 / 3937;

describe('EPSG Guidance Note 7-2 worked examples', () => {
  it('Transverse Mercator (9807, JHS): OSGB 1936 / British National Grid', () => {
    const airy = ellipsoid(6377563.396, 1 / 299.3249646);
    const bng = transverseMercator(airy, dms(49, 0, 0), -dms(2, 0, 0), 0.9996012717, 400000, -100000);
    expect([bng.b.toFixed(3), bng.m0.toFixed(3)]).toEqual(['6366914.609', '5429228.602']);
    expect(bng.h.map((h) => h.toPrecision(6))).toEqual(['0.000834745', '7.55435e-7', '1.18487e-9', '2.40864e-12']);
    const [e, n] = tmForward(bng, dms(50, 30, 0), dms(0, 30, 0));
    // The note's eta and xi, from which its easting and northing are 577274.98 and 69740.49.
    expect([
      ((e - 400000) / (0.9996012717 * bng.b)).toFixed(10),
      ((n + 100000) / 0.9996012717 / bng.b + bng.m0 / bng.b).toFixed(10),
    ]).toEqual(['0.0278542603', '0.8793956171']);
    nearly([e, n], [577274.99, 69740.5]);
    const [phi, lambda] = tmReverse(bng, e, n);
    expect([toDms(phi), toDms(lambda)]).toEqual(['50°30\'00.000"', '0°30\'00.000"']);
  });

  it('Lambert Conic Conformal (9802): NAD27 / Texas South Central, in US survey feet', () => {
    const clarke = ellipsoid(6378206.4, (6378206.4 - 6356583.8) / 6378206.4);
    const p = lambertConic2(
      clarke,
      dms(27, 50, 0),
      -dms(99, 0, 0),
      dms(28, 23, 0),
      dms(30, 17, 0),
      2000000 * US_FOOT,
      0,
    );
    const [e, n] = lccForward(p, dms(28, 30, 0), -dms(96, 0, 0));
    expect([(e / US_FOOT).toFixed(2), (n / US_FOOT).toFixed(2)]).toEqual(['2963503.91', '254759.80']);
    const [phi, lambda] = lccReverse(p, e, n);
    expect([toDms(phi), toDms(lambda)]).toEqual(['28°30\'00.000"', '96°00\'00.000"']);
  });

  it('Lambert Conic Conformal (9801): JAD69 / Jamaica National Grid', () => {
    const clarke = ellipsoid(6378206.4, (6378206.4 - 6356583.8) / 6378206.4);
    const p = lambertConic1(clarke, dms(18, 0, 0), -dms(77, 0, 0), 1, 250000, 150000);
    const [e, n] = lccForward(p, dms(17, 55, 55.8), -dms(76, 56, 37.26));
    expect([e.toFixed(2), n.toFixed(2)]).toEqual(['255966.58', '142493.51']);
    const [phi, lambda] = lccReverse(p, e, n);
    expect([toDms(phi), toDms(lambda)]).toEqual(['17°55\'55.800"', '76°56\'37.260"']);
  });

  it('Geographic/geocentric conversion (9602): a North Sea point on WGS 84', () => {
    const wgs84 = ellipsoid(6378137, 1 / 298.257223563);
    const [phi, lambda] = fromGeocentric(wgs84, 3771793.968, 140253.342, 5124304.349);
    expect([toDms(phi), toDms(lambda)]).toEqual(['53°48\'33.820"', '2°07\'46.380"']);
    // And back, at the ellipsoid: the round trip closes to well under a millimetre.
    const [x, y, z] = toGeocentric(wgs84, phi, lambda);
    const [phi2, lambda2] = fromGeocentric(wgs84, x, y, z);
    expect(Math.abs(phi2 - phi) * 6.4e6).toBeLessThan(1e-6);
    expect(Math.abs(lambda2 - lambda) * 6.4e6).toBeLessThan(1e-6);
  });

  it('Position vector (1033) and coordinate frame (1032): WGS 72 to WGS 84', () => {
    const pv = { tx: 0, ty: 0, tz: 4.5, rx: 0, ry: 0, rz: 0.554, ds: 0.219, positionVector: true };
    const out = helmert(pv, false, 3657660.66, 255768.55, 5201382.11);
    nearly(out, [3657660.78, 255778.43, 5201387.75]);
    const cf = { ...pv, rz: -0.554, positionVector: false };
    expect(helmert(cf, false, 3657660.66, 255768.55, 5201382.11)).toEqual(out);
    // The reverse is the same formula with every sign changed; it closes to a few millimetres.
    const back = helmert(
      pv,
      true,
      ...(helmert(pv, false, 3657660.66, 255768.55, 5201382.11) as [number, number, number]),
    );
    expect(Math.abs((back[0] as number) - 3657660.66)).toBeLessThan(0.01);
  });

  it('Geocentric translations (1031): WGS 84 to ED50 in the North Sea', () => {
    const t = { tx: 84.87, ty: 96.49, tz: 116.95, rx: 0, ry: 0, rz: 0, ds: 0, positionVector: true };
    expect(helmert(t, false, 3771793.97, 140253.34, 5124304.35).map((v) => v.toFixed(2))).toEqual([
      '3771878.84',
      '140349.83',
      '5124421.30',
    ]);
  });
});

describe('round trips', () => {
  it('Transverse Mercator closes to well under a millimetre within 40 degrees of the central meridian', () => {
    const wgs84 = ellipsoid(6378137, 1 / 298.257223563);
    const utm31 = transverseMercator(wgs84, 0, 3 * D, 0.9996, 500000, 0);
    let worst = 0;
    for (let lat = -80; lat <= 80; lat += 4.7) {
      for (let dl = -39; dl <= 39; dl += 3.3) {
        const [e, n] = tmForward(utm31, lat * D, (3 + dl) * D);
        const [phi, lambda] = tmReverse(utm31, e, n);
        worst = Math.max(worst, Math.abs(phi - lat * D) * 6.4e6, Math.abs(lambda - (3 + dl) * D) * 6.4e6);
      }
    }
    expect(worst).toBeLessThan(1e-4);
  });
});
