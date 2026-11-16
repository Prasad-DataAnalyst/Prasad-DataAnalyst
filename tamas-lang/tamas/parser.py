"""Tokens -> syntax tree. Every node is a tuple: (kind, line, ...)."""
from .errors import TamasError
from .lexer import lex

_CMP = ("=", "!=", "<", ">", "<=", ">=")


class Parser:
    def __init__(self, toks, lang, known):
        self.t, self.i, self.lang, self.known = toks, 0, lang, known

    # -- token helpers
    def peek(self, k=0):
        return self.t[min(self.i + k, len(self.t) - 1)]

    def next(self):
        tok = self.t[self.i]
        self.i += 1
        return tok

    def at(self, kind, val=None, k=0):
        tok = self.peek(k)
        return tok.kind == kind and (val is None or tok.val == val)

    def accept(self, kind, val=None):
        if self.at(kind, val):
            return self.next()
        return None

    def expect(self, kind, val=None):
        if self.at(kind, val):
            return self.next()
        tok = self.peek()
        got = "end of file" if tok.kind == "EOF" else "end of line" if tok.kind == "NL" else repr(
            tok.val if tok.kind in ("OP", "KW", "ID") else tok.kind.lower())
        raise TamasError(f"expected {val or kind.lower()!r} but found {got}", tok.line)

    def skip_nl(self):
        while self.accept("NL"):
            pass

    # -- statements
    def program(self):
        body = self.stmts("EOF")
        return body

    def stmts(self, end):
        out = []
        self.skip_nl()
        while not (self.at("EOF") if end == "EOF" else self.at("OP", end)):
            if self.at("EOF"):
                raise TamasError("a '{' is never closed", self.peek().line)
            out.append(self.stmt())
            if not (self.at("OP", "}") or self.at("EOF")):
                self.expect("NL")
            self.skip_nl()
        return out

    def block(self):
        self.expect("OP", "{")
        body = self.stmts("}")
        self.expect("OP", "}")
        return body

    def stmt(self):
        tok = self.peek()
        line = tok.line
        if tok.kind == "KW":
            kw = tok.val
            if kw == "when":
                return self.when()
            if kw == "each":
                self.next()
                a, b = self.expect("ID").val, None
                if self.accept("OP", ","):
                    b = self.expect("ID").val
                self.expect("KW", "in")
                return ("each", line, a, b, self.expr(), self.block())
            if kw == "loop":
                self.next()
                return ("loop", line, self.expr(), self.block())
            if kw in ("stop", "skip"):
                self.next()
                return (kw, line)
            if kw == "give":
                self.next()
                if self.at("NL") or self.at("OP", "}") or self.at("EOF"):
                    return ("give", line, None)
                return ("give", line, self.expr())
            if kw == "show":
                self.next()
                items = [self.expr()]
                while self.accept("OP", ","):
                    items.append(self.expr())
                return ("show", line, items)
            if kw == "unit":
                self.next()
                name = self.expect("ID").val
                self.expect("OP", ":")
                return ("unitdef", line, name, self.expr())
        e = self.expr()
        if self.accept("OP", ":"):
            if e[0] in ("name", "member", "index") or (e[0] == "str" and len(e[2]) == 1 and isinstance(e[2][0], str)):
                return ("bind", line, e, self.expr())
            raise TamasError("only a name, a field or an item can be given a value with ':'", line)
        if self.at("OP", "->") and e[0] == "call" and e[2][0] == "name" and not e[4] and all(a[0] == "name" for a in e[3]):
            self.next()
            name = e[2][2]
            body = self.block() if self.at("OP", "{") else [("give", line, self.expr())]
            return ("bind", line, e[2], ("fn", line, [a[2] for a in e[3]], body, name))
        return ("expr", line, e)

    def when(self):
        line = self.next().line
        cond, then, other = self.expr(), self.block(), None
        if self.accept("KW", "else"):
            other = [self.when()] if self.at("KW", "when") else self.block()
        return ("when", line, cond, then, other)

    # -- expressions, loosest binding first
    def expr(self):
        left = self.or_()
        while self.at("OP", "|>"):
            line = self.next().line
            if self.accept("KW", "show"):
                right = ("name", line, "show")
            else:
                right = self.or_()
            if right[0] == "call":
                left = ("call", line, right[2], [left] + right[3], right[4])
            else:
                left = ("call", line, right, [left], [])
        return left

    def or_(self):
        left = self.and_()
        while self.at("KW", "or"):
            left = ("or", self.next().line, left, self.and_())
        return left

    def and_(self):
        left = self.not_()
        while self.at("KW", "and"):
            left = ("and", self.next().line, left, self.not_())
        return left

    def not_(self):
        if self.at("KW", "not"):
            return ("not", self.next().line, self.not_())
        return self.cmp()

    def cmp(self):
        left = self.conv()
        if self.peek().kind == "OP" and self.peek().val in _CMP:
            tok = self.next()
            return ("bin", tok.line, tok.val, left, self.conv())
        return left

    def conv(self):
        left = self.add()
        while self.at("KW", "as"):
            line = self.next().line
            left = ("as", line, left, self.unit_expr())
        return left

    def unit_expr(self):
        tok = self.next()
        if tok.kind == "KW" and tok.val == "in":  # never a unit, but give a clear message
            raise TamasError("expected a unit after 'as'", tok.line)
        if tok.kind != "ID":
            raise TamasError("expected a unit after 'as'", tok.line)
        out = tok.val
        while True:
            if self.at("OP", "^") and (self.at("NUM", None, 1) or (self.at("OP", "-", 1) and self.at("NUM", None, 2))):
                self.next()
                sign = "-" if self.accept("OP", "-") else ""
                out += f"^{sign}{self.next().val}"
            elif (self.at("OP", "/") or self.at("OP", "*")) and self.at("ID", None, 1) and self.peek(1).val in self.known:
                out += self.next().val + self.next().val
            else:
                return out

    def add(self):
        left = self.mul()
        while self.at("OP", "+") or self.at("OP", "-"):
            tok = self.next()
            left = ("bin", tok.line, tok.val, left, self.mul())
        return left

    def mul(self):
        left = self.unary()
        while self.at("OP", "*") or self.at("OP", "/") or self.at("OP", "%"):
            tok = self.next()
            left = ("bin", tok.line, tok.val, left, self.unary())
        return left

    def unary(self):
        if self.at("OP", "-"):
            return ("neg", self.next().line, self.unary())
        return self.power()

    def power(self):
        left = self.postfix()
        if self.at("OP", "^"):
            line = self.next().line
            return ("bin", line, "^", left, self.unary())
        return left

    def postfix(self):
        e = self.primary()
        while True:
            if self.at("OP", "("):
                line = self.next().line
                args, named = [], []
                while not self.at("OP", ")"):
                    if self.at("ID") and self.at("OP", ":", 1):
                        key = self.next().val
                        self.next()
                        named.append((key, self.expr()))
                    elif named:
                        raise TamasError("named values must come after the unnamed ones", self.peek().line)
                    else:
                        args.append(self.expr())
                    if not self.accept("OP", ","):
                        break
                self.expect("OP", ")")
                e = ("call", line, e, args, named)
            elif self.at("OP", "."):
                line = self.next().line
                tok = self.next()
                if tok.kind not in ("ID", "KW"):
                    raise TamasError("expected a field name after '.'", line)
                e = ("member", line, e, tok.val)
            elif self.at("OP", "["):
                line = self.next().line
                idx = self.expr()
                self.expect("OP", "]")
                e = ("index", line, e, idx)
            else:
                return e

    def lambda_ahead(self):
        """Is this '(' the start of '(a, b) -> ...'?"""
        k = 1
        if self.at("OP", ")", k):
            return self.at("OP", "->", k + 1)
        while self.at("ID", None, k):
            if self.at("OP", ")", k + 1):
                return self.at("OP", "->", k + 2)
            if not self.at("OP", ",", k + 1):
                return False
            k += 2
        return False

    def fn_body(self, line):
        return self.block() if self.at("OP", "{") else [("give", line, self.or_())]

    def primary(self):
        tok = self.next()
        line = tok.line
        if tok.kind == "NUM":
            return ("num", line, tok.val)
        if tok.kind == "QTY":
            return ("qty", line, tok.val[0], tok.val[1])
        if tok.kind == "STR":
            parts = []
            for p in tok.val:
                if isinstance(p, tuple):
                    hint = "could not understand the {...} part of this text (write \\{ for a literal brace)"
                    try:
                        sub = Parser(lex(p[1], self.lang, self.known)[0], self.lang, self.known)
                        sub.skip_nl()
                        node = sub.expr()
                        sub.skip_nl()
                    except TamasError as err:
                        raise TamasError(f"{hint}: {err.msg}", p[3])
                    if not sub.at("EOF"):
                        raise TamasError(hint, p[3])
                    parts.append(node)
                else:
                    parts.append(p)
            return ("str", line, parts)
        if tok.kind == "KW":
            if tok.val in ("yes", "no"):
                return ("bool", line, tok.val == "yes")
            if tok.val == "nothing":
                return ("nothing", line)
            raise TamasError(f"'{tok.val}' cannot be used here", line)
        if tok.kind == "ID":
            if self.at("OP", "->"):
                self.next()
                return ("fn", line, [tok.val], self.fn_body(line), None)
            return ("name", line, tok.val)
        if tok.kind == "OP":
            if tok.val == "(":
                self.i -= 1
                if self.lambda_ahead():
                    self.next()
                    params = []
                    while not self.at("OP", ")"):
                        params.append(self.expect("ID").val)
                        self.accept("OP", ",")
                    self.next()
                    self.next()
                    return ("fn", line, params, self.fn_body(line), None)
                self.next()
                e = self.expr()
                self.expect("OP", ")")
                return e
            if tok.val == "[":
                items = []
                while not self.at("OP", "]"):
                    items.append(self.expr())
                    if not self.accept("OP", ","):
                        break
                self.expect("OP", "]")
                return ("list", line, items)
            if tok.val == "{":
                pairs = []
                while True:
                    while self.accept("NL") or self.accept("OP", ","):
                        pass
                    if self.accept("OP", "}"):
                        return ("rec", line, pairs)
                    k = self.next()
                    if k.kind in ("ID", "KW"):
                        key = k.val
                    elif k.kind == "STR" and len(k.val) == 1 and isinstance(k.val[0], str):
                        key = k.val[0]
                    else:
                        raise TamasError("expected a field name inside { }", k.line)
                    self.expect("OP", ":")
                    pairs.append((key, self.expr()))
        what = "end of file" if tok.kind == "EOF" else "end of line" if tok.kind == "NL" else f"'{tok.val}'"
        raise TamasError(f"unexpected {what}", line)


def parse(src, lang=None):
    toks, lang, known = lex(src, lang)
    return Parser(toks, lang, known).program()
