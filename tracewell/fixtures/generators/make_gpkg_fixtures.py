#!/usr/bin/env python3
"""Writes the GeoPackage fixtures of the messy-file library into fixtures/messy.

SQLite itself writes them (Python's sqlite3 module), not the product's writer, so the GeoPackage
reader is tested against what the SQLite library makes: its page layout and record encoding
(whole numbers in REAL columns stored as integers), interior and overflow pages, the free space a
deleted row leaves, a WAL-mode header, UTF-16 text, an R-tree spatial index with its shadow
tables, and records written before a column was added. The geometries are GeoPackageBinary,
packed here with struct in both byte orders and with each kind of envelope.
fixtures/README.md says what each file breaks.

Usage: python3 fixtures/generators/make_gpkg_fixtures.py [--out DIR]

With SQLite 3.53.1 (Python 3.13) the output is byte-for-byte reproducible; another SQLite version
records its own version number in the header, and may lay pages out differently. After running
this script, run gen-text-fixtures.mjs to refresh SHA256SUMS, then check every expectation again.
"""

from __future__ import annotations

import argparse
import sqlite3
import struct
from pathlib import Path

DEFAULT_OUT = Path(__file__).resolve().parent.parent / "messy"

WGS84 = (
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],'
    'AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],'
    'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]'
)
BNG = (
    'PROJCS["OSGB36 / British National Grid",GEOGCS["OSGB36",DATUM["Ordnance_Survey_of_Great_Britain_1936",'
    'SPHEROID["Airy 1830",6377563.396,299.3249646,AUTHORITY["EPSG","7001"]],AUTHORITY["EPSG","6277"]],'
    'PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],'
    'AUTHORITY["EPSG","4277"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",49],'
    'PARAMETER["central_meridian",-2],PARAMETER["scale_factor",0.9996012717],PARAMETER["false_easting",400000],'
    'PARAMETER["false_northing",-100000],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","27700"]]'
)

SRS_SQL = (
    "CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, "
    "organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, "
    "description TEXT)"
)
CONTENTS_SQL = (
    "CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, "
    "identifier TEXT UNIQUE, description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT "
    "(strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, "
    "srs_id INTEGER, CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id))"
)
GEOMETRY_COLUMNS_SQL = (
    "CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, "
    "geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, "
    "CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name), CONSTRAINT uk_gc_table_name UNIQUE (table_name), "
    "CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name), "
    "CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id))"
)
EXTENSIONS_SQL = (
    "CREATE TABLE gpkg_extensions (table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL, "
    "definition TEXT NOT NULL, scope TEXT NOT NULL, CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name))"
)

UNDEFINED = [
    ("Undefined Cartesian SRS", -1, "NONE", -1, "undefined", "undefined Cartesian coordinate reference system"),
    ("Undefined geographic SRS", 0, "NONE", 0, "undefined", "undefined geographic coordinate reference system"),
]


def wkb(order, kind, z, body):
    """An ISO WKB geometry: byte order, type (plus 1000 with heights), then its parts."""
    e = "<" if order == "little" else ">"
    return struct.pack(e + "BI", 1 if order == "little" else 0, kind + (1000 if z else 0)) + body(e)


def point(order, p):
    return wkb(order, 1, len(p) == 3, lambda e: struct.pack(e + "d" * len(p), *p))


def ring_bytes(e, ring):
    return struct.pack(e + "I", len(ring)) + b"".join(struct.pack(e + "d" * len(p), *p) for p in ring)


def polygon(order, rings):
    z = len(rings[0][0]) == 3
    return wkb(order, 3, z, lambda e: struct.pack(e + "I", len(rings)) + b"".join(ring_bytes(e, r) for r in rings))


def multipolygon(order, polygons):
    return wkb(order, 6, False, lambda e: struct.pack(e + "I", len(polygons)) + b"".join(polygon(order, p) for p in polygons))


def gp(order, srs_id, geometry, envelope):
    """GeoPackageBinary: "GP", version 0, flags (byte order, envelope kind), SRS ID, envelope, WKB."""
    e = "<" if order == "little" else ">"
    indicator = {0: 0, 4: 1, 6: 2, 8: 4}[len(envelope)]
    flags = (1 if order == "little" else 0) | (indicator << 1)
    return b"GP" + bytes([0, flags]) + struct.pack(e + "i", srs_id) + struct.pack(e + "d" * len(envelope), *envelope) + geometry


def metadata(con, systems):
    for sql in (SRS_SQL, CONTENTS_SQL, GEOMETRY_COLUMNS_SQL):
        con.execute(sql)
    con.executemany("INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)", UNDEFINED + systems)


def wells(path):
    """40 wells written by SQLite with 1,024-byte pages in WAL mode; one is then deleted."""
    con = sqlite3.connect(path)
    con.execute("PRAGMA page_size = 1024")
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA application_id = 1196444487")  # "GPKG"
    con.execute("PRAGMA user_version = 10400")
    metadata(con, [("WGS 84 geodetic", 4326, "EPSG", 4326, WGS84, "longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid")])
    con.execute(EXTENSIONS_SQL)
    con.execute(
        'CREATE TABLE "wells" ("fid" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "geom" POINT, "well_id" TEXT(12), '
        '"operator" TEXT, "spud_date" DATE, "last_test" DATETIME, "tvd_m" REAL, "slots" MEDIUMINT, "online" BOOLEAN, '
        '"remarks" TEXT, "photo" BLOB)'
    )
    con.execute("CREATE VIRTUAL TABLE rtree_wells_geom USING rtree(id, minx, maxx, miny, maxy)")
    con.execute(
        "INSERT INTO gpkg_extensions VALUES ('wells', 'geom', 'gpkg_rtree_index', "
        "'http://www.geopackage.org/spec120/#extension_rtree', 'write-only')"
    )
    operators = ["Brent Energy", "Forties Oil", "Cormorant Petroleum", ""]
    xs, ys = [], []
    for i in range(1, 41):
        x, y = round(1.0 + 0.05 * i, 4), round(57.0 + 0.02 * i, 4)
        p = (x, y, -1200.5) if i == 9 else (x, y)
        blob = None if i == 17 else gp("little", 4326, point("little", p), [])
        if blob is not None:
            xs.append(x)
            ys.append(y)
        last_test = None if i == 22 else f"2025-{1 + i % 12:02d}-{1 + i % 27:02d}T{i % 24:02d}:30:00.000Z"
        if i == 31:
            last_test = "2025-08-05T10:30:00Z"
        con.execute(
            'INSERT INTO "wells" VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (
                blob,
                f"NS-{'ABCD'[(i - 1) // 10]}{(i - 1) % 10 + 1:02d}",
                None if i % 11 == 0 else operators[i % 4],
                f"{2010 + i % 12}-{1 + i % 12:02d}-{1 + i % 27:02d}",
                last_test,
                i * 125.0 if i % 2 == 0 else i * 125.5,
                i % 6,
                None if i == 25 else int(i % 3 != 0),
                ("Long test record: " + "pressure build-up, " * 160).strip() if i == 13 else f"Workover {i % 5}",
                bytes(range(16)) if i == 5 else None,
            ),
        )
        if blob is not None:
            con.execute("INSERT INTO rtree_wells_geom VALUES (?, ?, ?, ?, ?)", (i, x, x, y, y))
    con.execute(
        "INSERT INTO gpkg_contents VALUES ('wells', 'features', 'wells', 'North Sea wells', "
        "'2026-11-01T00:00:00.000Z', ?, ?, ?, ?, 4326)",
        (min(xs), min(ys), max(xs), max(ys)),
    )
    con.execute("INSERT INTO gpkg_geometry_columns VALUES ('wells', 'geom', 'POINT', 4326, 2, 0)")
    con.execute('DELETE FROM "wells" WHERE fid = 7')
    con.execute("DELETE FROM rtree_wells_geom WHERE id = 7")
    con.commit()
    con.close()


def square(x, y, s, z=None):
    ring = [(x, y), (x + s, y), (x + s, y + s), (x, y + s), (x, y)]
    return [p + (z,) for p in ring] if z is not None else ring


def blocks(path):
    """Licence blocks in British National Grid, a GeoPackage 1.0 file in UTF-16LE, and an attributes table."""
    con = sqlite3.connect(path)
    con.execute('PRAGMA encoding = "UTF-16le"')
    con.execute("PRAGMA application_id = 1196437808")  # "GP10"
    metadata(
        con,
        [
            ("WGS 84 geodetic", 4326, "EPSG", 4326, WGS84, None),
            ("OSGB36 / British National Grid", 27700, "epsg", 27700, BNG, None),
        ],
    )
    con.execute(
        "CREATE TABLE blocks (id INTEGER PRIMARY KEY, shape GEOMETRY, block_ref TEXT, licence TEXT, "
        "area_km2 DOUBLE, awarded DATE, operator_name TEXT)"
    )
    outer, hole = square(400000, 100000, 10000), square(402000, 102000, 2000)[::-1]
    rows = [
        (1, gp("big", 27700, polygon("big", [outer, hole]), [400000, 410000, 100000, 110000]), "211/27a", "P.123", 54.25, "2003-06-01", "Brent Energy"),
        (
            2,
            gp("little", 27700, multipolygon("little", [[square(420000, 100000, 5000)], [square(430000, 100000, 5000)]]), [420000, 435000, 100000, 105000]),
            "211/28",
            "P.124",
            102.0,
            "2004-01-15",
            "Øresund Energi ApS",
        ),
        (3, gp("big", 27700, polygon("big", [square(440000, 120000, 3000)]), []), "3/15", "P.2001", 12.5, None, "Société des Pétroles"),
        (4, None, "9/13a", "P.77", None, "1999-11-30", None),
        (
            5,
            gp("little", 27700, polygon("little", [square(450000, 130000, 4000, 15.0)]), [450000, 454000, 130000, 134000, 15.0, 15.0]),
            "16/26",
            "P.300",
            77.75,
            "2011-02-28",
            "Forties Oil 北海",
        ),
    ]
    con.executemany("INSERT INTO blocks VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
    con.execute("ALTER TABLE blocks ADD COLUMN comment TEXT")
    con.execute("UPDATE blocks SET comment = 'Relinquished in 2020' WHERE id = 4")
    con.execute("CREATE TABLE operators (id INTEGER PRIMARY KEY, name TEXT, country TEXT)")
    con.executemany(
        "INSERT INTO operators VALUES (?, ?, ?)",
        [(1, "Brent Energy", "GB"), (2, "Øresund Energi ApS", "DK"), (3, "Société des Pétroles", "FR")],
    )
    con.execute(
        "INSERT INTO gpkg_contents VALUES ('blocks', 'features', 'Licence blocks', '', '2026-11-01T00:00:00.000Z', "
        "400000, 100000, 454000, 134000, 27700)"
    )
    con.execute(
        "INSERT INTO gpkg_contents VALUES ('operators', 'attributes', 'Operators', '', '2026-11-01T00:00:00.000Z', "
        "NULL, NULL, NULL, NULL, NULL)"
    )
    con.execute("INSERT INTO gpkg_geometry_columns VALUES ('blocks', 'shape', 'GEOMETRY', 27700, 2, 0)")
    con.commit()
    con.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    out = parser.parse_args().out
    out.mkdir(parents=True, exist_ok=True)
    for name, make in (("gpkg_wells_points_wgs84.gpkg", wells), ("gpkg_licence_blocks_bng.gpkg", blocks)):
        path = out / name
        path.unlink(missing_ok=True)
        make(str(path))
        print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
