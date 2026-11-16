# Tamas Language Specification - version 0.1

Owner and author: Prasad (github.com/Prasad-DataAnalyst). See [NOTICE](NOTICE).

## 1. Design rules

1. **One notation.** There is no separate "data format" and "programming language". A file of
   `name: value` lines is both.
2. **Meaning is checked.** A number may carry a unit; conditions must be `yes` or `no`; mistakes are
   reported in plain words with a line number.
3. **Small core.** 17 keywords. Everything else is an ordinary function or an ordinary record.
4. **Structure is fixed, words are not.** Keywords may be written in any human language through a
   language pack. Punctuation and structure are identical everywhere.
5. **Exact or refused.** Conversions from other formats and languages are either exact or rejected.
6. **Grow by addition.** Units, language packs and bridges are added without changing the grammar,
   so a program written for one version keeps its meaning in later versions.

## 2. Text of a program

- Encoding: UTF-8. Names may use letters of any script, digits and `_`.
- `~` starts a note that runs to the end of the line.
- A statement ends at the end of its line. Lines inside `( )` and `[ ]` continue freely; a line
  beginning with `|>` continues the previous line.
- An optional first line `@lang xx` selects a language pack (section 9).

## 3. Values

| Kind | Written as | Notes |
|---|---|---|
| number | `42`, `3.14`, `1_000_000`, `6.02e23` | whole numbers have no size limit |
| quantity | `250 km/h`, `9.81 m/s^2`, `52 INR` | a number with a unit (section 6) |
| text | `"Hello, {name}"` | `{...}` inserts any expression; escapes `\" \\ \n \t \r \{ \uXXXX` |
| truth | `yes`, `no` | |
| nothing | `nothing` | the absence of a value |
| list | `[1, 2, 3]` | items counted from 0; `xs[-1]` is the last |
| record | `{id: "TM-1", seats: 180}` | fields separated by commas or new lines; keys may be quoted text |
| function | `x -> x * 2`, `(a, b) -> a + b` | section 5 |

## 4. Statements

```
name: value                      bind a name (in the current function, or the top level)
record.field: value              set a field
list[i]: value                   set an item
show a, b, c                     print values separated by spaces
when cond { ... } else when cond { ... } else { ... }
each item in list { ... }        also: each i, item in list   /   each key, value in record
loop cond { ... }                repeat while cond is yes
stop                             leave the nearest each/loop
skip                             go to its next round
give value                       return from a function
unit name: quantity              define a unit (section 6)
```

A binding inside a function is local to that function. A function may read outer names and may
change outer *records and lists* (`state.count: state.count + 1`), but it never silently rebinds
an outer name.

The top-level bindings of a file form its **document**: the record that `tamas export`, and
`read("file.tms")` from another program, produce.

## 5. Functions

```
area(r) -> 3.14159 * r * r           one expression
describe(p) -> {                     a block; `give` returns
  when p.age < 18 { give "minor" }
  give "adult"
}
double: x -> x * 2                   unnamed functions are values
```

In a function body `{` always opens a block. To return a record from a one-line function, wrap it:
`origin() -> ({x: 0, y: 0})`.

## 6. Quantities and units

- A number followed by a known unit is a quantity: `5 km`, `5 km/h`, `5 m^2`, `1 kg*m/s^2`.
- `+`, `-` and comparisons need the same kind of measurement on both sides (`1 km + 500 m` is fine,
  `1 km + 1 kg` is an error). `*` and `/` combine units; units that cancel leave a plain number.
- `expr as unit` converts (`d as km`) or attaches a unit to a plain number (`row.price as INR`).
- `q.value` and `q.unit` give the parts; `number(q)` gives the value.
- `unit furlong: 201.168 m` defines a unit from an existing one. `unit credit: 1` defines a brand-new
  kind of measurement that mixes with nothing else.
- Each currency is its own kind: Tamas will not add USD to INR. Exchange rates are data, not syntax.

Built in: `m km cm mm um nm mi ft nmi au ly`, `kg g mg t lb`, `s ms min h day yr`, `A K mol cd`,
`Hz N Pa bar J kWh eV W kW MW V`, `L ha kn`, `bit byte kB MB GB TB`, `USD INR EUR GBP JPY CNY`.

## 7. Operators, loosest to tightest

| Level | Operators |
|---|---|
| 1 | `|>` pipe: `a |> f(b)` means `f(a, b)` |
| 2 | `or` |
| 3 | `and` |
| 4 | `not` |
| 5 | `=  !=  <  >  <=  >=` (equality is `=`; values of different kinds are never equal) |
| 6 | `as` |
| 7 | `+  -` |
| 8 | `*  /  %` |
| 9 | unary `-` |
| 10 | `^` power (right to left) |
| 11 | call `f(x)`, field `r.name`, item `xs[0]` |

`+` joins two texts or two lists. To put a number into text, use a template: `"total: {n}"`.

## 8. Built-in functions

- Lists: `len range map filter fold sort group sum mean min max push has join`
- Records: `keys values has`
- Numbers: `abs sqrt floor round whole number`
- Text: `text split join upper lower trim`
- Kinds: `type(v)` gives `number text truth nothing list record quantity function foreign`; `truthy(v)`
- Data: `read(path)` (`.json .geojson .csv .tms`, otherwise text), `write(path, value)`, `json(v)`, `parse(text)`
- Geography: `geo.distance(a, b)`, `geo.length(line)`, `geo.point`, `geo.line`, `geo.feature`, `geo.collection`
- Other languages: `bridge("python", "library")`

List functions take the list first so they chain with `|>`.

## 9. Human languages

A language pack is a Tamas data file in `tamas/langs/` giving one word for each of the 17 keywords:

```
when else each in loop stop skip give show unit as and or not yes no nothing
```

A program starting with `@lang ta` may use the Tamil words. English keywords are always understood.
`tamas translate file.tms --to hi` rewrites keywords only; translating there and back returns the
original file exactly. Names, text and notes are never touched.

## 10. Talking to other languages and formats

| Direction | v0.1 |
|---|---|
| JSON, GeoJSON -> Tamas | `tamas import` - exact |
| Tamas -> JSON | `tamas export` - exact for plain data; a quantity becomes `{"value": n, "unit": "u"}` |
| CSV -> Tamas | `read("file.csv")` gives a list of records |
| Python libraries inside Tamas | `bridge("python", name)` |
| Python source -> Tamas | `tamas from-python` - a defined subset; the rest is refused |
| Other languages | planned: each is a new bridge and a new converter, with no change to this grammar |

## 11. Versioning

The grammar in this document is edition `0.1`. Later editions may add keywords, units, bridges and
built-ins. Removing or changing the meaning of anything requires a new edition marker so that
existing files keep working.
