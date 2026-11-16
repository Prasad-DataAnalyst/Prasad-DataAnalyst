// Tamas <-> JavaScript bridge. Tamas starts this with Node and sends one JSON request per line.
const path = require("path");
const readline = require("readline");
const { createRequire } = require("module");
const { pathToFileURL } = require("url");

const MARK = "@@TAMAS@@ ";
const roots = new Map();
let nextRoot = 1;

function keep(value) {
  roots.set(nextRoot, value);
  return nextRoot++;
}

async function load(base, name) {
  const local = name.startsWith(".") || path.isAbsolute(name);
  if (!local && name in globalThis) return globalThis[name];
  const req = createRequire(path.join(path.resolve(base), "tamas-bridge.js"));
  const target = local ? path.resolve(base, name) : name;
  try {
    return req(target);
  } catch (e) {
    if (e.code !== "ERR_REQUIRE_ESM") throw e;
    return await import(local ? pathToFileURL(target).href : target);
  }
}

function isPlain(v, depth = 0) {
  if (v === null || v === undefined) return true;
  const t = typeof v;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(v);
  if (t !== "object" || depth > 50) return false;
  if (Array.isArray(v)) return v.every((x) => isPlain(x, depth + 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.getOwnPropertyNames(v).length !== Object.keys(v).length) return false; // e.g. Math, JSON
  return Object.values(v).every((x) => isPlain(x, depth + 1));
}

function describe(v, store) {
  if (typeof v === "function") return store ? { kind: "function", root: keep(v), path: [] } : { kind: "function" };
  if (isPlain(v)) return { kind: "value", value: v === undefined ? null : v };
  return store ? { kind: "object", root: keep(v), path: [] } : { kind: "object" };
}

function walk(root, steps) {
  let parent = null;
  let value = roots.get(root);
  for (const step of steps) {
    if (value === null || value === undefined) throw new Error(`cannot read '${step}' of nothing`);
    parent = value;
    value = value[step];
  }
  return [parent, value];
}

function decode(v) {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === "object") {
    if (v.__tamas_ref__) return walk(v.__tamas_ref__.root, v.__tamas_ref__.path)[1];
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}

async function handle(req) {
  if (req.op === "load") return describe(await load(req.base, req.name), true);
  if (req.op === "get") {
    const [parent, value] = walk(req.root, req.path);
    const last = req.path[req.path.length - 1];
    if (value === undefined) {
      if (last === "new" && typeof parent === "function") return { kind: "function" };
      return { kind: "missing" };
    }
    return describe(value, false);
  }
  if (req.op === "call") {
    const args = decode(req.args);
    const [parent, value] = walk(req.root, req.path);
    const last = req.path[req.path.length - 1];
    if (value === undefined && last === "new" && typeof parent === "function") {
      return { kind: "object", root: keep(new parent(...args)), path: [] };
    }
    if (typeof value !== "function") throw new Error(`'${req.path.join(".")}' is not a function`);
    return describe(await value.apply(parent, args), true);
  }
  throw new Error("unknown request");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
(async () => {
  for await (const line of rl) {
    let reply;
    try {
      reply = { ok: true, ...(await handle(JSON.parse(line))) };
    } catch (e) {
      reply = { ok: false, error: String((e && e.message) || e) };
    }
    process.stdout.write(MARK + JSON.stringify(reply) + "\n");
  }
})();
