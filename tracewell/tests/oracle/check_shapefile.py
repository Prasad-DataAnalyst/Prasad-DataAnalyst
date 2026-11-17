"""Shapefile oracle: python3 -I check_shapefile.py <package.zip>. Reads data.shp, data.dbf and
data.fields.csv with Python's struct and csv modules, independently of the product's reader, and
reports the structure and the SAD 9.4 digest of every column it holds: the .dbf fields by their
full headers, and the shapes as GeoJSON geometries under the geometry column's header."""

import csv
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from canonical import column_digest  # noqa: E402
from common import emit, open_package, retype, text_stream  # noqa: E402


def ring_area(ring):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:]))


def shapes(data):
    code, words = struct.unpack(">i20xi", data[:28])
    version, shape_type = struct.unpack("<ii", data[28:36])
    records = []
    at = 100
    while at < len(data):
        number, length = struct.unpack(">ii", data[at : at + 8])
        content = data[at + 8 : at + 8 + 2 * length]
        records.append((number, content))
        at += 8 + 2 * length
    return {"code": code, "words": words, "version": version, "type": shape_type}, records


def geometry(content):
    (kind,) = struct.unpack("<i", content[:4])
    if kind == 0:
        return None
    if kind in (1, 11):
        n = 3 if kind == 11 else 2
        return {"type": "Point", "coordinates": list(struct.unpack(f"<{n}d", content[4 : 4 + 8 * n]))}
    multipoint = kind in (8, 18)
    if multipoint:
        (count,) = struct.unpack("<i", content[36:40])
        starts, at = [0], 40
    else:
        nparts, count = struct.unpack("<ii", content[36:44])
        starts = list(struct.unpack(f"<{nparts}i", content[44 : 44 + 4 * nparts]))
        at = 44 + 4 * nparts
    xy = [list(struct.unpack("<2d", content[at + 16 * i : at + 16 * i + 16])) for i in range(count)]
    if kind in (13, 15, 18):
        zat = at + 16 * count + 16
        for i, p in enumerate(xy):
            p.append(struct.unpack("<d", content[zat + 8 * i : zat + 8 * i + 8])[0])
    parts = [xy[s : (starts[i + 1] if i + 1 < len(starts) else count)] for i, s in enumerate(starts)]
    if multipoint:
        return {"type": "MultiPoint", "coordinates": parts[0]}
    if kind in (3, 13):
        return {"type": "LineString", "coordinates": parts[0]} if len(parts) == 1 else {
            "type": "MultiLineString",
            "coordinates": parts,
        }
    polygons = []
    for ring in parts:
        if ring_area(ring) < 0 or not polygons:
            polygons.append([ring])
        else:
            polygons[-1].append(ring)
    if len(polygons) == 1:
        return {"type": "Polygon", "coordinates": polygons[0]}
    return {"type": "MultiPolygon", "coordinates": polygons}


def dbf(data):
    count, header_length, record_length = struct.unpack("<IHH", data[4:12])
    fields = []
    at = 32
    while data[at] != 0x0D:
        name = data[at : at + 11].split(b"\0")[0].decode("ascii")
        fields.append((name, chr(data[at + 11]), data[at + 16]))
        at += 32
    rows = []
    for r in range(count):
        at = header_length + r * record_length + 1
        row = []
        for _, _, width in fields:
            row.append(data[at : at + width].decode("utf-8").strip(" "))
            at += width
        rows.append(row)
    return fields, rows


def dbf_value(text, field_type, kind):
    if text == "" or (field_type == "L" and text == "?"):
        return None
    if field_type == "L":
        return text in ("T", "t", "Y", "y")
    if field_type == "D":
        return {"date": f"{text[0:4]}-{text[4:6]}-{text[6:8]}"}
    return retype(text, kind)


def main(path):
    files, manifest = open_package(path)
    head, records = shapes(files["data.shp"])
    fields, rows = dbf(files["data.dbf"])
    listed = list(csv.reader(text_stream(files["data.fields.csv"].decode("utf-8"))))[1:]
    digests = []
    for j, (field, name, unit, kind) in enumerate(listed):
        header = f"{name} [{unit}]" if unit else name
        values = [dbf_value(row[j], fields[j][1], kind) for row in rows]
        digests.append({"header": header, "sha256": column_digest(values), "field": field})
    geometry_columns = [c for c in manifest["dataset"]["columns"] if c["type"] == "geometry"]
    if geometry_columns:
        shapes_read = [geometry(content) for _, content in records]
        values = [None if g is None else {"geometry": g} for g in shapes_read]
        digests.append({"header": geometry_columns[0]["header"], "sha256": column_digest(values)})
    emit(
        {
            "file_code": head["code"],
            "version": head["version"],
            "shape_type": head["type"],
            "length_ok": head["words"] * 2 == len(files["data.shp"]),
            "records": len(records),
            "numbered": [n for n, _ in records] == list(range(1, len(records) + 1)),
            "dbf_records": len(rows),
            "field_names": [f[0] for f in fields],
            "fields_listed": [r[0] for r in listed],
            "prj": files["data.prj"].decode("utf-8"),
            "cpg": files["data.cpg"].decode("utf-8"),
            "columns": digests,
        }
    )


if __name__ == "__main__":
    main(sys.argv[1])
