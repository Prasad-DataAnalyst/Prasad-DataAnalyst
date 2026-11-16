"""Quantities: numbers that carry a unit and refuse to mix incompatible dimensions."""
import math
import re

from .errors import TamasError

BASE = ["m", "kg", "s", "A", "K", "mol", "cd", "bit", "USD", "INR", "EUR", "GBP", "JPY", "CNY"]

DEFAULT_UNITS = {b: (1, {b: 1}) for b in BASE}


def _add(name, factor, **dims):
    DEFAULT_UNITS[name] = (factor, dims)


# length
for _n, _f in [("km", 1e3), ("cm", 1e-2), ("mm", 1e-3), ("um", 1e-6), ("nm", 1e-9), ("mi", 1609.344),
               ("ft", 0.3048), ("nmi", 1852), ("au", 1.495978707e11), ("ly", 9.4607304725808e15)]:
    _add(_n, _f, m=1)
# mass
for _n, _f in [("g", 1e-3), ("mg", 1e-6), ("t", 1e3), ("lb", 0.45359237)]:
    _add(_n, _f, kg=1)
# time
for _n, _f in [("ms", 1e-3), ("min", 60), ("h", 3600), ("day", 86400), ("yr", 31557600)]:
    _add(_n, _f, s=1)
# mechanics, energy, electricity
_add("Hz", 1, s=-1)
_add("N", 1, kg=1, m=1, s=-2)
_add("Pa", 1, kg=1, m=-1, s=-2)
_add("bar", 1e5, kg=1, m=-1, s=-2)
for _n, _f in [("J", 1), ("kWh", 3.6e6), ("eV", 1.602176634e-19)]:
    _add(_n, _f, kg=1, m=2, s=-2)
for _n, _f in [("W", 1), ("kW", 1e3), ("MW", 1e6)]:
    _add(_n, _f, kg=1, m=2, s=-3)
_add("mW", 1e-3, kg=1, m=2, s=-3)
_add("V", 1, kg=1, m=2, s=-3, A=-1)
_add("mV", 1e-3, kg=1, m=2, s=-3, A=-1)
_add("mA", 1e-3, A=1)
_add("nA", 1e-9, A=1)
_add("pF", 1e-12, kg=-1, m=-2, s=4, A=2)
_add("fF", 1e-15, kg=-1, m=-2, s=4, A=2)
_add("mK", 1e-3, K=1)
_add("us", 1e-6, s=1)
_add("ns", 1e-9, s=1)
_add("uA", 1e-6, A=1)
_add("C", 1, A=1, s=1)
_add("ohm", 1, kg=1, m=2, s=-3, A=-2)
_add("F", 1, kg=-1, m=-2, s=4, A=2)
for _n, _f in [("kHz", 1e3), ("MHz", 1e6), ("GHz", 1e9)]:
    _add(_n, _f, s=-1)
# angles are plain numbers measured in radians: 90 deg is the number 1.5707...
_add("rad", 1)
_add("deg", math.pi / 180)
# area, volume, speed
_add("L", 1e-3, m=3)
_add("ha", 1e4, m=2)
_add("kn", 1852 / 3600, m=1, s=-1)
# information
for _n, _f in [("byte", 8), ("kB", 8e3), ("MB", 8e6), ("GB", 8e9), ("TB", 8e12)]:
    _add(_n, _f, bit=1)

_PIECE = re.compile(r"([*/]?)([A-Za-z]+)(?:\^(-?\d+))?")


def parse_unit(expr, registry, line=None):
    """'km/h' -> (factor to SI, dimensions)."""
    factor, dims, pos = 1, {}, 0
    while pos < len(expr):
        m = _PIECE.match(expr, pos)
        if not m or (pos == 0 and m.group(1)):
            raise TamasError(f"'{expr}' is not a valid unit", line)
        op, name, power = m.group(1), m.group(2), int(m.group(3) or 1)
        if name not in registry:
            raise TamasError(f"unknown unit '{name}'", line)
        if op == "/":
            power = -power
        f, d = registry[name]
        factor *= f ** power
        for k, v in d.items():
            dims[k] = dims.get(k, 0) + v * power
        pos = m.end()
    return factor, {k: v for k, v in dims.items() if v}


def base_unit(dims):
    """Dimensions -> a unit string written in base units, e.g. 'kg*m/s^2'."""
    def piece(k, v):
        return k if v == 1 else f"{k}^{v}"
    top = [piece(k, v) for k, v in dims.items() if v > 0]
    if not top:
        return "*".join(piece(k, v) for k, v in dims.items())
    return "*".join(top) + "".join("/" + piece(k, -v) for k, v in dims.items() if v < 0)


def fnum(v):
    if isinstance(v, float):
        return format(v, ".12g")
    return str(v)


def _is_num(v):
    return type(v) in (int, float)


class Quantity:
    __slots__ = ("si", "dims", "unit", "factor")

    def __init__(self, si, dims, unit, factor):
        self.si, self.dims, self.unit, self.factor = si, dims, unit, factor

    @classmethod
    def make(cls, number, unit, registry, line=None):
        factor, dims = parse_unit(unit, registry, line)
        return cls(number * factor, dims, unit, factor)

    @property
    def value(self):
        v = self.si / self.factor
        if isinstance(v, float) and v.is_integer() and abs(v) < 1e15 and isinstance(self.factor, int):
            return int(v)
        return v

    def convert(self, unit, registry, line=None):
        factor, dims = parse_unit(unit, registry, line)
        if dims != self.dims:
            raise TamasError(f"cannot convert {self.unit} to {unit}: they measure different things", line)
        return Quantity(self.si, self.dims, unit, factor)

    def _same(self, other, verb):
        if not isinstance(other, Quantity):
            raise TamasError(f"cannot {verb} a quantity ({self}) and a plain value")
        if other.dims != self.dims:
            raise TamasError(f"cannot {verb} {self.unit} and {other.unit}: they measure different things")

    @staticmethod
    def _build(si, dims):
        dims = {k: v for k, v in dims.items() if v}
        if not dims:
            return si
        return Quantity(si, dims, base_unit(dims), 1)

    def __add__(self, o):
        self._same(o, "add")
        return Quantity(self.si + o.si, self.dims, self.unit, self.factor)

    def __sub__(self, o):
        self._same(o, "subtract")
        return Quantity(self.si - o.si, self.dims, self.unit, self.factor)

    def __neg__(self):
        return Quantity(-self.si, self.dims, self.unit, self.factor)

    def __mul__(self, o):
        if _is_num(o):
            return Quantity(self.si * o, self.dims, self.unit, self.factor)
        if isinstance(o, Quantity):
            dims = dict(self.dims)
            for k, v in o.dims.items():
                dims[k] = dims.get(k, 0) + v
            return self._build(self.si * o.si, dims)
        return NotImplemented

    __rmul__ = __mul__

    def __truediv__(self, o):
        if _is_num(o):
            return Quantity(self.si / o, self.dims, self.unit, self.factor)
        if isinstance(o, Quantity):
            dims = dict(self.dims)
            for k, v in o.dims.items():
                dims[k] = dims.get(k, 0) - v
            return self._build(self.si / o.si, dims)
        return NotImplemented

    def __rtruediv__(self, o):
        if _is_num(o):
            return self._build(o / self.si, {k: -v for k, v in self.dims.items()})
        return NotImplemented

    def __pow__(self, n):
        if type(n) is not int:
            raise TamasError("a quantity can only be raised to a whole-number power")
        return self._build(self.si ** n, {k: v * n for k, v in self.dims.items()})

    def root(self):
        if any(v % 2 for v in self.dims.values()):
            raise TamasError(f"cannot take the square root of {self.unit}")
        return self._build(math.sqrt(self.si), {k: v // 2 for k, v in self.dims.items()})

    def __eq__(self, o):
        return isinstance(o, Quantity) and o.dims == self.dims and math.isclose(self.si, o.si, rel_tol=1e-12)

    def __hash__(self):
        return hash((round(self.si, 9), tuple(sorted(self.dims.items()))))

    def __lt__(self, o):
        self._same(o, "compare")
        return self.si < o.si

    def __le__(self, o):
        self._same(o, "compare")
        return self.si <= o.si

    def __gt__(self, o):
        self._same(o, "compare")
        return self.si > o.si

    def __ge__(self, o):
        self._same(o, "compare")
        return self.si >= o.si

    def __str__(self):
        return f"{fnum(self.value)} {self.unit}"

    __repr__ = __str__
