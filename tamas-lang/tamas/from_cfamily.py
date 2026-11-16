"""JavaScript -> Tamas and Java -> Tamas. Exact for the supported subset; everything else is refused."""
from .bridges import key_text, quote
from .cfamily import NAMES, P, inner
from .errors import TamasError
from .lexer import KEYWORDS

# Tamas built-ins the converter itself emits; a user name that clashes gets a trailing underscore.
_EMITTED = {"len", "map", "filter", "fold", "range", "push", "has", "join", "split", "floor", "abs", "sqrt",
            "max", "min", "whole", "div", "rem", "text", "upper", "lower", "trim", "show"}
_NUMERIC = ("int", "double", "num")
_JS_BUILTIN_METHODS = {
    "pop", "shift", "unshift", "splice", "slice", "sort", "reverse", "indexOf", "lastIndexOf", "concat", "forEach",
    "find", "findIndex", "some", "every", "keys", "values", "entries", "toString", "toFixed", "charAt", "charCodeAt",
    "substring", "substr", "replace", "replaceAll", "startsWith", "endsWith", "repeat", "padStart", "padEnd", "flat",
    "flatMap", "fill", "at", "match", "test", "then", "catch", "bind", "call", "apply", "push"}
_CONSTANTS = {("Math", "PI"): ("3.141592653589793", "double"), ("Math", "E"): ("2.718281828459045", "double"),
              ("Integer", "MAX_VALUE"): ("2147483647", "int"), ("Integer", "MIN_VALUE"): ("-2147483648", "int")}


def _walk(node):
    if isinstance(node, tuple):
        yield node
    if isinstance(node, (tuple, list)):
        for child in node:
            yield from _walk(child)


def _assigned(body, name):
    return any(n[0] in ("assign", "incdec") and n[-2 if n[0] == "assign" else -1][0] == "id"
               and n[-2 if n[0] == "assign" else -1][2] == name for n in _walk(body) if n and isinstance(n[0], str))


def _surely_text(e, name):
    """Is this JavaScript expression text no matter what its variables hold?"""
    k = e[0]
    if k in ("str", "tpl") or (k == "id" and e[2] == name):
        return True
    if k == "bin" and e[2] == "+":
        return _surely_text(e[3], name) or _surely_text(e[4], name)
    if k == "cond":
        return _surely_text(e[3], name) and _surely_text(e[4], name)
    if k == "call" and e[2][0] == "member":
        return e[2][3] in ("join", "toUpperCase", "toLowerCase", "trim")
    return k == "call" and e[2][0] == "id" and e[2][2] == "String"


def _stays_text(body, name):
    """True if every assignment to `name` in this function keeps it text."""
    for n in _walk(body):
        if n and n[0] == "assign" and isinstance(n[3], tuple) and n[3][0] == "id" and n[3][2] == name:
            if n[2] != "+=" and not (n[2] == "=" and _surely_text(n[4], name)):
                return False
        if n and n[0] == "incdec" and isinstance(n[-1], tuple) and n[-1][0] == "id" and n[-1][2] == name:
            return False
    return True


def _has_continue(stmts):
    for s in stmts:
        if s[0] == "continue":
            return True
        if s[0] == "if" and (_has_continue(s[3]) or (s[4] and _has_continue(s[4]))):
            return True
        if s[0] == "block" and _has_continue(s[2]):
            return True
    return False


def _only_read_safely(node, name):
    """True if `name` (a list) is only indexed or asked for its size inside node - never changed or passed on."""
    if isinstance(node, list):
        return all(_only_read_safely(c, name) for c in node)
    if not isinstance(node, tuple) or not node or not isinstance(node[0], str):
        return True
    kind = node[0]
    is_it = lambda e: isinstance(e, tuple) and e[0] == "id" and e[2] == name  # noqa: E731
    if kind == "id":
        return node[2] != name
    if kind == "index" and is_it(node[2]):
        return _only_read_safely(node[3], name)
    if kind == "member" and is_it(node[2]) and node[3] == "length":
        return True
    if kind == "call" and node[2][0] == "member" and is_it(node[2][2]) and node[2][3] in ("get", "size", "length"):
        return _only_read_safely(node[3], name)
    return all(_only_read_safely(c, name) for c in node[2:])


class Conv:
    def __init__(self, dialect):
        self.d, self.java, self.lang = dialect, dialect == "java", NAMES[dialect]
        self.out, self.depth, self.ctxs, self.methods, self.cls = [], 0, [], {}, None
        self.inline_ok = False

    # -- plumbing
    def no(self, what, line):
        raise TamasError(f"{self.lang} feature not supported by the converter yet: {what}", line)

    def emit(self, text):
        self.out.append("  " * self.depth + text)

    def name(self, n, line=None):
        if "$" in n:
            self.no(f"the name '{n}' ('$' cannot be used in Tamas names)", line)
        return n + "_" if n in KEYWORDS or n in _EMITTED else n

    @property
    def ctx(self):
        return self.ctxs[-1]

    def push_fn(self):
        self.ctxs.append({"scopes": [{}], "loops": 0, "ever": set(), "outer_reads": set(), "body": []})

    def declare(self, name, typ, line, function_wide=False):
        ctx = self.ctx
        scopes = ctx["scopes"]
        target = scopes[0] if function_wide else scopes[-1]
        for s in scopes:
            if s is not target and name in s:
                self.no(f"'{name}' declared again inside an inner block (Tamas names belong to the whole function)", line)
        if name in ctx["outer_reads"]:
            self.no(f"'{name}' is used with two different meanings in one function", line)
        target[name] = typ
        ctx["ever"].add(name)

    def lookup(self, name):
        for depth, ctx in enumerate(reversed(self.ctxs)):
            for s in reversed(ctx["scopes"]):
                if name in s:
                    return ("local" if depth == 0 else "outer"), s
        return None

    # -- whole programs
    def js(self, stmts):
        self.push_fn()
        self.ctx["body"] = stmts
        self.block(stmts, scope=False)
        return "\n".join(self.out) + "\n"

    def java_program(self, unit):
        self.cls, fields, methods = unit
        self.push_fn()
        for m in methods:
            if m[2] in self.methods:
                self.no(f"overloaded methods ('{m[2]}' is defined more than once)", m[1])
            self.methods[m[2]] = m[5]
        for f in fields:
            self.decl(f, field=True)
        main = None
        for m in methods:
            if m[2] == "main":
                main = m
            self.func(m)
        if main is not None:
            self.emit("main([])")
        return "\n".join(self.out) + "\n"

    # -- statements
    def block(self, stmts, scope=True):
        if scope:
            self.ctx["scopes"].append({})
        funcs = [s for s in stmts if s[0] == "func"]
        for f in funcs:
            self.declare(f[2], "fn", f[1])
        saved, self.out = self.out, []
        for s in stmts:
            if s[0] != "func":
                self.stmt(s)
        rest, self.out = self.out, saved
        for f in funcs:  # functions first, as the source language allows calling them before their definition
            self.func(f)
        self.out.extend(rest)
        if scope:
            self.ctx["scopes"].pop()

    def func(self, s):
        _, line, name, params, body, _ret = s
        if self.ctx["loops"]:
            self.no("a function declared inside a loop", line)
        self.emit(f"{self.name(name, line)}({', '.join(self.name(p[0], line) for p in params)}) -> {{")
        self.fn_body(params, body, line)
        self.emit("}")

    def fn_body(self, params, body, line):
        self.push_fn()
        for p in params:
            self.declare(p[0], p[1] or "unknown", line)
        self.ctx["body"] = body
        self.depth += 1
        self.block(body)
        self.depth -= 1
        self.ctxs.pop()

    def stmt(self, s):
        kind, line = s[0], s[1]
        if kind == "empty":
            return
        if kind == "block":
            self.block(s[2])
        elif kind == "decl":
            self.decl(s)
        elif kind == "expr":
            self.expr_stmt(s[2])
        elif kind == "if":
            self.if_(s, "when")
        elif kind == "while":
            self.emit(f"loop {self.cond(s[2])} {{")
            self.loop_body(s[3])
            self.emit("}")
        elif kind == "for":
            self.for_(s)
        elif kind == "foreach":
            _, _, name, typ, it, body = s
            text, t, _ = self.ex(it)
            self.ctx["scopes"].append({})
            self.declare(name, typ or inner(t), line)
            self.emit(f"each {self.name(name, line)} in {text} {{")
            self.loop_body(body)
            self.emit("}")
            self.ctx["scopes"].pop()
        elif kind == "return":
            if len(self.ctxs) == 1:
                self.no("return outside a function", line)
            if s[2] is None:
                self.emit("give")
            elif s[2][0] == "cond":
                self.choose(s[2], lambda text, t: self.emit(f"give {text}"))
            else:
                self.emit(f"give {self.ex(s[2])[0]}")
        elif kind == "break":
            self.emit("stop")
        elif kind == "continue":
            self.emit("skip")
        else:
            self.no(kind, line)

    def loop_body(self, body, tail=()):
        self.ctx["loops"] += 1
        self.depth += 1
        self.block(body)
        for t in tail:
            self.expr_stmt(t)
        self.depth -= 1
        self.ctx["loops"] -= 1

    def if_(self, s, head):
        self.emit(f"{head} {self.cond(s[2])} {{")
        self.depth += 1
        self.block(s[3])
        self.depth -= 1
        other = s[4]
        if other and len(other) == 1 and other[0][0] == "if":
            self.if_(other[0], "} else when")
            return
        if other:
            self.emit("} else {")
            self.depth += 1
            self.block(other)
            self.depth -= 1
        self.emit("}")

    def choose(self, e, use):
        """a ? b : c in a statement position becomes when / else."""
        _, line, c, a, b = e
        self.emit(f"when {self.cond(c)} {{")
        for i, branch in enumerate((a, b)):
            self.depth += 1
            if branch[0] == "cond":
                self.choose(branch, use)
            else:
                text, t, _ = self.ex(branch)
                use(text, t)
            self.depth -= 1
            self.emit("} else {" if i == 0 else "}")

    def decl(self, s, field=False):
        _, line, kind, entries = s
        if self.java and kind.replace("list<", "").rstrip(">").startswith("?"):
            self.no(f"the type {kind.replace('list<', '').rstrip('>')[1:]}", line)
        for name, _, init in entries:
            declared = kind if self.java and kind != "var" else None
            wide = kind == "var" and not self.java
            if init is None:
                if self.java and not field:
                    self.declare(name, declared, line)
                    continue
                if self.java and kind == "var":
                    self.no("'var' without a value", line)
                default = {"int": "0", "double": "0", "bool": "no"}.get(declared, "nothing")
                self.declare(name, declared or "unknown", line, wide)
                self.emit(f"{self.name(name, line)}: {default}")
            elif init[0] == "cond":
                seen = []

                def use(text, t, name=name):
                    seen.append(t)
                    self.emit(f"{self.name(name, line)}: {text}")
                self.choose(init, use)
                self.declare(name, declared or (seen[0] if len(set(seen)) == 1 else "unknown"), line, wide)
            else:
                if init[0] == "fn":  # so the function can call itself
                    self.declare(name, "fn", line, wide)
                text, t, _ = self.ex(init)
                if t == "text" and not self.java and not _stays_text(self.ctx["body"], name):
                    t = "unknown"
                self.check_value(declared, t, line)
                self.declare(name, declared or t, line, wide)
                self.emit(f"{self.name(name, line)}: {text}")

    def check_value(self, declared, t, line):
        if declared == "int" and t == "double":
            self.no("storing a decimal value in a whole-number variable", line)

    def local(self, name, line):
        found = self.lookup(name)
        if found is None:
            self.no(f"assigning to '{name}', which was never declared", line)
        if found[0] == "outer":
            self.no(f"changing the outer variable '{name}' from inside a function "
                    "(Tamas functions cannot rebind outer names; keep the value in a list or record)", line)
        return found[1]

    def set_name(self, name, text, t, line):
        scope = self.local(name, line)
        old = scope[name]
        if self.java:
            self.check_value(old, t, line)
        else:
            scope[name] = old if old in (t, "text") else "unknown"  # text was proven to stay text when declared
        self.emit(f"{self.name(name, line)}: {text}")

    def target(self, t):
        if t[0] == "id":
            self.local(t[2], t[1])
            return self.name(t[2], t[1])
        text = self.ex(t)[0]
        if t[0] == "member" and self.java:
            self.no("assigning to a field of an object", t[1])
        return text

    def expr_stmt(self, e):
        kind, line = e[0], e[1]
        if kind == "assign":
            _, _, op, tgt, value = e
            if op != "=":
                value = ("bin", line, op[:-1], tgt, value)
            if tgt[0] == "id":
                if value[0] == "cond":
                    self.choose(value, lambda text, t: self.set_name(tgt[2], text, t, line))
                else:
                    text, t, _ = self.ex(value)
                    self.set_name(tgt[2], text, t, line)
            else:
                left = self.target(tgt)
                if "(" in left and op != "=":
                    self.no("a compound assignment whose target contains a call", line)
                if value[0] == "cond":
                    self.choose(value, lambda text, t: self.emit(f"{left}: {text}"))
                else:
                    self.emit(f"{left}: {self.ex(value)[0]}")
        elif kind == "incdec":
            self.expr_stmt(("assign", line, "+=" if e[2] == "++" else "-=", e[3], ("num", line, 1)))
        elif kind == "call" and e[2][0] == "member":
            obj, m, args = e[2][2], e[2][3], e[3]
            is_global = lambda n: obj[0] == "id" and obj[2] == n and self.lookup(n) is None  # noqa: E731
            if not self.java and is_global("console") and m == "log":
                self.emit("show " + (", ".join(self.ex(a)[0] for a in args) or '""'))
            elif self.java and obj[0] == "member" and obj[3] == "out" and obj[2][0] == "id" and obj[2][2] == "System":
                if m != "println" or len(args) > 1:
                    self.no(f"System.out.{m} with these arguments (only println of one value)", line)
                self.emit("show " + (self.ex(args[0])[0] if args else '""'))
            elif not self.java and m == "push" and len(args) == 1:
                self.emit(f"push({self.ex(obj)[0]}, {self.ex(args[0])[0]})")
            elif self.java and m in ("add", "set") and self.ex(obj)[1].startswith("list<"):
                if m == "add" and len(args) == 1:
                    self.emit(f"push({self.ex(obj)[0]}, {self.ex(args[0])[0]})")
                elif m == "set" and len(args) == 2:
                    self.emit(f"{self.ex(obj)[0]}[{self.ex(args[0])[0]}]: {self.ex(args[1])[0]}")
                else:
                    self.no(f".{m}() with these arguments", line)
            else:
                self.emit(self.ex(e)[0])
        elif kind == "str" and not self.java:
            pass  # 'use strict'
        else:
            self.emit(self.ex(e)[0])

    def for_(self, s):
        _, line, init, cond, updates, body = s
        self.ctx["scopes"].append({})
        rng = self.range_form(init, cond, updates, body)
        if rng:
            name, text = rng
            self.declare(name, "int" if self.java else "num", line)
            self.emit(f"each {self.name(name, line)} in {text} {{")
            self.loop_body(body)
        else:
            if _has_continue(body):
                self.no("'continue' inside this kind of for loop (only simple counting loops may use it)", line)
            if init is not None:
                self.stmt(init)
            self.emit(f"loop {self.cond(cond) if cond is not None else 'yes'} {{")
            self.loop_body(body, updates)
        self.emit("}")
        self.ctx["scopes"].pop()

    def range_form(self, init, cond, updates, body):
        """for (let i = a; i < b; i++) with nothing disturbing i or b  ->  each i in range(a, b)."""
        if not (init and init[0] == "decl" and len(init[3]) == 1 and init[3][0][2] is not None and init[2] != "var"):
            return None
        if self.java and init[2] != "int":
            return None
        name, start = init[3][0][0], init[3][0][2]
        if not (cond and cond[0] == "bin" and cond[2] in ("<", "<=") and cond[3][0] == "id" and cond[3][2] == name):
            return None
        u = updates[0] if len(updates) == 1 else None
        one = lambda e: e[0] == "num" and e[2] == 1 and type(e[2]) is int  # noqa: E731
        step = u is not None and u[-1 if u[0] == "incdec" else -2][0] == "id" and u[-1 if u[0] == "incdec" else -2][2] == name and (
            (u[0] == "incdec" and u[2] == "++") or (u[0] == "assign" and u[2] == "+=" and one(u[4])))
        if not step or _assigned(body, name) or any(n[0] in ("fn", "func") for n in _walk(body) if n and isinstance(n[0], str)):
            return None
        bound = cond[4]
        if bound[0] == "num":
            stable = type(bound[2]) is int
        elif bound[0] == "id":
            stable = not _assigned(body, bound[2]) and bound[2] != name
        elif bound[0] == "member" and bound[3] == "length" and bound[2][0] == "id":
            stable = _only_read_safely(body, bound[2][2])
        elif bound[0] == "call" and not bound[3] and bound[2][0] == "member" and bound[2][3] in ("size", "length") \
                and bound[2][2][0] == "id":
            stable = _only_read_safely(body, bound[2][2][2])
        else:
            stable = False
        if not stable or not (start[0] in ("num", "id") and (start[0] != "num" or type(start[2]) is int)):
            return None
        a, ta, _ = self.ex(start)
        b, tb, _ = self.ex(bound)
        if self.java and not (ta == "int" and tb == "int"):
            return None
        if cond[2] == "<=":
            b = f"{b} + 1"
        return name, (f"range({b})" if a == "0" else f"range({a}, {b})")

    # -- expressions: each returns (text, kind of value, needs no brackets)
    def cond(self, e):
        text, t, _ = self.ex(e)
        if t not in ("bool", "unknown"):
            self.no("a condition that is not true/false (write an explicit comparison such as x !== 0)", e[1])
        return text

    def sub(self, e):
        text, t, tight = self.ex(e)
        return (text if tight else f"({text})"), t

    def template(self, parts, line):
        out = []
        for kind, value in parts:
            if kind == "lit":
                out.append(quote(value)[1:-1])
            else:
                if "{" in value or "}" in value:
                    self.no("building text from a value that contains { }", line)
                out.append("{" + value + "}")
        return '"' + "".join(out) + '"'

    def text_parts(self, e):
        if e[0] == "str":
            return [("lit", e[2])]
        if e[0] == "tpl":
            return [("lit", p) if isinstance(p, str) else ("ex", self.ex(p)[0]) for p in e[2]]
        if e[0] == "bin" and e[2] == "+":
            ta, tb = self.ex(e[3])[1], self.ex(e[4])[1]
            if "text" in (ta, tb):
                left = self.text_parts(e[3]) if ta == "text" else [("ex", self.ex(e[3])[0])]
                right = self.text_parts(e[4]) if tb == "text" else [("ex", self.ex(e[4])[0])]
                return left + right
        return [("ex", self.ex(e)[0])]

    def ex(self, e):
        kind, line = e[0], e[1]
        if kind == "num":
            v = e[2]
            return repr(v), ("num" if not self.java else "int" if type(v) is int else "double"), True
        if kind == "str":
            return quote(e[2]), "text", True
        if kind == "tpl":
            return self.template(self.text_parts(e), line), "text", True
        if kind == "bool":
            return ("yes" if e[2] else "no"), "bool", True
        if kind == "null":
            return "nothing", "null", True
        if kind == "id":
            n = e[2]
            found = self.lookup(n)
            if found is None:
                hint = " (JavaScript's undefined has no Tamas equivalent; use null)" if n == "undefined" else ""
                self.no(f"the name '{n}', which is not defined in this file{hint}", line)
            if found[0] == "outer":
                if n in self.ctx["ever"]:
                    self.no(f"'{n}' is used with two different meanings in one function", line)
                self.ctx["outer_reads"].add(n)
            return self.name(n, line), found[1][n] or "unknown", True
        if kind == "arr":
            items = [self.ex(x) for x in e[2]]
            t = f"list<{items[0][1] if items else 'unknown'}>" if self.java else "list"
            return "[" + ", ".join(x[0] for x in items) + "]", t, True
        if kind == "obj":
            return "{" + ", ".join(f"{key_text(k)}: {self.ex(v)[0]}" for k, v in e[2]) + "}", "obj", True
        if kind == "fn":
            return self.lam(e)
        if kind == "call":
            return self.call(e)
        if kind == "member":
            return self.member(e)
        if kind == "index":
            obj, t = self.sub(e[2])
            if self.java and not t.startswith("list<"):
                self.no("indexing something that is not an array", line)
            return f"{obj}[{self.ex(e[3])[0]}]", inner(t), True
        if kind == "un":
            text, t = self.sub(e[3])
            if e[2] == "!":
                if t not in ("bool", "unknown"):
                    self.no("'!' on a value that is not true/false", line)
                return f"not {text}", "bool", False
            return f"-{text}", (t if t in _NUMERIC else "unknown"), False
        if kind == "bin":
            return self.bin(e)
        if kind == "cast":
            text, t, tight = self.ex(e[3])
            if e[2] == "int":
                return (text, "int", tight) if t == "int" else (f"whole({text})", "int", True)
            return text, "double", tight
        if kind == "new":
            return self.new(e)
        if kind == "cond":
            self.no("'? :' inside a larger expression (use it directly in an assignment or return)", line)
        if kind in ("assign", "incdec"):
            self.no("an assignment used as a value", line)
        self.no(kind, line)

    def lam(self, e):
        _, line, params, body = e
        if self.ctx["loops"] and not self.inline_ok:
            self.no("a function created inside a loop", line)
        self.inline_ok = False
        names = [self.name(p[0], line) for p in params]
        head = names[0] if len(names) == 1 else f"({', '.join(names)})"
        if isinstance(body, tuple) and body[2][0] == "cond":
            body = [("return", line, body[2])]  # x => a ? b : c  becomes a small block
        if isinstance(body, tuple):
            self.push_fn()
            for p in params:
                self.declare(p[0], "unknown", line)
            text = self.ex(body[2])[0]
            self.ctxs.pop()
            return f"{head} -> {f'({text})' if text.startswith('{') else text}", "fn", False
        saved, self.out = self.out, []
        self.fn_body(params, body, line)
        lines, self.out = self.out, saved
        return head + " -> {\n" + "\n".join(lines) + ("\n" if lines else "") + "  " * self.depth + "}", "fn", False

    def bin(self, e):
        _, line, op, ea, eb = e
        if op == "+":
            ta, tb = self.ex(ea)[1], self.ex(eb)[1]
            if "text" in (ta, tb):
                return self.template(self.text_parts(e), line), "text", True
            if self.java and not (ta in _NUMERIC and tb in _NUMERIC):
                self.no("'+' where the converter cannot tell whether it adds numbers or joins text", line)
        a, ta = self.sub(ea)
        b, tb = self.sub(eb)
        both_num = ta in _NUMERIC and tb in _NUMERIC
        num = "num" if not self.java else "int" if ta == tb == "int" else "double" if both_num else "unknown"
        if op in ("&&", "||"):
            if ta not in ("bool", "unknown") or tb not in ("bool", "unknown"):
                self.no(f"'{op}' on values that are not true/false", line)
            return f"{a} {'and' if op == '&&' else 'or'} {b}", "bool", False
        if op in ("==", "!=", "===", "!=="):
            if self.java:
                simple = ("int", "double", "bool", "null")
                if not ((ta in simple and tb in simple) or "null" in (ta, tb)):
                    self.no("'==' between objects (it compares identity in Java; use .equals for text)", line)
            elif len(op) == 2:
                self.no(f"the loose comparison '{op}' (use '{op}=')", line)
            return f"{a} {'=' if op[0] == '=' else '!='} {b}", "bool", False
        if op in ("<", ">", "<=", ">="):
            return f"{a} {op} {b}", "bool", False
        if op in ("+", "-", "*"):
            return f"{a} {op} {b}", num, False
        if op == "/":
            if self.java:
                if not both_num:
                    self.no("a division where the converter cannot tell whole-number from decimal division", line)
                if num == "int":
                    return f"div({self.ex(ea)[0]}, {self.ex(eb)[0]})", "int", True
            return f"{a} / {b}", num, False
        if op == "%":
            return f"rem({self.ex(ea)[0]}, {self.ex(eb)[0]})", num, True
        if op == "**":
            return f"{a} ^ {b}", num, False
        self.no(f"the operator '{op}'", line)

    def member(self, e):
        _, line, obj, name = e
        if obj[0] == "id" and self.lookup(obj[2]) is None and (obj[2], name) in _CONSTANTS:
            text, t = _CONSTANTS[(obj[2], name)]
            return text, (t if self.java else "num"), not text.startswith("-")
        text, t = self.sub(obj)
        if name == "length" and (not self.java or t.startswith("list<")):
            return f"len({self.ex(obj)[0]})", ("int" if self.java else "num"), True
        if self.java:
            self.no(f"the field .{name}", line)
        return f"{text}.{self.name(name, line) if name in KEYWORDS else name}", "unknown", True

    def args(self, args):
        return ", ".join(self.ex(a)[0] for a in args)

    def math(self, m, args, line):
        vals = [self.ex(a) for a in args]
        texts, types = [v[0] for v in vals], [v[1] for v in vals]
        n = len(args)
        widest = "num" if not self.java else "int" if all(t == "int" for t in types) else "double"
        if m in ("abs", "sqrt", "floor") and n == 1:
            return f"{m}({texts[0]})", ("double" if self.java and m != "abs" else widest), True
        if m == "ceil" and n == 1:
            return f"-floor(-{self.sub(args[0])[0]})", ("double" if self.java else "num"), False
        if m in ("max", "min") and n >= 2 and (n == 2 or not self.java):
            return f"{m}({', '.join(texts)})", widest, True
        if m == "pow" and n == 2:
            return f"{self.sub(args[0])[0]} ^ {self.sub(args[1])[0]}", ("double" if self.java else "num"), False
        if m == "trunc" and n == 1 and not self.java:
            return f"whole({texts[0]})", "num", True
        self.no(f"Math.{m}()", line)

    def call(self, e):
        _, line, callee, args = e
        n = len(args)
        if callee[0] == "id":
            f = callee[2]
            if self.java:
                if f not in self.methods:
                    self.no(f"calling '{f}', which is not a static method of this class", line)
                return f"{self.name(f, line)}({self.args(args)})", self.methods[f], True
            if self.lookup(f) is None and f == "String" and n == 1:
                return f"text({self.args(args)})", "text", True
            return f"{self.ex(callee)[0]}({self.args(args)})", "unknown", True
        if callee[0] != "member":
            return f"{self.sub(callee)[0]}({self.args(args)})", "unknown", True
        obj, m = callee[2], callee[3]
        free = obj[2] if obj[0] == "id" and self.lookup(obj[2]) is None else None
        if free == "Math":
            return self.math(m, args, line)
        if self.java:
            return self.java_call(e, obj, m, args, free)
        if free is not None:
            self.no(f"{free}.{m}()", line)
        o = self.ex(obj)[0]
        arrow = lambda k: n >= 1 and args[0][0] == "fn" and len(args[0][2]) == k  # noqa: E731
        if m in ("map", "filter") and n == 1 and arrow(1):
            if m == "filter" and not (isinstance(args[0][3], tuple) and self.inline(args[0], want_bool=True)):
                self.no(".filter() whose test is not a plain true/false expression", line)
            self.inline_ok = True
            return f"{m}({o}, {self.ex(args[0])[0]})", "list", True
        if m == "reduce" and n == 2 and arrow(2):
            self.inline_ok = True
            return f"fold({o}, {self.ex(args[1])[0]}, {self.ex(args[0])[0]})", "unknown", True
        if m == "includes" and n == 1:
            return f"has({o}, {self.args(args)})", "bool", True
        if m == "join" and n == 1:
            return f"join({o}, {self.args(args)})", "text", True
        if m == "split" and n == 1 and args[0][0] == "str" and args[0][2]:
            return f"split({o}, {self.args(args)})", "list", True
        if m in ("toUpperCase", "toLowerCase", "trim") and n == 0:
            return f"{ {'toUpperCase': 'upper', 'toLowerCase': 'lower', 'trim': 'trim'}[m]}({o})", "text", True
        if m in _JS_BUILTIN_METHODS or m in ("map", "filter", "reduce", "includes", "join", "split"):
            self.no(f"the method .{m}() used this way", line)
        return f"{self.sub(obj)[0]}.{m}({self.args(args)})", "unknown", True

    def inline(self, fn, want_bool):
        """Kind of value an arrow function's expression body produces (checked without emitting)."""
        self.push_fn()
        for p in fn[2]:
            self.declare(p[0], "unknown", fn[1])
        t = self.ex(fn[3][2])[1]
        self.ctxs.pop()
        return t in ("bool", "unknown") if want_bool else t

    def java_call(self, e, obj, m, args, free):
        line, n = e[1], len(args)
        if free == self.cls and m in self.methods:
            return f"{self.name(m, line)}({self.args(args)})", self.methods[m], True
        if free == "String" and m == "valueOf" and n == 1:
            return f"text({self.args(args)})", "text", True
        if (free == "List" and m == "of") or (free == "Arrays" and m == "asList"):
            items = [self.ex(a) for a in args]
            return "[" + ", ".join(i[0] for i in items) + "]", f"list<{items[0][1] if items else 'unknown'}>", True
        if free is not None:
            self.no(f"{free}.{m}()", line)
        o, t = self.ex(obj)[0], self.ex(obj)[1]
        if t == "text":
            if m == "length" and n == 0:
                return f"len({o})", "int", True
            if m == "equals" and n == 1:
                return f"{self.sub(obj)[0]} = {self.sub(args[0])[0]}", "bool", False
            if m == "isEmpty" and n == 0:
                return f"len({o}) = 0", "bool", False
            if m == "contains" and n == 1 and self.ex(args[0])[1] == "text":
                return f"has({o}, {self.args(args)})", "bool", True
            if m in ("toUpperCase", "toLowerCase", "trim") and n == 0:
                return f"{ {'toUpperCase': 'upper', 'toLowerCase': 'lower', 'trim': 'trim'}[m]}({o})", "text", True
        if t.startswith("list<") and obj[0] != "arr":
            if m == "size" and n == 0:
                return f"len({o})", "int", True
            if m == "get" and n == 1:
                return f"{self.sub(obj)[0]}[{self.args(args)}]", inner(t), True
            if m == "contains" and n == 1:
                return f"has({o}, {self.args(args)})", "bool", True
            if m == "isEmpty" and n == 0:
                return f"len({o}) = 0", "bool", False
        self.no(f"the method .{m}() on this kind of value", line)

    def new(self, e):
        _, line, base, args, dims, init = e
        if base.startswith("?"):
            self.no(f"new {base[1:]}", line)
        if dims is None:
            if base.startswith("list<") and not args:
                return "[]", base, True
            self.no(f"new {base}(...) with these arguments", line)
        typ = base
        for _ in dims:
            typ = f"list<{typ}>"
        if init is not None:
            return self.ex(init)[0], typ, True
        if any(d is None for d in dims):
            self.no("an array created without all of its sizes", line)
        text = {"int": "0", "double": "0", "bool": "no"}.get(base, "nothing")
        for i, d in reversed(list(enumerate(dims))):
            size, t, _ = self.ex(d)
            if t != "int":
                self.no("an array size that is not a whole number", line)
            text = f"map(range({size}), i{i}_ -> {text})"
        return text, typ, True


def javascript_to_tamas(source):
    return Conv("js").js(P(source, "js").js_program())


def java_to_tamas(source):
    return Conv("java").java_program(P(source, "java").java_unit())
