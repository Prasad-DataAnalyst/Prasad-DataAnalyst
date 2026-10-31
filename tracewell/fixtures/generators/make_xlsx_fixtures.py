#!/usr/bin/env python3
"""Writes the XLSX and XLS fixtures of the messy-file library into fixtures/messy.

Every workbook is first written with openpyxl. Four of them are then opened and saved again by
LibreOffice (soffice --headless --convert-to xlsx): LibreOffice stores a cached value for every
formula and writes strings as shared strings, which openpyxl does not, and its XML differs from
openpyxl's in many small ways, so the XLSX reader is tested against two independent producers.
fixtures/README.md lists the producer of each file and what each file breaks.

Two things are changed after saving, and nothing else: every ZIP entry gets the same fixed time, and
a sheet that LibreOffice 24.2 saved as hidden although it was very hidden gets that state back.

Two finished workbooks are then saved by LibreOffice as Excel 97-2003 workbooks (.xls, BIFF8 in an
OLE compound file), so the legacy reader is tested against files a real spreadsheet program wrote.

Usage: python3 fixtures/generators/make_xlsx_fixtures.py [--out DIR]

Requires openpyxl 3.1.5 and LibreOffice 24.2 (soffice on the PATH); with those versions the output is
byte-for-byte reproducible. After running this script, run gen-text-fixtures.mjs to refresh
SHA256SUMS, then check every expectation again.
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from openpyxl import Workbook
from openpyxl.utils.datetime import CALENDAR_MAC_1904
from openpyxl.writer.excel import ExcelWriter

DEFAULT_OUT = Path(__file__).resolve().parent.parent / "messy"

# Fixed document properties and ZIP entry times, so openpyxl output does not depend on the clock.
FIXED_TIME = dt.datetime(2026, 1, 1, 0, 0, 0)
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
AUTHOR = "Prasad (Prasad-DataAnalyst)"

DATE = "yyyy-mm-dd"
DATETIME = "yyyy-mm-dd hh:mm"


def new_workbook() -> Workbook:
    wb = Workbook()
    wb.properties.creator = AUTHOR
    wb.properties.lastModifiedBy = AUTHOR
    wb.properties.created = FIXED_TIME
    wb.properties.modified = FIXED_TIME
    return wb


def day(start: dt.date, offset: int) -> dt.date:
    return start + dt.timedelta(days=offset)


def write_row(ws, row: int, values, formats=None) -> None:
    """Writes `values` from column A; `formats` maps a 0-based column to a number format."""
    for col, value in enumerate(values, start=1):
        if value is None:
            continue
        cell = ws.cell(row=row, column=col, value=value)
        fmt = (formats or {}).get(col - 1)
        if fmt is not None:
            cell.number_format = fmt


# ---------------------------------------------------------------------------------------------
# Workbooks


def merged_two_row_header_units() -> Workbook:
    """A title row, a two-row header with merged cells, a units row, then 12 data rows."""
    wb = new_workbook()
    ws = wb.active
    ws.title = "Report"
    ws["A1"] = "Separator test SEP-1 - March 2026"
    ws.merge_cells("A1:H1")
    for ref, text in {"A2": "Well ID", "B2": "Date", "C2": "Pressure", "E2": "Temperature",
                      "G2": "Oil rate", "H2": "Gas rate"}.items():
        ws[ref] = text
    for cells in ("A2:A3", "B2:B3", "C2:D2", "E2:F2", "G2:G3", "H2:H3"):
        ws.merge_cells(cells)
    write_row(ws, 3, [None, None, "Max", "Min", "Max", "Min"])
    write_row(ws, 4, [None, None, "psia", "psia", "degF", "degF", "bbl/d", "Mscf/d"])
    wells = {
        "NS-A01": {
            "p_max": [1854.2, 1851.6, 1849.3, 1846.1, 1843.8, 1840.9],
            "p_min": [1838.7, 1836.0, 1833.9, 1830.8, 1828.5, 1825.7],
            "t_max": [184.6, 184.5, 184.3, 184.2, 184.0, 183.9],
            "t_min": [181.9, 181.8, 181.6, 181.5, 181.3, 181.2],
            "oil": [2412.5, 2408.1, 2403.9, 2399.2, 2395.0, 2390.6],
            "gas": [2846.8, 2841.6, 2836.6, 2831.1, 2826.1, 2820.9],
        },
        "NS-A02": {
            "p_max": [2101.5, 2099.0, 2096.2, 2093.9, 2091.1, 2088.6],
            "p_min": [2088.3, 2085.9, 2083.0, 2080.7, 2078.2, 2075.4],
            "t_max": [188.2, 188.0, 187.9, 187.7, 187.6, 187.4],
            "t_min": [185.4, 185.3, 185.1, 185.0, 184.8, 184.7],
            "oil": [3051.8, 3046.0, 3040.7, 3035.1, 3029.6, 3024.2],
            "gas": [4028.4, 4020.7, 4013.7, 4006.3, 3999.1, 3991.9],
        },
    }
    row = 5
    for d in range(6):
        for well, s in wells.items():
            values = [well, day(dt.date(2026, 3, 2), d)]
            values += [s[key][d] for key in ("p_max", "p_min", "t_max", "t_min", "oil", "gas")]
            write_row(ws, row, values, {1: DATE})
            row += 1
    return wb


def text_and_serial_dates() -> Workbook:
    """Real date cells, two dates typed as text, datetimes, serials without a date format, d/m/y text."""
    wb = new_workbook()
    ws = wb.active
    ws.title = "Readings"
    write_row(ws, 1, ["Meter ID", "Read date", "Read time", "Install date", "Calibrated", "Volume (m3)"])
    meters = {
        "M-01": {"times": [(7, 30), (7, 25), (7, 40), (7, 35)], "install": 45292, "calibrated": "15/01/2026",
                 "volume": [1520.4, 1544.9, 1569.1, 1593.8]},
        "M-02": {"times": [(7, 45), (7, 50), (7, 55), (7, 45)], "install": 45444, "calibrated": "03/02/2026",
                 "volume": [980.2, 998.7, 1017.5, 1035.9]},
    }
    # These two readings were typed in as text by hand.
    typed = {("M-02", 1), ("M-01", 3)}
    row = 2
    for d in range(4):
        date = day(dt.date(2026, 3, 2), d)
        for meter, m in meters.items():
            hour, minute = m["times"][d]
            read_date = date.isoformat() if (meter, d) in typed else date
            values = [meter, read_date, dt.datetime.combine(date, dt.time(hour, minute)), m["install"],
                      m["calibrated"], m["volume"][d]]
            write_row(ws, row, values, {1: DATE, 2: DATETIME})
            row += 1
    return wb


def two_tables_one_sheet() -> Workbook:
    """A production table at A1:E8 and, after two blank rows, a downtime table at A11:C15."""
    wb = new_workbook()
    ws = wb.active
    ws.title = "Summary"
    production = [
        ["Well ID", "Field", "Oil (bbl)", "Gas (Mscf)", "Water (bbl)"],
        ["NS-A01", "Alpha", 72450.5, 85492.6, 9876.3],
        ["NS-A02", "Alpha", 93810.2, 123829.5, 7120.8],
        ["NS-B03", "Alpha", 59012.7, 61963.3, 15880.1],
        ["NS-C04", "Bravo", 36280.4, 43536.5, 2210.4],
        ["NS-C05", "Bravo", 41105.9, 49327.1, 3305.6],
        ["NS-D06", "Charlie", 28877.3, 31765.2, 4410.9],
        ["NS-D07", "Charlie", 30542.6, 33596.9, 6120.7],
    ]
    downtime = [
        ["Event", "Duration (h)", "Cause"],
        ["Compressor trip", 6.5, "High vibration"],
        ["ESD test", 2.0, "Planned"],
        ["Power dip", 1.25, "Grid"],
        ["Pig run", 4.0, "Planned"],
    ]
    for i, values in enumerate(production):
        write_row(ws, 1 + i, values)
    for i, values in enumerate(downtime):
        write_row(ws, 11 + i, values)
    return wb


def date1904() -> Workbook:
    """The 1904 date system (old Mac Excel): Daily!B2 is 2026-01-31, stored as serial 44591."""
    wb = new_workbook()
    wb.epoch = CALENDAR_MAC_1904
    ws = wb.active
    ws.title = "Daily"
    write_row(ws, 1, ["Well ID", "Date", "Oil (bbl/d)", "Water (bbl/d)"])
    oil = [1650.4, 1647.9, 1645.1, 1642.8, 1640.0, 1637.6, 1634.9, 1632.3, 1629.8, 1627.1]
    water = [410.2, 411.5, 412.9, 414.0, 415.4, 416.9, 418.1, 419.6, 420.8, 422.3]
    for d in range(10):
        write_row(ws, 2 + d, ["NS-D05", day(dt.date(2026, 1, 31), d), oil[d], water[d]], {1: DATE})
    return wb


def hidden_sheets_formulas() -> Workbook:
    """A hidden first sheet, the data sheet, a very hidden sheet; formulas, one giving #DIV/0!."""
    wb = new_workbook()
    config = wb.active
    config.title = "Config"
    write_row(config, 1, ["Setting", "Value"])
    write_row(config, 2, ["Percent factor", 100])
    config.sheet_state = "hidden"
    ws = wb.create_sheet("Production")
    write_row(ws, 1, ["Well ID", "Date", "Oil (bbl/d)", "Water (bbl/d)", "Liquid (bbl/d)", "Water cut (%)"])
    wells = {
        "NS-E01": ([1205.3, 1201.8, 1198.6, 1195.1, 1191.9], [312.4, 314.0, 315.7, 317.2, 318.9]),
        # No test on 4 March: both readings are blank, so the water cut divides by zero.
        "NS-E02": ([846.2, 843.0, None, 838.1, 835.4], [205.6, 206.9, None, 209.8, 211.2]),
    }
    row = 2
    for d in range(5):
        for well, (oil, water) in wells.items():
            liquid = f'=IF(COUNT(C{row}:D{row})=2,C{row}+D{row},"")'
            water_cut = f"=D{row}/(C{row}+D{row})*Config!$B$2"
            write_row(ws, row, [well, day(dt.date(2026, 3, 2), d), oil[d], water[d], liquid, water_cut], {1: DATE})
            row += 1
    notes = wb.create_sheet("Notes")
    write_row(notes, 1, ["Internal notes"])
    write_row(notes, 2, ["Water cut uses the percent factor on the Config sheet."])
    notes.sheet_state = "veryHidden"
    wb.active = 1
    return wb


def numbers_as_text() -> Workbook:
    """Identifiers with leading zeros and numbers stored as text (shared strings, t="s")."""
    wb = new_workbook()
    ws = wb.active
    ws.title = "Wells"
    write_row(ws, 1, ["Well ID", "Test date", "Oil (bbl/d)", "Water (bbl/d)", "Gas (Mscf/d)"])
    rows = [
        ["0042", dt.date(2026, 2, 2), "1234.5", 210.4, 1480.2],
        ["0043", dt.date(2026, 2, 3), "987.25", "305.1", 1102.7],
        ["0044", dt.date(2026, 2, 4), "1510.0", 95.6, 1795.3],
        ["0045", dt.date(2026, 2, 5), "1322.75", "188.0", 1560.9],
        ["0046", dt.date(2026, 2, 6), "876.4", 402.3, 990.5],
        ["0047", dt.date(2026, 2, 9), "1105.6", "256.7", 1290.1],
        ["0048", dt.date(2026, 2, 10), "1450.2", 133.9, 1702.4],
        ["0049", dt.date(2026, 2, 11), "1018.9", "277.5", 1188.6],
    ]
    for i, values in enumerate(rows):
        write_row(ws, 2 + i, values, {1: DATE})
    return wb


# Builder and whether LibreOffice saves the file again.
WORKBOOKS = {
    "xlsx_merged_two_row_header_units.xlsx": (merged_two_row_header_units, True),
    "xlsx_text_and_serial_dates.xlsx": (text_and_serial_dates, True),
    "xlsx_two_tables_one_sheet.xlsx": (two_tables_one_sheet, False),
    "xlsx_date1904.xlsx": (date1904, False),
    "xlsx_hidden_sheets_formulas.xlsx": (hidden_sheets_formulas, True),
    "xlsx_numbers_as_text.xlsx": (numbers_as_text, True),
}

# Legacy .xls copies and the finished XLSX workbook each is saved from.
LEGACY = {
    "xls_merged_two_row_header_units.xls": "xlsx_merged_two_row_header_units.xlsx",
    "xls_date1904.xls": "xlsx_date1904.xlsx",
}

# LibreOffice 24.2 saves a very hidden sheet as merely hidden; these sheets get their state back.
VERY_HIDDEN = {"xlsx_hidden_sheets_formulas.xlsx": ["Notes"]}


# ---------------------------------------------------------------------------------------------
# Writing


def save_without_clock(wb: Workbook, path: Path) -> None:
    """Saves through ExcelWriter directly: openpyxl's save_workbook stamps the current time."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        ExcelWriter(wb, archive).save()


def rewrite_zip(source: Path, target: Path, very_hidden: list[str]) -> None:
    """Copies the entries in order with a fixed time; restores very hidden sheet states."""
    with zipfile.ZipFile(source) as archive:
        entries = [(info.filename, archive.read(info)) for info in archive.infolist()]
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as out:
        for name, data in entries:
            if name == "xl/workbook.xml" and very_hidden:
                data = restore_very_hidden(data, very_hidden)
            info = zipfile.ZipInfo(name, date_time=ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            out.writestr(info, data)


def restore_very_hidden(workbook_xml: bytes, names: list[str]) -> bytes:
    text = workbook_xml.decode("utf-8")
    for name in names:
        pattern = re.compile(r'(<sheet name="%s"[^>]*? state=")hidden(")' % re.escape(name))
        text, count = pattern.subn(r"\1veryHidden\2", text)
        if count != 1:
            raise SystemExit(f'make_xlsx_fixtures: no hidden sheet "{name}" to mark very hidden.')
    return text.encode("utf-8")


def libreoffice_resave(source: Path, out_dir: Path, work: Path) -> Path:
    """Opens `source` in headless LibreOffice and saves it as XLSX into `out_dir`."""
    soffice = shutil.which("soffice")
    if soffice is None:
        raise SystemExit("make_xlsx_fixtures: soffice (LibreOffice) is not on the PATH.")
    profile = (work / "lo-profile").as_uri()
    command = [soffice, f"-env:UserInstallation={profile}", "--headless", "--convert-to", "xlsx",
               "--outdir", str(out_dir), str(source)]
    subprocess.run(command, check=True, capture_output=True, timeout=180)
    result = out_dir / source.name
    if not result.exists():
        raise SystemExit(f"make_xlsx_fixtures: LibreOffice did not write {result.name}.")
    return result


def libreoffice_xls(source: Path, target: Path, work: Path) -> None:
    """Opens `source` in headless LibreOffice and saves it as an Excel 97-2003 workbook at `target`."""
    soffice = shutil.which("soffice")
    if soffice is None:
        raise SystemExit("make_xlsx_fixtures: soffice (LibreOffice) is not on the PATH.")
    out_dir = work / "xls"
    out_dir.mkdir(exist_ok=True)
    profile = (work / "lo-profile").as_uri()
    command = [soffice, f"-env:UserInstallation={profile}", "--headless", "--convert-to", "xls:MS Excel 97",
               "--outdir", str(out_dir), str(source)]
    subprocess.run(command, check=True, capture_output=True, timeout=180)
    result = out_dir / (source.stem + ".xls")
    if not result.exists():
        raise SystemExit(f"make_xlsx_fixtures: LibreOffice did not write {result.name}.")
    shutil.move(result, target)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    out = parser.parse_args().out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tw-xlsx-") as tmp:
        work = Path(tmp)
        (work / "openpyxl").mkdir()
        (work / "libreoffice").mkdir()
        for name, (build, resave) in WORKBOOKS.items():
            first = work / "openpyxl" / name
            save_without_clock(build(), first)
            saved = libreoffice_resave(first, work / "libreoffice", work) if resave else first
            rewrite_zip(saved, out / name, VERY_HIDDEN.get(name, []))
            print(f"make_xlsx_fixtures: {name} ({'openpyxl, then LibreOffice' if resave else 'openpyxl'})")
        for name, source in LEGACY.items():
            libreoffice_xls(out / source, out / name, work)
            print(f"make_xlsx_fixtures: {name} (LibreOffice, from {source})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
