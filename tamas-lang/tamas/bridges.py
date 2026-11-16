"""Bridges to the outside world: JSON, GeoJSON, CSV, Python libraries, and Tamas's own notation."""
import csv
import importlib
import json
import math
import os
import re

from .errors import TamasError
from .lexer import KEYWORDS
from .units import Quantity

_BARE_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


# ---- plain data <-> Tamas notation -------------------------------------------------

def to_plain(v):
    """A Tamas value as plain JSON-compatible data."""
    if isinstance(v, Quantity):
        return {"value": v.value, "unit": v.unit}
    if isinstance(v, dict):
        return {str(k): to_plain(x) for k, x in v.items() if not callable(x)}
    if isinstance(v, (list, tuple)):
        return [to_plain(x) for x in v]
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    return str(v)


def quote(s):
    out = []
    for ch in s:
        if ch in '"\\{':
            out.append("\\" + ch)
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\r":
            out.append("\\r")
        elif ord(ch) < 32:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


def key_text(k):
    return k if _BARE_KEY.match(k) and k not in KEYWORDS else quote(k)


def _scalar(v):
    if v is None:
        return "nothing"
    if v is True:
        return "yes"
    if v is False:
        return "no"
    if isinstance(v, str):
        return quote(v)
    if isinstance(v, Quantity):
        return str(v)
    if isinstance(v, float) and not math.isfinite(v):
        raise TamasError("infinity and not-a-number cannot be written as Tamas data")
    return repr(v)


def _value(v, pad):
    if isinstance(v, dict):
        if not v:
            return "{}"
        inner = pad + "  "
        rows = [f"{inner}{key_text(str(k))}: {_value(x, inner)}" for k, x in v.items()]
        return "{\n" + "\n".join(rows) + "\n" + pad + "}"
    if isinstance(v, (list, tuple)):
        if not v:
            return "[]"
        if all(not isinstance(x, (dict, list, tuple)) for x in v):
            flat = "[" + ", ".join(_scalar(x) for x in v) + "]"
            if len(flat) + len(pad) <= 100:
                return flat
        inner = pad + "  "
        return "[\n" + ",\n".join(inner + _value(x, inner) for x in v) + "\n" + pad + "]"
    return _scalar(v)


def to_tms(data):
    """Plain data as Tamas source. A record becomes top-level bindings; anything else one expression."""
    if isinstance(data, dict) and data:
        return "".join(f"{key_text(str(k))}: {_value(v, '')}\n" for k, v in data.items())
    return _value(data, "") + "\n"


def json_to_tms(text):
    return to_tms(json.loads(text))


# ---- files -------------------------------------------------------------------------

def _cell(s):
    for cast in (int, float):
        try:
            return cast(s)
        except ValueError:
            pass
    return s


def read_file(path, run_tms):
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".tms":
            return run_tms(path)
        with open(path, encoding="utf-8", newline="") as f:
            if ext in (".json", ".geojson"):
                return json.load(f)
            if ext == ".csv":
                return [{k: _cell(v) for k, v in row.items()} for row in csv.DictReader(f)]
            return f.read()
    except OSError as e:
        raise TamasError(f"cannot read '{path}': {e.strerror}")
    except json.JSONDecodeError as e:
        raise TamasError(f"'{path}' is not valid JSON: {e}")


def write_file(path, value):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".json", ".geojson"):
        text = json.dumps(to_plain(value), ensure_ascii=False, indent=2) + "\n"
    elif ext == ".tms":
        text = to_tms(to_plain(value))
    else:
        text = value if isinstance(value, str) else json.dumps(to_plain(value), ensure_ascii=False)
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    except OSError as e:
        raise TamasError(f"cannot write '{path}': {e.strerror}")
    return path


# ---- other languages ---------------------------------------------------------------

def bridge(kind, name):
    """Borrow a library from another language. Only Python is connected in v0.1."""
    if kind != "python":
        raise TamasError(f"the '{kind}' bridge is not built yet (v0.1 connects: python)")
    try:
        return importlib.import_module(name)
    except ImportError:
        raise TamasError(f"Python has no library called '{name}' installed")


# ---- geography (GeoJSON-shaped) ----------------------------------------------------

_EARTH_KM = 6371.0088


def _lonlat(p):
    if isinstance(p, dict):
        if p.get("type") == "Feature":
            p = p.get("geometry")
        if isinstance(p, dict) and p.get("type") == "Point":
            p = p["coordinates"]
    if not isinstance(p, list) or len(p) < 2:
        raise TamasError("expected a point: [longitude, latitude], a GeoJSON Point or a Point Feature")
    return float(p[0]), float(p[1])


def geo_distance(a, b):
    lon1, lat1 = _lonlat(a)
    lon2, lat2 = _lonlat(b)
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    km = 2 * _EARTH_KM * math.asin(math.sqrt(h))
    return Quantity(km * 1000, {"m": 1}, "km", 1000)


def geo_length(line):
    if isinstance(line, dict):
        if line.get("type") == "Feature":
            line = line["geometry"]
        line = line["coordinates"]
    total = Quantity(0, {"m": 1}, "km", 1000)
    for a, b in zip(line, line[1:]):
        total = total + geo_distance(a, b)
    return total


GEO = {
    "distance": geo_distance,
    "length": geo_length,
    "point": lambda lon, lat: {"type": "Point", "coordinates": [lon, lat]},
    "line": lambda coords: {"type": "LineString", "coordinates": coords},
    "feature": lambda geometry, properties=None: {"type": "Feature", "geometry": geometry,
                                                  "properties": properties or {}},
    "collection": lambda features: {"type": "FeatureCollection", "features": features},
}
