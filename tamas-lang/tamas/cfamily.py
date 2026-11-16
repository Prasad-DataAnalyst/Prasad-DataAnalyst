"""Reads the two C-family languages Tamas can convert from - JavaScript and Java - into one syntax tree.

Only a defined subset is understood. Everything else raises a clear "not supported" error.
Nodes are tuples (kind, line, ...); plain lists hold groups that are not nodes.
"""
import re
from collections import namedtuple

from .errors import TamasError

T = namedtuple("T", "kind val line nl")

_PUNCT = ["===", "!==", "**=", "...", "=>", "==", "!=", "<=", ">=", "&&", "||", "++", "--",
          "+=", "-=", "*=", "/=", "%=", "**", "->", "::"] + list("{}()[];,.<>+-*/%=!?:&|^~@#")
_NUM = re.compile(r"0[xX][0-9a-fA-F_]+|(\d[\d_]*)?\.?\d[\d_]*([eE][+-]?\d+)?")
_ID = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
_ESC = {"n": "\n", "t": "\t", "r": "\r", "0": "\0", "b": "\b", "f": "\f", "\\": "\\", '"': '"', "'": "'", "`": "`",
        "$": "$", "{": "{", "}": "}"}
_ASSIGN = ("=", "+=", "-=", "*=", "/=", "%=", "**=")
_PREC = {"||": 1, "&&": 2, "==": 3, "!=": 3, "===": 3, "!==": 3, "<": 4, ">": 4, "<=": 4, ">=": 4,
         "+": 5, "-": 5, "*": 6, "/": 6, "%": 6, "**": 7}
_REFUSE = {
    "js": {"class", "switch", "try", "throw", "do", "new", "this", "async", "await", "yield", "typeof", "delete",
           "void", "import", "export", "with", "debugger", "super", "case", "catch", "finally"},
    "java": {"switch", "try", "throw", "do", "this", "super", "synchronized", "interface", "enum", "record",
             "assert", "case", "catch", "finally", "throws", "abstract", "native", "goto", "class"},
}
_JAVA_MODS = {"public", "private", "protected", "static", "final"}
_JAVA_WORDS = {"if", "else", "while", "for", "return", "break", "continue", "new", "true", "false", "null"}
_INT = {"int", "long", "short", "byte", "Integer", "Long", "Short", "Byte"}
_DBL = {"double", "float", "Double", "Float"}
_LISTS = {"List", "ArrayList", "LinkedList", "Collection", "Iterable"}
NAMES = {"js": "JavaScript", "java": "Java"}


def inner(t):
    return t[5:-1] if t.startswith("list<") else "unknown"


def _norm(name, args):
    if name in _INT:
        return "int"
    if name in _DBL:
        return "double"
    if name in ("boolean", "Boolean"):
        return "bool"
    if name == "String":
        return "text"
    if name in _LISTS:
        return f"list<{args[0] if args else 'unknown'}>"
    if name in ("void", "var"):
        return name
    return "?" + name


def clex(src, dialect):
    lang, toks, i, n, line, nl = NAMES[dialect], [], 0, len(src), 1, False

    def text_until(quote, start):
        """Decode a quoted string starting after its opening quote. Returns (parts, end)."""
        nonlocal line
        j, buf, parts = start, [], []
        while True:
            if j >= n or (src[j] == "\n" and quote != "`"):
                raise TamasError(f"{lang}: text is missing its closing quote", line)
            ch = src[j]
            if ch == quote:
                break
            if ch == "\\":
                e = src[j + 1] if j + 1 < n else ""
                if e == "u" and re.match(r"[0-9a-fA-F]{4}", src[j + 2:j + 6]):
                    buf.append(chr(int(src[j + 2:j + 6], 16)))
                    j += 6
                elif e in _ESC:
                    buf.append(_ESC[e])
                    j += 2
                elif e == "\n":
                    line += 1
                    j += 2
                else:
                    raise TamasError(f"{lang} feature not supported by the converter yet: escape \\{e}", line)
            elif quote == "`" and src.startswith("${", j):
                depth, k = 1, j + 2
                while k < n and depth:
                    depth += {"{": 1, "}": -1}.get(src[k], 0)
                    k += 1
                parts.append("".join(buf))
                buf = []
                parts.append(("x", src[j + 2:k - 1], line))
                line += src.count("\n", j, k)
                j = k
            else:
                if ch == "\n":
                    line += 1
                buf.append(ch)
                j += 1
        parts.append("".join(buf))
        return parts, j + 1

    while i < n:
        c = src[i]
        if c == "\n":
            line, nl, i = line + 1, True, i + 1
        elif c in " \t\r":
            i += 1
        elif src.startswith("//", i):
            while i < n and src[i] != "\n":
                i += 1
        elif src.startswith("/*", i):
            end = src.find("*/", i + 2)
            end = n if end < 0 else end + 2
            line += src.count("\n", i, end)
            i = end
        elif c.isdigit() or (c == "." and i + 1 < n and src[i + 1].isdigit()):
            m = _NUM.match(src, i)
            raw = m.group().replace("_", "")
            if raw[:2].lower() == "0x":
                val = int(raw, 16)
            elif "." in raw or "e" in raw.lower():
                val = float(raw)
            else:
                val = int(raw)
            i = m.end()
            if dialect == "java" and i < n and src[i] in "lLfFdD":
                if src[i] in "fFdD":
                    val = float(val)
                i += 1
            if dialect == "js" and i < n and src[i] == "n":
                raise TamasError("JavaScript feature not supported by the converter yet: BigInt literals", line)
            toks.append(T("num", val, line, nl))
            nl = False
        elif c in "\"'`":
            if c == "'" and dialect == "java":
                raise TamasError("Java feature not supported by the converter yet: the char type", line)
            start_line = line
            parts, i = text_until(c, i + 1)
            if c == "`":
                toks.append(T("tpl", parts, start_line, nl))
            else:
                toks.append(T("str", parts[0], start_line, nl))
            nl = False
        elif _ID.match(src, i):
            m = _ID.match(src, i)
            toks.append(T("id", m.group(), line, nl))
            nl, i = False, m.end()
        else:
            for p in _PUNCT:
                if src.startswith(p, i):
                    toks.append(T("op", p, line, nl))
                    nl, i = False, i + len(p)
                    break
            else:
                raise TamasError(f"{lang}: unexpected character '{c}'", line)
    toks.append(T("eof", None, line, True))
    return toks


class P:
    def __init__(self, src, dialect):
        self.d, self.lang = dialect, NAMES[dialect]
        self.t, self.i = clex(src, dialect), 0

    # -- helpers
    def no(self, what, line=None):
        raise TamasError(f"{self.lang} feature not supported by the converter yet: {what}",
                         line if line is not None else self.peek().line)

    def peek(self, k=0):
        return self.t[min(self.i + k, len(self.t) - 1)]

    def next(self):
        tok = self.t[self.i]
        self.i = min(self.i + 1, len(self.t) - 1)
        return tok

    def at(self, val, k=0):
        tok = self.peek(k)
        return tok.kind in ("op", "id") and tok.val == val

    def accept(self, val):
        if self.at(val):
            return self.next()
        return None

    def show(self, tok):
        return "end of file" if tok.kind == "eof" else f"'{tok.val}'" if tok.kind in ("op", "id") else "a value"

    def expect(self, val):
        if self.at(val):
            return self.next()
        tok = self.peek()
        raise TamasError(f"{self.lang}: expected '{val}' but found {self.show(tok)}", tok.line)

    def ident(self):
        tok = self.next()
        if tok.kind != "id":
            raise TamasError(f"{self.lang}: expected a name but found {self.show(tok)}", tok.line)
        if tok.val in _REFUSE[self.d]:
            self.no(f"'{tok.val}'", tok.line)
        return tok.val

    def end_stmt(self):
        if self.accept(";"):
            return
        tok = self.peek()
        if self.d == "js" and (tok.kind == "eof" or self.at("}") or tok.nl):
            return
        if tok.kind in ("op", "id"):
            self.no(f"'{tok.val}' here", tok.line)
        raise TamasError(f"{self.lang}: expected ';' but found {self.show(tok)}", tok.line)

    # -- Java types
    def type_end(self, k):
        tok = self.peek(k)
        if tok.kind != "id" or tok.val in _JAVA_WORDS:
            return None
        k += 1
        while self.at(".", k) and self.peek(k + 1).kind == "id":
            k += 2
        if self.at("<", k):
            depth = 0
            while True:
                tok = self.peek(k)
                if self.at("<", k):
                    depth += 1
                elif self.at(">", k):
                    depth -= 1
                elif not (tok.kind == "id" or (tok.kind == "op" and tok.val in ",.?[]")):
                    return None
                k += 1
                if depth == 0:
                    break
        while self.at("[", k) and self.at("]", k + 1):
            k += 2
        return k

    def is_decl(self):
        k = self.type_end(0)
        return k is not None and self.peek(k).kind == "id" and self.peek(k + 1).kind == "op" \
            and self.peek(k + 1).val in ("=", ";", ",", ":")

    def parse_type(self, arrays=True):
        tok = self.next()
        if tok.kind != "id":
            self.no(f"{self.show(tok)} here", tok.line)
        name = tok.val
        while self.at(".") and self.peek(1).kind == "id":
            self.next()
            name = self.next().val
        args = []
        if self.accept("<"):
            while not self.at(">"):
                args.append("unknown" if self.accept("?") else self.parse_type())
                if not self.accept(","):
                    break
            self.expect(">")
        t = _norm(name, args)
        while arrays and self.at("[") and self.at("]", 1):
            self.next()
            self.next()
            t = f"list<{t}>"
        return t

    # -- programs
    def js_program(self):
        out = []
        while self.peek().kind != "eof":
            out.append(self.statement())
        return out

    def java_unit(self):
        while self.at("package") or self.at("import"):
            line, is_import = self.peek().line, self.next().val == "import"
            path = []
            while not self.at(";"):
                path.append(str(self.next().val))
            self.next()
            if is_import and not "".join(path).startswith(("java.util.", "java.lang.")):
                self.no(f"import {''.join(path)}", line)
        while self.peek().val in _JAVA_MODS:
            self.next()
        if not self.accept("class"):
            self.no(f"{self.show(self.peek())} where a class should start")
        cls = self.ident()
        if not self.at("{"):
            self.no("extends / implements")
        self.next()
        fields, methods = [], []
        while not self.at("}"):
            line, mods = self.peek().line, set()
            while self.peek().kind == "id" and self.peek().val in _JAVA_MODS:
                mods.add(self.next().val)
            if self.at(cls) and self.at("(", 1):
                self.no("constructors (only static methods and fields are converted)", line)
            typ = self.parse_type()
            name = self.ident()
            if "static" not in mods:
                self.no(f"non-static member '{name}' (only static methods and fields are converted)", line)
            if self.accept("("):
                params = []
                while not self.at(")"):
                    self.accept("final")
                    ptype = self.parse_type()
                    if self.at("..."):
                        self.no("varargs")
                    params.append([self.ident(), ptype])
                    if not self.accept(","):
                        break
                self.expect(")")
                methods.append(("func", line, name, params, self.block(), typ))
            else:
                fields.append(self.declarators(line, typ, name))
        self.next()
        if self.peek().kind != "eof":
            self.no("more than one class in a file")
        return cls, fields, methods

    # -- statements
    def block(self):
        self.expect("{")
        out = []
        while not self.at("}"):
            if self.peek().kind == "eof":
                raise TamasError(f"{self.lang}: a '{{' is never closed", self.peek().line)
            out.append(self.statement())
        self.next()
        return out

    def body(self):
        s = self.statement()
        return s[2] if s[0] == "block" else [s]

    def declarators(self, line, kind, first=None, end=True):
        entries = []
        while True:
            if first is None and self.peek().kind == "op":
                self.no("destructuring")
            name, first = first or self.ident(), None
            if self.at("["):
                self.no("C-style array declarations (write int[] a)")
            init = None
            if self.accept("="):
                init = self.arr_init() if self.d == "java" and self.at("{") else self.assign()
            entries.append([name, None, init])
            if not self.accept(","):
                break
        if end:
            self.end_stmt()
        return ("decl", line, kind, entries)

    def arr_init(self):
        line = self.expect("{").line
        items = []
        while not self.at("}"):
            items.append(self.arr_init() if self.at("{") else self.assign())
            if not self.accept(","):
                break
        self.expect("}")
        return ("arr", line, items)

    def decl_ahead(self):
        if self.d == "js":
            return self.peek().kind == "id" and self.peek().val in ("let", "const", "var")
        while self.at("final"):
            self.next()
        return self.is_decl()

    def decl(self, end=True):
        line = self.peek().line
        kind = self.next().val if self.d == "js" else self.parse_type()
        return self.declarators(line, kind, end=end)

    def statement(self):
        tok = self.peek()
        line = tok.line
        if self.at("{"):
            return ("block", line, self.block())
        if self.accept(";"):
            return ("empty", line)
        if tok.kind == "id":
            v = tok.val
            if v == "if":
                self.next()
                self.expect("(")
                cond = self.expr()
                self.expect(")")
                then = self.body()
                other = self.body() if self.accept("else") else None
                return ("if", line, cond, then, other)
            if v == "while":
                self.next()
                self.expect("(")
                cond = self.expr()
                self.expect(")")
                return ("while", line, cond, self.body())
            if v == "for":
                return self.for_()
            if v == "return":
                self.next()
                nxt = self.peek()
                if self.at(";") or (self.d == "js" and (self.at("}") or nxt.kind == "eof" or nxt.nl)):
                    self.end_stmt()
                    return ("return", line, None)
                e = self.expr()
                self.end_stmt()
                return ("return", line, e)
            if v in ("break", "continue"):
                self.next()
                self.end_stmt()
                return (v, line)
            if v == "function" and self.d == "js":
                self.next()
                if self.at("*"):
                    self.no("generator functions")
                name = self.ident()
                return ("func", line, name, self.params(), self.block(), None)
            if v in _REFUSE[self.d]:
                self.no(f"'{v}'", line)
            if self.decl_ahead():
                return self.decl()
        e = self.expr()
        self.end_stmt()
        return ("expr", line, e)

    def params(self):
        self.expect("(")
        out = []
        while not self.at(")"):
            if self.peek().kind != "id":
                self.no("destructuring or rest parameters")
            out.append([self.ident(), None])
            if self.at("="):
                self.no("default parameter values")
            if not self.accept(","):
                break
        self.expect(")")
        return out

    def for_(self):
        line = self.next().line
        self.expect("(")
        if self.d == "js" and self.peek().val in ("let", "const", "var") and self.peek(1).kind == "id":
            if self.at("of", 2):
                self.next()
                name = self.ident()
                self.next()
                it = self.expr()
                self.expect(")")
                return ("foreach", line, name, None, it, self.body())
            if self.at("in", 2):
                self.no("for...in loops (use for...of)", line)
        if self.d == "java":
            while self.at("final"):
                self.next()
            k = self.type_end(0)
            if k is not None and self.peek(k).kind == "id" and self.at(":", k + 1):
                typ = self.parse_type()
                name = self.ident()
                self.next()
                it = self.expr()
                self.expect(")")
                return ("foreach", line, name, typ, it, self.body())
        init = None
        if not self.at(";"):
            init = self.decl(end=False) if self.decl_ahead() else ("expr", line, self.expr())
        self.expect(";")
        cond = None if self.at(";") else self.expr()
        self.expect(";")
        updates = []
        while not self.at(")"):
            updates.append(self.expr())
            if not self.accept(","):
                break
        self.expect(")")
        return ("for", line, init, cond, updates, self.body())

    # -- expressions
    def expr(self):
        return self.assign()

    def assign(self):
        left = self.ternary()
        tok = self.peek()
        if tok.kind == "op" and tok.val in _ASSIGN:
            if left[0] not in ("id", "member", "index"):
                self.no("this assignment target", tok.line)
            self.next()
            return ("assign", tok.line, tok.val, left, self.assign())
        return left

    def ternary(self):
        cond = self.binary(0)
        if self.at("?"):
            line = self.next().line
            a = self.assign()
            self.expect(":")
            return ("cond", line, cond, a, self.assign())
        return cond

    def binary(self, minp):
        left = self.unary()
        while True:
            tok = self.peek()
            p = _PREC.get(tok.val) if tok.kind == "op" else None
            if p is None or p < minp:
                return left
            self.next()
            left = ("bin", tok.line, tok.val, left, self.binary(p if tok.val == "**" else p + 1))

    def unary(self):
        tok = self.peek()
        if tok.kind == "op":
            if tok.val in ("!", "-"):
                self.next()
                return ("un", tok.line, tok.val, self.unary())
            if tok.val in ("++", "--"):
                self.next()
                return ("incdec", tok.line, tok.val, self.unary())
            if tok.val == "(" and self.d == "java" and self.peek(1).kind == "id" and self.at(")", 2) \
                    and self.peek(1).val in ("int", "long", "double", "float", "short", "byte"):
                self.next()
                typ = _norm(self.next().val, [])
                self.next()
                return ("cast", tok.line, typ, self.unary())
        return self.postfix()

    def postfix(self):
        e = self.primary()
        while True:
            tok = self.peek()
            if self.at("("):
                self.next()
                args = []
                while not self.at(")"):
                    args.append(self.assign())
                    if not self.accept(","):
                        break
                self.expect(")")
                e = ("call", tok.line, e, args)
            elif self.at("."):
                self.next()
                name = self.next()
                if name.kind != "id":
                    raise TamasError(f"{self.lang}: expected a name after '.'", name.line)
                e = ("member", tok.line, e, name.val)
            elif self.at("["):
                self.next()
                idx = self.expr()
                self.expect("]")
                e = ("index", tok.line, e, idx)
            elif tok.kind == "op" and tok.val in ("++", "--") and not tok.nl:
                self.next()
                e = ("incdec", tok.line, tok.val, e)
            else:
                return e

    def arrow_ahead(self):
        depth, k = 0, 0
        while True:
            tok = self.peek(k)
            if tok.kind == "eof":
                return False
            if tok.kind == "op" and tok.val in "([{":
                depth += 1
            elif tok.kind == "op" and tok.val in ")]}":
                depth -= 1
                if depth == 0:
                    return self.at("=>", k + 1)
            k += 1

    def fn_body(self, line):
        if self.at("{"):
            return self.block()
        return ("exprbody", line, self.assign())

    def primary(self):
        tok = self.next()
        line = tok.line
        if tok.kind == "num":
            return ("num", line, tok.val)
        if tok.kind == "str":
            return ("str", line, tok.val)
        if tok.kind == "tpl":
            parts = []
            for p in tok.val:
                if isinstance(p, tuple):
                    sub = P(p[1], self.d)
                    node = sub.expr()
                    if sub.peek().kind != "eof":
                        sub.no("this ${...} placeholder", p[2])
                    parts.append(node)
                elif p:
                    parts.append(p)
            return ("tpl", line, parts)
        if tok.kind == "id":
            v = tok.val
            if v in ("true", "false"):
                return ("bool", line, v == "true")
            if v == "null":
                return ("null", line)
            if self.d == "js":
                if v == "function":
                    if self.peek().kind == "id":
                        self.no("named function expressions", line)
                    return ("fn", line, self.params(), self.block())
                if self.at("=>"):
                    self.next()
                    return ("fn", line, [[v, None]], self.fn_body(line))
            elif v == "new":
                return self.new_(line)
            if v in _REFUSE[self.d]:
                self.no(f"'{v}'", line)
            return ("id", line, v)
        if tok.kind == "op":
            if tok.val == "(":
                self.i -= 1
                if self.d == "js" and self.arrow_ahead():
                    params = self.params()
                    self.next()
                    return ("fn", line, params, self.fn_body(line))
                self.next()
                e = self.expr()
                self.expect(")")
                return e
            if tok.val == "[" and self.d == "js":
                items = []
                while not self.at("]"):
                    if self.at(",") or self.at("..."):
                        self.no("array holes or spread")
                    items.append(self.assign())
                    if not self.accept(","):
                        break
                self.expect("]")
                return ("arr", line, items)
            if tok.val == "{" and self.d == "js":
                pairs = []
                while not self.at("}"):
                    k = self.next()
                    if k.kind == "id" or k.kind == "str":
                        key = k.val
                    elif k.kind == "num":
                        self.no("number keys in objects", k.line)
                    else:
                        self.no("computed keys or spread in objects", k.line)
                    if self.accept(":"):
                        pairs.append([key, self.assign()])
                    elif k.kind == "id" and (self.at(",") or self.at("}")):
                        pairs.append([key, ("id", k.line, key)])
                    else:
                        self.no("methods or getters inside object literals", k.line)
                    if not self.accept(","):
                        break
                self.expect("}")
                return ("obj", line, pairs)
            if tok.val == "->" or tok.val == "::":
                self.no("lambdas and method references", line)
        if tok.kind == "eof":
            raise TamasError(f"{self.lang}: the file ends in the middle of a statement", line)
        self.no(f"{self.show(tok)} here", line)

    def new_(self, line):
        base = self.parse_type(arrays=False)
        if self.at("["):
            dims = []
            while self.accept("["):
                dims.append(None if self.at("]") else self.expr())
                self.expect("]")
            init = self.arr_init() if self.at("{") else None
            return ("new", line, base, None, dims, init)
        self.expect("(")
        args = []
        while not self.at(")"):
            args.append(self.assign())
            if not self.accept(","):
                break
        self.expect(")")
        if self.at("{"):
            self.no("anonymous classes", line)
        return ("new", line, base, args, None, None)
