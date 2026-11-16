# The Tamas library

Load any library with `use("name")`. List what is installed with `python3 -m tamas libs`.

```tamas
chip: use("semiconductor")
show chip.dies_per_wafer(300 mm, 8 mm, 6 mm)        ~ 1376
```

A library is an ordinary record of values and functions, so nothing new has to be learned to use one.

## What exists today (v0.1)

| Library | What it gives you | Written in |
|---|---|---|
| `math` | pi, e, trigonometry, exp/log, gcd, factorial, random numbers | host |
| `stats` | median, variance, stdev, percentile, mode, z-scores, correlation, linear fit, histogram - all unit-aware | Tamas |
| `matrix` | zeros, identity, transpose, add, scale, dot, multiply, determinant, solve | Tamas |
| `ai` | k-nearest neighbours, k-means, linear and logistic regression, normalize, softmax, accuracy | Tamas |
| `robotics` | arm forward / inverse kinematics, PID controller, two-wheel odometry, motion timing | Tamas |
| `semiconductor` | physical constants, thermal voltage, dies per wafer, three yield models, sheet resistance, MOSFET and diode equations, junction potential | Tamas |
| `physics` | constants with units, energy, orbital speed / period, escape speed, rocket equation, photon energy, relativity factor | Tamas |
| `finance` | interest, present value, NPV, IRR, loan payment, CAGR, returns, moving average - currency-aware | Tamas |
| `xml` | parse, write, find, text, build | host |
| `html` | parse (forgiving, like a browser), write, find, CSS-style `select`, text, build, escape | host |
| `css` | parse a style sheet into rules and declarations, write it back | host |
| `regex` | find, find_all, matches, replace, split | host |
| built in | JSON, GeoJSON, CSV (`read`, `write`, `json`, `parse`), geography (`geo`), units | host |

"Host" means the library is implemented inside the Tamas interpreter, the same way Python's own `json`
and `math` are implemented in C. "Tamas" means the library is a `.tms` file in `tamas/lib/` that you can
open and read.

XML and HTML share one document model: a node is `{tag, attrs, children}` and a child is another node
or a piece of text.

## Reaching the rest of the world's libraries

Tamas does not need its own copy of a library to use it. A bridge calls the original:

| You need | Use today | Checked in this repository |
|---|---|---|
| Arrays, linear algebra | `bridge("python", "numpy")` | yes - `examples/bridge_numpy.tms`, tests |
| Data tables | `bridge("python", "pandas")` | tried by hand, not in the test suite |
| Deep learning | `bridge("python", "torch")`, `"tensorflow"` | not checked (not installed here) |
| Machine learning | `bridge("python", "sklearn")` | not checked |
| Computer vision | `bridge("python", "cv2")` | not checked |
| Robots (ROS 2) | `bridge("python", "rclpy")` | not checked |
| Chip layout, circuit simulation | `bridge("python", "gdstk")`, `"PySpice"` | not checked |
| Astronomy, biology, maps | `bridge("python", "astropy")`, `"Bio"`, `"geopandas"` | not checked |
| Any npm package or Node.js module | `bridge("javascript", name)` | yes - tests |
| Any Java class or jar | `bridge("java", "full.class.Name")` | yes - tests |
| Any compiled C library; C++ through `extern "C"` | `bridge("c", name)` | yes - tests compile and call a C++ library |

"Not checked" means the bridge mechanism is the same one the tests exercise, but that particular
library has not been run from Tamas yet, so expect rough edges.

What the bridges cannot do yet: pass a Tamas function as a callback into JavaScript, Java or C; call
C functions that take pointers, arrays or structs; use C++ classes directly.

## Why Tamas bridges instead of converting everything

The goal is that a Tamas programmer can use everything. Converting all of the world's libraries into
Tamas source is not the way to get there:

- **Size.** NumPy, PyTorch, OpenCV, ROS and the JDK are tens of millions of lines of C, C++, Fortran,
  CUDA and Java, written over decades by thousands of people.
- **The converters refuse most library code, on purpose.** They translate a safe core of Python,
  JavaScript and Java and reject classes, exceptions, pointers and the rest instead of guessing.
  There is no C or C++ converter at all.
- **Speed.** Those libraries are fast because they are compiled machine code. Rewritten for the v0.1
  interpreter they would run thousands of times slower.
- **Ownership.** Those libraries belong to their authors. A converted copy is a derivative work under
  their licences; it would not become yours. Calling a library through a bridge is ordinary use.

This is also how every successful language did it: Python's scientific stack is C and Fortran behind
a bridge. What must be written in Tamas itself is what makes Tamas different - libraries where units,
readable data and plain-language errors matter, like the ones in the first table.

## Adding a library

1. Write a `.tms` file. Its top-level names are what `use()` returns.
2. Put it next to your program (`use("mylib")` finds `mylib.tms`), or in `tamas/lib/` to ship it with Tamas.
3. A library can use other libraries, and can wrap a bridge so its users never see the other language.

```tamas
~ wafers.tms
chip: use("semiconductor")
cost_per_good_die(wafer_cost, diameter, width, height, defects) -> {
  give wafer_cost / chip.good_dies(diameter, width, height, defects)
}
```

Limits to know: a `unit` defined inside a library is not visible by name to the program that loads
it (its quantities still work), and libraries are loaded once per program.

## Road ahead

Not built yet, roughly in the order that would matter most: a package manager and public registry;
libraries for health, agriculture, aviation, logistics, law and government data formats; YAML, TOML,
SQL and Excel readers; HTTP and files; a compiler so that libraries written in Tamas run fast;
callbacks and structured data across the C bridge.
