"""Runs a Tamas syntax tree."""
import functools
import json
import math
import operator
import os
import sys

from . import bridges
from .errors import TamasError
from .parser import parse
from .units import DEFAULT_UNITS, Quantity, fnum

sys.setrecursionlimit(max(sys.getrecursionlimit(), 20000))


class _Give(Exception):
    def __init__(self, value):
        self.value = value


class _Stop(Exception):
    pass


class _Skip(Exception):
    pass


class Env:
    __slots__ = ("vars", "parent")

    def __init__(self, parent=None):
        self.vars, self.parent = {}, parent

    def find(self, name):
        env = self
        while env is not None:
            if name in env.vars:
                return env.vars
            env = env.parent
        return None


class Function:
    def __init__(self, interp, params, body, env, name):
        self.interp, self.params, self.body, self.env, self.name = interp, params, body, env, name

    def __call__(self, *args):
        if len(args) != len(self.params):
            raise TamasError(f"{self} takes {len(self.params)} value(s) but was given {len(args)}")
        env = Env(self.env)
        env.vars.update(zip(self.params, args))
        try:
            self.interp.run_block(self.body, env)
        except _Give as g:
            return g.value
        return None

    def __str__(self):
        return f"<function {self.name or '(unnamed)'}>"


def is_num(v):
    return type(v) in (int, float)


def fmt(v, top=True):
    if v is None:
        return "nothing"
    if v is True:
        return "yes"
    if v is False:
        return "no"
    if isinstance(v, str):
        return v if top else bridges.quote(v)
    if isinstance(v, float):
        return fnum(v)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(fmt(x, False) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ", ".join(f"{bridges.key_text(str(k))}: {fmt(x, False)}" for k, x in v.items()) + "}"
    return str(v)


def type_name(v):
    if v is None:
        return "nothing"
    if isinstance(v, bool):
        return "truth"
    if is_num(v):
        return "number"
    if isinstance(v, str):
        return "text"
    if isinstance(v, list):
        return "list"
    if isinstance(v, dict):
        return "record"
    if isinstance(v, Quantity):
        return "quantity"
    if callable(v):
        return "function"
    return "foreign"


def _number(v):
    if isinstance(v, Quantity):
        return v.value
    if isinstance(v, str):
        try:
            return int(v)
        except ValueError:
            try:
                return float(v)
            except ValueError:
                raise TamasError(f"'{v}' is not a number")
    if is_num(v):
        return v
    raise TamasError(f"cannot turn {type_name(v)} into a number")


def _round(v, places=0):
    if isinstance(v, Quantity):
        return Quantity(round(v.value, places) * v.factor, v.dims, v.unit, v.factor)
    r = round(v, places)
    return int(r) if places == 0 else r


def _group(xs, f):
    out = {}
    for x in xs:
        out.setdefault(fmt(f(x)), []).append(x)
    return out


def _push(xs, x):
    xs.append(x)
    return xs


def _total(xs):
    return functools.reduce(operator.add, xs) if xs else 0


def _pick(fn):
    return lambda *a: fn(a[0]) if len(a) == 1 else fn(a)


BUILTINS = {
    "len": len,
    "range": lambda *a: list(range(*a)),
    "map": lambda xs, f: [f(x) for x in xs],
    "filter": lambda xs, f: [x for x in xs if f(x) is True],
    "fold": lambda xs, start, f: functools.reduce(f, xs, start),
    "sort": lambda xs, key=None: sorted(xs, key=key),
    "group": _group,
    "sum": _total,
    "mean": lambda xs: _total(xs) / len(xs),
    "min": _pick(min),
    "max": _pick(max),
    "abs": abs,
    "sqrt": math.sqrt,
    "floor": math.floor,
    "round": _round,
    "whole": int,
    "number": _number,
    "text": lambda v: fmt(v),
    "truthy": bool,
    "type": type_name,
    "keys": lambda d: list(d),
    "values": lambda d: list(d.values()),
    "has": lambda c, x: x in c,
    "push": _push,
    "join": lambda xs, sep="": sep.join(fmt(x) for x in xs),
    "split": lambda s, sep=None: s.split(sep),
    "upper": lambda s: s.upper(),
    "lower": lambda s: s.lower(),
    "trim": lambda s: s.strip(),
    "json": lambda v: json.dumps(bridges.to_plain(v), ensure_ascii=False),
    "parse": lambda s: json.loads(s),
    "bridge": bridges.bridge,
    "geo": bridges.GEO,
}


class Interp:
    def __init__(self, base_dir=".", out=None):
        self.base_dir = base_dir
        self.out = out or (lambda s: print(s))
        self.units = dict(DEFAULT_UNITS)
        self.builtins = Env()
        self.builtins.vars.update(BUILTINS)
        self.builtins.vars.update({
            "show": lambda *a: self.out(" ".join(fmt(x) for x in a)),
            "read": lambda p: bridges.read_file(self.path(p), self.run_tms),
            "write": lambda p, v: bridges.write_file(self.path(p), v),
        })
        self.globals = Env(self.builtins)
        self.last = None

    def path(self, p):
        return p if os.path.isabs(p) else os.path.join(self.base_dir, p)

    def run_tms(self, path):
        with open(path, encoding="utf-8") as f:
            sub = Interp(os.path.dirname(path) or ".", self.out)
            sub.run(f.read())
            return sub.document()

    def run(self, src):
        tree = parse(src)
        try:
            self.run_block(tree, self.globals)
        except _Give as g:
            self.last = g.value
        except (_Stop, _Skip):
            raise TamasError("'stop' and 'skip' only make sense inside 'each' or 'loop'")
        except RecursionError:
            raise TamasError("the program called itself too deeply")
        return self.last

    def document(self):
        """A program is also a document: its top-level data, ready for export."""
        data = {k: v for k, v in self.globals.vars.items() if type_name(v) not in ("function", "foreign")}
        return data if data else self.last

    # -- statements
    def run_block(self, stmts, env):
        for s in stmts:
            try:
                getattr(self, "s_" + s[0])(s, env)
            except TamasError as e:
                if e.line is None:
                    e.line = s[1]
                raise

    def s_expr(self, s, env):
        self.last = self.ev(s[2], env)

    def s_bind(self, s, env):
        target, value = s[2], self.ev(s[3], env)
        kind = target[0]
        if kind == "name":
            env.vars[target[2]] = value
        elif kind == "str":
            env.vars[target[2][0]] = value
        elif kind == "member":
            obj = self.ev(target[2], env)
            if not isinstance(obj, dict):
                raise TamasError(f"only a record has fields to set, not {type_name(obj)}", s[1])
            obj[target[3]] = value
        else:
            obj, idx = self.ev(target[2], env), self.ev(target[3], env)
            try:
                obj[idx] = value
            except (IndexError, TypeError):
                raise TamasError(f"cannot set item {fmt(idx, False)} of this {type_name(obj)}", s[1])

    def truth(self, v, line):
        if v is True or v is False:
            return v
        raise TamasError(f"a condition must be yes or no, but this is {type_name(v)} ({fmt(v, False)})", line)

    def s_when(self, s, env):
        if self.truth(self.ev(s[2], env), s[1]):
            self.run_block(s[3], env)
        elif s[4] is not None:
            self.run_block(s[4], env)

    def s_each(self, s, env):
        _, line, a, b, it, body = s
        seq = self.ev(it, env)
        if isinstance(seq, dict):
            items = list(seq.items()) if b else list(seq)
        elif isinstance(seq, (list, str)):
            items = list(enumerate(seq)) if b else list(seq)
        else:
            raise TamasError(f"'each' needs a list, record or text, not {type_name(seq)}", line)
        for item in items:
            if b:
                env.vars[a], env.vars[b] = item
            else:
                env.vars[a] = item
            try:
                self.run_block(body, env)
            except _Skip:
                continue
            except _Stop:
                break

    def s_loop(self, s, env):
        while self.truth(self.ev(s[2], env), s[1]):
            try:
                self.run_block(s[3], env)
            except _Skip:
                continue
            except _Stop:
                break

    def s_stop(self, s, env):
        raise _Stop()

    def s_skip(self, s, env):
        raise _Skip()

    def s_give(self, s, env):
        raise _Give(None if s[2] is None else self.ev(s[2], env))

    def s_show(self, s, env):
        self.out(" ".join(fmt(self.ev(e, env)) for e in s[2]))

    def s_unitdef(self, s, env):
        value = self.ev(s[3], env)
        if isinstance(value, Quantity):
            self.units[s[2]] = (value.si, dict(value.dims))
        elif is_num(value):
            self.units[s[2]] = (value, {s[2]: 1})  # a brand-new kind of measurement
        else:
            raise TamasError("a unit is defined by a quantity (unit mile: 1609.344 m) or a number", s[1])

    # -- expressions
    def ev(self, e, env):
        return getattr(self, "e_" + e[0])(e, env)

    def e_num(self, e, env):
        return e[2]

    def e_qty(self, e, env):
        return Quantity.make(e[2], e[3], self.units, e[1])

    def e_str(self, e, env):
        if len(e[2]) == 1 and isinstance(e[2][0], str):
            return e[2][0]
        return "".join(p if isinstance(p, str) else fmt(self.ev(p, env)) for p in e[2])

    def e_bool(self, e, env):
        return e[2]

    def e_nothing(self, e, env):
        return None

    def e_name(self, e, env):
        scope = env.find(e[2])
        if scope is None:
            raise TamasError(f"'{e[2]}' has not been given a value", e[1])
        return scope[e[2]]

    def e_list(self, e, env):
        return [self.ev(x, env) for x in e[2]]

    def e_rec(self, e, env):
        return {k: self.ev(v, env) for k, v in e[2]}

    def e_fn(self, e, env):
        return Function(self, e[2], e[3], env, e[4])

    def e_call(self, e, env):
        f = self.ev(e[2], env)
        if not callable(f):
            raise TamasError(f"this {type_name(f)} is not a function and cannot be called", e[1])
        args = [self.ev(a, env) for a in e[3]]
        try:
            result = f(*args)
        except TamasError as err:
            if err.line is None:
                err.line = e[1]
            raise
        except (_Give, _Stop, _Skip, RecursionError):
            raise
        except Exception as err:
            raise TamasError(f"{type(err).__name__}: {err}", e[1])
        return list(result) if isinstance(result, tuple) else result

    def e_member(self, e, env):
        obj, name = self.ev(e[2], env), e[3]
        if isinstance(obj, dict):
            if name in obj:
                return obj[name]
            raise TamasError(f"this record has no field '{name}' (it has: {', '.join(map(str, obj)) or 'none'})", e[1])
        if isinstance(obj, Quantity) and name in ("value", "unit"):
            return getattr(obj, name)
        if type_name(obj) == "foreign" and not name.startswith("_") and hasattr(obj, name):
            value = getattr(obj, name)
            return list(value) if isinstance(value, tuple) else value
        raise TamasError(f"{type_name(obj)} has no field '{name}'", e[1])

    def e_index(self, e, env):
        obj, idx = self.ev(e[2], env), self.ev(e[3], env)
        try:
            return obj[idx]
        except (KeyError, IndexError, TypeError):
            raise TamasError(f"this {type_name(obj)} has no item {fmt(idx, False)}", e[1])

    def e_neg(self, e, env):
        v = self.ev(e[2], env)
        if is_num(v) or isinstance(v, Quantity):
            return -v
        raise TamasError(f"cannot negate {type_name(v)}", e[1])

    def e_not(self, e, env):
        return not self.truth(self.ev(e[2], env), e[1])

    def e_and(self, e, env):
        return self.truth(self.ev(e[2], env), e[1]) and self.truth(self.ev(e[3], env), e[1])

    def e_or(self, e, env):
        return self.truth(self.ev(e[2], env), e[1]) or self.truth(self.ev(e[3], env), e[1])

    def e_as(self, e, env):
        v = self.ev(e[2], env)
        if is_num(v):
            return Quantity.make(v, e[3], self.units, e[1])
        if isinstance(v, Quantity):
            return v.convert(e[3], self.units, e[1])
        raise TamasError(f"only a number or quantity can be converted with 'as', not {type_name(v)}", e[1])

    def e_bin(self, e, env):
        _, line, op, ea, eb = e
        a, b = self.ev(ea, env), self.ev(eb, env)
        if op in ("=", "!="):
            same = a == b if (is_num(a) and is_num(b)) or type(a) is type(b) else False
            return same if op == "=" else not same
        na, nb = is_num(a) or isinstance(a, Quantity), is_num(b) or isinstance(b, Quantity)
        if op in ("<", ">", "<=", ">="):
            if (na and nb and isinstance(a, Quantity) == isinstance(b, Quantity)) or (isinstance(a, str) and isinstance(b, str)):
                return {"<": operator.lt, ">": operator.gt, "<=": operator.le, ">=": operator.ge}[op](a, b)
            raise TamasError(f"cannot compare {type_name(a)} with {type_name(b)}", line)
        if op == "+" and isinstance(a, str) and isinstance(b, str):
            return a + b
        if op == "+" and isinstance(a, list) and isinstance(b, list):
            return a + b
        if not (na and nb):
            hint = ' (to build text, write "... {value} ...")' if op == "+" and (isinstance(a, str) or isinstance(b, str)) else ""
            raise TamasError(f"cannot use '{op}' between {type_name(a)} and {type_name(b)}{hint}", line)
        qa, qb = isinstance(a, Quantity), isinstance(b, Quantity)
        if op in "+-":
            if qa != qb:
                raise TamasError(f"cannot use '{op}' between a plain number and a quantity ({a if qa else b})", line)
            return a + b if op == "+" else a - b
        if op == "*":
            return a * b
        if op == "/":
            if (b.si if qb else b) == 0:
                raise TamasError("cannot divide by zero", line)
            if type(a) is int and type(b) is int and a % b == 0:
                return a // b
            return a / b
        if op == "%":
            if qa or qb:
                raise TamasError("'%' works on plain numbers only", line)
            if b == 0:
                raise TamasError("cannot divide by zero", line)
            return a % b
        if qb:
            raise TamasError("a power must be a plain number", line)
        try:
            return a ** b
        except (OverflowError, ZeroDivisionError) as err:
            raise TamasError(f"cannot compute this power: {err}", line)


def run_source(src, base_dir=".", out=None):
    interp = Interp(base_dir, out)
    interp.run(src)
    return interp


def run_file(path, out=None):
    with open(path, encoding="utf-8") as f:
        return run_source(f.read(), os.path.dirname(os.path.abspath(path)), out)
