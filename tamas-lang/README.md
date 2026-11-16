# Tamas

**One language for data, code and measurement.** Created and owned by Prasad
([@Prasad-DataAnalyst](https://github.com/Prasad-DataAnalyst)). File extension: `.tms`.

```tamas
~ A Tamas file is a document and a program at the same time.
flight: {
  id: "TM-101"
  distance: 1580 nmi
  cruise: 460 kn
}

time: flight.distance / flight.cruise as h
show "Flight {flight.id}: {round(time, 2)} in the air"      ~ Flight TM-101: 3.43 h in the air
```

This folder holds **version 0.1**: a written specification ([SPEC.md](SPEC.md)) and a working
reference implementation with a test suite. It runs today, on Python 3.9+ with nothing to install.

## The five ideas that make Tamas its own language

| Idea | What it means |
|---|---|
| **Data and code are one notation** | `name: value` is both a JSON-style field and a variable. Any JSON or GeoJSON file converts to Tamas and back without losing anything, and every program can be exported as data. |
| **Numbers carry units** | `460 kn`, `2400 kg/h`, `52 INR`. Adding kilometres to kilograms, or dollars to rupees, is an error caught by the language, in every field from aviation to banking. |
| **Your mother tongue, same structure** | The 17 keywords can be written in Hindi, Tamil or Telugu (more languages = one small file each). `tamas translate` converts a program between them; only the keywords change, never the structure. |
| **Bridges instead of walls** | `bridge("python", "numpy")`, `bridge("javascript", "./lib.js")` and `bridge("java", "java.math.BigInteger")` borrow other languages' libraries. `read()` / `write()` speak JSON, GeoJSON and CSV directly. Converters turn Python, JavaScript and Java source into Tamas. |
| **It grows without breaking** | New units (`unit furlong: 201.168 m`), new measurement kinds, new language packs and new bridges are added *in* Tamas or as data files, without changing the grammar. |

## Try it

```bash
cd tamas-lang
python3 -m tamas run examples/hello.tms
python3 -m tamas run examples/flight.tms        # aviation, units
python3 -m tamas run examples/geo.tms           # GeoJSON
python3 -m tamas run examples/analytics.tms     # CSV analytics with currency
python3 -m tamas run examples/bridge.tms        # using Python libraries
python3 -m tamas run examples/bridge_js.tms     # using JavaScript (needs Node.js)
python3 -m tamas run examples/bridge_java.tms   # using Java (needs a JDK, 11 or newer)

python3 -m tamas import examples/cities.geojson         # JSON/GeoJSON  -> Tamas
python3 -m tamas export examples/flight.tms             # Tamas         -> JSON
python3 -m tamas translate examples/hello.tms --to ta   # English words -> Tamil words
python3 -m tamas from-python examples/sample.py         # Python        -> Tamas
python3 -m tamas from-js examples/sample.js             # JavaScript    -> Tamas
python3 -m tamas from-java examples/Sample.java         # Java          -> Tamas

python3 -m unittest discover -s tests           # 21 tests
```

The same program in Tamil - identical structure, identical result:

```tamas
@lang ta
பெயர்: "தமஸ்"
என்றால் ஆம் { காட்டு "வணக்கம், {பெயர்}" }
```

## What is real today, and what is not yet

Built and tested in v0.1:

- The full core language: values, records, lists, functions, closures, pipes, conditions, loops, text templates.
- 52 built-in units (length, mass, time, energy, power, pressure, data, six currencies) plus user-defined units.
- Lossless JSON / GeoJSON import and export; CSV reading; great-circle distance and GeoJSON builders (`geo`).
- Keyword packs for Hindi, Tamil and Telugu, with exact round-trip translation.
- Bridges to three languages: every installed Python library; any JavaScript module, Node.js library or
  built-in object (through Node.js); any Java class on the classpath (through a JDK). Classes can be
  instantiated with `.new(...)` and the objects used from Tamas.
- Converters from Python, JavaScript and Java for a core subset of each: functions, loops, conditions,
  lists/arrays, records/objects, text building. The test suite runs the converted programs and compares
  their output with what real Node.js and Java print. Anything outside the subset is **refused with a
  clear message** rather than converted wrongly. [SPEC.md](SPEC.md) section 10 lists what is covered.

Not built yet - this is the road ahead, not a finished claim:

- Full coverage of Python, JavaScript and Java. Classes, exceptions, modules/imports, `switch`,
  generics beyond lists, and most library calls are refused today. Converting *every* program of
  *every* language with no errors is not something any tool can honestly promise; Tamas's rule is
  "convert what is understood exactly, refuse the rest".
- Converters and bridges for C, C++, C#, Go, Rust and others.
- Passing Tamas functions as callbacks into JavaScript or Java.
- A compiler (v0.1 is an interpreter, so it is slower than Java or C), a package manager, editor support.
- Type declarations, modules, concurrency, a standard library for each industry.
- "Evolving by itself": no language rewrites itself. What Tamas has is a design that can be extended
  without breaking old programs. The evolving will be done by you and the people who adopt it.
- The Hindi, Tamil and Telugu keyword choices should be reviewed by native-speaking programmers.

## Layout

```
tamas/          the reference implementation (lexer, parser, interpreter, units, bridges, converters)
tamas/helpers/  the small Node.js and Java programs the JavaScript and Java bridges talk to
tamas/langs/    language packs - each is itself a small Tamas file
examples/       runnable programs and sample data
tests/          the test suite
SPEC.md         the language specification
NOTICE          ownership
```
