//! Geometry tests on GeoJSON values (src/geo): validation (rule TW-GEO-001), longitude and
//! latitude ranges and the swap heuristic (TW-GEO-002 and 003), and bounding boxes (TW-GEO-005 and
//! the area filter). Coordinates are read as plane coordinates, as RFC 7946 section 3.1.1 reads
//! line and ring edges; no CRS transformation takes place.
//!
//! A geometry is whatever JSON object the file holds: the validation takes any value, so raw JSON
//! is checked before anything trusts its shape. The other tests are only asked about values whose
//! shape validation has passed.

use crate::json::J;

/// [west, south, east, north]; a box whose west edge lies east of its east edge crosses the
/// antimeridian (RFC 7946 section 5.2).
pub type BBox = [f64; 4];
type XY = (f64, f64);

// ---------------------------------------------------------------------------------------------
// Validation (validate.ts)

/// What validation reports (types.ts). SkippedTooLarge is a note, not a defect: the ring has too
/// many vertices for the self-intersection test, so that one test was not run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Problem {
    Empty,
    NonFinite,
    TooFewPositions,
    RingNotClosed,
    SelfIntersection,
    BadStructure,
    SkippedTooLarge,
}

impl Problem {
    pub fn code(self) -> &'static str {
        match self {
            Problem::Empty => "EMPTY",
            Problem::NonFinite => "NON_FINITE",
            Problem::TooFewPositions => "TOO_FEW_POSITIONS",
            Problem::RingNotClosed => "RING_NOT_CLOSED",
            Problem::SelfIntersection => "SELF_INTERSECTION",
            Problem::BadStructure => "BAD_STRUCTURE",
            Problem::SkippedTooLarge => "SKIPPED_TOO_LARGE",
        }
    }
}

/// Collections nested deeper than this are refused.
const MAX_NESTING: usize = 32;
/// The largest ring, in distinct corners, that the self-intersection test runs on.
const MAX_INTERSECTION_VERTICES: usize = 10_000;

fn member<'a>(o: &'a [(String, J)], key: &str) -> Option<&'a J> {
    o.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// Why a value is not a position: not an array of at least two numbers (BadStructure), or an
/// ordinate that is not a finite number (NonFinite).
fn position_fault(p: &J) -> Option<Problem> {
    let J::Arr(p) = p else {
        return Some(Problem::BadStructure);
    };
    if p.iter().any(|v| matches!(v, J::Arr(_) | J::Obj(_))) || p.len() < 2 {
        return Some(Problem::BadStructure);
    }
    if p.iter().any(|v| !matches!(v, J::Num(n) if n.is_finite())) {
        return Some(Problem::NonFinite);
    }
    None
}

struct Check {
    problems: Vec<Problem>,
    /// False when only the shape matters, which skips the costly topology tests.
    topology: bool,
}

impl Check {
    /// Checks every entry of an array that should hold positions; faults are reported once per
    /// kind, structure first. True when all are valid positions.
    fn positions(&mut self, list: &[J]) -> bool {
        let (mut bad, mut non_finite) = (false, false);
        for p in list {
            match position_fault(p) {
                Some(Problem::BadStructure) => bad = true,
                Some(_) => non_finite = true,
                None => {}
            }
        }
        if bad {
            self.problems.push(Problem::BadStructure);
        }
        if non_finite {
            self.problems.push(Problem::NonFinite);
        }
        !bad && !non_finite
    }

    /// Calls `check` on each entry that is an array; entries that are not are reported once,
    /// after the others.
    fn each_part(&mut self, parts: &[J], check: fn(&mut Check, &[J])) {
        let mut bad = false;
        for part in parts {
            match part {
                J::Arr(part) => check(self, part),
                _ => bad = true,
            }
        }
        if bad {
            self.problems.push(Problem::BadStructure);
        }
    }

    fn line(&mut self, line: &[J]) {
        let valid = self.positions(line);
        if line.len() < 2 || (valid && all_same(line)) {
            self.problems.push(Problem::TooFewPositions);
        }
    }

    fn ring(&mut self, ring: &[J]) {
        let valid = self.positions(ring);
        if ring.len() < 4 {
            self.problems.push(Problem::TooFewPositions);
        }
        if !valid || ring.len() < 2 {
            return;
        }
        if !same_position(&ring[0], &ring[ring.len() - 1]) {
            self.problems.push(Problem::RingNotClosed);
            return;
        }
        if ring.len() >= 4 && self.topology {
            self.ring_topology(ring);
        }
    }

    fn ring_topology(&mut self, ring: &[J]) {
        let corners = ring_corners(ring);
        // Distinct points, not just consecutive ones: a ring running back and forth between two
        // places encloses no area either.
        if distinct_corner_count(&corners, 3) < 3 {
            self.problems.push(Problem::TooFewPositions);
        } else if corners.len() > MAX_INTERSECTION_VERTICES {
            self.problems.push(Problem::SkippedTooLarge);
        } else if ring_self_intersects(&corners) {
            self.problems.push(Problem::SelfIntersection);
        }
    }

    fn polygon(&mut self, rings: &[J]) {
        self.each_part(rings, Check::ring);
    }

    fn coordinates(&mut self, kind: &str, coords: &[J]) {
        match kind {
            "Point" => {
                // The coordinates array is the position itself.
                let fault = if coords.iter().any(|v| matches!(v, J::Arr(_) | J::Obj(_)))
                    || coords.len() < 2
                {
                    Some(Problem::BadStructure)
                } else if coords
                    .iter()
                    .any(|v| !matches!(v, J::Num(n) if n.is_finite()))
                {
                    Some(Problem::NonFinite)
                } else {
                    None
                };
                self.problems.extend(fault);
            }
            "MultiPoint" => {
                self.positions(coords);
            }
            "LineString" => self.line(coords),
            "MultiLineString" => self.each_part(coords, Check::line),
            "Polygon" => self.polygon(coords),
            _ => self.each_part(coords, |c, rings| {
                if rings.is_empty() {
                    c.problems.push(Problem::Empty);
                } else {
                    c.polygon(rings);
                }
            }),
        }
    }

    fn geometry(&mut self, g: &J, depth: usize) {
        let J::Obj(o) = g else {
            self.problems.push(Problem::BadStructure);
            return;
        };
        let kind = match member(o, "type") {
            Some(J::Str(t)) => t.as_str(),
            _ => {
                self.problems.push(Problem::BadStructure);
                return;
            }
        };
        if kind == "GeometryCollection" {
            if depth >= MAX_NESTING {
                self.problems.push(Problem::BadStructure);
                return;
            }
            match member(o, "geometries") {
                Some(J::Arr(members)) => {
                    if members.is_empty() {
                        self.problems.push(Problem::Empty);
                    }
                    for m in members {
                        self.geometry(m, depth + 1);
                    }
                }
                _ => self.problems.push(Problem::BadStructure),
            }
            return;
        }
        if !COORDINATE_TYPES.contains(&kind) {
            self.problems.push(Problem::BadStructure);
            return;
        }
        match member(o, "coordinates") {
            Some(J::Arr(coords)) if coords.is_empty() => self.problems.push(Problem::Empty),
            Some(J::Arr(coords)) => self.coordinates(kind, coords),
            _ => self.problems.push(Problem::BadStructure),
        }
    }
}

const COORDINATE_TYPES: [&str; 6] = [
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
];

/// For positions already known to be valid: whether they hold identical values.
fn same_position(a: &J, b: &J) -> bool {
    match (a, b) {
        (J::Arr(a), J::Arr(b)) => {
            a.len() == b.len()
                && a.iter()
                    .zip(b)
                    .all(|(x, y)| matches!((x, y), (J::Num(x), J::Num(y)) if x == y))
        }
        _ => false,
    }
}

/// Every ordinate counts, so a vertical well path (one place, several depths) keeps its length;
/// only a line whose positions are identical in full has none.
fn all_same(line: &[J]) -> bool {
    line.iter().all(|p| same_position(&line[0], p))
}

/// Every problem found in a geometry, in document order; none for a valid geometry
/// (geometryProblems).
pub fn problems(g: &J) -> Vec<Problem> {
    let mut check = Check {
        problems: Vec::new(),
        topology: true,
    };
    check.geometry(g, 0);
    check.problems
}

/// Whether a geometry breaks no rule: the note that a ring was too large to test is not a defect.
pub fn is_valid(g: &J) -> bool {
    problems(g).iter().all(|p| *p == Problem::SkippedTooLarge)
}

/// Whether a value has the shape of a geometry: a known type, the right array nesting, and finite
/// numbers in every position (isGeometry). An invalid geometry is still a geometry.
pub fn has_shape(g: &J) -> bool {
    let mut check = Check {
        problems: Vec::new(),
        topology: false,
    };
    check.geometry(g, 0);
    !check
        .problems
        .iter()
        .any(|p| matches!(p, Problem::BadStructure | Problem::NonFinite))
}

// ---------------------------------------------------------------------------------------------
// Ring self-intersection (intersect.ts)

/// The longitude and latitude of a position, or None when either is missing or not finite.
fn lon_lat(p: &J) -> Option<XY> {
    let J::Arr(p) = p else { return None };
    match (p.first(), p.get(1)) {
        (Some(J::Num(x)), Some(J::Num(y))) if x.is_finite() && y.is_finite() => Some((*x, *y)),
        _ => None,
    }
}

/// The corners of a closed ring: its longitude and latitude pairs without consecutive repeats and
/// without the closing position.
fn ring_corners(ring: &[J]) -> Vec<XY> {
    let mut corners: Vec<XY> = Vec::with_capacity(ring.len());
    for point in ring.iter().filter_map(lon_lat) {
        if corners.last() != Some(&point) {
            corners.push(point);
        }
    }
    if corners.len() > 1 && corners.first() == corners.last() {
        corners.pop();
    }
    corners
}

/// How many different points the corners hold, counting no further than `limit`.
fn distinct_corner_count(corners: &[XY], limit: usize) -> usize {
    let mut found: Vec<XY> = Vec::new();
    for corner in corners {
        if found.len() >= limit {
            break;
        }
        if !found.contains(corner) {
            found.push(*corner);
        }
    }
    found.len()
}

/// Twice the signed area of the triangle abc: positive when c lies left of the directed line ab.
fn orient(a: XY, b: XY, c: XY) -> f64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

/// For a point r already known to be collinear with p and q: whether it lies on the segment pq.
fn within_segment(p: XY, q: XY, r: XY) -> bool {
    p.0.min(q.0) <= r.0 && r.0 <= p.0.max(q.0) && p.1.min(q.1) <= r.1 && r.1 <= p.1.max(q.1)
}

fn opposite_signs(a: f64, b: f64) -> bool {
    (a > 0.0 && b < 0.0) || (a < 0.0 && b > 0.0)
}

/// Whether the closed segments ab and cd meet; touching counts.
fn segments_meet(a: XY, b: XY, c: XY, d: XY) -> bool {
    let da = orient(c, d, a);
    let db = orient(c, d, b);
    let dc = orient(a, b, c);
    let dd = orient(a, b, d);
    (opposite_signs(da, db) && opposite_signs(dc, dd))
        || (da == 0.0 && within_segment(c, d, a))
        || (db == 0.0 && within_segment(c, d, b))
        || (dc == 0.0 && within_segment(a, b, c))
        || (dd == 0.0 && within_segment(a, b, d))
}

/// Whether two segments that share the vertex s (p-s and s-q) overlap along more than s: they do
/// exactly when p and q lie on the same ray from s, which is how a ring doubles back on itself.
fn folds_back(p: XY, s: XY, q: XY) -> bool {
    orient(p, s, q) == 0.0 && (p.0 - s.0) * (q.0 - s.0) + (p.1 - s.1) * (q.1 - s.1) > 0.0
}

struct Edge {
    /// The edge runs from corner `index` to corner `index + 1` (wrapping round).
    index: usize,
    from: XY,
    to: XY,
    west: f64,
    east: f64,
    south: f64,
    north: f64,
}

/// v × 2^exponent, exactly; split in two factors so that neither overflows on its own.
fn times_power_of_two(v: f64, exponent: i32) -> f64 {
    let half = exponent / 2;
    v * 2f64.powi(half) * 2f64.powi(exponent - half)
}

/// The orientation test multiplies coordinate differences, which overflows beyond about 1e154 and
/// underflows to zero below about 1e-154. Scaling every coordinate by one power of two is exact
/// and changes no verdict, so a ring outside the safe band is first scaled into it.
fn rescaling_exponent(corners: &[XY]) -> i32 {
    const SAFE_MAGNITUDE: i32 = 500;
    let largest = corners
        .iter()
        .fold(0f64, |m, (x, y)| m.max(x.abs()).max(y.abs()));
    if largest == 0.0 {
        return 0;
    }
    let magnitude = largest.log2().floor() as i32;
    if magnitude > SAFE_MAGNITUDE {
        SAFE_MAGNITUDE - magnitude
    } else if magnitude < -SAFE_MAGNITUDE {
        -magnitude
    } else {
        0
    }
}

/// Whether a ring crosses, touches or folds back on itself. `corners` comes from ring_corners and
/// holds at least 3 corners. Every pair of edges is a candidate; sorting the edges by their west
/// end and stopping once a candidate starts east of the current edge prunes most pairs.
fn ring_self_intersects(corners: &[XY]) -> bool {
    let exponent = rescaling_exponent(corners);
    if exponent == 0 {
        return any_meeting(corners);
    }
    let scaled: Vec<XY> = corners
        .iter()
        .map(|(x, y)| {
            (
                times_power_of_two(*x, exponent),
                times_power_of_two(*y, exponent),
            )
        })
        .collect();
    any_meeting(&scaled)
}

fn any_meeting(corners: &[XY]) -> bool {
    let n = corners.len();
    let mut edges: Vec<Edge> = corners
        .iter()
        .enumerate()
        .map(|(index, &from)| {
            let to = corners[(index + 1) % n];
            Edge {
                index,
                from,
                to,
                west: from.0.min(to.0),
                east: from.0.max(to.0),
                south: from.1.min(to.1),
                north: from.1.max(to.1),
            }
        })
        .collect();
    // As the comparator a.west - b.west orders them: equal values, -0 and 0 among them, keep their order.
    edges.sort_by(|a, b| {
        a.west
            .partial_cmp(&b.west)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for (k, a) in edges.iter().enumerate() {
        for b in &edges[k + 1..] {
            if b.west > a.east {
                break;
            }
            if b.south > a.north || b.north < a.south {
                continue;
            }
            // Consecutive edges always share a corner, so for them only a fold back along the
            // same line counts.
            let hit = if b.index == (a.index + 1) % n {
                folds_back(a.from, a.to, b.to)
            } else if a.index == (b.index + 1) % n {
                folds_back(b.from, b.to, a.to)
            } else {
                segments_meet(a.from, a.to, b.from, b.to)
            };
            if hit {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------------------------
// Positions and ranges (positions.ts, range.ts)

/// Calls `f` with every position of a geometry in document order, members of a collection
/// included, until it answers false. The geometry has the shape of one.
fn each_position(g: &J, f: &mut dyn FnMut(&J) -> bool) -> bool {
    let J::Obj(o) = g else { return true };
    let Some(J::Str(kind)) = member(o, "type") else {
        return true;
    };
    if kind == "GeometryCollection" {
        if let Some(J::Arr(members)) = member(o, "geometries") {
            for m in members {
                if !each_position(m, f) {
                    return false;
                }
            }
        }
        return true;
    }
    let Some(J::Arr(coords)) = member(o, "coordinates") else {
        return true;
    };
    fn walk(v: &[J], depth: usize, f: &mut dyn FnMut(&J) -> bool) -> bool {
        for item in v {
            let more = match (depth, item) {
                (0, p) => f(p),
                (_, J::Arr(inner)) => walk(inner, depth - 1, f),
                _ => true,
            };
            if !more {
                return false;
            }
        }
        true
    }
    match kind.as_str() {
        // An empty Point (RFC 7946 allows one) has no position at all.
        "Point" => coords.is_empty() || f(&J::Arr(coords.clone())),
        "MultiPoint" | "LineString" => walk(coords, 0, f),
        "MultiLineString" | "Polygon" => walk(coords, 1, f),
        "MultiPolygon" => walk(coords, 2, f),
        _ => true,
    }
}

/// Whether both values are finite and within -180..180 (longitude) and -90..90 (latitude).
fn in_lon_lat_range(lon: f64, lat: f64) -> bool {
    lon.is_finite() && lat.is_finite() && lon.abs() <= 180.0 && lat.abs() <= 90.0
}

/// Whether every position of the geometry is in range; an empty geometry has none out of range.
pub fn in_range(g: &J) -> bool {
    each_position(g, &mut |p| {
        lon_lat(p).is_some_and(|(lon, lat)| in_lon_lat_range(lon, lat))
    })
}

/// Whether the point lies in the box, edges included. A box crossing the antimeridian covers
/// west..180 and -180..east.
pub fn bbox_contains(b: &BBox, lon: f64, lat: f64) -> bool {
    if !lon.is_finite() || !lat.is_finite() {
        return false;
    }
    let [west, south, east, north] = *b;
    if lat < south || lat > north {
        return false;
    }
    if west <= east {
        lon >= west && lon <= east
    } else {
        (lon >= west && lon <= 180.0) || (lon >= -180.0 && lon <= east)
    }
}

/// Whether a longitude and latitude pair was probably entered the wrong way round: the latitude
/// is impossible but the pair is valid once swapped, or a project area is set, the point lies
/// outside it and the swapped point lies inside it.
pub fn likely_swapped(lon: f64, lat: f64, area: Option<&BBox>) -> bool {
    if !lon.is_finite() || !lat.is_finite() {
        return false;
    }
    if lat.abs() > 90.0 {
        return lon.abs() <= 90.0 && lat.abs() <= 180.0;
    }
    area.is_some_and(|a| !bbox_contains(a, lon, lat) && bbox_contains(a, lat, lon))
}

/// Whether any position of the geometry was probably entered the wrong way round.
pub fn any_swapped(g: &J, area: Option<&BBox>) -> bool {
    !each_position(g, &mut |p| match p {
        // A position's first two values are its longitude and latitude; a missing one is not a number.
        J::Arr(p) => {
            let at = |i: usize| match p.get(i) {
                Some(J::Num(n)) => *n,
                _ => f64::NAN,
            };
            !likely_swapped(at(0), at(1), area)
        }
        _ => true,
    })
}

// ---------------------------------------------------------------------------------------------
// Bounding boxes (bbox.ts, planar.ts)

fn in_plain_box(b: &BBox, x: f64, y: f64) -> bool {
    x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]
}

/// Whether the closed segment ab meets a box that does not cross the antimeridian, edges
/// included. Liang-Barsky clipping: the segment is a + t(b - a) for t in [0, 1], and each box edge
/// narrows the range of t; the segment meets the box when the range stays non-empty.
fn segment_meets_plain_box(b: &BBox, a: XY, to: XY) -> bool {
    let [west, south, east, north] = *b;
    let (ax, ay) = a;
    let (dx, dy) = (to.0 - ax, to.1 - ay);
    let (mut low, mut high) = (0f64, 1f64);
    for (p, q) in [
        (-dx, ax - west),
        (dx, east - ax),
        (-dy, ay - south),
        (dy, north - ay),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return false;
            }
            continue;
        }
        let t = q / p;
        if p < 0.0 {
            if t > high {
                return false;
            }
            low = low.max(t);
        } else {
            if t < low {
                return false;
            }
            high = high.min(t);
        }
    }
    true
}

/// Even-odd point-in-polygon over all rings of one polygon, so a point inside a hole is outside.
/// A ring is closed implicitly; edges with a non-finite end are ignored.
fn inside_rings(rings: &[J], x: f64, y: f64) -> bool {
    let mut inside = false;
    for ring in rings {
        let J::Arr(ring) = ring else { continue };
        let n = ring.len();
        for i in 0..n {
            let j = if i == 0 { n - 1 } else { i - 1 };
            let (Some(a), Some(b)) = (lon_lat(&ring[i]), lon_lat(&ring[j])) else {
                continue;
            };
            // Half-open in y, so a vertex exactly at the point's latitude is counted once.
            if (a.1 > y) != (b.1 > y) {
                let cross_x = a.0 + ((y - a.1) * (b.0 - a.0)) / (b.1 - a.1);
                if x < cross_x {
                    inside = !inside;
                }
            }
        }
    }
    inside
}

/// Whether a chain of positions meets the box. A ring is closed implicitly. Positions without a
/// finite longitude and latitude break the chain; a lone position is tested as a point.
fn chain_meets(b: &BBox, chain: &J, closed: bool) -> bool {
    let J::Arr(chain) = chain else { return false };
    let mut previous: Option<XY> = if closed {
        chain.last().and_then(lon_lat)
    } else {
        None
    };
    for position in chain {
        let point = lon_lat(position);
        if let Some(p) = point {
            let hit = match previous {
                None => in_plain_box(b, p.0, p.1),
                Some(from) => segment_meets_plain_box(b, from, p),
            };
            if hit {
                return true;
            }
        }
        previous = point;
    }
    false
}

/// A polygon meets the box when its boundary does, or when the box lies wholly inside it; then
/// any one box corner is inside (and not inside a hole).
fn polygon_meets(b: &BBox, rings: &J) -> bool {
    let J::Arr(rings) = rings else { return false };
    rings.iter().any(|ring| chain_meets(b, ring, true)) || inside_rings(rings, b[0], b[1])
}

fn geometry_meets(b: &BBox, g: &J) -> bool {
    let J::Obj(o) = g else { return false };
    let Some(J::Str(kind)) = member(o, "type") else {
        return false;
    };
    if kind == "GeometryCollection" {
        return matches!(member(o, "geometries"), Some(J::Arr(members)) if members.iter().any(|m| geometry_meets(b, m)));
    }
    let Some(coords) = member(o, "coordinates") else {
        return false;
    };
    let parts = |f: &dyn Fn(&J) -> bool| matches!(coords, J::Arr(items) if items.iter().any(f));
    let point = |p: &J| lon_lat(p).is_some_and(|(x, y)| in_plain_box(b, x, y));
    match kind.as_str() {
        "Point" => point(coords),
        "MultiPoint" => parts(&point),
        "LineString" => chain_meets(b, coords, false),
        "MultiLineString" => parts(&|line| chain_meets(b, line, false)),
        "Polygon" => polygon_meets(b, coords),
        "MultiPolygon" => parts(&|polygon| polygon_meets(b, polygon)),
        _ => false,
    }
}

/// Whether the geometry and the box share at least one point, edges included: a point in the box,
/// a line crossing it (even with no vertex inside), a polygon overlapping or enclosing it. A box
/// wholly inside a polygon's hole does not meet the polygon.
pub fn bbox_intersects(b: &BBox, g: &J) -> bool {
    let [west, south, east, north] = *b;
    if west <= east {
        geometry_meets(b, g)
    } else {
        geometry_meets(&[west, south, 180.0, north], g)
            || geometry_meets(&[-180.0, south, east, north], g)
    }
}

// ---------------------------------------------------------------------------------------------
// Places for the map (places.ts boxOf, pointOf)

fn each_xy(c: &J, visit: &mut dyn FnMut(f64, f64)) {
    if let J::Arr(items) = c {
        if matches!(items.first(), Some(J::Num(_))) {
            if let (Some(J::Num(x)), Some(J::Num(y))) = (items.first(), items.get(1)) {
                visit(*x, *y);
            }
        } else {
            items.iter().for_each(|i| each_xy(i, visit));
        }
    }
}

fn walk_geometry(g: &J, visit: &mut dyn FnMut(f64, f64)) {
    let J::Obj(members) = g else { return };
    for (k, v) in members {
        if k == "coordinates" {
            each_xy(v, visit);
        } else if k == "geometries"
            && let J::Arr(items) = v
        {
            items.iter().for_each(|m| walk_geometry(m, visit));
        }
    }
}

/// [west, south, east, north] of a WGS 84 geometry's positions, folded as Math.min and Math.max
/// fold them (boxOf); None for an empty geometry.
pub fn wgs84_box(g: &J) -> Option<BBox> {
    use crate::shapefile::{js_max, js_min};
    let mut b: Option<BBox> = None;
    walk_geometry(g, &mut |x, y| {
        b = Some(match b {
            None => [x, y, x, y],
            Some(b) => [
                js_min(b[0], x),
                js_min(b[1], y),
                js_max(b[2], x),
                js_max(b[3], y),
            ],
        });
    });
    b
}

/// A row's point for the density view (pointOf): a point's position, or the centre of the box of
/// another geometry.
pub fn wgs84_point(g: &J) -> Option<(f64, f64)> {
    let J::Obj(members) = g else { return None };
    let is_point = members
        .iter()
        .rev()
        .find(|(k, _)| k == "type")
        .is_some_and(|(_, v)| matches!(v, J::Str(t) if t == "Point"));
    if is_point {
        let coords = members
            .iter()
            .rev()
            .find(|(k, _)| k == "coordinates")
            .map(|(_, v)| v);
        return match coords {
            Some(J::Arr(c)) => match (c.first(), c.get(1)) {
                (Some(J::Num(x)), Some(J::Num(y))) => Some((*x, *y)),
                _ => None,
            },
            _ => None,
        };
    }
    wgs84_box(g).map(|b| ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    fn codes(text: &str) -> Vec<&'static str> {
        problems(&parse(text).unwrap())
            .into_iter()
            .map(Problem::code)
            .collect()
    }

    #[test]
    fn finds_the_problems_of_a_geometry_in_document_order() {
        let none: [&str; 0] = [];
        assert_eq!(codes(r#"{"type":"Point","coordinates":[2.5,57.1]}"#), none);
        assert_eq!(
            codes(r#"{"type":"Point","coordinates":[2.5,57.1,-1200]}"#),
            none
        );
        assert_eq!(codes(r#"{"type":"Point","coordinates":[]}"#), ["EMPTY"]);
        assert_eq!(
            codes(r#"{"type":"Point","coordinates":[2.5]}"#),
            ["BAD_STRUCTURE"]
        );
        assert_eq!(
            codes(r#"{"type":"Point","coordinates":[2.5,null]}"#),
            ["NON_FINITE"]
        );
        assert_eq!(
            codes(r#"{"type":"Point","coordinates":[[2.5,57.1]]}"#),
            ["BAD_STRUCTURE"]
        );
        assert_eq!(
            codes(r#"{"type":"point","coordinates":[1,2]}"#),
            ["BAD_STRUCTURE"]
        );
        assert_eq!(codes(r#"{"coordinates":[1,2]}"#), ["BAD_STRUCTURE"]);
        assert_eq!(codes("5"), ["BAD_STRUCTURE"]);
        assert_eq!(codes(r#"{"type":"Polygon"}"#), ["BAD_STRUCTURE"]);
        assert_eq!(
            codes(r#"{"type":"LineString","coordinates":[[1,2]]}"#),
            ["TOO_FEW_POSITIONS"]
        );
        assert_eq!(
            codes(r#"{"type":"LineString","coordinates":[[1,2],[1,2]]}"#),
            ["TOO_FEW_POSITIONS"]
        );
        // One place at several depths is a line with a length.
        assert_eq!(
            codes(r#"{"type":"LineString","coordinates":[[1,2,0],[1,2,-900]]}"#),
            none
        );
        // Faults of both kinds in one list: structure first, each once.
        assert_eq!(
            codes(r#"{"type":"MultiPoint","coordinates":[[1,"x"],[1],[2,null],5]}"#),
            ["BAD_STRUCTURE", "NON_FINITE"]
        );
        assert_eq!(
            codes(r#"{"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[0,0]]]}"#),
            none
        );
        assert_eq!(
            codes(r#"{"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[0,4]]]}"#),
            ["RING_NOT_CLOSED"]
        );
        assert_eq!(
            codes(r#"{"type":"Polygon","coordinates":[[[0,0],[4,0],[0,0]]]}"#),
            ["TOO_FEW_POSITIONS"]
        );
        assert_eq!(
            codes(r#"{"type":"Polygon","coordinates":[[[0,0],[4,0],[0,0],[4,0],[0,0]]]}"#),
            ["TOO_FEW_POSITIONS"]
        );
        // A bow tie crosses itself.
        assert_eq!(
            codes(r#"{"type":"Polygon","coordinates":[[[0,0],[4,4],[4,0],[0,4],[0,0]]]}"#),
            ["SELF_INTERSECTION"]
        );
        // A ring that doubles back along its own edge.
        assert_eq!(
            codes(r#"{"type":"Polygon","coordinates":[[[0,0],[4,0],[2,0],[2,3],[0,0]]]}"#),
            ["SELF_INTERSECTION"]
        );
        // A part that is not an array is reported once, after the parts that are.
        assert_eq!(
            codes(r#"{"type":"MultiPolygon","coordinates":[5,[],[[[0,0],[4,0],[4,4],[0,4]]]]}"#),
            ["EMPTY", "RING_NOT_CLOSED", "BAD_STRUCTURE"]
        );
        assert_eq!(
            codes(
                r#"{"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[]},{"type":"LineString","coordinates":[[0,0]]}]}"#
            ),
            ["EMPTY", "TOO_FEW_POSITIONS"]
        );
        assert_eq!(
            codes(r#"{"type":"GeometryCollection","geometries":[]}"#),
            ["EMPTY"]
        );
        assert_eq!(codes(r#"{"type":"GeometryCollection"}"#), ["BAD_STRUCTURE"]);
        let mut nested = r#"{"type":"Point","coordinates":[1,2]}"#.to_string();
        for _ in 0..33 {
            nested = format!(r#"{{"type":"GeometryCollection","geometries":[{nested}]}}"#);
        }
        assert_eq!(codes(&nested), ["BAD_STRUCTURE"]);
    }

    #[test]
    fn tells_shape_from_validity() {
        let shape = |t: &str| has_shape(&parse(t).unwrap());
        let valid = |t: &str| is_valid(&parse(t).unwrap());
        let open = r#"{"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[0,4]]]}"#;
        assert!(shape(open) && !valid(open));
        let bow = r#"{"type":"Polygon","coordinates":[[[0,0],[4,4],[4,0],[0,4],[0,0]]]}"#;
        assert!(shape(bow) && !valid(bow));
        assert!(!shape(r#"{"type":"Point","coordinates":["a","b"]}"#));
        assert!(!shape(r#"{"type":"Circle","coordinates":[1,2]}"#));
        // A ring too large for the self-intersection test is noted, and still valid.
        let n = 10_002;
        let ring: Vec<String> = (0..=n)
            .map(|i| {
                let a = (i % n) as f64 / n as f64 * std::f64::consts::TAU;
                format!("[{},{}]", a.cos(), a.sin())
            })
            .collect();
        let big = format!(
            r#"{{"type":"Polygon","coordinates":[[{}]]}}"#,
            ring.join(",")
        );
        assert_eq!(codes(&big), ["SKIPPED_TOO_LARGE"]);
        assert!(valid(&big));
    }

    #[test]
    fn keeps_its_verdicts_for_huge_and_tiny_rings() {
        let ring = |s: f64| {
            format!(
                r#"{{"type":"Polygon","coordinates":[[[0,0],[{a},{a}],[{a},0],[0,{a}],[0,0]]]}}"#,
                a = crate::canonical::canonical_number(4.0 * s)
            )
        };
        for scale in [1e-300, 1e-160, 1.0, 1e160, 1e300] {
            assert_eq!(codes(&ring(scale)), ["SELF_INTERSECTION"], "{scale}");
        }
    }

    #[test]
    fn tests_ranges_and_swaps() {
        let g = |t: &str| parse(t).unwrap();
        assert!(in_range(&g(r#"{"type":"Point","coordinates":[180,-90]}"#)));
        assert!(!in_range(&g(r#"{"type":"Point","coordinates":[2.5,91]}"#)));
        assert!(!in_range(&g(
            r#"{"type":"LineString","coordinates":[[0,0],[181,0]]}"#
        )));
        assert!(in_range(&g(r#"{"type":"Point","coordinates":[]}"#)));
        assert!(in_range(&g(
            r#"{"type":"GeometryCollection","geometries":[]}"#
        )));
        assert!(likely_swapped(57.1, 120.0, None));
        assert!(!likely_swapped(2.5, 57.1, None));
        let area: BBox = [0.0, 50.0, 10.0, 60.0];
        assert!(likely_swapped(57.1, 2.5, Some(&area)));
        assert!(!likely_swapped(2.5, 57.1, Some(&area)));
        assert!(any_swapped(
            &g(r#"{"type":"MultiPoint","coordinates":[[2.5,57.1],[57.1,2.5]]}"#),
            Some(&area)
        ));
        assert!(!any_swapped(
            &g(r#"{"type":"MultiPoint","coordinates":[[2.5,57.1],[3,58]]}"#),
            Some(&area)
        ));
    }

    #[test]
    fn tests_bounding_boxes() {
        let g = |t: &str| parse(t).unwrap();
        let b: BBox = [0.0, 0.0, 10.0, 10.0];
        assert!(bbox_intersects(
            &b,
            &g(r#"{"type":"Point","coordinates":[10,10]}"#)
        ));
        assert!(!bbox_intersects(
            &b,
            &g(r#"{"type":"Point","coordinates":[10.1,10]}"#)
        ));
        // A line crossing the box with no vertex inside it.
        assert!(bbox_intersects(
            &b,
            &g(r#"{"type":"LineString","coordinates":[[-5,5],[15,5]]}"#)
        ));
        assert!(!bbox_intersects(
            &b,
            &g(r#"{"type":"LineString","coordinates":[[-5,11],[15,11]]}"#)
        ));
        // A polygon enclosing the box, and one whose hole encloses it.
        let around =
            r#"{"type":"Polygon","coordinates":[[[-20,-20],[30,-20],[30,30],[-20,30],[-20,-20]]]}"#;
        assert!(bbox_intersects(&b, &g(around)));
        let hole = r#"{"type":"Polygon","coordinates":[[[-20,-20],[30,-20],[30,30],[-20,30],[-20,-20]],[[-5,-5],[15,-5],[15,15],[-5,15],[-5,-5]]]}"#;
        assert!(!bbox_intersects(&b, &g(hole)));
        // A box across the antimeridian.
        let across: BBox = [170.0, -10.0, -170.0, 10.0];
        assert!(bbox_contains(&across, 175.0, 0.0) && bbox_contains(&across, -175.0, 0.0));
        assert!(!bbox_contains(&across, 0.0, 0.0));
        assert!(bbox_intersects(
            &across,
            &g(r#"{"type":"Point","coordinates":[-179,5]}"#)
        ));
        assert!(!bbox_intersects(
            &across,
            &g(r#"{"type":"Point","coordinates":[0,5]}"#)
        ));
        assert!(bbox_intersects(
            &b,
            &g(
                r#"{"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[50,50]},{"type":"Point","coordinates":[5,5]}]}"#
            )
        ));
    }
}
