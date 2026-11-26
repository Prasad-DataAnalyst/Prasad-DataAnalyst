"""GeoPackage oracle: python3 -I check_geopackage.py <package.zip>. Opens data.gpkg with SQLite
itself (Python's sqlite3 module), independently of the product's reader: runs SQLite's integrity
and foreign key checks, reads the GeoPackage tables with SQL, decodes each GeoPackageBinary
geometry with the struct module, and reports the SAD 9.4 digest of every column it holds: the
fields by name, and the geometries as GeoJSON under the geometry column's header."""

import json
import os
import sqlite3
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from canonical import column_digest  # noqa: E402
from common import emit, open_package, retype  # noqa: E402

NAMES = {
    1: "Point",
    2: "LineString",
    3: "Polygon",
    4: "MultiPoint",
    5: "MultiLineString",
    6: "MultiPolygon",
    7: "GeometryCollection",
}
ENVELOPE_DOUBLES = {0: 0, 1: 4, 2: 6, 3: 6, 4: 8}


class Wkb:
    """ISO Well-Known Binary, each geometry in its own byte order."""

    def __init__(self, data, at):
        self.data = data
        self.at = at

    def take(self, fmt):
        values = struct.unpack_from(fmt, self.data, self.at)
        self.at += struct.calcsize(fmt)
        return values

    def geometry(self):
        (order,) = self.take("B")
        e = "<" if order == 1 else ">"
        (code,) = self.take(e + "I")
        base, dims = code % 1000, code // 1000
        has_z, has_m = dims in (1, 3), dims in (2, 3)
        n = 2 + has_z + has_m

        def position():
            p = list(self.take(e + "d" * n))
            return p[: 3 if has_z else 2]

        def positions():
            (count,) = self.take(e + "I")
            return [position() for _ in range(count)]

        name = NAMES[base]
        if name == "Point":
            p = position()
            return {"type": name, "coordinates": [] if all(v != v for v in p) else p}
        if name == "LineString":
            return {"type": name, "coordinates": positions()}
        if name == "Polygon":
            (rings,) = self.take(e + "I")
            return {"type": name, "coordinates": [positions() for _ in range(rings)]}
        (count,) = self.take(e + "I")
        members = [self.geometry() for _ in range(count)]
        if name == "GeometryCollection":
            return {"type": name, "geometries": members}
        return {"type": name, "coordinates": [m["coordinates"] for m in members]}


def gpkg_geometry(blob):
    """GeoPackageBinary: "GP", version, flags, SRS ID and envelope, then the WKB."""
    if blob[:2] != b"GP" or blob[2] != 0:
        raise ValueError("a geometry is not GeoPackageBinary version 1")
    flags = blob[3]
    e = "<" if flags & 1 else ">"
    (srs_id,) = struct.unpack_from(e + "i", blob, 4)
    doubles = ENVELOPE_DOUBLES[(flags >> 1) & 7]
    envelope = list(struct.unpack_from(e + "d" * doubles, blob, 8))
    geometry = Wkb(blob, 8 + 8 * doubles).geometry()
    return srs_id, bool(flags & 0x10), envelope, geometry


def typed(v, kind):
    """A field with the manifest's column type, as the other oracles type exported values."""
    if v is None:
        return None
    if kind in ("number", "integer"):
        return float(v)
    if kind == "boolean":
        return bool(v)
    return retype(v, kind)


def main(path):
    files, manifest = open_package(path)
    data = files["data.gpkg"]
    con = sqlite3.connect(":memory:")
    con.deserialize(data)
    q = lambda sql, *args: con.execute(sql, args).fetchall()  # noqa: E731
    (table, data_type, identifier, last_change, min_x, min_y, max_x, max_y, srs_id) = q(
        "SELECT table_name, data_type, identifier, last_change, min_x, min_y, max_x, max_y, srs_id FROM gpkg_contents"
    )[0]
    (column, type_name, geometry_srs, z, m) = q(
        "SELECT column_name, geometry_type_name, srs_id, z, m FROM gpkg_geometry_columns WHERE table_name = ?", table
    )[0]
    info = q("SELECT name, type, pk FROM pragma_table_info(?)", table)
    fid = [name for name, _, pk in info if pk == 1][0]
    fields = [(name, kind) for name, kind, pk in info if pk == 0 and name != column]
    quoted = lambda n: '"' + n.replace('"', '""') + '"'  # noqa: E731
    select = ", ".join(quoted(n) for n in [fid, column] + [n for n, _ in fields])
    rows = q(f"SELECT {select} FROM {quoted(table)} ORDER BY {quoted(fid)}")
    shapes = []
    systems = set()
    for row in rows:
        if row[1] is None:
            shapes.append(None)
            continue
        srs, _, _, g = gpkg_geometry(row[1])
        systems.add(srs)
        shapes.append(g)
    kinds = {c["header"]: c["type"] for c in manifest["dataset"]["columns"]}
    digests = [
        {"header": name, "sha256": column_digest([typed(r[2 + j], kinds[name]) for r in rows])}
        for j, (name, _) in enumerate(fields)
    ]
    geometry_columns = [c for c in manifest["dataset"]["columns"] if c["type"] == "geometry"]
    if geometry_columns:
        values = [None if s is None else {"geometry": s} for s in shapes]
        digests.append({"header": geometry_columns[0]["header"], "sha256": column_digest(values)})
    srs = q(
        "SELECT organization, organization_coordsys_id, srs_name, definition FROM gpkg_spatial_ref_sys WHERE srs_id = ?",
        srs_id,
    )
    emit(
        {
            "integrity": [r[0] for r in q("PRAGMA integrity_check")],
            "foreign_keys": q("PRAGMA foreign_key_check"),
            "application_id": q("PRAGMA application_id")[0][0],
            "user_version": q("PRAGMA user_version")[0][0],
            "srs_ids": [r[0] for r in q("SELECT srs_id FROM gpkg_spatial_ref_sys ORDER BY srs_id")],
            "srs": None if not srs else {"org": srs[0][0], "code": srs[0][1], "name": srs[0][2], "wkt": srs[0][3][:7]},
            "table": table,
            "data_type": data_type,
            "identifier": identifier,
            "last_change": last_change,
            "extent": [min_x, min_y, max_x, max_y],
            "geometry_column": {"name": column, "type": type_name, "srs_id": geometry_srs, "z": z, "m": m},
            "geometry_srs_ids": sorted(systems),
            "fid": fid,
            "fids_in_order": [r[0] for r in rows] == list(range(1, len(rows) + 1)),
            "field_types": [kind for _, kind in fields],
            "features": len(rows),
            "with_geometry": sum(1 for s in shapes if s is not None),
            "columns": digests,
            "geometries": json.dumps(shapes[:3]),
        }
    )


if __name__ == "__main__":
    main(sys.argv[1])
