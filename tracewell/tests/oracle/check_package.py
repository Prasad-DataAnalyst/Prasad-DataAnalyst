"""Package oracle: python3 -I check_package.py <package.zip>. Verifies CHECKSUMS.sha256 against every
entry, the manifest's file list, and the manifest fields a recipient relies on."""

import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import emit, open_package  # noqa: E402

REQUIRED = ["format", "formatVersion", "exportId", "createdAt", "appVersion", "owner", "profile", "project",
            "dataset", "sources", "rulePacks", "unitRegistry", "steps", "files", "validation", "auditHead"]


def main(path):
    files, manifest = open_package(path)
    problems = []
    sums = {}
    for line in files.get("CHECKSUMS.sha256", b"").decode("utf-8").splitlines():
        digest, _, name = line.partition("  ")
        sums[name] = digest
    if not sums:
        problems.append("CHECKSUMS.sha256 is missing or empty")
    for name, data in files.items():
        if name == "CHECKSUMS.sha256":
            continue
        actual = hashlib.sha256(data).hexdigest()
        if sums.get(name) != actual:
            problems.append(f"{name}: checksum {sums.get(name)} does not match {actual}")
    for name in sums:
        if name not in files:
            problems.append(f"{name} is listed in CHECKSUMS.sha256 but missing")
    for key in REQUIRED:
        if key not in manifest:
            problems.append(f"manifest.json has no {key}")
    if manifest.get("format") != "tracewell-export":
        problems.append(f"manifest format is {manifest.get('format')!r}")
    for f in manifest.get("files", []):
        data = files.get(f["path"])
        if data is None:
            problems.append(f"manifest lists {f['path']}, which is missing")
        elif hashlib.sha256(data).hexdigest() != f["sha256"] or len(data) != f["size"]:
            problems.append(f"{f['path']} does not match the manifest")
    if not manifest.get("validation", {}).get("ok"):
        problems.append("the manifest records a failed validation")
    emit(
        {
            "ok": not problems,
            "problems": problems,
            "entries": sorted(files),
            "rows": manifest.get("dataset", {}).get("rowCount"),
            "columns": [{"header": c["header"], "sha256": c["sha256"]} for c in manifest.get("dataset", {}).get("columns", [])],
            "owner": manifest.get("owner"),
            "profile": manifest.get("profile"),
        }
    )


if __name__ == "__main__":
    main(sys.argv[1])
