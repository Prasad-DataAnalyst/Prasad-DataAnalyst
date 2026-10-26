"""Shared helpers of the oracles: reading a package, and typing exported text by manifest type."""

import io
import json
import zipfile


def open_package(path):
    """The package's entries by name, and its parsed manifest."""
    with zipfile.ZipFile(path) as z:
        files = {name: z.read(name) for name in z.namelist()}
    manifest = json.loads(files["manifest.json"].decode("utf-8"))
    return files, manifest


def retype(text, kind):
    """Exported text read back with the column's logical type; empty text is no value."""
    if text is None or text == "":
        return None
    if kind == "string":
        return text
    if kind in ("number", "integer"):
        return float(text)
    if kind == "boolean":
        if text == "true":
            return True
        if text == "false":
            return False
        raise ValueError(f"{text!r} is not a boolean")
    if kind == "date":
        return {"date": text}
    if kind == "datetime":
        return {"datetime": text}
    if kind == "geometry":
        return {"geometry": json.loads(text)}
    raise ValueError(f"unknown type {kind}")


def emit(result):
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


def text_stream(data):
    return io.StringIO(data, newline="")
