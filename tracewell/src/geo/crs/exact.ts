/**
 * Elementary functions built from IEEE 754 double arithmetic only: +, -, *, /, square root,
 * comparisons and the bits of a double. JavaScript engines compute Math.sin and the like in their
 * own ways, and the native engine's platform does too, so coordinates converted with them would
 * differ in the last digit between engines and browsers, and between a project and its replay.
 * These functions give the same bits everywhere; geodesy.rs in the native engine performs the same
 * operations in the same order. The algorithms and constants are those of the FreeBSD (fdlibm)
 * implementations, accurate to about one unit in the last place.
 *
 * The domain is what coordinate conversion needs: angles of at most a few thousand radians and
 * finite arguments. Outside it a function gives NaN rather than a wrong number.
 */

const VIEW = new DataView(new ArrayBuffer(8));

function highWord(x: number): number {
  VIEW.setFloat64(0, x);
  return VIEW.getInt32(0);
}

function withHighWord(x: number, high: number): number {
  VIEW.setFloat64(0, x);
  VIEW.setInt32(0, high);
  return VIEW.getFloat64(0);
}

/** 2^k for an integer k in the normal range, exactly. */
function twoTo(k: number): number {
  VIEW.setInt32(0, (0x3ff + k) << 20);
  VIEW.setInt32(4, 0);
  return VIEW.getFloat64(0);
}

// ---------------------------------------------------------------------------------------------
// sin, cos, tan (k_sin.c, k_cos.c, e_rem_pio2.c medium case)

const INVPIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO4 = 7.85398163397448278999e-1;
/** Arguments beyond this are refused: the reduction below is exact only for |n| < 2^20. */
const MAX_ANGLE = 1.0e5;

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.0875723212981748279e-9;
const C6 = -1.13596475577881948265e-11;

function kernelSin(x: number): number {
  const z = x * x;
  const w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const v = z * x;
  return x + v * (S1 + z * r);
}

function kernelCos(x: number): number {
  const z = x * x;
  const w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  const v = 1 - hz;
  return v + (1 - v - hz + z * r);
}

/** x = n·π/2 + r with |r| ≤ about π/4; n modulo 4, from 0 to 3. */
function reduce(x: number): { n: number; r: number } {
  if (Math.abs(x) <= PIO4) return { n: 0, r: x };
  const t = Math.abs(x);
  const fn = Math.floor(t * INVPIO2 + 0.5);
  const r = t - fn * PIO2_1 - fn * PIO2_1T;
  const n = fn % 4;
  return x < 0 ? { n: (4 - n) % 4, r: -r } : { n, r };
}

function bad(x: number): boolean {
  return !(Math.abs(x) <= MAX_ANGLE);
}

export function sin(x: number): number {
  if (bad(x)) return NaN;
  const { n, r } = reduce(x);
  switch (n) {
    case 0:
      return kernelSin(r);
    case 1:
      return kernelCos(r);
    case 2:
      return -kernelSin(r);
    default:
      return -kernelCos(r);
  }
}

export function cos(x: number): number {
  if (bad(x)) return NaN;
  const { n, r } = reduce(x);
  switch (n) {
    case 0:
      return kernelCos(r);
    case 1:
      return -kernelSin(r);
    case 2:
      return -kernelCos(r);
    default:
      return kernelSin(r);
  }
}

export function tan(x: number): number {
  if (bad(x)) return NaN;
  const { n, r } = reduce(x);
  const s = kernelSin(r);
  const c = kernelCos(r);
  return n % 2 === 0 ? s / c : -c / s;
}

// ---------------------------------------------------------------------------------------------
// atan, atan2, asin (s_atan.c, e_atan2.c)

const ATAN_HI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.570796326794896558];
const ATAN_LO = [
  2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17,
];
const AT0 = 3.33333333333329318027e-1;
const AT1 = -1.99999999998764832476e-1;
const AT2 = 1.42857142725034663711e-1;
const AT3 = -1.1111110405462355788e-1;
const AT4 = 9.09088713343650656196e-2;
const AT5 = -7.69187620504482999495e-2;
const AT6 = 6.66107313738753120669e-2;
const AT7 = -5.83357013379057348645e-2;
const AT8 = 4.97687799461593236017e-2;
const AT9 = -3.6531572744216915527e-2;
const AT10 = 1.62858201153657823623e-2;

export const PI = 3.141592653589793116;
const PI_LO = 1.2246467991473532e-16;
export const HALF_PI = 1.570796326794896558;

export function atan(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const t = Math.abs(x);
  if (t >= 7.378697629483820646e19)
    return x < 0 ? -(ATAN_HI[3] as number) - (ATAN_LO[3] as number) : (ATAN_HI[3] as number) + (ATAN_LO[3] as number);
  let id: number;
  let y: number;
  if (t < 0.4375) {
    if (t < 7.450580596923828e-9) return x;
    id = -1;
    y = x;
  } else if (t < 1.1875) {
    if (t < 0.6875) {
      id = 0;
      y = (2 * t - 1) / (2 + t);
    } else {
      id = 1;
      y = (t - 1) / (t + 1);
    }
  } else if (t < 2.4375) {
    id = 2;
    y = (t - 1.5) / (1 + 1.5 * t);
  } else {
    id = 3;
    y = -1 / t;
  }
  const z = y * y;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) return y - y * (s1 + s2);
  const r = (ATAN_HI[id] as number) - (y * (s1 + s2) - (ATAN_LO[id] as number) - y);
  return x < 0 ? -r : r;
}

export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (x === 1) return atan(y);
  if (y === 0) return x < 0 || (x === 0 && 1 / x < 0) ? (1 / y < 0 ? -PI : PI) : y;
  if (x === 0) return y < 0 ? -HALF_PI : HALF_PI;
  const z = atan(Math.abs(y / x));
  if (x > 0) return y < 0 ? -z : z;
  return y < 0 ? z - PI_LO - PI : PI - (z - PI_LO);
}

export function asin(x: number): number {
  if (!(Math.abs(x) <= 1)) return NaN;
  return atan2(x, Math.sqrt((1 - x) * (1 + x)));
}

// ---------------------------------------------------------------------------------------------
// log, exp (e_log.c, e_exp.c)

const LN2_HI = 6.9314718036912381649e-1;
const LN2_LO = 1.90821492927058770002e-10;
const LG1 = 6.66666666666673513e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;

/** The natural logarithm of a positive, finite, normal number. */
export function log(x: number): number {
  if (!(x >= 2.2250738585072014e-308) || x === Infinity) return x === 0 ? -Infinity : NaN;
  let hx = highWord(x);
  let k = (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i = (hx + 0x95f64) & 0x100000;
  const m = withHighWord(x, hx | (i ^ 0x3ff00000));
  k += i >> 20;
  const f = m - 1;
  const dk = k;
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) return k === 0 ? 0 : dk * LN2_HI + dk * LN2_LO;
    const r = f * f * (0.5 - 0.3333333333333333 * f);
    return k === 0 ? f - r : dk * LN2_HI - (r - dk * LN2_LO - f);
  }
  const s = f / (2 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const r = t2 + t1;
  if (((hx - 0x6147a) | (0x6b851 - hx)) > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0 ? f - (hfsq - s * (hfsq + r)) : dk * LN2_HI - (hfsq - (s * (hfsq + r) + dk * LN2_LO) - f);
  }
  return k === 0 ? f - s * (f - r) : dk * LN2_HI - (s * (f - r) - dk * LN2_LO - f);
}

const INVLN2 = 1.442695040888963387;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.6533902205465251539e-6;
const P5 = 4.13813679705723846039e-8;

/** e^x, for |x| up to 700. */
export function exp(x: number): number {
  if (!(Math.abs(x) <= 700)) return NaN;
  const hx = highWord(x) & 0x7fffffff;
  let hi = 0;
  let lo = 0;
  let k = 0;
  let r = x;
  if (hx > 0x3fd62e42) {
    if (hx < 0x3ff0a2b2) {
      hi = x < 0 ? x + LN2_HI : x - LN2_HI;
      lo = x < 0 ? -LN2_LO : LN2_LO;
      k = x < 0 ? -1 : 1;
    } else {
      k = Math.trunc(INVLN2 * x + (x < 0 ? -0.5 : 0.5));
      hi = x - k * LN2_HI;
      lo = k * LN2_LO;
    }
    r = hi - lo;
  } else if (hx < 0x3e300000) {
    return 1 + x;
  }
  const t = r * r;
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((r * c) / (c - 2) - r);
  const y = 1 - (lo - (r * c) / (2 - c) - hi);
  return y * twoTo(k);
}

// ---------------------------------------------------------------------------------------------
// Hyperbolic functions and powers, from the above (s_sinh.c, s_asinh.c, e_atanh.c)

/** log(1 + u), accurate for small u: the rounding of 1 + u is undone exactly (Kahan). */
export function log1p(u: number): number {
  const w = 1 + u;
  if (w === 1) return u;
  return (log(w) * u) / (w - 1);
}

/** e^x - 1, accurate for small x, the same way. */
export function expm1(x: number): number {
  const u = exp(x);
  if (u === 1) return x;
  const um1 = u - 1;
  if (um1 === -1) return -1;
  return (um1 * x) / log(u);
}

export function sinh(x: number): number {
  const h = x < 0 ? -0.5 : 0.5;
  const t = expm1(Math.abs(x));
  if (Math.abs(x) < 1) return h * (2 * t - (t * t) / (t + 1));
  return h * (t + t / (t + 1));
}

export function cosh(x: number): number {
  const e = exp(Math.abs(x));
  return 0.5 * e + 0.5 / e;
}

export function tanh(x: number): number {
  return sinh(x) / cosh(x);
}

export function asinh(x: number): number {
  const t = Math.abs(x);
  const r = t > 2 ? log(2 * t + 1 / (Math.sqrt(x * x + 1) + t)) : log1p(t + (t * t) / (1 + Math.sqrt(1 + t * t)));
  return x < 0 ? -r : r;
}

/** For |x| < 1. */
export function atanh(x: number): number {
  const t = Math.abs(x);
  const r = t < 0.5 ? 0.5 * log1p(2 * t + (2 * t * t) / (1 - t)) : 0.5 * log1p((2 * t) / (1 - t));
  return x < 0 ? -r : r;
}

/** x^y for a positive x. */
export function pow(x: number, y: number): number {
  return exp(y * log(x));
}
