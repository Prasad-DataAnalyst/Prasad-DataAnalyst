//! Coordinate transformation (FR-PRC-02), as src/geo/crs does it, operation for operation, so both
//! engines give every converted coordinate the same bits: the elementary functions of exact.ts,
//! built from IEEE 754 arithmetic only (the FreeBSD fdlibm algorithms), the EPSG methods of
//! methods.ts (IOGP Guidance Note 7-2) and the transformation of transform.ts, from the same
//! registry file. Rust performs `+ - * /` and the square root exactly as JavaScript does and never
//! fuses a multiply and an add, so writing the same expressions in the same order is enough; the
//! shared vectors in src/geo/crs/__fixtures__ hold both to it.

// The constants are fdlibm's, digit for digit; a negated comparison such as `!(x <= limit)` is
// there to catch NaN as well.
#![allow(
    clippy::excessive_precision,
    clippy::approx_constant,
    clippy::neg_cmp_op_on_partial_ord
)]

use crate::json::J;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

// ---------------------------------------------------------------------------------------------
// Elementary functions (exact.ts)

fn high_word(x: f64) -> i32 {
    (x.to_bits() >> 32) as u32 as i32
}

fn with_high_word(x: f64, high: i32) -> f64 {
    f64::from_bits((u64::from(high as u32) << 32) | (x.to_bits() & 0xffff_ffff))
}

fn two_to(k: i32) -> f64 {
    f64::from_bits(((0x3ff + k) as u64) << 52)
}

const INVPIO2: f64 = 6.36619772367581382433e-1;
const PIO2_1: f64 = 1.57079632673412561417;
const PIO2_1T: f64 = 6.07710050650619224932e-11;
const PIO4: f64 = 7.85398163397448278999e-1;
const MAX_ANGLE: f64 = 1.0e5;

const S1: f64 = -1.66666666666666324348e-1;
const S2: f64 = 8.33333333332248946124e-3;
const S3: f64 = -1.98412698298579493134e-4;
const S4: f64 = 2.75573137070700676789e-6;
const S5: f64 = -2.50507602534068634195e-8;
const S6: f64 = 1.58969099521155010221e-10;

const C1: f64 = 4.16666666666666019037e-2;
const C2: f64 = -1.38888888888741095749e-3;
const C3: f64 = 2.48015872894767294178e-5;
const C4: f64 = -2.75573143513906633035e-7;
const C5: f64 = 2.08757232129817482790e-9;
const C6: f64 = -1.13596475577881948265e-11;

fn kernel_sin(x: f64) -> f64 {
    let z = x * x;
    let w = z * z;
    let r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
    let v = z * x;
    x + v * (S1 + z * r)
}

fn kernel_cos(x: f64) -> f64 {
    let z = x * x;
    let w = z * z;
    let r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
    let hz = 0.5 * z;
    let v = 1.0 - hz;
    v + (1.0 - v - hz + z * r)
}

fn reduce(x: f64) -> (i32, f64) {
    if x.abs() <= PIO4 {
        return (0, x);
    }
    let t = x.abs();
    let f = (t * INVPIO2 + 0.5).floor();
    let r = t - f * PIO2_1 - f * PIO2_1T;
    let n = (f % 4.0) as i32;
    if x < 0.0 { ((4 - n) % 4, -r) } else { (n, r) }
}

fn bad(x: f64) -> bool {
    !(x.abs() <= MAX_ANGLE)
}

pub fn sin(x: f64) -> f64 {
    if bad(x) {
        return f64::NAN;
    }
    let (n, r) = reduce(x);
    match n {
        0 => kernel_sin(r),
        1 => kernel_cos(r),
        2 => -kernel_sin(r),
        _ => -kernel_cos(r),
    }
}

pub fn cos(x: f64) -> f64 {
    if bad(x) {
        return f64::NAN;
    }
    let (n, r) = reduce(x);
    match n {
        0 => kernel_cos(r),
        1 => -kernel_sin(r),
        2 => -kernel_cos(r),
        _ => kernel_sin(r),
    }
}

pub fn tan(x: f64) -> f64 {
    if bad(x) {
        return f64::NAN;
    }
    let (n, r) = reduce(x);
    let s = kernel_sin(r);
    let c = kernel_cos(r);
    if n % 2 == 0 { s / c } else { -c / s }
}

const ATAN_HI: [f64; 4] = [
    4.63647609000806093515e-1,
    7.85398163397448278999e-1,
    9.82793723247329054082e-1,
    1.5707963267948965580,
];
const ATAN_LO: [f64; 4] = [
    2.26987774529616870924e-17,
    3.06161699786838301793e-17,
    1.39033110312309984516e-17,
    6.12323399573676603587e-17,
];
const AT0: f64 = 3.33333333333329318027e-1;
const AT1: f64 = -1.99999999998764832476e-1;
const AT2: f64 = 1.42857142725034663711e-1;
const AT3: f64 = -1.11111104054623557880e-1;
const AT4: f64 = 9.09088713343650656196e-2;
const AT5: f64 = -7.69187620504482999495e-2;
const AT6: f64 = 6.66107313738753120669e-2;
const AT7: f64 = -5.83357013379057348645e-2;
const AT8: f64 = 4.97687799461593236017e-2;
const AT9: f64 = -3.65315727442169155270e-2;
const AT10: f64 = 1.62858201153657823623e-2;

pub const PI: f64 = 3.1415926535897931160;
const PI_LO: f64 = 1.2246467991473532e-16;
pub const HALF_PI: f64 = 1.5707963267948965580;

pub fn atan(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    let t = x.abs();
    if t >= 7.378697629483820646e19 {
        return if x < 0.0 {
            -ATAN_HI[3] - ATAN_LO[3]
        } else {
            ATAN_HI[3] + ATAN_LO[3]
        };
    }
    let (id, y): (i32, f64) = if t < 0.4375 {
        if t < 7.450580596923828e-9 {
            return x;
        }
        (-1, x)
    } else if t < 1.1875 {
        if t < 0.6875 {
            (0, (2.0 * t - 1.0) / (2.0 + t))
        } else {
            (1, (t - 1.0) / (t + 1.0))
        }
    } else if t < 2.4375 {
        (2, (t - 1.5) / (1.0 + 1.5 * t))
    } else {
        (3, -1.0 / t)
    };
    let z = y * y;
    let w = z * z;
    let s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
    let s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
    if id < 0 {
        return y - y * (s1 + s2);
    }
    let id = id as usize;
    let r = ATAN_HI[id] - (y * (s1 + s2) - ATAN_LO[id] - y);
    if x < 0.0 { -r } else { r }
}

pub fn atan2(y: f64, x: f64) -> f64 {
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    if x == 1.0 {
        return atan(y);
    }
    if y == 0.0 {
        return if x < 0.0 || (x == 0.0 && x.is_sign_negative()) {
            if y.is_sign_negative() { -PI } else { PI }
        } else {
            y
        };
    }
    if x == 0.0 {
        return if y < 0.0 { -HALF_PI } else { HALF_PI };
    }
    let z = atan((y / x).abs());
    if x > 0.0 {
        return if y < 0.0 { -z } else { z };
    }
    if y < 0.0 {
        z - PI_LO - PI
    } else {
        PI - (z - PI_LO)
    }
}

pub fn asin(x: f64) -> f64 {
    if !(x.abs() <= 1.0) {
        return f64::NAN;
    }
    atan2(x, ((1.0 - x) * (1.0 + x)).sqrt())
}

const LN2_HI: f64 = 6.93147180369123816490e-1;
const LN2_LO: f64 = 1.90821492927058770002e-10;
const LG1: f64 = 6.666666666666735130e-1;
const LG2: f64 = 3.999999999940941908e-1;
const LG3: f64 = 2.857142874366239149e-1;
const LG4: f64 = 2.222219843214978396e-1;
const LG5: f64 = 1.818357216161805012e-1;
const LG6: f64 = 1.531383769920937332e-1;
const LG7: f64 = 1.479819860511658591e-1;

pub fn log(x: f64) -> f64 {
    if !(x >= 2.2250738585072014e-308) || x == f64::INFINITY {
        return if x == 0.0 {
            f64::NEG_INFINITY
        } else {
            f64::NAN
        };
    }
    let mut hx = high_word(x);
    let mut k = (hx >> 20) - 1023;
    hx &= 0x000fffff;
    let i = (hx + 0x95f64) & 0x100000;
    let m = with_high_word(x, hx | (i ^ 0x3ff00000));
    k += i >> 20;
    let f = m - 1.0;
    let dk = f64::from(k);
    if (0x000fffff & (2 + hx)) < 3 {
        if f == 0.0 {
            return if k == 0 {
                0.0
            } else {
                dk * LN2_HI + dk * LN2_LO
            };
        }
        let r = f * f * (0.5 - 0.3333333333333333 * f);
        return if k == 0 {
            f - r
        } else {
            dk * LN2_HI - (r - dk * LN2_LO - f)
        };
    }
    let s = f / (2.0 + f);
    let z = s * s;
    let w = z * z;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    let r = t2 + t1;
    if ((hx - 0x6147a) | (0x6b851 - hx)) > 0 {
        let hfsq = 0.5 * f * f;
        return if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - (hfsq - (s * (hfsq + r) + dk * LN2_LO) - f)
        };
    }
    if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - (s * (f - r) - dk * LN2_LO - f)
    }
}

const INVLN2: f64 = 1.44269504088896338700;
const P1: f64 = 1.66666666666666019037e-1;
const P2: f64 = -2.77777777770155933842e-3;
const P3: f64 = 6.61375632143793436117e-5;
const P4: f64 = -1.65339022054652515390e-6;
const P5: f64 = 4.13813679705723846039e-8;

pub fn exp(x: f64) -> f64 {
    if !(x.abs() <= 700.0) {
        return f64::NAN;
    }
    let hx = high_word(x) & 0x7fffffff;
    let mut hi = 0.0;
    let mut lo = 0.0;
    let mut k: f64 = 0.0;
    let mut r = x;
    if hx > 0x3fd62e42 {
        if hx < 0x3ff0a2b2 {
            hi = if x < 0.0 { x + LN2_HI } else { x - LN2_HI };
            lo = if x < 0.0 { -LN2_LO } else { LN2_LO };
            k = if x < 0.0 { -1.0 } else { 1.0 };
        } else {
            k = (INVLN2 * x + if x < 0.0 { -0.5 } else { 0.5 }).trunc();
            hi = x - k * LN2_HI;
            lo = k * LN2_LO;
        }
        r = hi - lo;
    } else if hx < 0x3e300000 {
        return 1.0 + x;
    }
    let t = r * r;
    let c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if k == 0.0 {
        return 1.0 - ((r * c) / (c - 2.0) - r);
    }
    let y = 1.0 - (lo - (r * c) / (2.0 - c) - hi);
    y * two_to(k as i32)
}

pub fn log1p(u: f64) -> f64 {
    let w = 1.0 + u;
    if w == 1.0 {
        return u;
    }
    (log(w) * u) / (w - 1.0)
}

pub fn expm1(x: f64) -> f64 {
    let u = exp(x);
    if u == 1.0 {
        return x;
    }
    let um1 = u - 1.0;
    if um1 == -1.0 {
        return -1.0;
    }
    (um1 * x) / log(u)
}

pub fn sinh(x: f64) -> f64 {
    let h = if x < 0.0 { -0.5 } else { 0.5 };
    let t = expm1(x.abs());
    if x.abs() < 1.0 {
        return h * (2.0 * t - (t * t) / (t + 1.0));
    }
    h * (t + t / (t + 1.0))
}

pub fn cosh(x: f64) -> f64 {
    let e = exp(x.abs());
    0.5 * e + 0.5 / e
}

pub fn tanh(x: f64) -> f64 {
    sinh(x) / cosh(x)
}

pub fn asinh(x: f64) -> f64 {
    let t = x.abs();
    let r = if t > 2.0 {
        log(2.0 * t + 1.0 / ((x * x + 1.0).sqrt() + t))
    } else {
        log1p(t + (t * t) / (1.0 + (1.0 + t * t).sqrt()))
    };
    if x < 0.0 { -r } else { r }
}

pub fn atanh(x: f64) -> f64 {
    let t = x.abs();
    let r = if t < 0.5 {
        0.5 * log1p(2.0 * t + (2.0 * t * t) / (1.0 - t))
    } else {
        0.5 * log1p((2.0 * t) / (1.0 - t))
    };
    if x < 0.0 { -r } else { r }
}

pub fn pow(x: f64, y: f64) -> f64 {
    exp(y * log(x))
}

// ---------------------------------------------------------------------------------------------
// Methods (methods.ts)

#[derive(Clone, Copy, Debug)]
pub struct Ellipsoid {
    pub a: f64,
    pub f: f64,
    pub e2: f64,
    pub e: f64,
}

pub fn ellipsoid(a: f64, f: f64) -> Ellipsoid {
    let e2 = 2.0 * f - f * f;
    Ellipsoid {
        a,
        f,
        e2,
        e: e2.sqrt(),
    }
}

pub fn to_geocentric(el: &Ellipsoid, phi: f64, lambda: f64) -> (f64, f64, f64) {
    let s = sin(phi);
    let nu = el.a / (1.0 - el.e2 * s * s).sqrt();
    let c = cos(phi);
    (
        nu * c * cos(lambda),
        nu * c * sin(lambda),
        (1.0 - el.e2) * nu * s,
    )
}

pub fn from_geocentric(el: &Ellipsoid, x: f64, y: f64, z: f64) -> (f64, f64) {
    let eps = el.e2 / (1.0 - el.e2);
    let b = el.a * (1.0 - el.f);
    let p = (x * x + y * y).sqrt();
    let q = atan2(z * el.a, p * b);
    let sq = sin(q);
    let cq = cos(q);
    let phi = atan2(z + eps * b * sq * sq * sq, p - el.e2 * el.a * cq * cq * cq);
    (phi, atan2(y, x))
}

#[derive(Clone, Copy, Debug)]
pub struct Helmert {
    pub tx: f64,
    pub ty: f64,
    pub tz: f64,
    pub rx: f64,
    pub ry: f64,
    pub rz: f64,
    pub ds: f64,
    pub position_vector: bool,
}

fn arcsec() -> f64 {
    PI / 648000.0
}

pub fn helmert(h: &Helmert, reverse: bool, x: f64, y: f64, z: f64) -> (f64, f64, f64) {
    let sign = if reverse { -1.0 } else { 1.0 };
    let turn = if h.position_vector { sign } else { -sign };
    let rx = turn * h.rx * arcsec();
    let ry = turn * h.ry * arcsec();
    let rz = turn * h.rz * arcsec();
    let m = 1.0 + sign * h.ds * 1e-6;
    (
        m * (x - rz * y + ry * z) + sign * h.tx,
        m * (rz * x + y - rx * z) + sign * h.ty,
        m * (-ry * x + rx * y + z) + sign * h.tz,
    )
}

#[derive(Clone, Debug)]
pub struct TransverseMercator {
    el: Ellipsoid,
    lambda0: f64,
    k0: f64,
    fe: f64,
    fn_: f64,
    b: f64,
    m0: f64,
    h: [f64; 4],
    hr: [f64; 4],
}

pub fn transverse_mercator(
    el: Ellipsoid,
    phi0: f64,
    lambda0: f64,
    k0: f64,
    fe: f64,
    fn_: f64,
) -> TransverseMercator {
    let n = el.f / (2.0 - el.f);
    let n2 = n * n;
    let n3 = n2 * n;
    let n4 = n3 * n;
    let b = (el.a / (1.0 + n)) * (1.0 + n2 / 4.0 + n4 / 64.0);
    let h = [
        n / 2.0 - (2.0 / 3.0) * n2 + (5.0 / 16.0) * n3 + (41.0 / 180.0) * n4,
        (13.0 / 48.0) * n2 - (3.0 / 5.0) * n3 + (557.0 / 1440.0) * n4,
        (61.0 / 240.0) * n3 - (103.0 / 140.0) * n4,
        (49561.0 / 161280.0) * n4,
    ];
    let hr = [
        n / 2.0 - (2.0 / 3.0) * n2 + (37.0 / 96.0) * n3 - (1.0 / 360.0) * n4,
        (1.0 / 48.0) * n2 + (1.0 / 15.0) * n3 - (437.0 / 1440.0) * n4,
        (17.0 / 480.0) * n3 - (37.0 / 840.0) * n4,
        (4397.0 / 161280.0) * n4,
    ];
    let m0 = if phi0 == 0.0 {
        0.0
    } else if phi0 == HALF_PI {
        b * HALF_PI
    } else if phi0 == -HALF_PI {
        -b * HALF_PI
    } else {
        let q0 = asinh(tan(phi0)) - el.e * atanh(el.e * sin(phi0));
        let xi0 = atan(sinh(q0));
        b * (xi0
            + h[0] * sin(2.0 * xi0)
            + h[1] * sin(4.0 * xi0)
            + h[2] * sin(6.0 * xi0)
            + h[3] * sin(8.0 * xi0))
    };
    TransverseMercator {
        el,
        lambda0,
        k0,
        fe,
        fn_,
        b,
        m0,
        h,
        hr,
    }
}

fn clamp_unit(x: f64) -> f64 {
    x.clamp(-1.0, 1.0)
}

pub fn tm_forward(p: &TransverseMercator, phi: f64, lambda: f64) -> (f64, f64) {
    let el = &p.el;
    let q = asinh(tan(phi)) - el.e * atanh(el.e * sin(phi));
    let beta = atan(sinh(q));
    let eta0 = atanh(cos(beta) * sin(lambda - p.lambda0));
    let xi0 = asin(clamp_unit(sin(beta) * cosh(eta0)));
    let mut xi = xi0;
    let mut eta = eta0;
    for i in 0..4 {
        let k = 2.0 * (i as f64 + 1.0);
        xi += p.h[i] * sin(k * xi0) * cosh(k * eta0);
        eta += p.h[i] * cos(k * xi0) * sinh(k * eta0);
    }
    (p.fe + p.k0 * p.b * eta, p.fn_ + p.k0 * (p.b * xi - p.m0))
}

const MAX_ITERATIONS: usize = 15;

pub fn tm_reverse(p: &TransverseMercator, e: f64, n: f64) -> (f64, f64) {
    let el = &p.el;
    let eta_p = (e - p.fe) / (p.b * p.k0);
    let xi_p = (n - p.fn_ + p.k0 * p.m0) / (p.b * p.k0);
    let mut sxi = 0.0;
    let mut seta = 0.0;
    for i in 0..4 {
        let k = 2.0 * (i as f64 + 1.0);
        sxi += p.hr[i] * sin(k * xi_p) * cosh(k * eta_p);
        seta += p.hr[i] * cos(k * xi_p) * sinh(k * eta_p);
    }
    let xi0 = xi_p - sxi;
    let eta0 = eta_p - seta;
    let beta = asin(clamp_unit(sin(xi0) / cosh(eta0)));
    let qp = asinh(tan(beta));
    let mut q = qp;
    for _ in 0..MAX_ITERATIONS {
        let next = qp + el.e * atanh(el.e * tanh(q));
        let done = (next - q).abs() < 1e-15;
        q = next;
        if done {
            break;
        }
    }
    (
        atan(sinh(q)),
        p.lambda0 + asin(clamp_unit(tanh(eta0) / cos(beta))),
    )
}

#[derive(Clone, Debug)]
pub struct LambertConic {
    el: Ellipsoid,
    lambda0: f64,
    n: f64,
    af: f64,
    r0: f64,
    fe: f64,
    fn_: f64,
}

fn lcc_m(el: &Ellipsoid, phi: f64) -> f64 {
    let s = sin(phi);
    cos(phi) / (1.0 - el.e2 * s * s).sqrt()
}

fn lcc_t(el: &Ellipsoid, phi: f64) -> f64 {
    let es = el.e * sin(phi);
    tan(PI / 4.0 - phi / 2.0) / pow((1.0 - es) / (1.0 + es), el.e / 2.0)
}

pub fn lambert_conic2(
    el: Ellipsoid,
    phi_f: f64,
    lambda_f: f64,
    phi1: f64,
    phi2: f64,
    ef: f64,
    nf: f64,
) -> LambertConic {
    let m1 = lcc_m(&el, phi1);
    let m2 = lcc_m(&el, phi2);
    let t1 = lcc_t(&el, phi1);
    let t2 = lcc_t(&el, phi2);
    let n = (log(m1) - log(m2)) / (log(t1) - log(t2));
    let af = el.a * (m1 / (n * pow(t1, n)));
    let r0 = af * pow(lcc_t(&el, phi_f), n);
    LambertConic {
        el,
        lambda0: lambda_f,
        n,
        af,
        r0,
        fe: ef,
        fn_: nf,
    }
}

pub fn lcc_forward(p: &LambertConic, phi: f64, lambda: f64) -> (f64, f64) {
    let r = p.af * pow(lcc_t(&p.el, phi), p.n);
    let theta = p.n * (lambda - p.lambda0);
    (p.fe + r * sin(theta), p.fn_ + p.r0 - r * cos(theta))
}

pub fn lcc_reverse(p: &LambertConic, e: f64, n: f64) -> (f64, f64) {
    let dx = e - p.fe;
    let dy = p.r0 - (n - p.fn_);
    let r = (if p.n < 0.0 { -1.0 } else { 1.0 }) * (dx * dx + dy * dy).sqrt();
    let t = pow(r / p.af, 1.0 / p.n);
    let theta = atan2(dx, dy);
    let mut phi = HALF_PI - 2.0 * atan(t);
    for _ in 0..MAX_ITERATIONS {
        let es = p.el.e * sin(phi);
        let next = HALF_PI - 2.0 * atan(t * pow((1.0 - es) / (1.0 + es), p.el.e / 2.0));
        let done = (next - phi).abs() < 1e-15;
        phi = next;
        if done {
            break;
        }
    }
    (phi, theta / p.n + p.lambda0)
}

// ---------------------------------------------------------------------------------------------
// Coordinate reference systems and transformations (transform.ts)

pub const REGISTRY_JSON: &str = include_str!("../../../src/geo/crs/registry.json");

fn registry() -> &'static Value {
    static R: OnceLock<Value> = OnceLock::new();
    R.get_or_init(|| serde_json::from_str(REGISTRY_JSON).expect("the CRS registry is JSON"))
}

/// The registry's version (CRS_REGISTRY_VERSION).
pub fn registry_version() -> &'static str {
    registry()["version"].as_str().unwrap_or_default()
}

/// Where the registry's parameters and formulas come from (CRS_REGISTRY_SOURCE).
pub fn registry_source() -> &'static str {
    registry()["source"].as_str().unwrap_or_default()
}

fn d2r() -> f64 {
    PI / 180.0
}

fn r2d() -> f64 {
    180.0 / PI
}

/// A datum's transformation to WGS 84. Its code, name, method and accuracy describe a
/// transformation in the audit log, which only the transformation step reads.
#[derive(Clone, Debug)]
pub struct DatumTransformation {
    pub code: String,
    pub name: String,
    pub method: String,
    pub helmert: Helmert,
    pub accuracy: f64,
}

#[derive(Clone, Debug)]
pub struct Datum {
    pub code: String,
    pub ellipsoid: Ellipsoid,
    pub to_wgs84: Option<DatumTransformation>,
}

#[derive(Clone, Debug)]
pub enum Projection {
    Tm(TransverseMercator),
    Lcc(LambertConic),
}

#[derive(Clone, Debug)]
pub struct CrsDefinition {
    pub code: String,
    pub name: String,
    pub geographic: bool,
    pub datum: Datum,
    pub projection: Option<Projection>,
}

fn num(v: &Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or(0.0)
}

fn datum_of(code: &str) -> Option<Datum> {
    let r = registry();
    let raw = &r["datums"][code];
    let el = &r["ellipsoids"][raw["ellipsoid"].as_str()?];
    let a = el["a"].as_f64()?;
    let f = match el["invF"].as_f64() {
        Some(inv) => 1.0 / inv,
        None => (a - el["b"].as_f64()?) / a,
    };
    let t = &raw["toWgs84"];
    let to_wgs84 = (!t.is_null()).then(|| DatumTransformation {
        code: t["code"].as_str().unwrap_or("").to_string(),
        name: t["name"].as_str().unwrap_or("").to_string(),
        method: t["method"].as_str().unwrap_or("").to_string(),
        helmert: Helmert {
            tx: num(t, "tx"),
            ty: num(t, "ty"),
            tz: num(t, "tz"),
            rx: num(t, "rx"),
            ry: num(t, "ry"),
            rz: num(t, "rz"),
            ds: num(t, "ds"),
            position_vector: t["method"] != "9607",
        },
        accuracy: num(t, "accuracy"),
    });
    Some(Datum {
        code: code.to_string(),
        ellipsoid: ellipsoid(a, f),
        to_wgs84,
    })
}

fn geographic(code: &str) -> Option<CrsDefinition> {
    let raw = &registry()["geographic"][code];
    Some(CrsDefinition {
        code: format!("EPSG:{code}"),
        name: raw["name"].as_str()?.to_string(),
        geographic: true,
        datum: datum_of(raw["datum"].as_str()?)?,
        projection: None,
    })
}

fn projected(code: &str, raw: &Value) -> Option<CrsDefinition> {
    let base = geographic(raw["base"].as_str()?)?;
    let el = base.datum.ellipsoid;
    let projection = if raw["method"] == "9807" {
        Projection::Tm(transverse_mercator(
            el,
            num(raw, "lat0") * d2r(),
            num(raw, "lon0") * d2r(),
            num(raw, "k0"),
            num(raw, "fe"),
            num(raw, "fn"),
        ))
    } else {
        Projection::Lcc(lambert_conic2(
            el,
            num(raw, "latF") * d2r(),
            num(raw, "lonF") * d2r(),
            num(raw, "lat1") * d2r(),
            num(raw, "lat2") * d2r(),
            num(raw, "fe"),
            num(raw, "fn"),
        ))
    };
    Some(CrsDefinition {
        code: format!("EPSG:{code}"),
        name: raw["name"].as_str()?.to_string(),
        geographic: false,
        datum: base.datum,
        projection: Some(projection),
    })
}

fn utm(code: i64) -> Option<CrsDefinition> {
    for u in registry()["utm"].as_array()? {
        let zone = code - u["first"].as_i64()? + u["firstZone"].as_i64()?;
        if zone < u["firstZone"].as_i64()? || zone > u["lastZone"].as_i64()? {
            continue;
        }
        let south = u["south"] == true;
        let raw = serde_json::json!({
            "name": u["name"].as_str()?.replace("{zone}", &zone.to_string()),
            "base": u["base"],
            "method": "9807",
            "lat0": 0,
            "lon0": zone * 6 - 183,
            "k0": 0.9996,
            "fe": 500000,
            "fn": if south { 10000000 } else { 0 },
        });
        return projected(&code.to_string(), &raw);
    }
    None
}

/// The definition of a supported CRS (crsDefinition); OGC:CRS84 is WGS 84 with longitude first.
pub fn crs_definition(code: &str) -> Option<CrsDefinition> {
    static CACHE: OnceLock<std::sync::Mutex<HashMap<String, Option<CrsDefinition>>>> =
        OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(found) = cache.lock().ok()?.get(code) {
        return found.clone();
    }
    let found = if code == "OGC:CRS84" {
        geographic("4326").map(|c| CrsDefinition {
            code: code.to_string(),
            name: "WGS 84 (CRS84)".into(),
            ..c
        })
    } else {
        code.strip_prefix("EPSG:")
            .filter(|n| (4..=5).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|n| {
                let raw = &registry()["projected"][n];
                if raw.is_object() {
                    projected(n, raw)
                } else {
                    geographic(n).or_else(|| n.parse().ok().and_then(utm))
                }
            })
    };
    if let Ok(mut c) = cache.lock() {
        c.insert(code.to_string(), found.clone());
    }
    found
}

/// Every supported CRS by code, name and kind (supportedCrs): geographic ones first, each kind in
/// code order.
pub fn supported_crs() -> Vec<Value> {
    let r = registry();
    let mut codes: Vec<String> = Vec::new();
    for kind in ["geographic", "projected"] {
        codes.extend(
            r[kind]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, _)| k.clone()),
        );
    }
    for u in r["utm"].as_array().into_iter().flatten() {
        let first = u["first"].as_i64().unwrap_or(0);
        let zones = u["lastZone"].as_i64().unwrap_or(0) - u["firstZone"].as_i64().unwrap_or(0);
        codes.extend((0..=zones).map(|i| (first + i).to_string()));
    }
    let mut all: Vec<CrsDefinition> = codes
        .iter()
        .filter_map(|c| crs_definition(&format!("EPSG:{c}")))
        .collect();
    let number = |c: &CrsDefinition| c.code[5..].parse::<u32>().unwrap_or(0);
    all.sort_by(|a, b| {
        b.geographic
            .cmp(&a.geographic)
            .then(number(a).cmp(&number(b)))
    });
    all.iter()
        .map(|c| {
            serde_json::json!({
                "code": c.code,
                "name": c.name,
                "kind": if c.geographic { "geographic" } else { "projected" },
            })
        })
        .collect()
}

/// The transformation between two systems (crsTransformer).
pub struct Transformer {
    pub from: CrsDefinition,
    pub to: CrsDefinition,
    same_datum: bool,
    identity: bool,
}

fn wrap(lambda: f64) -> f64 {
    if lambda > PI {
        lambda - 2.0 * PI
    } else if lambda < -PI {
        lambda + 2.0 * PI
    } else {
        lambda
    }
}

fn unproject(c: &CrsDefinition, x: f64, y: f64) -> Option<(f64, f64)> {
    match &c.projection {
        None => (y.abs() <= 90.0 && x.abs() <= 180.0).then(|| (y * d2r(), x * d2r())),
        Some(p) => {
            let (phi, lambda) = match p {
                Projection::Tm(tm) => tm_reverse(tm, x, y),
                Projection::Lcc(lcc) => lcc_reverse(lcc, x, y),
            };
            Some((phi, wrap(lambda)))
        }
    }
}

fn project(c: &CrsDefinition, phi: f64, lambda: f64) -> (f64, f64) {
    match &c.projection {
        None => (lambda * r2d(), phi * r2d()),
        Some(Projection::Tm(tm)) => tm_forward(tm, phi, lambda),
        Some(Projection::Lcc(lcc)) => lcc_forward(lcc, phi, lambda),
    }
}

fn shift_datum(from: &Datum, to: &Datum, phi: f64, lambda: f64) -> (f64, f64) {
    let (mut x, mut y, mut z) = to_geocentric(&from.ellipsoid, phi, lambda);
    if let Some(t) = &from.to_wgs84 {
        (x, y, z) = helmert(&t.helmert, false, x, y, z);
    }
    if let Some(t) = &to.to_wgs84 {
        (x, y, z) = helmert(&t.helmert, true, x, y, z);
    }
    let (p, l) = from_geocentric(&to.ellipsoid, x, y, z);
    (p, wrap(l))
}

fn method_name(code: &str) -> &'static str {
    match code {
        "9603" => "Geocentric translations (geog2D domain)",
        "9606" => "Position Vector transformation (geog2D domain)",
        "9607" => "Coordinate Frame rotation (geog2D domain)",
        "9807" => "Transverse Mercator",
        "9802" => "Lambert Conic Conformal (2SP)",
        _ => "",
    }
}

fn projection_operation(c: &CrsDefinition, reverse: bool) -> Option<Value> {
    let method = match c.projection.as_ref()? {
        Projection::Tm(_) => "9807",
        Projection::Lcc(_) => "9802",
    };
    Some(serde_json::json!({
        "code": c.code,
        "name": if reverse { format!("{}, to latitude and longitude", c.name) } else { c.name.clone() },
        "method": format!("{} (EPSG method {method})", method_name(method)),
        "accuracy": null,
    }))
}

fn datum_operation(d: &Datum, reverse: bool) -> Option<Value> {
    let t = d.to_wgs84.as_ref()?;
    Some(serde_json::json!({
        "code": t.code,
        "name": if reverse { format!("{}, reversed", t.name) } else { t.name.clone() },
        "method": format!("{} (EPSG method {})", method_name(&t.method), t.method),
        "accuracy": t.accuracy,
    }))
}

impl Transformer {
    /// The operations, as the audit log records them (CrsTransformer.operations).
    pub fn operations(&self) -> Vec<Value> {
        if self.identity {
            return Vec::new();
        }
        let mut out: Vec<Value> = projection_operation(&self.from, true).into_iter().collect();
        if !self.same_datum {
            out.extend(datum_operation(&self.from.datum, false));
            out.extend(datum_operation(&self.to.datum, true));
        }
        out.extend(projection_operation(&self.to, false));
        out
    }

    /// The sum of the operations' stated accuracies, in metres.
    pub fn accuracy(&self) -> f64 {
        self.operations()
            .iter()
            .map(|o| o["accuracy"].as_f64().unwrap_or(0.0))
            .sum()
    }

    pub fn new(from: &str, to: &str) -> Option<Transformer> {
        let from = crs_definition(from)?;
        let to = crs_definition(to)?;
        let same_datum = from.datum.code == to.datum.code;
        let identity = same_datum
            && (from.code == to.code || (from.projection.is_none() && to.projection.is_none()));
        Some(Transformer {
            from,
            to,
            same_datum,
            identity,
        })
    }

    /// The transformed point, or None for a point outside what the system can hold.
    pub fn forward(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        if self.identity {
            return (!self.from.geographic || (y.abs() <= 90.0 && x.abs() <= 180.0))
                .then_some((x, y));
        }
        let (mut phi, mut lambda) = unproject(&self.from, x, y)?;
        if !self.same_datum {
            (phi, lambda) = shift_datum(&self.from.datum, &self.to.datum, phi, lambda);
        }
        let (ox, oy) = project(&self.to, phi, lambda);
        (ox.is_finite() && oy.is_finite()).then_some((ox, oy))
    }
}

// ---------------------------------------------------------------------------------------------
// ESRI WKT (wkt.ts)

/// A number as ESRI WKT writes it (wktNumber): 15 significant digits, a whole number with ".0".
pub fn wkt_number(x: f64) -> String {
    let rounded: f64 = format!("{x:.14e}").parse().unwrap_or(x);
    let text = crate::canonical::canonical_number(rounded);
    if text.contains(['.', 'e']) {
        text
    } else {
        format!("{text}.0")
    }
}

fn esri_geogcs(code: &str) -> Option<String> {
    let r = registry();
    let g = &r["geographic"][code];
    let datum = &r["datums"][g["datum"].as_str()?];
    let el = &r["ellipsoids"][datum["ellipsoid"].as_str()?];
    let a = el["a"].as_f64()?;
    let inv_f = match el["invF"].as_f64() {
        Some(f) => f,
        None => a / (a - el["b"].as_f64()?),
    };
    Some(format!(
        "GEOGCS[\"{}\",DATUM[\"{}\",SPHEROID[\"{}\",{},{}]],PRIMEM[\"Greenwich\",0.0],UNIT[\"Degree\",{}]]",
        g["esri"].as_str()?,
        datum["esri"].as_str()?,
        el["esri"].as_str()?,
        wkt_number(a),
        wkt_number(inv_f),
        wkt_number(PI / 180.0)
    ))
}

fn esri_projcs(name: &str, raw: &Value) -> Option<String> {
    let base = esri_geogcs(raw["base"].as_str()?)?;
    let parameter =
        |n: &str, key: &str| format!("PARAMETER[\"{n}\",{}]", wkt_number(num(raw, key)));
    let (projection, params) = if raw["method"] == "9807" {
        (
            "Transverse_Mercator",
            [
                parameter("False_Easting", "fe"),
                parameter("False_Northing", "fn"),
                parameter("Central_Meridian", "lon0"),
                parameter("Scale_Factor", "k0"),
                parameter("Latitude_Of_Origin", "lat0"),
            ]
            .join(","),
        )
    } else {
        (
            "Lambert_Conformal_Conic",
            [
                parameter("False_Easting", "fe"),
                parameter("False_Northing", "fn"),
                parameter("Central_Meridian", "lonF"),
                parameter("Standard_Parallel_1", "lat1"),
                parameter("Standard_Parallel_2", "lat2"),
                parameter("Latitude_Of_Origin", "latF"),
            ]
            .join(","),
        )
    };
    Some(format!(
        "PROJCS[\"{name}\",{base},PROJECTION[\"{projection}\"],{params},UNIT[\"Meter\",1.0]]"
    ))
}

/// The ESRI WKT of a CRS the registry holds (esriWkt), or None; OGC:CRS84 is described as WGS 84.
pub fn esri_wkt(code: &str) -> Option<String> {
    if code == "OGC:CRS84" {
        return esri_geogcs("4326");
    }
    let n = code
        .strip_prefix("EPSG:")
        .filter(|n| (4..=5).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))?;
    let r = registry();
    let projected = &r["projected"][n];
    if projected.is_object() {
        return esri_projcs(projected["esri"].as_str()?, projected);
    }
    if r["geographic"][n].is_object() {
        return esri_geogcs(n);
    }
    let number: i64 = n.parse().ok()?;
    for u in r["utm"].as_array()? {
        let zone = number - u["first"].as_i64()? + u["firstZone"].as_i64()?;
        if zone < u["firstZone"].as_i64()? || zone > u["lastZone"].as_i64()? {
            continue;
        }
        let raw = serde_json::json!({
            "base": u["base"],
            "method": "9807",
            "lat0": 0,
            "lon0": zone * 6 - 183,
            "k0": 0.9996,
            "fe": 500000,
            "fn": if u["south"] == true { 10000000 } else { 0 },
        });
        return esri_projcs(
            &u["esri"].as_str()?.replace("{zone}", &zone.to_string()),
            &raw,
        );
    }
    None
}

// ---------------------------------------------------------------------------------------------
// Geometries (places.ts)

fn positions(c: &J, t: &Transformer) -> Option<J> {
    let J::Arr(items) = c else {
        return Some(c.clone());
    };
    if let [J::Num(x), J::Num(y), rest @ ..] = items.as_slice() {
        let (ox, oy) = t.forward(*x, *y)?;
        let mut out = vec![J::Num(ox), J::Num(oy)];
        out.extend(rest.iter().cloned());
        return Some(J::Arr(out));
    }
    items
        .iter()
        .map(|item| positions(item, t))
        .collect::<Option<Vec<_>>>()
        .map(J::Arr)
}

fn walk(g: &J, t: &Transformer) -> Option<J> {
    let J::Obj(members) = g else {
        return Some(g.clone());
    };
    let mut out = Vec::with_capacity(members.len());
    for (k, v) in members {
        match (k.as_str(), v) {
            ("bbox", _) => {}
            ("coordinates", _) => out.push((k.clone(), positions(v, t)?)),
            ("geometries", J::Arr(items)) => out.push((
                k.clone(),
                J::Arr(
                    items
                        .iter()
                        .map(|m| walk(m, t))
                        .collect::<Option<Vec<_>>>()?,
                ),
            )),
            _ => out.push((k.clone(), v.clone())),
        }
    }
    Some(J::Obj(out))
}

/// A geometry transformed position by position (transformGeometry): every position's first two
/// ordinates are transformed and a third, such as a height, kept; a bounding box is left out,
/// since it no longer bounds the geometry. None for a value that is not a geometry and for a
/// geometry with a position the transformation cannot place.
pub fn transform_geometry(g: &J, t: &Transformer) -> Option<J> {
    match g {
        J::Obj(members)
            if members
                .iter()
                .any(|(k, v)| k == "type" && matches!(v, J::Str(_))) =>
        {
            walk(g, t)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ESRI WKT the registry gives is the text ESRI publishes, for every system of the fixture.
    #[test]
    fn writes_esri_wkt_as_published() {
        let reference: Value = serde_json::from_str(include_str!(
            "../../../src/geo/crs/__fixtures__/esri-wkt.json"
        ))
        .unwrap();
        for (code, text) in reference["wkt"].as_object().unwrap() {
            assert_eq!(esri_wkt(code).as_deref(), text.as_str(), "{code}");
        }
        assert_eq!(esri_wkt("OGC:CRS84"), esri_wkt("EPSG:4326"));
        assert_eq!(esri_wkt("EPSG:3857"), None);
        assert_eq!(
            wkt_number(6378206.4 / (6378206.4 - 6356583.8)),
            "294.978698213898"
        );
        assert_eq!(wkt_number(-2.0), "-2.0");
    }

    const VECTORS: &str = include_str!("../../../src/geo/crs/__fixtures__/crs-vectors.json");

    fn from_bits(hex: &str) -> f64 {
        f64::from_bits(u64::from_str_radix(hex, 16).unwrap())
    }

    fn bits(x: f64) -> String {
        format!("{:016x}", x.to_bits())
    }

    /// Every vector the TypeScript code is held to, bit for bit.
    #[test]
    fn gives_the_bits_the_typescript_code_gives() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        type Unary = fn(f64) -> f64;
        let unary: [(&str, Unary); 14] = [
            ("sin", sin),
            ("cos", cos),
            ("tan", tan),
            ("atan", atan),
            ("asin", asin),
            ("log", log),
            ("exp", exp),
            ("sinh", sinh),
            ("cosh", cosh),
            ("tanh", tanh),
            ("asinh", asinh),
            ("atanh", atanh),
            ("log1p", log1p),
            ("expm1", expm1),
        ];
        let mut checked = 0;
        for (name, f) in unary {
            for case in v["functions"][name].as_array().unwrap() {
                let x = from_bits(case[0].as_str().unwrap());
                assert_eq!(bits(f(x)), case[1].as_str().unwrap(), "{name}({x:e})");
                checked += 1;
            }
        }
        for (name, f) in [("atan2", atan2 as fn(f64, f64) -> f64), ("pow", pow)] {
            for case in v["functions"][name].as_array().unwrap() {
                let (a, b) = case[0].as_str().unwrap().split_once(',').unwrap();
                let (a, b) = (from_bits(a), from_bits(b));
                assert_eq!(
                    bits(f(a, b)),
                    case[1].as_str().unwrap(),
                    "{name}({a:e}, {b:e})"
                );
                checked += 1;
            }
        }
        for t in v["transforms"].as_array().unwrap() {
            let (from, to) = (t["from"].as_str().unwrap(), t["to"].as_str().unwrap());
            let tr = Transformer::new(from, to).unwrap();
            for p in t["points"].as_array().unwrap() {
                let (x, y) = (
                    from_bits(p[0].as_str().unwrap()),
                    from_bits(p[1].as_str().unwrap()),
                );
                let got = tr.forward(x, y).map(|(a, b)| (bits(a), bits(b)));
                let want = p[2]
                    .as_str()
                    .map(|a| (a.to_string(), p[3].as_str().unwrap().to_string()));
                assert_eq!(got, want, "{from} to {to} of ({x}, {y})");
                checked += 1;
            }
        }
        assert!(checked > 3000);
    }

    #[test]
    fn knows_the_systems_the_typescript_code_knows() {
        assert_eq!(
            crs_definition("EPSG:32631").unwrap().name,
            "WGS 84 / UTM zone 31N"
        );
        assert_eq!(
            crs_definition("EPSG:28350").unwrap().name,
            "GDA94 / MGA zone 50"
        );
        assert_eq!(
            crs_definition("EPSG:27700")
                .unwrap()
                .datum
                .to_wgs84
                .unwrap()
                .code,
            "EPSG:1314"
        );
        for unknown in [
            "EPSG:32661",
            "EPSG:23027",
            "EPSG:9999",
            "unknown",
            "EPSG:4326x",
        ] {
            assert!(crs_definition(unknown).is_none(), "{unknown}");
        }
    }

    /// The operations the audit log records, as transform.test.ts expects them.
    #[test]
    fn describes_its_operations_as_the_typescript_code_does() {
        let t = Transformer::new("EPSG:23031", "EPSG:27700").unwrap();
        let named: Vec<String> = t
            .operations()
            .iter()
            .map(|o| {
                format!(
                    "{} {}",
                    o["code"].as_str().unwrap(),
                    o["name"].as_str().unwrap()
                )
            })
            .collect();
        assert_eq!(
            named,
            [
                "EPSG:23031 ED50 / UTM zone 31N, to latitude and longitude",
                "EPSG:1133 ED50 to WGS 84 (1)",
                "EPSG:1314 OSGB36 to WGS 84 (6), reversed",
                "EPSG:27700 OSGB36 / British National Grid",
            ]
        );
        assert_eq!(t.accuracy(), 12.0);
        let utm = Transformer::new("EPSG:4326", "EPSG:32631").unwrap();
        assert_eq!(
            utm.operations()[0]["method"],
            "Transverse Mercator (EPSG method 9807)"
        );
        assert_eq!(utm.accuracy(), 0.0);
        assert!(
            Transformer::new("EPSG:27700", "EPSG:27700")
                .unwrap()
                .operations()
                .is_empty()
        );
    }
}
