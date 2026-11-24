"""KML oracle: python3 -I check_kml.py <package.zip>. Reads data.kml with Python's ElementTree,
independently of the product's reader, and reports the structure and the SAD 9.4 digest of every
column it holds: the extended data by header, and the geometries under the geometry column's
header, a MultiGeometry read as a multi-part geometry when its members are all of one kind."""

import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from canonical import column_digest  # noqa: E402
from common import emit, open_package, retype  # noqa: E402

NS = "{http://www.opengis.net/kml/2.2}"


def positions(element):
    text = (element.findtext(f"{NS}coordinates") or "").split()
    return [[float(x) for x in t.split(",")] for t in text]


def geometry(element):
    tag = element.tag[len(NS):]
    if tag == "Point":
        return {"type": "Point", "coordinates": positions(element)[0]}
    if tag == "LineString":
        return {"type": "LineString", "coordinates": positions(element)}
    if tag == "Polygon":
        outer = [positions(r) for r in element.findall(f"{NS}outerBoundaryIs/{NS}LinearRing")]
        inner = [positions(r) for r in element.findall(f"{NS}innerBoundaryIs/{NS}LinearRing")]
        return {"type": "Polygon", "coordinates": outer + inner}
    members = [geometry(m) for m in element]
    kinds = {m["type"] for m in members}
    if members and kinds == {"Point"}:
        return {"type": "MultiPoint", "coordinates": [m["coordinates"] for m in members]}
    if members and kinds == {"LineString"}:
        return {"type": "MultiLineString", "coordinates": [m["coordinates"] for m in members]}
    if members and kinds == {"Polygon"}:
        return {"type": "MultiPolygon", "coordinates": [m["coordinates"] for m in members]}
    return {"type": "GeometryCollection", "geometries": members}


GEOMETRIES = {f"{NS}{t}" for t in ("Point", "LineString", "Polygon", "MultiGeometry")}


def main(path):
    files, manifest = open_package(path)
    root = ET.fromstring(files["data.kml"])
    document = root.find(f"{NS}Document")
    placemarks = document.findall(f"{NS}Placemark") if document is not None else []
    rows = []
    shapes = []
    for p in placemarks:
        rows.append([(d.get("name"), d.findtext(f"{NS}value") or "") for d in p.findall(f"{NS}ExtendedData/{NS}Data")])
        found = [g for g in p if g.tag in GEOMETRIES]
        shapes.append(geometry(found[0]) if found else None)
    columns = {c["header"]: c for c in manifest["dataset"]["columns"]}
    headers = [name for name, _ in rows[0]] if rows else []
    digests = []
    for j, header in enumerate(headers):
        kind = columns[header]["type"]
        digests.append({"header": header, "sha256": column_digest([retype(r[j][1], kind) for r in rows])})
    geometry_columns = [c for c in manifest["dataset"]["columns"] if c["type"] == "geometry"]
    if geometry_columns:
        values = [None if g is None else {"geometry": g} for g in shapes]
        digests.append({"header": geometry_columns[0]["header"], "sha256": column_digest(values)})
    emit(
        {
            "root": root.tag,
            "documents": len(root.findall(f"{NS}Document")),
            "name": document.findtext(f"{NS}name") if document is not None else None,
            "placemarks": len(placemarks),
            "named": sum(1 for p in placemarks if p.find(f"{NS}name") is not None),
            "with_geometry": sum(1 for s in shapes if s is not None),
            "columns": digests,
        }
    )


if __name__ == "__main__":
    main(sys.argv[1])
