import contextlib
import glob
import io
import json
import os
import re
import shutil
import ctypes.util
import importlib.util
import subprocess
import sys
import tempfile
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
NUMPY, LIBM, GXX = importlib.util.find_spec("numpy"), ctypes.util.find_library("m"), shutil.which("g++")
NEEDS = {"bridge_js.tms": NODE, "bridge_java.tms": JAVA, "bridge_numpy.tms": NUMPY, "bridge_c.tms": LIBM}


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


class Libraries(unittest.TestCase):
    def test_language_support_for_libraries(self):
        self.assertEqual(out("f(a, b) -> a - b\nshow f(b: 1, a: 10), f(10, b: 1), round(2.567, places: 1)"), "9 9 2.6")
        self.assertEqual(out("""show 'a {b} "c" \\n it''s', len('{}')"""), 'a {b} "c" \\n it\'s 2')
        self.assertEqual(out('show round(90 deg, 4), round(use("math").pi as deg), sqrt(16 m^2), sqrt(2 m * 8 m)'), "1.5708 180 4 m 4 m")
        for bad in ["f(a) -> a\nf(b: 1)", "f(a) -> a\nf(1, a: 2)", "show sqrt(4 m)", 'use("no_such_library")', "show 'open"]:
            with self.assertRaises(TamasError, msg=bad):
                out(bad)

    def test_own_libraries_and_errors(self):
        with tempfile.TemporaryDirectory() as d:
            files = {"shop.tms": 'tax: 0.18\nprice(net) -> net * (1 + tax)\nhelper: use("stats")',
                     "loop_a.tms": 'b: use("loop_b")', "loop_b.tms": 'a: use("loop_a")', "broken.tms": "x: 1\nshow y"}
            for name, text in files.items():
                with open(os.path.join(d, name), "w", encoding="utf-8") as f:
                    f.write(text)
            self.assertEqual(out('shop: use("shop")\nshow shop.price(100 INR), shop.tax, shop.helper.median([3, 1, 2])', d), "118 INR 0.18 2")
            for bad, text in (('use("loop_a")', "circle"), ('use("broken")', "line 2")):
                with self.assertRaises(TamasError) as cm:
                    out(bad, d)
                self.assertIn(text, str(cm.exception))

    def test_xml_html_css_regex(self):
        src = """x: use("xml")
doc: x.parse('<order id="7"><item qty="2">Rice &amp; dal</item><item qty="1">Tea</item>tail<empty/></order>')
show doc.attrs.id, len(x.find(doc, "item")), x.text(doc.children[0])
show x.write(doc)
show x.write(x.el("a", {t: "1 < 2 & \\"q\\""}, ["<b>"]))"""
        self.assertEqual(out(src), '7 2 Rice & dal\n<order id="7"><item qty="2">Rice &amp; dal</item><item qty="1">Tea</item>tail<empty/></order>\n'
                         '<a t="1 &lt; 2 &amp; &quot;q&quot;">&lt;b&gt;</a>')
        src = """h: use("html")
page: h.parse('<!doctype html><body><ul class="menu big"><li><a href="/a">A &lt; B</a><li><a id=x href="/b">B</a></ul><br><p>Hi<script>if (a<b) {}</script>')
show map(h.select(page, "ul.menu a"), a -> a.attrs.href), h.text(h.select(page, "#x")[0]), len(h.select(page, "ul > li")) 
"""
        with self.assertRaises(TamasError):
            out(src)  # '>' combinators are not understood, and say so
        src = src.replace('"ul > li"', '"ul li"') + "show h.write(page)\nshow h.write(h.parse(h.write(page))) = h.write(page)"
        self.assertEqual(out(src), '["/a", "/b"] B 2\n<body><ul class="menu big"><li><a href="/a">A &lt; B</a></li><li><a id="x" href="/b">B</a></li></ul>'
                         '<br><p>Hi<script>if (a<b) {}</script></p></body>\nyes')
        src = """c: use("css")
sheet: c.parse('/* note */ @import url(''a;b.css''); body, h1 { margin: 0; font: 12px "A;B" } @media (max-width: 600px) { .x { color: red } }')
show len(sheet), sheet[1].selector, sheet[1].declarations.font, sheet[2].rules[0].declarations.color
show c.parse(c.write(sheet)) = sheet"""
        self.assertEqual(out(src), '3 body, h1 12px "A;B" red\nyes')
        for bad in ["use(\"xml\").parse('<a><b></a>')", "use(\"css\").parse('a { b: c')", "use(\"css\").parse('a b c')", "use(\"regex\").find('(', 'x')"]:
            with self.assertRaises(TamasError, msg=bad):
                out(bad)
        self.assertEqual(out("""r: use("regex")\nshow r.find_all('\\d+', "a1 b22"), r.find('(\\w+)@(\\w+)', "x asha@tamas y"), r.find('z', "abc"), r.replace('\\s+', "a  b", " ")"""),
                         '["1", "22"] ["asha", "tamas"] nothing a b')

    def test_science_and_industry_libraries(self):
        checks = {
            'st: use("stats")\nf: st.linear_fit([1, 2, 3, 4], [3, 5, 7, 9])\nshow st.median([3, 1, 4, 1, 5]), st.median([1, 2, 3, 4]), '
            'round(st.stdev([2, 4, 4, 4, 5, 5, 7, 9]), 4), st.stdev([1 kg, 2 kg, 3 kg]), st.percentile([1, 2, 3, 4, 5], 90), f.slope, f.intercept, f.r2, f.predict(10)':
                "3 2.5 2.1381 1 kg 4.6 2 1 1 21",
            'mx: use("matrix")\nshow mx.multiply([[1, 2], [3, 4]], [[5, 6], [7, 8]]), mx.determinant([[2, 0], [1, 3]]), mx.solve([[2, 1], [1, 3]], [3, 5]), '
            'mx.solve([[1, 2], [2, 4]], [1, 2]), mx.identity(2)':
                "[[19, 22], [43, 50]] 6 [0.8, 1.4] nothing [[1, 0], [0, 1]]",
            'ai: use("ai")\npts: [[1, 1], [1.2, 0.8], [0.9, 1.1], [5, 5], [5.2, 4.9], [4.8, 5.1]]\n'
            'lr: ai.linear_regression([[1], [2], [3], [4]], [3, 5, 7, 9], 0.05, 2000)\n'
            'lg: ai.logistic_regression([[0.5], [1], [1.5], [3], [3.5], [4]], [0, 0, 0, 1, 1, 1], 0.5, 500)\n'
            'show ai.knn(pts, ["a", "a", "a", "b", "b", "b"], [4.5, 4.7], 3), ai.kmeans([[1, 1], [5, 5], [1.2, 0.8], [5.2, 4.9]], 2, 5).labels, '
            'round(lr.weights[0], 2), round(lr.predict([10]), 1), map([[1], [3.8]], lg.classify), ai.accuracy([1, 0, 1, 1], [1, 0, 0, 1])':
                "b [0, 1, 0, 1] 2 21 [0, 1] 0.75",
            'rb: use("robotics")\ntip: rb.forward([30 cm, 20 cm], [90 deg, -90 deg])\nik: rb.inverse_2link(30 cm, 20 cm, 20 cm, 30 cm)\nc: rb.pid(2, 0.5, 0.1)\n'
            'p: rb.drive({x: 0 m, y: 0 m, heading: 0}, 1 m/s, 1 m/s, 0.5 m, 2 s)\n'
            'show round(tip.x as cm, 6), round(tip.y as cm, 6), round(ik.shoulder as deg, 2), round(ik.elbow as deg, 2), rb.inverse_2link(1 m, 1 m, 3 m, 0 m), '
            'rb.pid_step(c, 1, 0.1), round(rb.pid_step(c, 0.5, 0.1), 4), p.x, rb.move_time(10 m, 2 m/s, 1 m/s^2), rb.move_time(1 m, 2 m/s, 1 m/s^2)':
                "20 cm 30 cm 22.62 90 nothing 2.05 0.575 2 m 7 s 2 s",
            'sc: use("semiconductor")\ncox: sc.oxide_capacitance(2 nm)\n'
            'show round(sc.thermal_voltage(300 K), 3), sc.dies_per_wafer(300 mm, 10 mm, 10 mm), round(sc.yield_poisson(0.1 cm^-2, 1 cm^2), 4), '
            'round(sc.yield_murphy(0.1 cm^-2, 100 mm^2), 4), sc.good_dies(300 mm, 10 mm, 10 mm, 0.1 cm^-2), sc.sheet_resistance(1e-6 ohm*m, 100 nm), '
            'round(sc.mosfet_current(400 cm^2/V/s, cox, 1 um, 100 nm, 1 V, 0.4 V), 4), round(sc.built_in_potential(1e17 cm^-3, 1e16 cm^-3, 300 K), 3)':
                "25.852 mV 640 0.9048 0.9056 579 10 ohm 1.2431 mA 0.774 V",
            'fn: use("finance")\nshow round(fn.compound(100000 INR, 0.08, 10, 1)), round(fn.loan_payment(1000000 INR, 0.09, 240), 2), '
            'round(fn.npv(0.1, [-1000 USD, 500 USD, 500 USD, 500 USD]), 2), round(fn.irr([-1000, 500, 500, 500]), 4), round(fn.cagr(100, 200, 5), 4), '
            'fn.moving_average([1, 2, 3, 4, 5], 3), fn.irr([1, 2])':
                "215892 INR 8997.26 INR 243.43 USD 0.2338 0.1487 [2, 3, 4] nothing",
            'ph: use("physics")\nshow round(ph.orbital_period(6771 km, ph.earth_mass) as min, 1), round(ph.orbital_speed(6771 km, ph.earth_mass) as km/s, 2), '
            'round(ph.escape_speed(ph.earth_radius, ph.earth_mass) as km/s, 2), ph.kinetic_energy(1000 kg, 20 m/s), round(ph.delta_v(300 s, 500 t, 100 t) as km/s, 2), '
            'round(ph.photon_energy(500 nm), 3), round(ph.lorentz_factor(0.6 * ph.c), 4)':
                "92.4 min 7.67 km/s 11.19 km/s 200000 J 4.73 km/s 2.48 eV 1.25",
        }
        for src, expected in checks.items():
            self.assertEqual(out(src), expected, src[:20])
        with self.assertRaises(TamasError):  # units are checked inside libraries too
            out('use("semiconductor").yield_poisson(0.1 cm^-2, 1 kg)\nshow use("physics").kinetic_energy(1 m, 1 s)')

    @unittest.skipUnless(NUMPY, "NumPy is not installed")
    def test_python_libraries_with_named_values_and_arithmetic(self):
        self.assertEqual(out('np: bridge("python", "numpy")\na: np.array([1, 2, 3])\n'
                             'show (a * 2 + 1).tolist(), (-a).tolist(), np.linspace(0, 1, num: 3).tolist(), truthy((a > 0).all()), (a ^ 2).tolist()'),
                         "[3, 5, 7] [-1, -2, -3] [0, 0.5, 1] yes [1, 4, 9]")
        with self.assertRaises(TamasError):
            out('np: bridge("python", "numpy")\nshow np.array([1, 2]) + np.array([1, 2, 3])')

    @unittest.skipUnless(LIBM, "the C maths library was not found")
    def test_c_bridge(self):
        self.assertEqual(out(read("bridge_c.tms")), "1 1024\n13")
        for bad in ['bridge("c", "no_such_lib_x")', 'bridge("c", "m").fn("nope", "double", [])', 'bridge("c", "m").fn("cos", "complex", [])',
                    'f: bridge("c", "m").fn("cos", "double", ["double"])\nf("x")', 'f: bridge("c", "m").fn("cos", "double", ["double"])\nf(1, 2)']:
            with self.assertRaises(TamasError, msg=bad):
                out(bad)

    @unittest.skipUnless(GXX, "no C++ compiler")
    def test_cpp_library_through_extern_c(self):
        code = ('#include <string>\n#include <numeric>\n#include <vector>\nextern "C" {\n'
                'double triangle(int n) { std::vector<int> v(n); std::iota(v.begin(), v.end(), 1); return std::accumulate(v.begin(), v.end(), 0.0); }\n'
                'const char* shout(const char* s) { static std::string out; out = std::string(s) + "!"; return out.c_str(); }\n'
                'bool is_even(long n) { return n % 2 == 0; }\n}\n')
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "fast.cpp"), "w") as f:
                f.write(code)
            subprocess.run([GXX, "-shared", "-fPIC", "-o", os.path.join(d, "libfast.so"), os.path.join(d, "fast.cpp")], check=True)
            src = ('lib: bridge("c++", "libfast.so")\nshow lib.fn("triangle", "double", ["int"])(100), lib.fn("shout", "text", ["text"])("தமிழ்"), '
                   'lib.fn("is_even", "truth", ["long"])(7)')
            self.assertEqual(out(src, d), "5050 தமிழ்! no")


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
