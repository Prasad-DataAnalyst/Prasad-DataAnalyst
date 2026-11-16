import contextlib
import glob
import io
import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from tamas import TamasError, run_source  # noqa: E402
from tamas.bridges import json_to_tms, to_plain  # noqa: E402
from tamas.from_python import python_to_tamas  # noqa: E402
from tamas.lexer import available_langs, translate  # noqa: E402

EX = os.path.join(ROOT, "examples")


def out(src, base=EX):
    lines = []
    run_source(src, base, lines.append)
    return "\n".join(lines)


def read(name):
    with open(os.path.join(EX, name), encoding="utf-8") as f:
        return f.read()


class Core(unittest.TestCase):
    def test_basics(self):
        self.assertEqual(out('x: 2\nshow x + 3 * 4, 2 ^ 3 ^ 2, -2 ^ 2, 7 / 2, 6 / 2, 7 % 3'), "14 512 -4 3.5 3 1")
        self.assertEqual(out('show "a{1 + 1}b", "\\{x}", [1, "t", yes, nothing], {a: 1}'),
                         'a2b {x} [1, "t", yes, nothing] {a: 1}')

    def test_functions_and_scope(self):
        src = 'n: 1\nf(x) -> {\n n: x * 2\n give n\n}\nshow f(5), n\nadd: (a, b) -> a + b\nshow add(1, 2)'
        self.assertEqual(out(src), "10 1\n3")
        self.assertEqual(out('fact(n) -> {\n when n < 2 { give 1 }\n give n * fact(n - 1)\n}\nshow fact(20)'),
                         "2432902008176640000")
        self.assertEqual(out('c: {n: 0}\nbump() -> {\n c.n: c.n + 1\n}\nbump()\nbump()\nshow c.n'), "2")

    def test_flow(self):
        src = 'i: 0\nloop yes {\n i: i + 1\n when i = 2 { skip }\n when i > 4 { stop }\n show i\n}'
        self.assertEqual(out(src), "1\n3\n4")
        self.assertEqual(out('each k, v in {a: 1, b: 2} { show k, v }\neach i, v in ["x"] { show i, v }'), "a 1\nb 2\n0 x")
        self.assertEqual(out('x: 5\nwhen x < 3 { show "s" } else when x < 9 { show "m" } else { show "l" }'), "m")

    def test_pipes(self):
        self.assertEqual(out('range(1, 6)\n  |> map(n -> n * n)\n  |> filter(n -> n % 2 = 1)\n  |> sum\n  |> show'), "35")

    def test_units(self):
        self.assertEqual(out('show 100 km / 2 h as km/h, 1 km + 500 m, 2 * 3 kg, 10 m * 10 m as ha'),
                         "50 km/h 1.5 km 6 kg 0.01 ha")
        self.assertEqual(out('show 90 km/h > 20 m/s, 1 kWh as J, 6 m / 2 m, 1 GB as MB'), "yes 3600000 J 3 1000 MB")
        self.assertEqual(out('unit credit: 1\nunit pack: 12 credit\nshow 3 pack as credit, sum([1 INR, 2 INR])'), "36 credit 3 INR")
        for bad in ['show 1 km + 1 kg', 'show 1 km + 1', 'show 1 USD + 1 INR', 'show 1 kg as m', 'show 5 as parsec']:
            with self.assertRaises(TamasError, msg=bad):
                out(bad)

    def test_errors_are_clear(self):
        cases = {'show x': "has not been given a value", 'when 1 { show 1 }': "must be yes or no",
                 'show 1 / 0': "divide by zero", 'show "a" + 1': "cannot use '+'", 'x: {a: 1}\nshow x.b': "no field 'b'",
                 'show (1': "expected", 'show 1 = "1"\nshow [1][3]': "no item", 'stop': "only make sense"}
        for src, text in cases.items():
            with self.assertRaises(TamasError) as cm:
                out(src)
            self.assertIn(text, str(cm.exception), src)
        with self.assertRaises(TamasError) as cm:
            out('a: 1\nb: 2\nshow c')
        self.assertEqual(cm.exception.line, 3)
        self.assertEqual(out('show 1 = 1.0, 1 = "1", yes = 1, 2 km = 2000 m'), "yes no no yes")


class Bridges(unittest.TestCase):
    TRICKY = {"type": "X", "in": 1, "show": [1, 2.5, -3, 1e-7, 1e21, True, False, None], "my key": {"a b": {}, "e": []},
              "text": "quote \" brace {x} slash \\ newline \n tab \t unicode தமிழ் \u0001", "len": "shadow",
              "nested": [[1, [2, {"deep": [{"k": "v"}]}]], {"unit": "m", "no": 5}], "h": 3, "m": 4, "big": 12345678901234567890}

    def roundtrip(self, data):
        interp = run_source(json_to_tms(json.dumps(data)))
        self.assertEqual(json.dumps(to_plain(interp.document())), json.dumps(data))

    def test_json_roundtrip_is_lossless(self):
        self.roundtrip(self.TRICKY)
        for data in [{}, [], [1, {"a": [2]}], "text", 5, None, {"a": {}}]:
            self.roundtrip(data)
        self.roundtrip(json.loads(read("cities.geojson")))

    def test_geojson(self):
        self.assertEqual(out('c: read("cities.geojson").features\nshow round(geo.distance(c[0], c[1])), len(c)'), "515 km 4")
        self.assertEqual(out('show geo.point(1, 2), round(geo.distance([0, 0], [0, 1]))'),
                         '{type: "Point", coordinates: [1, 2]} 111 km')

    def test_python_bridge(self):
        self.assertEqual(out('m: bridge("python", "math")\nshow m.gcd(12, 18), m.floor(2.7)'), "6 2")
        with self.assertRaises(TamasError):
            out('bridge("java", "util")')

    def test_python_converter_matches_python(self):
        expected = subprocess.run([sys.executable, os.path.join(EX, "sample.py")], capture_output=True, text=True).stdout
        got = out(python_to_tamas(read("sample.py")))
        norm = expected.replace("['asha']", '["asha"]').replace("True", "yes").strip()
        self.assertEqual(got, norm)
        for unsupported in ["import os", "class A: pass", "x = [i for i in y]", "with f() as g: pass", "x = a[1:2]"]:
            with self.assertRaises(TamasError, msg=unsupported):
                python_to_tamas(unsupported)


class Languages(unittest.TestCase):
    def test_every_example_means_the_same_in_every_language(self):
        self.assertEqual(available_langs(), ["en", "hi", "ta", "te"])
        for path in sorted(glob.glob(os.path.join(EX, "*.tms"))):
            src = read(os.path.basename(path))
            expected = out(src)
            for lang in ("hi", "ta", "te"):
                local = translate(src, lang)
                self.assertNotEqual(local, src)
                self.assertEqual(out(local), expected, f"{path} in {lang}")
                self.assertEqual(translate(local, "en"), src, f"{path} back from {lang}")
                self.assertEqual(translate(translate(local, "ta"), "en"), src)

    def test_keywords_inside_text_placeholders(self):
        src = 'a: yes\nshow "{a and not no}"'
        for lang in ("hi", "ta", "te"):
            self.assertEqual(out(translate(src, lang)), "yes")

    def test_native_script_names(self):
        self.assertEqual(out('@lang ta\nபெயர்: "தமஸ்"\nஎன்றால் ஆம் { காட்டு "வணக்கம், {பெயர்}" }'), "வணக்கம், தமஸ்")


class Examples(unittest.TestCase):
    def test_examples_run(self):
        for path in sorted(glob.glob(os.path.join(EX, "*.tms"))):
            self.assertTrue(out(read(os.path.basename(path))), path)

    def test_cli(self):
        def cli(*args):
            return subprocess.run([sys.executable, "-m", "tamas", *args], cwd=ROOT, capture_output=True, text=True)
        self.assertIn("Hello, world!", cli("run", "examples/hello.tms").stdout)
        self.assertEqual(json.loads(cli("export", "examples/flight.tms").stdout)["flight"]["cruise"], {"value": 460, "unit": "kn"})
        self.assertIn('type: "FeatureCollection"', cli("import", "examples/cities.geojson").stdout)
        bad = cli("run", "tests/test_tamas.py")
        self.assertEqual(bad.returncode, 1)
        self.assertIn("Tamas error", bad.stderr)


if __name__ == "__main__":
    unittest.main()
