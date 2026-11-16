"""Bridges to the outside world: JSON, GeoJSON, CSV, Python libraries, and Tamas's own notation."""
import atexit
import csv
import ctypes
import ctypes.util
import importlib
import json
import math
import os
import re
import shutil
import subprocess

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

_MARK = "@@TAMAS@@ "
_HELPERS = os.path.join(os.path.dirname(__file__), "helpers")
_processes = {}


class Foreign:
    """Something that lives in another language's runtime (a module, class or object)."""

    def __init__(self, proc, root, path):
        self._proc, self._root, self._path = proc, root, tuple(path)

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        reply = self._proc.ask({"op": "get", "root": self._root, "path": list(self._path) + [name]})
        if reply["kind"] == "missing":
            raise AttributeError(name)
        if reply["kind"] == "value":
            return reply["value"]
        cls = ForeignFunction if reply["kind"] == "function" else Foreign
        return cls(self._proc, self._root, self._path + (name,))

    def __str__(self):
        return f"<{self._proc.kind} {'.'.join(self._path) or 'object'}>"


class ForeignFunction(Foreign):
    def __call__(self, *args):
        reply = self._proc.ask({"op": "call", "root": self._root, "path": list(self._path),
                                "args": [self._proc.encode(a) for a in args]})
        return self._proc.result(reply)


class _Process:
    """One helper process per foreign language, started the first time its bridge is used."""

    def __init__(self, kind, cmd, quiet):
        self.kind = kind
        try:
            self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8",
                                      stderr=subprocess.DEVNULL if quiet else None)
        except OSError as e:
            raise TamasError(f"could not start the {kind} bridge: {e.strerror}")
        atexit.register(self.close)

    def close(self):
        if self.p.poll() is None:
            try:
                self.p.stdin.close()
                self.p.wait(timeout=2)
            except Exception:
                self.p.kill()

    def ask(self, request):
        try:
            self.p.stdin.write(json.dumps(request) + "\n")
            self.p.stdin.flush()
            while True:
                line = self.p.stdout.readline()
                if not line:
                    raise OSError
                at = line.find(_MARK)
                if at < 0:
                    print(line, end="")  # ordinary output printed by the foreign code
                    continue
                if at:
                    print(line[:at])
                reply = json.loads(line[at + len(_MARK):])
                break
        except (OSError, ValueError):
            _processes.pop(self.kind, None)
            raise TamasError(f"the {self.kind} bridge stopped unexpectedly")
        if not reply["ok"]:
            first = str(reply["error"]).strip().splitlines()[0] if str(reply["error"]).strip() else "unknown error"
            raise TamasError(f"{self.kind}: {first[18:] if first.startswith('RuntimeException: ') else first}")
        return reply

    def result(self, reply):
        if reply["kind"] == "value":
            return reply["value"]
        cls = ForeignFunction if reply["kind"] == "function" else Foreign
        return cls(self, reply["root"], reply["path"])

    def encode(self, v):
        if isinstance(v, Foreign):
            if v._proc is not self:
                raise TamasError(f"a value from another bridge cannot be passed into {self.kind}")
            return {"__tamas_ref__": {"root": v._root, "path": list(v._path)}}
        if isinstance(v, dict):
            return {str(k): self.encode(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)):
            return [self.encode(x) for x in v]
        if isinstance(v, Quantity):
            return v.value
        if callable(v):
            raise TamasError(f"functions cannot be passed across the {self.kind} bridge yet")
        return v


def _process(kind):
    if kind not in _processes or _processes[kind].p.poll() is not None:
        if kind == "javascript":
            exe = shutil.which("node")
            if not exe:
                raise TamasError("the javascript bridge needs Node.js (the 'node' command) to be installed")
            cmd = [exe, os.path.join(_HELPERS, "bridge.js")]
        else:
            exe = shutil.which("java")
            if not exe:
                raise TamasError("the java bridge needs a Java JDK 11 or newer (the 'java' command) to be installed")
            extra = os.environ.get("TAMAS_JAVA_CLASSPATH")
            cmd = [exe] + (["-cp", extra] if extra else []) + [os.path.join(_HELPERS, "TamasBridge.java")]
        _processes[kind] = _Process(kind, cmd, quiet=kind == "java")
    return _processes[kind]


_C_TYPES = {"int": ctypes.c_int, "long": ctypes.c_long, "size": ctypes.c_size_t, "double": ctypes.c_double,
            "float": ctypes.c_float, "truth": ctypes.c_bool, "text": ctypes.c_char_p, "nothing": None}


class CLibrary:
    """A compiled C library (or C++ functions exported with extern "C")."""

    def __init__(self, name, base_dir):
        local = os.path.join(base_dir, name)
        path = local if os.path.exists(local) else name if os.path.exists(name) else ctypes.util.find_library(name)
        if not path:
            raise TamasError(f"cannot find the C library '{name}'")
        try:
            self._lib, self._name = ctypes.CDLL(path), name
        except OSError as e:
            raise TamasError(f"cannot load the C library '{name}': {e}")

    def fn(self, name, returns, takes):
        """Describe a C function so it can be called: lib.fn("cos", "double", ["double"])."""
        if returns not in _C_TYPES or any(t not in _C_TYPES or t == "nothing" for t in takes):
            raise TamasError(f"C types must be one of: {', '.join(_C_TYPES)} ('nothing' only as a result)")
        try:
            f = getattr(self._lib, name)
        except AttributeError:
            raise TamasError(f"the C library '{self._name}' has no function '{name}'")
        f.restype, f.argtypes = _C_TYPES[returns], [_C_TYPES[t] for t in takes]

        def call(*args):
            if len(args) != len(takes):
                raise TamasError(f"C function {name} takes {len(takes)} value(s) but was given {len(args)}")
            sent = []
            for v, t in zip(args, takes):
                v = v.value if isinstance(v, Quantity) else v
                ok = isinstance(v, str) if t == "text" else isinstance(v, bool) if t == "truth" else (
                    type(v) is int if t in ("int", "long", "size") else type(v) in (int, float))
                if not ok:
                    raise TamasError(f"C function {name} expected {t} but was given {v!r}")
                sent.append(v.encode("utf-8") if t == "text" else v)
            result = f(*sent)
            return result.decode("utf-8", "replace") if isinstance(result, bytes) else result
        return call

    def __str__(self):
        return f"<c library {self._name}>"


def bridge(kind, name, base_dir="."):
    """Borrow a library from another language: python, javascript (Node.js), java (JDK) or c / c++."""
    kind = {"js": "javascript", "node": "javascript", "py": "python", "c++": "c", "cpp": "c"}.get(kind, kind)
    if kind == "c":
        return CLibrary(name, base_dir)
    if kind == "python":
        try:
            return importlib.import_module(name)
        except ImportError:
            raise TamasError(f"Python has no library called '{name}' installed")
    if kind in ("javascript", "java"):
        proc = _process(kind)
        try:
            return proc.result(proc.ask({"op": "load", "name": name, "base": os.path.abspath(base_dir)}))
        except TamasError as e:
            raise TamasError(f"could not load '{name}' ({e.msg})")
    raise TamasError(f"there is no '{kind}' bridge yet (available: python, javascript, java, c)")


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
