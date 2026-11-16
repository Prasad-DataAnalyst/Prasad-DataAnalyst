"""Tamas's built-in libraries that are implemented in the host language: math, xml, html, css, regex.

Libraries written in Tamas itself live next to this file in lib/ and are loaded the same way: use("name").
"""
import html as _html
import math
import os
import random
import re
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

from .errors import TamasError

LIB_DIR = os.path.join(os.path.dirname(__file__), "lib")

# ---- one document model for XML and HTML -------------------------------------------
# A node is a record {tag, attrs, children}; a child is another node or a piece of text.

_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
_RAW = {"script", "style"}
_AUTO_CLOSE = {"li": {"li"}, "p": {"p"}, "tr": {"tr", "td", "th"}, "td": {"td", "th"}, "th": {"td", "th"},
               "option": {"option"}, "dt": {"dt", "dd"}, "dd": {"dt", "dd"}}


def el(tag, attrs=None, children=None):
    if isinstance(children, str):
        children = [children]
    return {"tag": tag, "attrs": dict(attrs or {}), "children": list(children or [])}


def _is_node(n):
    return isinstance(n, dict) and "tag" in n and "children" in n


def _need_node(n):
    if not _is_node(n):
        raise TamasError("expected a document node: a record with tag, attrs and children")
    return n


def _descendants(node):
    for child in _need_node(node)["children"]:
        if _is_node(child):
            yield child
            yield from _descendants(child)


def find(node, tag):
    return [n for n in _descendants(node) if n["tag"] == tag]


def text_of(node):
    if isinstance(node, str):
        return node
    return "".join(text_of(c) for c in _need_node(node)["children"])


def _escape(s, quote=False):
    return _html.escape(str(s), quote=quote)


def _attrs(node):
    out = []
    for k, v in (node.get("attrs") or {}).items():
        out.append(f" {k}" if v is None or v is True else f' {k}="{_escape(v, True)}"')
    return "".join(out)


_SIMPLE = re.compile(r"([A-Za-z][\w-]*|\*)?((?:[.#][\w-]+)*)\Z")


def _matcher(part):
    m = _SIMPLE.match(part)
    if not m or not part:
        raise TamasError(f"select() understands tag, .class and #id joined by spaces, not '{part}'")
    tag = m.group(1)
    marks = re.findall(r"([.#])([\w-]+)", m.group(2))

    def test(n):
        attrs = n.get("attrs") or {}
        if tag and tag != "*" and n["tag"] != tag:
            return False
        for kind, name in marks:
            if kind == "#" and attrs.get("id") != name:
                return False
            if kind == "." and name not in str(attrs.get("class") or "").split():
                return False
        return True
    return test


def select(node, selector):
    """Nodes matching a simple CSS selector such as "ul.menu a" or "#main"."""
    current = [_need_node(node)]
    for part in selector.split():
        test, found, seen = _matcher(part), [], set()
        for start in current:
            for n in _descendants(start):
                if id(n) not in seen and test(n):
                    seen.add(id(n))
                    found.append(n)
        current = found
    return current


# ---- XML ---------------------------------------------------------------------------

def _from_etree(e):
    node = el(e.tag, e.attrib)
    if e.text and e.text.strip():
        node["children"].append(e.text)
    for child in e:
        if isinstance(child.tag, str):
            node["children"].append(_from_etree(child))
        if child.tail and child.tail.strip():
            node["children"].append(child.tail)
    return node


def xml_parse(text):
    try:
        return _from_etree(ET.fromstring(text))
    except ET.ParseError as e:
        raise TamasError(f"this is not well-formed XML: {e}")


def xml_write(node):
    if isinstance(node, str):
        return _escape(node)
    _need_node(node)
    if not re.match(r"[A-Za-z_][\w.:-]*\Z", str(node["tag"])):
        raise TamasError(f"'{node['tag']}' is not a valid XML tag name")
    inner = "".join(xml_write(c) for c in node["children"])
    return f"<{node['tag']}{_attrs(node)}>{inner}</{node['tag']}>" if inner else f"<{node['tag']}{_attrs(node)}/>"


# ---- HTML --------------------------------------------------------------------------

class _Builder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = el("document")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        if tag in _AUTO_CLOSE and self.stack[-1]["tag"] in _AUTO_CLOSE[tag] and len(self.stack) > 1:
            self.stack.pop()  # <li>one<li>two : the second <li> ends the first
        node = el(tag, dict(attrs))
        self.stack[-1]["children"].append(node)
        if tag not in _VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1]["children"].append(el(tag, dict(attrs)))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i]["tag"] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        if data.strip():
            self.stack[-1]["children"].append(data)


def html_parse(text):
    builder = _Builder()
    builder.feed(text)
    builder.close()
    return builder.root


def html_write(node, raw=False):
    if isinstance(node, str):
        return node if raw else _escape(node)
    _need_node(node)
    tag = node["tag"]
    inner = "".join(html_write(c, tag in _RAW) for c in node["children"])
    if tag == "document":
        return inner
    return f"<{tag}{_attrs(node)}>" if tag in _VOID else f"<{tag}{_attrs(node)}>{inner}</{tag}>"


# ---- CSS ---------------------------------------------------------------------------

def _css_split(text, i, stops):
    """Read up to one of the stop characters, skipping over quoted text and ( )."""
    start, depth = i, 0
    while i < len(text):
        c = text[i]
        if c in "\"'":
            j = i + 1
            while j < len(text) and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            i = j
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif depth <= 0 and c in stops:
            break
        i += 1
    return text[start:i].strip(), i


def _css_declarations(body):
    out, i = {}, 0
    while i < len(body):
        decl, i = _css_split(body, i, ";")
        i += 1
        if ":" in decl:
            prop, value = decl.split(":", 1)
            out[prop.strip()] = value.strip()
    return out


def _css_rules(text, i=0, nested=False):
    rules = []
    while i < len(text):
        head, i = _css_split(text, i, "{;}")
        if i >= len(text) or text[i] == "}":
            if head:
                raise TamasError(f"CSS: '{head[:30]}' is not followed by a {{ }} block")
            if i < len(text) and not nested:
                raise TamasError("CSS: there is a '}' with no matching '{'")
            return rules, i + 1
        if text[i] == ";":
            if head:
                rules.append({"at": head})
            i += 1
            continue
        end, depth = i + 1, 1
        while end < len(text) and depth:
            piece, end = _css_split(text, end, "{}")
            if end < len(text):
                depth += 1 if text[end] == "{" else -1
                end += 1
        if depth:
            raise TamasError(f"CSS: the block after '{head[:30]}' is never closed")
        body = text[i + 1:end - 1]
        if head.startswith("@"):
            if "{" in body:
                rules.append({"at": head, "rules": _css_rules(body, 0, True)[0]})
            else:
                rules.append({"at": head, "declarations": _css_declarations(body)})
        else:
            rules.append({"selector": " ".join(head.split()), "declarations": _css_declarations(body)})
        i = end
    return rules, i


def css_parse(text):
    return _css_rules(re.sub(r"/\*.*?\*/", "", text, flags=re.S))[0]


def css_write(rules, pad=""):
    out = []
    for r in rules:
        if not isinstance(r, dict):
            raise TamasError("a style sheet is a list of rule records")
        head = r.get("at") or r.get("selector")
        if head is None:
            raise TamasError("a CSS rule needs a selector (or 'at' for an @-rule)")
        if "rules" in r:
            out.append(f"{pad}{head} {{\n{css_write(r['rules'], pad + '  ')}{pad}}}\n")
        elif "declarations" in r:
            body = "".join(f"{pad}  {k}: {v};\n" for k, v in r["declarations"].items())
            out.append(f"{pad}{head} {{\n{body}{pad}}}\n")
        else:
            out.append(f"{pad}{head};\n")
    return "".join(out)


# ---- regular expressions -----------------------------------------------------------

def _rx(pattern):
    try:
        return re.compile(pattern)
    except re.error as e:
        raise TamasError(f"'{pattern}' is not a valid pattern: {e}")


def _groups(m):
    return m.group(0) if not m.re.groups else list(m.groups())


def rx_find(pattern, text):
    m = _rx(pattern).search(text)
    return _groups(m) if m else None


# ---- the registry ------------------------------------------------------------------

def _seeded(seed):
    random.seed(seed)


NATIVE = {
    "math": {
        "pi": math.pi, "e": math.e, "tau": math.tau,
        "sin": math.sin, "cos": math.cos, "tan": math.tan, "asin": math.asin, "acos": math.acos, "atan": math.atan,
        "atan2": math.atan2, "sinh": math.sinh, "cosh": math.cosh, "tanh": math.tanh, "hypot": math.hypot,
        "exp": math.exp, "log": math.log, "log2": math.log2, "log10": math.log10, "ceil": math.ceil,
        "gcd": math.gcd, "factorial": math.factorial, "is_nan": math.isnan,
        "random": random.random, "random_whole": random.randint, "seed": _seeded,
    },
    "xml": {"parse": xml_parse, "write": xml_write, "find": find, "text": text_of, "el": el},
    "html": {"parse": html_parse, "write": lambda node: html_write(node), "find": find, "select": select,
             "text": text_of, "el": el, "escape": lambda s: _escape(s, True)},
    "css": {"parse": css_parse, "write": lambda rules: css_write(rules)},
    "regex": {
        "find": rx_find,
        "find_all": lambda pattern, text: [_groups(m) for m in _rx(pattern).finditer(text)],
        "matches": lambda pattern, text: _rx(pattern).fullmatch(text) is not None,
        "replace": lambda pattern, text, new: _rx(pattern).sub(new, text),
        "split": lambda pattern, text: _rx(pattern).split(text),
    },
}


def available():
    return sorted(list(NATIVE) + [f[:-4] for f in os.listdir(LIB_DIR) if f.endswith(".tms")])
