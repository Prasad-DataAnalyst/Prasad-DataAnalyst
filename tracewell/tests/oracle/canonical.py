"""Canonical encodings and digests of SAD section 9.4, written independently of the TypeScript
engine so the end-to-end tests can check exported files against the manifest without trusting
any of the engine's code.

Values use these Python forms: None, str, float (int is accepted), bool, {"date": "YYYY-MM-DD"},
{"datetime": "YYYY-MM-DDTHH:MM:SS.sssZ"} and {"geometry": <GeoJSON geometry dict>}.
"""

import hashlib
import json
import math

NULL_CELL = "\u0000N"


def canonical_number(x):
    """ECMAScript Number.prototype.toString for a finite double, with -0 written as 0."""
    if isinstance(x, bool):
        raise ValueError("a boolean is not a number")
    x = float(x)
    if math.isnan(x) or math.isinf(x):
        raise ValueError(f"{x} has no canonical form")
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    text = repr(abs(x))  # the shortest digits that round-trip, as ECMAScript requires
    mantissa, _, exp = text.partition("e")
    whole, _, frac = mantissa.partition(".")
    digits = whole + frac
    point = len(whole) + (int(exp) if exp else 0)  # value = 0.<digits> * 10**point
    stripped = digits.lstrip("0")
    point -= len(digits) - len(stripped)
    digits = stripped.rstrip("0")
    k, n = len(digits), point
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        exponent = ("+" if e >= 0 else "-") + str(abs(e))
        out = (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + exponent
    return sign + out


def _string(s):
    """A JSON string literal exactly as JavaScript's JSON.stringify writes it."""
    out = ['"']
    for ch in s:
        c = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif c < 0x20 or 0xD800 <= c <= 0xDFFF:
            out.append("\\u%04x" % c)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_key(s):
    return s.encode("utf-16-be", "surrogatepass")


def canonical_json(v):
    """Keys sorted by UTF-16 code unit, no whitespace, canonical numbers."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return canonical_number(v)
    if isinstance(v, str):
        return _string(v)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonical_json(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=_utf16_key)
        return "{" + ",".join(_string(k) + ":" + canonical_json(v[k]) for k in keys) + "}"
    raise ValueError(f"cannot encode {type(v).__name__}")


def canonical_cell(v):
    if v is None:
        return NULL_CELL
    if isinstance(v, bool):
        return "b:1" if v else "b:0"
    if isinstance(v, (int, float)):
        return "n:" + canonical_number(v)
    if isinstance(v, str):
        return "s:" + v
    if isinstance(v, dict) and len(v) == 1:
        if "date" in v:
            return "d:" + v["date"]
        if "datetime" in v:
            return "t:" + v["datetime"]
        if "geometry" in v:
            return "g:" + canonical_json(v["geometry"])
    raise ValueError(f"not a cell value: {v!r}")


def utf8(s):
    # A lone surrogate becomes U+FFFD, as TextEncoder does.
    return s.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")


def column_digest(values):
    h = hashlib.sha256()
    for v in values:
        cell = utf8(canonical_cell(v))
        h.update(str(len(cell)).encode("ascii") + b":" + cell)
    return h.hexdigest()


def self_test(vectors_path):
    """Checks this module against the shared golden vectors; returns the failures."""
    with open(vectors_path, encoding="utf-8") as f:
        spec = json.load(f)
    failures = []
    encoders = {"number": canonical_number, "json": canonical_json, "cell": canonical_cell}
    for vec in spec["vectors"]:
        value = json.loads(vec["input"], parse_int=float)
        try:
            got = encoders[vec["kind"]](value)
        except Exception as e:  # noqa: BLE001 - every failure is reported
            got = f"<error {e}>"
        if got != vec["expected"]:
            failures.append({"name": vec["name"], "expected": vec["expected"], "got": got})
    for vec in spec["rejected"]:
        try:
            canonical_number(float(vec["literal"].replace("Infinity", "inf")))
            failures.append({"name": vec["name"], "expected": "rejected", "got": "accepted"})
        except ValueError:
            pass
    return failures


if __name__ == "__main__":
    import sys

    result = self_test(sys.argv[1])
    print(json.dumps({"ok": not result, "failures": result}))
