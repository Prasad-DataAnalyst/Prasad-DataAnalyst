import contextlib
import glob
import io
import json
import os
import re
import shutil
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from tamas import TamasError, run_source  # noqa: E402
from tamas.bridges import json_to_tms, to_plain  # noqa: E402
from tamas.from_cfamily import java_to_tamas, javascript_to_tamas  # noqa: E402
from tamas.from_python import python_to_tamas  # noqa: E402
from tamas.lexer import available_langs, translate  # noqa: E402

EX = os.path.join(ROOT, "examples")
FIX = os.path.join(ROOT, "tests", "fixtures")
NODE, JAVA = shutil.which("node"), shutil.which("java")
NEEDS = {"bridge_js.tms": NODE, "bridge_java.tms": JAVA}


def runnable_examples():
    return [p for p in sorted(glob.glob(os.path.join(EX, "*.tms"))) if NEEDS.get(os.path.basename(p), True)]


def as_tamas_prints(text):
    """What Node or Java printed, in Tamas's display conventions (yes/no, list spacing, double quotes)."""
    text = re.sub(r"\btrue\b", "yes", re.sub(r"\bfalse\b", "no", text))
    return text.replace("[ ", "[").replace(" ]", "]").replace("'", '"').strip()


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
            out('bridge("cobol", "util")')

    def test_python_converter_matches_python(self):
        expected = subprocess.run([sys.executable, os.path.join(EX, "sample.py")], capture_output=True, text=True).stdout
        got = out(python_to_tamas(read("sample.py")))
        norm = expected.replace("['asha']", '["asha"]').replace("True", "yes").strip()
        self.assertEqual(got, norm)
        for unsupported in ["import os", "class A: pass", "x = [i for i in y]", "with f() as g: pass", "x = a[1:2]"]:
            with self.assertRaises(TamasError, msg=unsupported):
                python_to_tamas(unsupported)


JS_EXPECTED = """RICE: in stock
WHEAT: out of stock
SUGAR: in stock
stocked: rice, sugar | count 2
total value 8280, gcd 15, -7 % 3 = -1
35 yes"""

JAVA_EXPECTED = """primes below 30: [2, 3, 5, 7, 11, 13, 17, 19, 23, 29]
total 288, whole average 72, remainder 0
grades ABCB no -3 -1
8 cells: 12"""

JS_REFUSED = [
    "class A {}", "import x from 'y'", "const x = require('fs')", "try { f() } catch (e) {}", "let {a, b} = o",
    "function f(a = 1) {}", "let x = [...ys]", "x = 5", "let c = 0; function f() { c = c + 1 }",
    "let x = 1; { let x = 2 }", "let n = 1; function f() { console.log(n); let n = 2 }",
    "let n = 1; function f() { if (true) { let n = 2 } return n }", "if (1) {}", "let s = 'a'; if (s) {}",
    "let a = 1 == 1", "let u = undefined", "let a = 1 || 2", "for (const k in {a: 1}) {}",
    "for (let i = 0; i < 9; i += 2) { if (i === 4) continue }",
    "let fs = []; for (let i = 0; i < 3; i++) { fs.push(() => i) }", "let a = [1, 2].pop()", "let a = [3, 1].sort()",
    "let a = [1, 2].filter(x => 1)", "let a = Math.round(2.5)", "let a = parseInt('5')", "let a = new Date()",
    "let a = 1; let b = [a ? 1 : 2]", "let i = 0; let a = i++", "let a = 1 & 2", "let o = {f() {}}", "async function f() {}",
    "switch (1) {}", "do { } while (false)", "throw new Error('x')", "let a = null ?? 1", "let a = o?.b", "let a = 5n",
]


def _main(body):
    return "public class A { public static void main(String[] a) { %s } }" % body


JAVA_REFUSED = [
    "class A { int x; }", "class A { void f() {} }", "class A { A() {} }", "class A {} class B {}", "interface A {}",
    "class A extends B {}", "import java.io.File; class A {}",
    "class A { static int f(int a) { return a; } static int f(double a) { return 1; } }",
    "class A { static int c = 0; static void f() { c = c + 1; } }", "class A { static void f(int... xs) {} }",
    _main("char c = 'a';"), _main("Map<String, Integer> m = new HashMap<>();"),
    _main('String s = "a"; boolean b = s == "a";'), _main("int x = 5; switch (x) { }"), _main("try { } finally { }"),
    _main("for (int i = 0; i < 9; i += 2) { if (i == 4) continue; }"), _main("Runnable r = () -> {};"),
    _main("System.out.print(1);"), _main('int x = Integer.parseInt("5");'), _main("int z = 1 << 2;"),
    _main("int x = 1; int z = (x > 0 ? 1 : 2) + 1;"), _main("int i = 0; int j = i++;"), _main("foo();"),
    _main("double d = 2.5; int n = d;"), _main("StringBuilder sb = new StringBuilder();"),
    _main("List<Integer> xs = new ArrayList<>(); xs.remove(0);"), _main("int x = this.y;"),
]


class Converters(unittest.TestCase):
    def check(self, path, convert, runtime, expected=None):
        with open(path, encoding="utf-8") as f:
            got = out(convert(f.read()))
        if expected is not None:
            self.assertEqual(got, expected)
        if runtime:  # compare with what the real language prints
            real = subprocess.run([runtime, path], capture_output=True, text=True).stdout
            self.assertEqual(got, as_tamas_prints(real), path)
        return got

    def test_javascript_matches_node(self):
        self.check(os.path.join(EX, "sample.js"), javascript_to_tamas, NODE, JS_EXPECTED)
        got = self.check(os.path.join(FIX, "tricky.js"), javascript_to_tamas, NODE)
        self.assertEqual(got.splitlines()[0], "3628800 610")
        self.assertEqual(got.splitlines()[3], "steps 111 3.5 1024 -4 3 -1 2 1.5")

    def test_java_matches_java(self):
        self.check(os.path.join(EX, "Sample.java"), java_to_tamas, JAVA, JAVA_EXPECTED)
        got = self.check(os.path.join(FIX, "Tricky.java"), java_to_tamas, JAVA)
        self.assertEqual(got.splitlines()[0], "102334155 1594323 yes")
        self.assertEqual(got.splitlines()[2], "3 2 yes yes 9 -9")

    def test_shapes_of_converted_code(self):
        self.assertEqual(javascript_to_tamas("for (let i = 0; i < 3; i++) { console.log(i) }"),
                         "each i in range(3) {\n  show i\n}\n")
        self.assertEqual(javascript_to_tamas("let xs = [1]; for (let i = 0; i < xs.length; i++) { xs.push(i); if (i > 3) break }"),
                         "xs: [1]\ni: 0\nloop i < len(xs) {\n  push(xs, i)\n  when i > 3 {\n    stop\n  }\n  i: i + 1\n}\n")
        self.assertEqual(javascript_to_tamas("const max = (a, b) => a > b ? a : b").count("max_"), 1)
        self.assertEqual(out(javascript_to_tamas("const when = {n: 0}; const bump = () => { when.n += 2 }; bump(); bump(); console.log(when.n)")), "4")
        self.assertIn("div(a, b)", java_to_tamas("class A { static int f(int a, int b) { return a / b; } }"))
        self.assertIn("a / b", java_to_tamas("class A { static double f(double a, int b) { return a / b; } }"))
        self.assertEqual(out("show div(-7, 2), rem(-7, 3), rem(7, -3), div(10 ^ 30, 7), rem(5.5, 2)"),
                         "-3 -1 1 142857142857142857142857142857 1.5")

    def test_unsupported_code_is_refused_not_guessed(self):
        for convert, cases in ((javascript_to_tamas, JS_REFUSED), (java_to_tamas, JAVA_REFUSED)):
            for src in cases:
                with self.assertRaises(TamasError, msg=src):
                    convert(src)


class ForeignBridges(unittest.TestCase):
    @unittest.skipUnless(NODE, "Node.js is not installed")
    def test_javascript_bridge(self):
        self.assertEqual(out(read("bridge_js.tms")), "area: 12.566\nbox with 3 sides: 2 x 3 x 4\nawaited for you: 42\n"
                         "counter: 42\nq3.csv .csv\n5 9")
        self.assertEqual(out('j: bridge("js", "JSON")\nshow j.parse(j.stringify({a: [1, yes, nothing, "தமிழ்"]}))'),
                         '{a: [1, yes, nothing, "தமிழ்"]}')
        for bad in ['bridge("javascript", "no-such-module-x")', 'm: bridge("javascript", "Math")\nshow m.nope',
                    'm: bridge("javascript", "Math")\nshow m.max(x -> x)', 'm: bridge("javascript", "JSON")\nm.parse("oops")']:
            with self.assertRaises(TamasError, msg=bad):
                out(bad)
        self.assertEqual(out('show bridge("javascript", "Math").abs(-2)'), "2")  # still alive after errors

    @unittest.skipUnless(JAVA, "Java is not installed")
    def test_java_bridge(self):
        self.assertEqual(out(read("bridge_java.tms")), "2 5 3.1416\n2^100 = 1267650600228229401496703205376 has 101 bits\n"
                         "chip-fab-line 00042|3.14\nsamat!\n9 [\"ab\", \"ab\", \"ab\"]")
        src = ('a: bridge("java", "java.util.ArrayList").new()\na.add("é✓")\na.add(nothing)\na.add(2.5)\n'
               'show a.size(), a.toArray(), bridge("java", "java.util.Map").of("k", [1, 2])')
        self.assertEqual(out(src), '3 ["é✓", nothing, 2.5] {k: [1, 2]}')
        for bad in ['bridge("java", "no.such.Class")', 'j: bridge("java", "java.lang.Math")\nshow j.sqrt("x")',
                    'j: bridge("java", "java.lang.Integer")\nshow j.parseInt("abc")', 'bridge("ruby", "x")']:
            with self.assertRaises(TamasError, msg=bad):
                out(bad)


class Languages(unittest.TestCase):
    def test_every_example_means_the_same_in_every_language(self):
        self.assertEqual(available_langs(), ["en", "hi", "ta", "te"])
        for path in runnable_examples():
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
        for path in runnable_examples():
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
