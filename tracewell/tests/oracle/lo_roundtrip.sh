#!/bin/sh
# LibreOffice oracle: lo_roundtrip.sh <data.xlsx> <out-dir>
# Converts the workbook's first sheet to CSV with LibreOffice (an independent spreadsheet engine)
# and prints the rows as a JSON array of arrays of strings.
set -eu
xlsx="$1"
out="$2"
profile="$out/lo-profile"
mkdir -p "$out" "$profile"
soffice "-env:UserInstallation=file://$profile" --headless --norestore \
  --convert-to 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false' \
  --outdir "$out" "$xlsx" >/dev/null 2>&1
csv="$out/$(basename "${xlsx%.*}").csv"
python3 -I -c 'import csv, json, sys; print(json.dumps(list(csv.reader(open(sys.argv[1], encoding="utf-8-sig", newline="")))))' "$csv"
