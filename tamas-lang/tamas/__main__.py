"""Command line:  python -m tamas run program.tms"""
import argparse
import json
import sys

from . import __version__
from .bridges import json_to_tms, to_plain
from .errors import TamasError
from .from_cfamily import java_to_tamas, javascript_to_tamas
from .from_python import python_to_tamas
from .interp import run_file
from .lexer import available_langs, translate


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _emit(text, out):
    if out:
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        sys.stdout.write(text)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="tamas", description=f"Tamas {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, help_ in [("run", "run a Tamas program"),
                        ("export", "run a program and print its data as JSON"),
                        ("import", "turn a JSON or GeoJSON file into Tamas"),
                        ("translate", "rewrite a program's keywords in another human language"),
                        ("from-python", "convert a Python file (supported subset) into Tamas"),
                        ("from-js", "convert a JavaScript file (supported subset) into Tamas"),
                        ("from-java", "convert a Java file (supported subset) into Tamas")]:
        p = sub.add_parser(name, help=help_)
        p.add_argument("file")
        if name != "run":
            p.add_argument("-o", "--out", help="write to this file instead of the screen")
        if name == "translate":
            p.add_argument("--to", required=True, help="language code, e.g. hi, ta, te, en")
    sub.add_parser("langs", help="list installed language packs")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "run":
            run_file(args.file)
        elif args.cmd == "export":
            doc = run_file(args.file, out=lambda s: None).document()
            _emit(json.dumps(to_plain(doc), ensure_ascii=False, indent=2) + "\n", args.out)
        elif args.cmd == "import":
            _emit(json_to_tms(_read(args.file)), args.out)
        elif args.cmd == "translate":
            _emit(translate(_read(args.file), args.to), args.out)
        elif args.cmd == "from-python":
            _emit(python_to_tamas(_read(args.file)), args.out)
        elif args.cmd == "from-js":
            _emit(javascript_to_tamas(_read(args.file)), args.out)
        elif args.cmd == "from-java":
            _emit(java_to_tamas(_read(args.file)), args.out)
        else:
            print(" ".join(available_langs()))
    except TamasError as e:
        where = f"{getattr(args, 'file', '')}{', line ' + str(e.line) if e.line else ''}"
        print(f"Tamas error ({where}): {e.msg}", file=sys.stderr)
        return 1
    except (OSError, json.JSONDecodeError) as e:
        print(f"Tamas error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
