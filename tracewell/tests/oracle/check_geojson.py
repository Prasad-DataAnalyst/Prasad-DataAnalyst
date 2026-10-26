"""GeoJSON oracle: python3 -I check_geojson.py <package.zip>. Parses data.geojson with Python's json
module and reports its structure and the SAD 9.4 digest of every column."""

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from canonical import column_digest  # noqa: E402
from common import emit, open_package, retype  # noqa: E402

TYPES = {"Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"}


def positions(g):
    if g is None:
        return
    if g["type"] == "GeometryCollection":
        for child in g["geometries"]:
            yield from positions(child)
        return
    stack = [g["coordinates"]]
    while stack:
        c = stack.pop()
        if c and isinstance(c[0], (int, float)):
            yield c
        else:
            stack.extend(c)


def prop_value(v, kind):
    if v is None or v == "":
        return None
    if kind in ("number", "integer"):
        return float(v)
    if kind == "boolean" and isinstance(v, bool):
        return v
    if isinstance(v, str):
        return retype(v, kind)
    raise ValueError(f"unexpected property value {v!r} for {kind}")


def main(path):
    files, manifest = open_package(path)
    doc = json.loads(files["data.geojson"].decode("utf-8"))
    features = doc.get("features", [])
    columns = manifest["dataset"]["columns"]
    digests = []
    for col in columns:
        header = col["header"]
        in_props = any(header in (f.get("properties") or {}) for f in features)
        if col["type"] == "geometry" and not in_props:
            values = [None if f.get("geometry") is None else {"geometry": f["geometry"]} for f in features]
        else:
            values = [prop_value((f.get("properties") or {}).get(header), col["type"]) for f in features]
        digests.append({"header": header, "sha256": column_digest(values)})
    in_range = all(
        -180 <= p[0] <= 180 and -90 <= p[1] <= 90 and all(math.isfinite(x) for x in p)
        for f in features
        for p in positions(f.get("geometry"))
    )
    emit(
        {
            "type": doc.get("type"),
            "has_crs_member": "crs" in doc,
            "features": len(features),
            "geometry_types": sorted({f["geometry"]["type"] for f in features if f.get("geometry")}),
            "valid_types": all(f.get("geometry") is None or f["geometry"].get("type") in TYPES for f in features),
            "in_lonlat_range": in_range,
            "columns": digests,
        }
    )


if __name__ == "__main__":
    main(sys.argv[1])
