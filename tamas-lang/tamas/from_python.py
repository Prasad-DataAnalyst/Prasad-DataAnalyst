"""Convert a subset of Python into Tamas. Anything outside the subset is refused, never guessed."""
import ast

from .bridges import quote
from .errors import TamasError
from .lexer import KEYWORDS

_BIN = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/", ast.Mod: "%", ast.Pow: "^"}
_CMP = {ast.Eq: "=", ast.NotEq: "!=", ast.Lt: "<", ast.Gt: ">", ast.LtE: "<=", ast.GtE: ">="}
_CALLS = {"str": "text", "int": "whole", "float": "number", "sorted": "sort"}
_SAME = {"len", "sum", "min", "max", "abs", "round", "range"}


class _Converter:
    def __init__(self):
        self.out = []

    def no(self, node, what=None):
        what = what or type(node).__name__
        raise TamasError(f"Python feature not supported by the converter yet: {what}", getattr(node, "lineno", None))

    def name(self, n):
        return n + "_" if n in KEYWORDS else n

    def emit(self, depth, text):
        self.out.append("  " * depth + text)

    # -- statements
    def body(self, stmts, depth):
        for s in stmts:
            self.stmt(s, depth)

    def stmt(self, s, d):
        if isinstance(s, ast.Assign):
            if len(s.targets) != 1:
                self.no(s, "chained assignment")
            self.emit(d, f"{self.target(s.targets[0])}: {self.expr(s.value)}")
        elif isinstance(s, ast.AugAssign):
            if type(s.op) not in _BIN:
                self.no(s, "this augmented assignment")
            t = self.target(s.target)
            self.emit(d, f"{t}: {t} {_BIN[type(s.op)]} {self.sub(s.value)}")
        elif isinstance(s, ast.FunctionDef):
            a = s.args
            if a.defaults or a.vararg or a.kwarg or a.kwonlyargs or a.posonlyargs or s.decorator_list:
                self.no(s, "default arguments, *args, **kwargs or decorators")
            self.emit(d, f"{self.name(s.name)}({', '.join(self.name(x.arg) for x in a.args)}) -> {{")
            self.body(s.body, d + 1)
            self.emit(d, "}")
        elif isinstance(s, ast.Return):
            self.emit(d, "give" + (f" {self.expr(s.value)}" if s.value else ""))
        elif isinstance(s, ast.If):
            self.if_(s, d, "when")
        elif isinstance(s, ast.While):
            if s.orelse:
                self.no(s, "while/else")
            self.emit(d, f"loop {self.cond(s.test)} {{")
            self.body(s.body, d + 1)
            self.emit(d, "}")
        elif isinstance(s, ast.For):
            if s.orelse:
                self.no(s, "for/else")
            self.for_(s, d)
        elif isinstance(s, ast.Break):
            self.emit(d, "stop")
        elif isinstance(s, ast.Continue):
            self.emit(d, "skip")
        elif isinstance(s, ast.Pass):
            pass
        elif isinstance(s, ast.Expr):
            v = s.value
            if isinstance(v, ast.Call) and isinstance(v.func, ast.Name) and v.func.id == "print":
                if v.keywords:
                    self.no(s, "print() with keyword arguments")
                self.emit(d, "show " + (", ".join(self.expr(a) for a in v.args) or '""'))
            elif isinstance(v, ast.Constant) and isinstance(v.value, str):
                for line in v.value.strip().splitlines():
                    self.emit(d, "~ " + line.strip())
            else:
                self.emit(d, self.expr(v))
        else:
            self.no(s)

    def if_(self, s, d, head):
        self.emit(d, f"{head} {self.cond(s.test)} {{")
        self.body(s.body, d + 1)
        if len(s.orelse) == 1 and isinstance(s.orelse[0], ast.If):
            self.if_(s.orelse[0], d, "} else when")
            return
        if s.orelse:
            self.emit(d, "} else {")
            self.body(s.orelse, d + 1)
        self.emit(d, "}")

    def for_(self, s, d):
        t, it = s.target, s.iter
        pair = isinstance(t, ast.Tuple) and len(t.elts) == 2 and all(isinstance(x, ast.Name) for x in t.elts)
        if isinstance(t, ast.Name):
            head = f"each {self.name(t.id)} in {self.expr(it)}"
        elif pair and isinstance(it, ast.Call) and not it.keywords and len(it.args) == 1 and \
                isinstance(it.func, ast.Name) and it.func.id == "enumerate":
            head = f"each {self.name(t.elts[0].id)}, {self.name(t.elts[1].id)} in {self.expr(it.args[0])}"
        elif pair and isinstance(it, ast.Call) and not it.args and isinstance(it.func, ast.Attribute) \
                and it.func.attr == "items":
            head = f"each {self.name(t.elts[0].id)}, {self.name(t.elts[1].id)} in {self.expr(it.func.value)}"
        else:
            self.no(s, "this form of 'for' loop")
        self.emit(d, head + " {")
        self.body(s.body, d + 1)
        self.emit(d, "}")

    def target(self, t):
        if isinstance(t, ast.Name):
            return self.name(t.id)
        if isinstance(t, ast.Subscript):
            return self.expr(t)
        self.no(t, "this assignment target")

    # -- expressions
    def cond(self, e):
        """Tamas conditions must be yes/no; wrap anything Python would have judged by 'truthiness'."""
        if isinstance(e, ast.BoolOp):
            op = " and " if isinstance(e.op, ast.And) else " or "
            return "(" + op.join(self.cond(v) for v in e.values) + ")"
        if isinstance(e, ast.UnaryOp) and isinstance(e.op, ast.Not):
            return f"not {self.cond(e.operand)}"
        if isinstance(e, ast.Compare) or (isinstance(e, ast.Constant) and isinstance(e.value, bool)):
            return self.expr(e)
        return f"truthy({self.expr(e)})"

    def sub(self, e):
        text = self.expr(e)
        simple = (ast.Constant, ast.Name, ast.Call, ast.Subscript, ast.Attribute, ast.List, ast.Dict, ast.JoinedStr)
        return text if isinstance(e, simple) and not text.startswith("-") else f"({text})"

    def expr(self, e):
        if isinstance(e, ast.Constant):
            v = e.value
            if v is None:
                return "nothing"
            if isinstance(v, bool):
                return "yes" if v else "no"
            if isinstance(v, str):
                return quote(v)
            if isinstance(v, (int, float)):
                return repr(v)
            self.no(e, f"constant {v!r}")
        if isinstance(e, ast.Name):
            return self.name(e.id)
        if isinstance(e, ast.BinOp):
            if isinstance(e.op, ast.FloorDiv):
                return f"floor({self.sub(e.left)} / {self.sub(e.right)})"
            if type(e.op) not in _BIN:
                self.no(e, "this operator")
            return f"{self.sub(e.left)} {_BIN[type(e.op)]} {self.sub(e.right)}"
        if isinstance(e, ast.UnaryOp):
            if isinstance(e.op, ast.USub):
                return f"-{self.sub(e.operand)}"
            if isinstance(e.op, ast.Not):
                return f"not {self.cond(e.operand)}"
            self.no(e, "this unary operator")
        if isinstance(e, ast.BoolOp):
            return self.cond(e)
        if isinstance(e, ast.Compare):
            parts, left = [], e.left
            for op, right in zip(e.ops, e.comparators):
                if isinstance(op, ast.In):
                    parts.append(f"has({self.expr(right)}, {self.expr(left)})")
                elif isinstance(op, ast.NotIn):
                    parts.append(f"not has({self.expr(right)}, {self.expr(left)})")
                elif type(op) in _CMP:
                    parts.append(f"{self.sub(left)} {_CMP[type(op)]} {self.sub(right)}")
                else:
                    self.no(e, "'is' comparison")
                left = right
            return parts[0] if len(parts) == 1 else "(" + " and ".join(parts) + ")"
        if isinstance(e, ast.Call):
            if e.keywords:
                self.no(e, "keyword arguments")
            args = [self.expr(a) for a in e.args]
            if isinstance(e.func, ast.Attribute):
                if e.func.attr == "append" and len(args) == 1:
                    return f"push({self.expr(e.func.value)}, {args[0]})"
                self.no(e, f"method .{e.func.attr}()")
            if isinstance(e.func, ast.Name):
                n = e.func.id
                if n == "print":
                    self.no(e, "print() used as a value")
                if n in _CALLS:
                    return f"{_CALLS[n]}({', '.join(args)})"
                return f"{n if n in _SAME else self.name(n)}({', '.join(args)})"
            return f"{self.sub(e.func)}({', '.join(args)})"
        if isinstance(e, ast.List):
            return "[" + ", ".join(self.expr(x) for x in e.elts) + "]"
        if isinstance(e, ast.Dict):
            pairs = []
            for k, v in zip(e.keys, e.values):
                if not (isinstance(k, ast.Constant) and isinstance(k.value, str)):
                    self.no(e, "dictionary keys that are not plain text")
                pairs.append(f"{quote(k.value)}: {self.expr(v)}")
            return "{" + ", ".join(pairs) + "}"
        if isinstance(e, ast.Subscript):
            if isinstance(e.slice, ast.Slice):
                self.no(e, "slices")
            return f"{self.sub(e.value)}[{self.expr(e.slice)}]"
        if isinstance(e, ast.Lambda):
            a = e.args
            if a.defaults or a.vararg or a.kwarg or a.kwonlyargs:
                self.no(e, "lambda with default or star arguments")
            return f"(({', '.join(self.name(x.arg) for x in a.args)}) -> {self.sub(e.body)})"
        if isinstance(e, ast.JoinedStr):
            out = []
            for part in e.values:
                if isinstance(part, ast.Constant):
                    out.append(quote(part.value)[1:-1])
                elif part.format_spec is None and part.conversion == -1:
                    inner = self.expr(part.value)
                    if '"' in inner or "{" in inner:
                        self.no(e, "text or records inside an f-string placeholder")
                    out.append("{" + inner + "}")
                else:
                    self.no(e, "f-string format specifiers")
            return '"' + "".join(out) + '"'
        self.no(e)


def python_to_tamas(source):
    try:
        tree = ast.parse(source)
    except SyntaxError as err:
        raise TamasError(f"this is not valid Python: {err.msg}", err.lineno)
    conv = _Converter()
    conv.body(tree.body, 0)
    return "\n".join(conv.out) + "\n"
