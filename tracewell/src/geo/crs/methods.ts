/**
 * Coordinate operation methods of the EPSG Dataset, with the formulas of IOGP Geomatics Guidance
 * Note 7-2 (September 2019): geographic/geocentric conversion (method 9602), the Helmert
 * transformations (geocentric translations 1031, position vector 1033, coordinate frame 1032) and
 * the Transverse Mercator (9807, JHS formulas) and Lambert Conic Conformal (9801, 9802) map
 * projections. Angles are in radians and lengths in metres. Only the functions of exact.ts are
 * used, in an order that geodesy.rs in the native engine repeats, so both engines give the same bits.
 */
import { asin, asinh, atan, atan2, atanh, cos, cosh, HALF_PI, log, PI, pow, sin, sinh, tan, tanh } from './exact';

export interface Ellipsoid {
  a: number;
  f: number;
  e2: number;
  e: number;
}

export function ellipsoid(a: number, f: number): Ellipsoid {
  const e2 = 2 * f - f * f;
  return { a, f, e2, e: Math.sqrt(e2) };
}

/** Geocentric X, Y, Z of a point on the ellipsoid (height 0), as method 9602 gives them. */
export function toGeocentric(el: Ellipsoid, phi: number, lambda: number): [number, number, number] {
  const s = sin(phi);
  const nu = el.a / Math.sqrt(1 - el.e2 * s * s);
  const c = cos(phi);
  return [nu * c * cos(lambda), nu * c * sin(lambda), (1 - el.e2) * nu * s];
}

/** Latitude and longitude of a geocentric point, by the non-iterative formula of method 9602. */
export function fromGeocentric(el: Ellipsoid, x: number, y: number, z: number): [number, number] {
  const eps = el.e2 / (1 - el.e2);
  const b = el.a * (1 - el.f);
  const p = Math.sqrt(x * x + y * y);
  const q = atan2(z * el.a, p * b);
  const sq = sin(q);
  const cq = cos(q);
  const phi = atan2(z + eps * b * sq * sq * sq, p - el.e2 * el.a * cq * cq * cq);
  return [phi, atan2(y, x)];
}

/** Seven Helmert parameters: translations in metres, rotations in arc-seconds, scale in ppm. */
export interface Helmert {
  tx: number;
  ty: number;
  tz: number;
  rx: number;
  ry: number;
  rz: number;
  ds: number;
  /** Rotations as the position vector convention (1033) states them; else coordinate frame (1032). */
  positionVector: boolean;
}

const ARCSEC = PI / 648000;

/**
 * Applies the transformation, or its reverse: the same formula with the signs of every parameter
 * changed, as the EPSG Dataset defines the reverse of these methods.
 */
export function helmert(h: Helmert, reverse: boolean, x: number, y: number, z: number): [number, number, number] {
  const sign = reverse ? -1 : 1;
  const turn = h.positionVector ? sign : -sign;
  const rx = turn * h.rx * ARCSEC;
  const ry = turn * h.ry * ARCSEC;
  const rz = turn * h.rz * ARCSEC;
  const m = 1 + sign * h.ds * 1e-6;
  return [
    m * (x - rz * y + ry * z) + sign * h.tx,
    m * (rz * x + y - rx * z) + sign * h.ty,
    m * (-ry * x + rx * y + z) + sign * h.tz,
  ];
}

// ---------------------------------------------------------------------------------------------
// Transverse Mercator (9807), JHS formulas

export interface TransverseMercator {
  el: Ellipsoid;
  lambda0: number;
  k0: number;
  fe: number;
  fn: number;
  b: number;
  m0: number;
  h: [number, number, number, number];
  hr: [number, number, number, number];
}

export function transverseMercator(
  el: Ellipsoid,
  phi0: number,
  lambda0: number,
  k0: number,
  fe: number,
  fn: number,
): TransverseMercator {
  const n = el.f / (2 - el.f);
  const n2 = n * n;
  const n3 = n2 * n;
  const n4 = n3 * n;
  const b = (el.a / (1 + n)) * (1 + n2 / 4 + n4 / 64);
  const h: [number, number, number, number] = [
    n / 2 - (2 / 3) * n2 + (5 / 16) * n3 + (41 / 180) * n4,
    (13 / 48) * n2 - (3 / 5) * n3 + (557 / 1440) * n4,
    (61 / 240) * n3 - (103 / 140) * n4,
    (49561 / 161280) * n4,
  ];
  const hr: [number, number, number, number] = [
    n / 2 - (2 / 3) * n2 + (37 / 96) * n3 - (1 / 360) * n4,
    (1 / 48) * n2 + (1 / 15) * n3 - (437 / 1440) * n4,
    (17 / 480) * n3 - (37 / 840) * n4,
    (4397 / 161280) * n4,
  ];
  let m0: number;
  if (phi0 === 0) m0 = 0;
  else if (phi0 === HALF_PI) m0 = b * HALF_PI;
  else if (phi0 === -HALF_PI) m0 = -b * HALF_PI;
  else {
    const q0 = asinh(tan(phi0)) - el.e * atanh(el.e * sin(phi0));
    const xi0 = atan(sinh(q0));
    m0 = b * (xi0 + h[0] * sin(2 * xi0) + h[1] * sin(4 * xi0) + h[2] * sin(6 * xi0) + h[3] * sin(8 * xi0));
  }
  return { el, lambda0, k0, fe, fn, b, m0, h, hr };
}

function clampUnit(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

export function tmForward(p: TransverseMercator, phi: number, lambda: number): [number, number] {
  const { el, h } = p;
  const q = asinh(tan(phi)) - el.e * atanh(el.e * sin(phi));
  const beta = atan(sinh(q));
  const eta0 = atanh(cos(beta) * sin(lambda - p.lambda0));
  const xi0 = asin(clampUnit(sin(beta) * cosh(eta0)));
  let xi = xi0;
  let eta = eta0;
  for (let i = 0; i < 4; i++) {
    const k = 2 * (i + 1);
    xi += (h[i] as number) * sin(k * xi0) * cosh(k * eta0);
    eta += (h[i] as number) * cos(k * xi0) * sinh(k * eta0);
  }
  return [p.fe + p.k0 * p.b * eta, p.fn + p.k0 * (p.b * xi - p.m0)];
}

/** Iterations of the latitude: closure to 1e-15 takes four or five, more are never needed. */
const MAX_ITERATIONS = 15;

export function tmReverse(p: TransverseMercator, e: number, n: number): [number, number] {
  const { el, hr } = p;
  const etaP = (e - p.fe) / (p.b * p.k0);
  const xiP = (n - p.fn + p.k0 * p.m0) / (p.b * p.k0);
  let sxi = 0;
  let seta = 0;
  for (let i = 0; i < 4; i++) {
    const k = 2 * (i + 1);
    sxi += (hr[i] as number) * sin(k * xiP) * cosh(k * etaP);
    seta += (hr[i] as number) * cos(k * xiP) * sinh(k * etaP);
  }
  const xi0 = xiP - sxi;
  const eta0 = etaP - seta;
  const beta = asin(clampUnit(sin(xi0) / cosh(eta0)));
  const qp = asinh(tan(beta));
  let q = qp;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const next = qp + el.e * atanh(el.e * tanh(q));
    const done = Math.abs(next - q) < 1e-15;
    q = next;
    if (done) break;
  }
  return [atan(sinh(q)), p.lambda0 + asin(clampUnit(tanh(eta0) / cos(beta)))];
}

// ---------------------------------------------------------------------------------------------
// Lambert Conic Conformal (9802 two standard parallels, 9801 one)

export interface LambertConic {
  el: Ellipsoid;
  lambda0: number;
  n: number;
  /** a·F, times the scale factor for the one-parallel variant. */
  af: number;
  r0: number;
  fe: number;
  fn: number;
}

function lccM(el: Ellipsoid, phi: number): number {
  const s = sin(phi);
  return cos(phi) / Math.sqrt(1 - el.e2 * s * s);
}

function lccT(el: Ellipsoid, phi: number): number {
  const es = el.e * sin(phi);
  return tan(PI / 4 - phi / 2) / pow((1 - es) / (1 + es), el.e / 2);
}

export function lambertConic2(
  el: Ellipsoid,
  phiF: number,
  lambdaF: number,
  phi1: number,
  phi2: number,
  ef: number,
  nf: number,
): LambertConic {
  const m1 = lccM(el, phi1);
  const m2 = lccM(el, phi2);
  const t1 = lccT(el, phi1);
  const t2 = lccT(el, phi2);
  const n = (log(m1) - log(m2)) / (log(t1) - log(t2));
  const af = el.a * (m1 / (n * pow(t1, n)));
  return { el, lambda0: lambdaF, n, af, r0: af * pow(lccT(el, phiF), n), fe: ef, fn: nf };
}

export function lambertConic1(
  el: Ellipsoid,
  phi0: number,
  lambda0: number,
  k0: number,
  fe: number,
  fn: number,
): LambertConic {
  const n = sin(phi0);
  const t0 = lccT(el, phi0);
  const af = el.a * (lccM(el, phi0) / (n * pow(t0, n))) * k0;
  return { el, lambda0, n, af, r0: af * pow(t0, n), fe, fn };
}

export function lccForward(p: LambertConic, phi: number, lambda: number): [number, number] {
  const r = p.af * pow(lccT(p.el, phi), p.n);
  const theta = p.n * (lambda - p.lambda0);
  return [p.fe + r * sin(theta), p.fn + p.r0 - r * cos(theta)];
}

export function lccReverse(p: LambertConic, e: number, n: number): [number, number] {
  const dx = e - p.fe;
  const dy = p.r0 - (n - p.fn);
  const r = (p.n < 0 ? -1 : 1) * Math.sqrt(dx * dx + dy * dy);
  const t = pow(r / p.af, 1 / p.n);
  const theta = atan2(dx, dy);
  let phi = HALF_PI - 2 * atan(t);
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const es = p.el.e * sin(phi);
    const next = HALF_PI - 2 * atan(t * pow((1 - es) / (1 + es), p.el.e / 2));
    const done = Math.abs(next - phi) < 1e-15;
    phi = next;
    if (done) break;
  }
  return [phi, theta / p.n + p.lambda0];
}
