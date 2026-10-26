"""CSV oracle: python3 -I check_csv.py <package.zip>. Reads data.csv with Python's csv module and
reports its encoding facts, header and the SAD 9.4 digest of every column."""

import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from canonical import column_digest  # noqa: E402
from common import emit, open_package, retype, text_stream  # noqa: E402


def main(path):
    files, manifest = open_package(path)
    raw = files["data.csv"]
    bom = raw.startswith(b"\xef\xbb\xbf")
    text = raw[3:].decode("utf-8") if bom else raw.decode("utf-8")
    rows = list(csv.reader(text_stream(text)))
    header, body = rows[0], rows[1:]
    columns = manifest["dataset"]["columns"]
    digests = []
    for i, col in enumerate(columns):
        values = [retype(r[i] if i < len(r) else "", col["type"]) for r in body]
        digests.append({"header": header[i] if i < len(header) else None, "sha256": column_digest(values)})
    emit(
        {
            "bom": bom,
            "crlf": "\r\n" in text,
            "rows": len(body),
            "header": header,
            "columns": digests,
            "ragged": sorted({len(r) for r in body} - {len(header)}),
        }
    )


if __name__ == "__main__":
    main(sys.argv[1])
