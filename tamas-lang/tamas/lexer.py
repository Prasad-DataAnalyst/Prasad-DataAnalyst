"""Turns Tamas source text into tokens. Keywords may be written in any installed language pack."""
import os
import re
import unicodedata
from collections import namedtuple

from .errors import TamasError
from .units import DEFAULT_UNITS

KEYWORDS = ["when", "else", "each", "in", "loop", "stop", "skip", "give", "show", "unit", "as",
            "and", "or", "not", "yes", "no", "nothing"]

Tok = namedtuple("Tok", "kind val line start end")

LANG_DIR = os.path.join(os.path.dirname(__file__), "langs")
_LANG_RE = re.compile(r"\s*@lang[ \t]+([A-Za-z_-]+)[^\n]*")
_NUM_RE = re.compile(r"\d[\d_]*(\.\d+)?([eE][+-]?\d+)?")
_UNIT_NAME = re.compile(r"[A-Za-z]+")
_UNIT_POW = re.compile(r"\^-?\d+")
_PIPE_AHEAD = re.compile(r"[ \t\r\n]*\|>")
_PACK_LINE = re.compile(r'^\s*(\w+)\s*:\s*"([^"]+)"\s*(~.*)?$')
_OPS2 = ("|>", "->", "!=", "<=", ">=")
_OPS1 = ":,.()[]{}+-*/%^=<>"
_ESC = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "{": "{", "}": "}"}
_packs = {}


def id_start(c):
    return c == "_" or unicodedata.category(c)[0] in "LM"


def id_part(c):
    return c in "_‌‍" or unicodedata.category(c)[0] in "LMN"


def available_langs():
    return ["en"] + sorted(f[:-4] for f in os.listdir(LANG_DIR) if f.endswith(".tms"))


def load_pack(lang):
    """Language pack: canonical keyword -> word in that language. Packs are plain Tamas data files."""
    if lang in (None, "en"):
        return {k: k for k in KEYWORDS}
    if lang not in _packs:
        path = os.path.join(LANG_DIR, lang + ".tms")
        if not os.path.exists(path):
            raise TamasError(f"no language pack '{lang}' (available: {', '.join(available_langs())})")
        pack = {}
        with open(path, encoding="utf-8") as f:
            for raw in f:
                m = _PACK_LINE.match(raw)
                if m and m.group(1) in KEYWORDS:
                    pack[m.group(1)] = unicodedata.normalize("NFC", m.group(2))
        missing = [k for k in KEYWORDS if k not in pack]
        if missing or len(set(pack.values())) != len(pack):
            raise TamasError(f"language pack '{lang}' is incomplete or has duplicate words: {missing}")
        _packs[lang] = pack
    return _packs[lang]


def keyword_map(lang):
    """Word as written -> canonical keyword. English is always understood; the pack wins on a clash."""
    kw = {k: k for k in KEYWORDS}
    kw.update({word: canon for canon, word in load_pack(lang).items()})
    return kw


def _scan_unit(src, j, known):
    """Longest run like km/h or m^2 made only of known units, starting at j. Returns its end or None."""
    end, k, first = None, j, True
    while True:
        k2 = k
        if not first:
            if k < len(src) and src[k] in "*/":
                k2 = k + 1
            else:
                break
        m = _UNIT_NAME.match(src, k2)
        if not m or m.group() not in known:
            break
        k3 = m.end()
        p = _UNIT_POW.match(src, k3)
        if p:
            k3 = p.end()
        if k3 < len(src) and id_part(src[k3]):
            break
        end, k, first = k3, k3, False
    return end


def lex(src, lang=None, known=None):
    """Returns (tokens, language, known unit names)."""
    i = 0
    m = _LANG_RE.match(src)
    if m:
        lang, i = m.group(1), m.end()
    kw = keyword_map(lang)
    known = set(DEFAULT_UNITS) | set(known or ())
    toks, stack, n = [], [], len(src)
    line = 1 + src.count("\n", 0, i)

    while i < n:
        c = src[i]
        if c in " \t\r":
            i += 1
        elif c == "\n":
            if ((not stack or stack[-1] == "{") and toks and toks[-1].kind != "NL"
                    and not _PIPE_AHEAD.match(src, i)):
                toks.append(Tok("NL", None, line, i, i + 1))
            line += 1
            i += 1
        elif c == "~":
            while i < n and src[i] != "\n":
                i += 1
        elif c.isdigit() and c.isascii():
            m = _NUM_RE.match(src, i)
            text = m.group().replace("_", "")
            num = float(text) if (m.group(1) or m.group(2)) else int(text)
            j = m.end()
            while j < n and src[j] in " \t":
                j += 1
            uend = _scan_unit(src, j, known)
            if uend:
                toks.append(Tok("QTY", (num, src[j:uend]), line, i, uend))
                i = uend
            else:
                toks.append(Tok("NUM", num, line, i, m.end()))
                i = m.end()
        elif c == '"':
            start, start_line = i, line
            i += 1
            parts, buf = [], []
            while True:
                if i >= n:
                    raise TamasError("text is missing its closing quote", start_line)
                ch = src[i]
                if ch == '"':
                    i += 1
                    break
                if ch == "\\":
                    nxt = src[i + 1] if i + 1 < n else ""
                    if nxt == "u":
                        buf.append(chr(int(src[i + 2:i + 6], 16)))
                        i += 6
                    elif nxt in _ESC:
                        buf.append(_ESC[nxt])
                        i += 2
                    else:
                        raise TamasError(f"unknown escape \\{nxt} in text", line)
                elif ch == "{":
                    depth, j = 1, i + 1
                    while j < n and depth:
                        depth += {"{": 1, "}": -1}.get(src[j], 0)
                        j += 1
                    if depth:
                        raise TamasError("'{' inside text is never closed (write \\{ for a literal brace)", line)
                    if buf:
                        parts.append("".join(buf))
                        buf = []
                    parts.append(("x", src[i + 1:j - 1], i + 1, line))
                    line += src.count("\n", i, j)
                    i = j
                else:
                    if ch == "\n":
                        line += 1
                    buf.append(ch)
                    i += 1
            if buf or not parts:
                parts.append("".join(buf))
            toks.append(Tok("STR", parts, start_line, start, i))
        elif c == "'":  # plain text: nothing inside is special, '' stands for one quote
            start, start_line, buf = i, line, []
            i += 1
            while True:
                if i >= n:
                    raise TamasError("text is missing its closing quote", start_line)
                if src[i] == "'":
                    if src[i + 1:i + 2] != "'":
                        break
                    i += 1
                if src[i] == "\n":
                    line += 1
                buf.append(src[i])
                i += 1
            i += 1
            toks.append(Tok("STR", ["".join(buf)], start_line, start, i))
        elif id_start(c):
            j = i + 1
            while j < n and id_part(src[j]):
                j += 1
            word = unicodedata.normalize("NFC", src[i:j])
            if word in kw:
                toks.append(Tok("KW", kw[word], line, i, j))
            else:
                if toks and toks[-1].kind == "KW" and toks[-1].val == "unit":
                    known.add(word)
                toks.append(Tok("ID", word, line, i, j))
            i = j
        elif src[i:i + 2] in _OPS2:
            toks.append(Tok("OP", src[i:i + 2], line, i, i + 2))
            i += 2
        elif c in _OPS1:
            if c in "([{":
                stack.append(c)
            elif c in ")]}" and stack:
                stack.pop()
            toks.append(Tok("OP", c, line, i, i + 1))
            i += 1
        else:
            raise TamasError(f"unexpected character '{c}'", line)
    toks.append(Tok("NL", None, line, n, n))
    toks.append(Tok("EOF", None, line, n, n))
    return toks, lang, known


def translate(src, to):
    """Rewrite the keywords of a program into another language. Nothing else changes."""
    target = load_pack(to)
    m = _LANG_RE.match(src)
    lang = m.group(1) if m else None
    body = src[m.end():].lstrip("\n") if m else src

    def rewrite(text, known):
        toks, _, known = lex(text, lang, known)
        out, pos = [], 0
        for t in toks:
            if t.kind == "KW":
                out.append(text[pos:t.start] + target[t.val])
                pos = t.end
            elif t.kind == "STR":
                for p in t.val:
                    if isinstance(p, tuple):
                        out.append(text[pos:p[2]] + rewrite(p[1], known))
                        pos = p[2] + len(p[1])
        out.append(text[pos:])
        return "".join(out)

    result = rewrite(body, None)
    return result if to == "en" else f"@lang {to}\n{result}"
