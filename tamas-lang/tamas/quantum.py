"""The 'quantum' library: quantum circuits as plain data, and an exact state-vector simulator for them.

A circuit is the record {qubits: n, ops: [{gate, qubits, angle}, ...]}. Qubit 0 is the leftmost
character of every bit string ("10" means qubit 0 is 1 and qubit 1 is 0).
"""
import cmath
import math
import random
import re

from .errors import TamasError

MAX_QUBITS = 20
_R = math.sqrt(0.5)
_FIXED = {
    "h": ((_R, _R), (_R, -_R)), "x": ((0, 1), (1, 0)), "y": ((0, -1j), (1j, 0)), "z": ((1, 0), (0, -1)),
    "s": ((1, 0), (0, 1j)), "sdg": ((1, 0), (0, -1j)),
    "t": ((1, 0), (0, cmath.exp(0.25j * math.pi))), "tdg": ((1, 0), (0, cmath.exp(-0.25j * math.pi))),
}
# gate -> (number of qubits, takes an angle); 0 qubits means "any number, given as a list"
_SHAPE = {**{g: (1, False) for g in _FIXED}, "rx": (1, True), "ry": (1, True), "rz": (1, True), "phase": (1, True),
          "cx": (2, False), "cy": (2, False), "cz": (2, False), "cp": (2, True), "swap": (2, False),
          "ccx": (3, False), "mcx": (0, False), "mcz": (0, False)}


def _matrix(gate, angle):
    if gate in _FIXED:
        return _FIXED[gate]
    c, s = math.cos(angle / 2), math.sin(angle / 2)
    if gate == "rx":
        return ((c, -1j * s), (-1j * s, c))
    if gate == "ry":
        return ((c, -s), (s, c))
    if gate == "rz":
        return ((cmath.exp(-0.5j * angle), 0), (0, cmath.exp(0.5j * angle)))
    return ((1, 0), (0, cmath.exp(1j * angle)))  # phase


def circuit(qubits):
    if type(qubits) is not int or not 1 <= qubits <= MAX_QUBITS:
        raise TamasError(f"a circuit needs between 1 and {MAX_QUBITS} qubits (this simulator keeps 2^n numbers in memory)")
    return {"qubits": qubits, "ops": []}


def _check(c):
    if not (isinstance(c, dict) and type(c.get("qubits")) is int and isinstance(c.get("ops"), list)):
        raise TamasError("expected a quantum circuit (make one with circuit(n))")
    if not 1 <= c["qubits"] <= MAX_QUBITS:
        raise TamasError(f"a circuit needs between 1 and {MAX_QUBITS} qubits")
    return c


def _add(c, gate, qubits, angle=None):
    n = _check(c)["qubits"]
    for q in qubits:
        if type(q) is not int or not 0 <= q < n:
            raise TamasError(f"gate {gate}: there is no qubit {q!r} in a {n}-qubit circuit (they are numbered 0 to {n - 1})")
    if len(set(qubits)) != len(qubits) or not qubits:
        raise TamasError(f"gate {gate} needs different qubits, got {list(qubits)}")
    op = {"gate": gate, "qubits": list(qubits)}
    if angle is not None:
        if type(angle) not in (int, float):
            raise TamasError(f"gate {gate} needs an angle in radians (write 90 deg for a quarter turn)")
        op["angle"] = angle
    c["ops"].append(op)
    return c


def _gate_fn(gate):
    count, angled = _SHAPE[gate]
    if count == 0:
        if gate == "mcx":
            return lambda c, controls, target: _add(c, gate, list(controls) + [target])
        return lambda c, qubits: _add(c, gate, list(qubits))
    if angled:
        if count == 1:
            return lambda c, qubit, angle: _add(c, gate, [qubit], angle)
        return lambda c, control, target, angle: _add(c, gate, [control, target], angle)
    if count == 1:
        return lambda c, qubit: _add(c, gate, [qubit])
    if count == 2:
        return lambda c, a, b: _add(c, gate, [a, b])
    return lambda c, a, b, target: _add(c, gate, [a, b, target])


def _apply(state, n, m, target, controls=()):
    tbit = 1 << (n - 1 - target)
    cmask = sum(1 << (n - 1 - q) for q in controls)
    (a, b), (c, d) = m
    for i in range(len(state)):
        if not i & tbit and i & cmask == cmask:
            j = i | tbit
            x, y = state[i], state[j]
            state[i], state[j] = a * x + b * y, c * x + d * y


def simulate(c):
    n = _check(c)["qubits"]
    state = [0j] * (1 << n)
    state[0] = 1 + 0j
    for op in c["ops"]:
        gate, qs = op.get("gate"), op.get("qubits")
        if gate not in _SHAPE or not isinstance(qs, list) or (_SHAPE[gate][0] and len(qs) != _SHAPE[gate][0]):
            raise TamasError(f"the circuit contains something that is not a known gate: {op!r}")
        if any(type(q) is not int or not 0 <= q < n for q in qs) or len(set(qs)) != len(qs):
            raise TamasError(f"gate {gate} is applied to qubits that do not exist: {qs}")
        angle = op.get("angle", 0)
        if gate == "swap":
            for k in ((qs[0], qs[1]), (qs[1], qs[0]), (qs[0], qs[1])):
                _apply(state, n, _FIXED["x"], k[1], [k[0]])
        elif gate in ("cx", "ccx", "mcx"):
            _apply(state, n, _FIXED["x"], qs[-1], qs[:-1])
        elif gate == "cy":
            _apply(state, n, _FIXED["y"], qs[1], qs[:1])
        elif gate in ("cz", "mcz"):
            _apply(state, n, _FIXED["z"], qs[-1], qs[:-1])
        elif gate == "cp":
            _apply(state, n, _matrix("phase", angle), qs[1], qs[:1])
        else:
            _apply(state, n, _matrix(gate, angle), qs[0])
    return state, n


def _clean(x):
    return 0 if abs(x) < 1e-12 else round(x, 12)


def _bits(i, n):
    return format(i, f"0{n}b")


def run(c):
    state, n = simulate(c)
    return {"qubits": n, "amplitudes": [[_clean(a.real), _clean(a.imag)] for a in state]}


def probabilities(c):
    state, n = simulate(c)
    return {_bits(i, n): _clean(abs(a) ** 2) for i, a in enumerate(state) if abs(a) ** 2 > 1e-12}


def most_likely(c):
    state, n = simulate(c)
    return _bits(max(range(len(state)), key=lambda i: abs(state[i]) ** 2), n)


def sample(c, shots, seed):
    state, n = simulate(c)
    if type(shots) is not int or shots < 1:
        raise TamasError("sample needs a whole number of shots, at least 1")
    picks = random.Random(seed).choices(range(len(state)), weights=[abs(a) ** 2 for a in state], k=shots)
    counts = {}
    for i in sorted(picks):
        counts[_bits(i, n)] = counts.get(_bits(i, n), 0) + 1
    return counts


def expect(c, paulis):
    """Average value of a measurement such as "ZZI": one of I, X, Y, Z per qubit."""
    state, n = simulate(c)
    if not isinstance(paulis, str) or len(paulis) != n or set(paulis.upper()) - set("IXYZ"):
        raise TamasError(f"expect needs {n} letters from I, X, Y, Z - one per qubit - such as \"{'Z' * n}\"")
    other = list(state)
    for q, p in enumerate(paulis.upper()):
        if p != "I":
            _apply(other, n, _FIXED[p.lower()], q)
    return _clean(sum((a.conjugate() * b).real for a, b in zip(state, other)))


def bloch(c, qubit):
    """Where one qubit points on the Bloch sphere: [x, y, z]."""
    n = _check(c)["qubits"]
    if type(qubit) is not int or not 0 <= qubit < n:
        raise TamasError(f"there is no qubit {qubit!r} in this circuit")
    return [expect(c, "I" * qubit + p + "I" * (n - qubit - 1)) for p in "XYZ"]


def fidelity(a, b):
    """How alike the final states of two circuits are, from 0 to 1."""
    sa, na = simulate(a)
    sb, nb = simulate(b)
    if na != nb:
        raise TamasError("the two circuits have different numbers of qubits")
    return _clean(abs(sum(x.conjugate() * y for x, y in zip(sa, sb))) ** 2)


def depth(c):
    busy = [0] * _check(c)["qubits"]
    for op in c["ops"]:
        layer = max(busy[q] for q in op["qubits"]) + 1
        for q in op["qubits"]:
            busy[q] = layer
    return max(busy)


def counts(c):
    out = {}
    for op in _check(c)["ops"]:
        out[op["gate"]] = out.get(op["gate"], 0) + 1
    return out


def draw(c):
    n = _check(c)["qubits"]
    rows = [[f"q{q}: "] for q in range(n)]
    width = max(len(r[0]) for r in rows)
    rows = [[r[0].ljust(width)] for r in rows]
    for op in c["ops"]:
        gate, qs = op["gate"], op["qubits"]
        cells = {}
        if gate == "swap":
            cells = {q: "x" for q in qs}
        elif gate in ("cx", "ccx", "mcx", "cy", "cz", "cp"):
            cells = {q: "●" for q in qs[:-1]}
            cells[qs[-1]] = {"cx": "X", "ccx": "X", "mcx": "X", "cy": "Y", "cz": "Z", "cp": "P"}[gate]
        elif gate == "mcz":
            cells = {q: "●" for q in qs}
        else:
            cells[qs[0]] = gate.upper() if gate in _FIXED else gate.upper() if gate != "phase" else "P"
        size = max(len(v) for v in cells.values())
        for q in range(n):
            mark = cells.get(q, "│" if min(qs) < q < max(qs) else "─")
            rows[q].append("─" + mark.center(size, "─") + "─")
    return "\n".join("".join(r) for r in rows)


# ---- OpenQASM 2.0, the common exchange format for real quantum computers ------------

_QASM = {"phase": "u1", "cp": "cu1"}


def to_qasm(c):
    n = _check(c)["qubits"]
    lines = ["OPENQASM 2.0;", 'include "qelib1.inc";', f"qreg q[{n}];", f"creg c[{n}];"]
    for op in c["ops"]:
        gate, qs = op["gate"], op["qubits"]
        if gate in ("mcx", "mcz"):
            if len(qs) > 3 or (gate == "mcz" and len(qs) == 1):
                if len(qs) == 1:
                    gate = "z"
                else:
                    raise TamasError(f"a {gate} gate on {len(qs)} qubits has no standard OpenQASM 2 gate; split it into smaller gates first")
            elif gate == "mcx":
                gate = {1: "x", 2: "cx", 3: "ccx"}[len(qs)]
            elif len(qs) == 2:
                gate = "cz"
            else:
                lines += [f"h q[{qs[2]}];", f"ccx q[{qs[0]}],q[{qs[1]}],q[{qs[2]}];", f"h q[{qs[2]}];"]
                continue
        name = _QASM.get(gate, gate) + (f"({op['angle']!r})" if "angle" in op else "")
        lines.append(f"{name} {','.join(f'q[{q}]' for q in qs)};")
    lines.append("measure q -> c;")
    return "\n".join(lines) + "\n"


def _angle(text):
    value, op = None, "*"
    for piece in re.findall(r"[*/]|[^*/]+", text.replace(" ", "")):
        if piece in "*/":
            op = piece
            continue
        sign = -1 if piece.startswith("-") else 1
        piece = piece.lstrip("+-")
        try:
            x = sign * (math.pi if piece == "pi" else float(piece))
        except ValueError:
            raise TamasError(f"OpenQASM: cannot read the angle '{text}'")
        value = x if value is None else value * x if op == "*" else value / x
    if value is None:
        raise TamasError("OpenQASM: a gate is missing its angle")
    return value


def from_qasm(text):
    c, names = None, {v: k for k, v in _QASM.items()}
    names.update({"p": "phase", "cu1": "cp"})
    for raw in re.sub(r"//[^\n]*", "", text).split(";"):
        stmt = " ".join(raw.split())
        if not stmt or stmt.startswith(("OPENQASM", "include", "creg", "measure", "barrier")):
            continue
        m = re.match(r"qreg (\w+)\[(\d+)\]$", stmt)
        if m:
            if c is not None:
                raise TamasError("OpenQASM: only one qreg is supported")
            c = circuit(int(m.group(2)))
            continue
        m = re.match(r"(\w+)\s*(?:\(([^)]*)\))?\s*(.+)$", stmt)
        if not m or c is None:
            raise TamasError(f"OpenQASM: cannot understand '{stmt}'")
        gate = names.get(m.group(1), m.group(1))
        if gate not in _SHAPE or gate in ("mcx", "mcz"):
            raise TamasError(f"OpenQASM: the gate '{m.group(1)}' is not supported")
        qubits = [int(q) for q in re.findall(r"\w+\[(\d+)\]", m.group(3))]
        if len(qubits) != _SHAPE[gate][0] or (m.group(2) is not None) != _SHAPE[gate][1]:
            raise TamasError(f"OpenQASM: '{stmt}' has the wrong number of qubits or angles")
        _add(c, gate, qubits, _angle(m.group(2)) if m.group(2) is not None else None)
    if c is None:
        raise TamasError("OpenQASM: there is no qreg line")
    return c


LIBRARY = {
    "circuit": circuit, "run": run, "probabilities": probabilities, "most_likely": most_likely, "sample": sample,
    "expect": expect, "bloch": bloch, "fidelity": fidelity, "depth": depth, "counts": counts, "draw": draw,
    "to_qasm": to_qasm, "from_qasm": from_qasm, "gates": sorted(_SHAPE), "max_qubits": MAX_QUBITS,
    **{g: _gate_fn(g) for g in _SHAPE},
}
