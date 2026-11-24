"""FlatGeobuf oracle: python3 -I check_flatgeobuf.py <package.zip>. Reads data.fgb with Python's
struct module, following the FlatBuffers layout and the FlatGeobuf schema (header.fbs,
feature.fbs) independently of the product's reader, and reports the header and the SAD 9.4 digest
of every column it holds: the properties by column name, and the geometries as GeoJSON under the
geometry column's header."""

import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from canonical import column_digest  # noqa: E402
from common import emit, open_package, retype  # noqa: E402

NAMES = [
    "Unknown",
    "Point",
    "LineString",
    "Polygon",
    "MultiPoint",
    "MultiLineString",
    "MultiPolygon",
    "GeometryCollection",
]


def scalar(fmt, buf, at):
    return struct.unpack_from("<" + fmt, buf, at)[0]


class Table:
    """A FlatBuffers table: its fields are found through the vtable its first word points to."""

    def __init__(self, buf, pos):
        self.buf = buf
        self.pos = pos
        self.vtable = pos - scalar("i", buf, pos)
        self.vsize = scalar("H", buf, self.vtable)

    def field(self, slot):
        entry = 4 + 2 * slot
        if entry >= self.vsize:
            return None
        offset = scalar("H", self.buf, self.vtable + entry)
        return None if offset == 0 else self.pos + offset

    def value(self, slot, fmt, default):
        at = self.field(slot)
        return default if at is None else scalar(fmt, self.buf, at)

    def vector(self, slot):
        at = self.field(slot)
        if at is None:
            return None
        start = at + scalar("I", self.buf, at)
        return start + 4, scalar("I", self.buf, start)

    def string(self, slot):
        v = self.vector(slot)
        return None if v is None else self.buf[v[0] : v[0] + v[1]].decode("utf-8")

    def numbers(self, slot, fmt):
        v = self.vector(slot)
        return None if v is None else list(struct.unpack_from(f"<{v[1]}{fmt}", self.buf, v[0]))

    def table(self, slot):
        at = self.field(slot)
        return None if at is None else Table(self.buf, at + scalar("I", self.buf, at))

    def tables(self, slot):
        v = self.vector(slot)
        if v is None:
            return []
        return [Table(self.buf, v[0] + 4 * i + scalar("I", self.buf, v[0] + 4 * i)) for i in range(v[1])]


def root(buf):
    return Table(buf, scalar("I", buf, 0))


def geometry(t, fallback, has_z):
    name = NAMES[t.value(6, "B", 0) or fallback]
    if name in ("MultiPolygon", "GeometryCollection"):
        parts = [geometry(p, 3 if name == "MultiPolygon" else 0, has_z) for p in t.tables(7)]
        if name == "GeometryCollection":
            return {"type": name, "geometries": parts}
        return {"type": name, "coordinates": [p["coordinates"] for p in parts]}
    xy = t.numbers(1, "d") or []
    z = (t.numbers(2, "d") or []) if has_z else None
    positions = [[xy[2 * i], xy[2 * i + 1]] + ([z[i]] if z is not None else []) for i in range(len(xy) // 2)]
    ends = t.numbers(0, "I")
    if ends is None:
        parts = [positions]
    else:
        parts = [positions[a:b] for a, b in zip([0] + ends, ends)]
    if name == "Point":
        return {"type": name, "coordinates": positions[0] if positions else []}
    if name in ("MultiPoint", "LineString"):
        return {"type": name, "coordinates": positions}
    return {"type": name, "coordinates": parts}


def properties(data, columns):
    values = [None] * len(columns)
    at = 0
    while at < len(data):
        (i,) = struct.unpack_from("<H", data, at)
        at += 2
        kind = columns[i][1]
        fixed = {0: "b", 1: "B", 2: "?", 3: "h", 4: "H", 5: "i", 6: "I", 7: "q", 8: "Q", 9: "f", 10: "d"}
        if kind in fixed:
            (values[i],) = struct.unpack_from("<" + fixed[kind], data, at)
            at += struct.calcsize("<" + fixed[kind])
        else:
            (n,) = struct.unpack_from("<I", data, at)
            raw = data[at + 4 : at + 4 + n]
            values[i] = raw if kind == 14 else raw.decode("utf-8")
            at += 4 + n
    return values


def typed(v, kind):
    """A property with the manifest's column type, as the other oracles type exported text."""
    if v is None:
        return None
    if kind in ("number", "integer"):
        return float(v)
    if kind == "boolean":
        return bool(v)
    return retype(v, kind)


def main(path):
    files, manifest = open_package(path)
    data = files["data.fgb"]
    magic = data[:8]
    (size,) = struct.unpack_from("<I", data, 8)
    header = root(data[12 : 12 + size])
    has_z = bool(header.value(3, "B", 0))
    columns = [(c.string(0), c.value(1, "B", 0)) for c in header.tables(7)]
    crs = header.table(10)
    at = 12 + size
    if header.value(9, "H", 16) != 0:
        raise ValueError("the file has a spatial index")
    rows = []
    shapes = []
    while at < len(data):
        (n,) = struct.unpack_from("<I", data, at)
        feature = root(data[at + 4 : at + 4 + n])
        g = feature.table(0)
        shapes.append(None if g is None else geometry(g, header.value(2, "B", 0), has_z))
        v = feature.vector(1)
        rows.append(properties(feature.buf[v[0] : v[0] + v[1]], columns) if v else [None] * len(columns))
        at += 4 + n
    kinds = {c["header"]: c["type"] for c in manifest["dataset"]["columns"]}
    digests = [
        {"header": name, "sha256": column_digest([typed(r[j], kinds[name]) for r in rows])}
        for j, (name, _) in enumerate(columns)
    ]
    geometry_columns = [c for c in manifest["dataset"]["columns"] if c["type"] == "geometry"]
    if geometry_columns:
        values = [None if s is None else {"geometry": s} for s in shapes]
        digests.append({"header": geometry_columns[0]["header"], "sha256": column_digest(values)})
    emit(
        {
            "magic": magic.hex(),
            "name": header.string(0),
            "geometry_type": NAMES[header.value(2, "B", 0)],
            "has_z": has_z,
            "envelope": header.numbers(1, "d"),
            "crs": None if crs is None else {"org": crs.string(0), "code": crs.value(1, "i", 0), "name": crs.string(2)},
            "features_count": header.value(8, "Q", 0),
            "features": len(shapes),
            "with_geometry": sum(1 for s in shapes if s is not None),
            "column_types": [kind for _, kind in columns],
            "columns": digests,
            "geometries": json.dumps(shapes[:3]),
        }
    )


if __name__ == "__main__":
    main(sys.argv[1])
