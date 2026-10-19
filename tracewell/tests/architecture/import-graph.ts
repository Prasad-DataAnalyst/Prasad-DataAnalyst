/**
 * Import parsing and module-boundary checking for tests/architecture/boundaries.test.ts.
 *
 * Everything here works on strings (paths and source text), so the checker can be tested on
 * in-memory file lists without writing files. Paths are repository-relative to tracewell/ and use
 * forward slashes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import ts from 'typescript';

export type RefKind =
  | 'import'
  | 'export'
  | 'dynamic-import'
  | 'require'
  | 'import-type'
  | 'url'
  | 'glob'
  /** A specifier that is not a string literal, so nobody can tell what it loads. */
  | 'computed'
  /** JSX, which the automatic runtime compiles to an import of react/jsx-runtime. */
  | 'jsx';

/** One module reference found in a source file. */
export interface ImportRef {
  specifier: string;
  line: number;
  kind: RefKind;
}

export interface SourceFile {
  path: string;
  source: string;
}

export type ViolationKind =
  | 'forbidden-module'
  | 'deep-import'
  | 'cross-module-relative'
  | 'forbidden-package'
  | 'node-only'
  | 'unknown-module'
  | 'self-import'
  | 'outside-module'
  | 'computed-import';

export interface Violation {
  file: string;
  line: number;
  specifier: string;
  kind: ViolationKind;
  message: string;
}

export interface BoundaryPolicy {
  /** Internal modules each module may import (SAD section 6.1). */
  allowed: Readonly<Record<string, readonly string[]>>;
  /** npm runtime packages each module may import. */
  allowedNpm: Readonly<Record<string, readonly string[]>>;
  /** Folder of each module. */
  moduleDirs: Readonly<Record<string, string>>;
  /** Node-only entry points: specifier to file, e.g. '@tw/io/node' to 'src/io/node.ts'. */
  nodeEntries: Readonly<Record<string, string>>;
  /** Modules that only ever run in Node, so Node built-ins are fine in all of their files. */
  nodeModules: readonly string[];
  /** Modules that consist only of test code. */
  testModules: readonly string[];
  /** Development packages that any test file may use. */
  testNpm: readonly string[];
}

const NODE_BUILTINS = new Set(builtinModules);
// JavaScript too: tsconfig sets allowJs, so a .js file would otherwise be an unchecked way in.
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const JSX_RUNTIME = 'react/jsx-runtime';

/** Files the boundary check reads: TypeScript and JavaScript sources. */
export function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.test(path);
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

// ---------------------------------------------------------------------------------------------
// Parsing

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function stringValue(node: ts.Node | undefined): string | null {
  if (!node) return null;
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

/** `import.meta.<name>`, e.g. `import.meta.url` or `import.meta.glob`. */
function isImportMeta(node: ts.Node | undefined, name: string): boolean {
  return (
    node !== undefined &&
    ts.isPropertyAccessExpression(node) &&
    node.name.text === name &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

type RefHit = { specifier: string; kind: RefKind };

/** A literal specifier, or a `computed` reference carrying the expression text for the report. */
function literalOr(node: ts.Node | undefined, kind: RefKind, sf: ts.SourceFile): RefHit {
  const value = stringValue(node);
  return value === null ? { specifier: node ? node.getText(sf) : '', kind: 'computed' } : { specifier: value, kind };
}

/** Vite's `import.meta.glob('./x/*.ts')` or `import.meta.glob(['a', '!b'])`: one reference per pattern. */
function globRefs(argument: ts.Expression | undefined, sf: ts.SourceFile): RefHit[] {
  if (argument && ts.isArrayLiteralExpression(argument)) {
    return argument.elements.map((element) => literalOr(element, 'glob', sf));
  }
  return [literalOr(argument, 'glob', sf)];
}

function callRefs(node: ts.CallExpression, sf: ts.SourceFile): RefHit[] {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return [literalOr(node.arguments[0], 'dynamic-import', sf)];
  if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
    return [literalOr(node.arguments[0], 'require', sf)];
  }
  if (isImportMeta(node.expression, 'glob')) return globRefs(node.arguments[0], sf);
  return [];
}

/** The module references a single AST node makes, if any. */
function refsOf(node: ts.Node, sf: ts.SourceFile): RefHit[] {
  if (ts.isImportDeclaration(node)) return withKind(stringValue(node.moduleSpecifier), 'import');
  if (ts.isExportDeclaration(node)) return withKind(stringValue(node.moduleSpecifier), 'export');
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return withKind(stringValue(node.moduleReference.expression), 'require');
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    return withKind(stringValue(node.argument.literal), 'import-type');
  }
  if (ts.isCallExpression(node)) return callRefs(node, sf);
  // `new URL('./x.ts', import.meta.url)` is how Vite bundles workers and assets.
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
    if (isImportMeta(node.arguments?.[1], 'url')) return [literalOr(node.arguments?.[0], 'url', sf)];
  }
  return [];
}

function withKind(specifier: string | null, kind: RefKind): RefHit[] {
  return specifier === null ? [] : [{ specifier, kind }];
}

function isJsx(node: ts.Node): boolean {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

interface ScanResult {
  refs: ImportRef[];
  /** Line of the first JSX expression, or null when the file has none. */
  jsxLine: number | null;
}

function scanSource(source: string, fileName: string): ScanResult {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const refs: ImportRef[] = [];
  let jsxLine: number | null = null;
  const visit = (node: ts.Node): void => {
    for (const ref of refsOf(node, sf)) refs.push({ ...ref, line: lineOf(sf, node) });
    if (jsxLine === null && isJsx(node)) jsxLine = lineOf(sf, node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { refs, jsxLine };
}

/**
 * Every module reference in a TypeScript or JavaScript source text: static imports and re-exports
 * (type-only included), dynamic import(), require(), `import('x')` types, `import.meta.glob()`
 * patterns and `new URL(..., import.meta.url)`. A specifier that is not a string literal comes back
 * as kind `computed`. Uses the TypeScript parser, so comments and string contents are never
 * mistaken for imports.
 */
export function parseImports(source: string, fileName = 'file.ts'): ImportRef[] {
  return scanSource(source, fileName).refs;
}

// ---------------------------------------------------------------------------------------------
// Classification

export type Target =
  | { kind: 'module'; module: string; deep: boolean }
  | { kind: 'relative'; path: string }
  | { kind: 'builtin'; name: string }
  | { kind: 'package'; name: string };

/** The npm package a bare specifier names: '@scope/pkg/sub' gives '@scope/pkg', 'pkg/sub' gives 'pkg'. */
export function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** What a specifier written in `fromFile` points at. */
export function classify(specifier: string, fromFile: string): Target {
  const bare = specifier.replace(/[?#].*$/, '');
  if (bare.startsWith('.') || bare.startsWith('/')) {
    const joined = bare.startsWith('/') ? bare.slice(1) : posix.join(posix.dirname(fromFile), bare);
    return { kind: 'relative', path: posix.normalize(joined) };
  }
  if (bare.startsWith('@tw/')) {
    const [module = '', ...rest] = bare.slice('@tw/'.length).split('/');
    return { kind: 'module', module, deep: rest.length > 0 };
  }
  if (bare.startsWith('node:') || NODE_BUILTINS.has(packageName(bare))) return { kind: 'builtin', name: bare };
  return { kind: 'package', name: packageName(bare) };
}

/** The module that owns a path (longest folder match), or null when no module does. */
export function moduleOf(path: string, moduleDirs: Readonly<Record<string, string>>): string | null {
  let best: string | null = null;
  let bestLength = -1;
  for (const [module, dir] of Object.entries(moduleDirs)) {
    if ((path === dir || path.startsWith(`${dir}/`)) && dir.length > bestLength) {
      best = module;
      bestLength = dir.length;
    }
  }
  return best;
}

/** Test code: `*.test.ts(x)`, `*.spec.ts(x)` (or .js) and anything under `__tests__` or `__fixtures__`. */
export function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)__(?:tests|fixtures)__\//.test(path);
}

/** Every module reachable from `module` through the allow-list (excluding itself unless cyclic). */
export function closure(module: string, allowed: Readonly<Record<string, readonly string[]>>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(allowed[module] ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(allowed[next] ?? []));
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// Checking

interface FileContext {
  path: string;
  module: string;
  test: boolean;
  nodeAllowed: boolean;
  internal: ReadonlySet<string>;
  npm: ReadonlySet<string>;
}

/**
 * What one file may import. Production code gets exactly its module's allow-list. Test code may
 * also reach everything its module reaches transitively, the fixtures library, the Node-only
 * entries and the test tools, but never a module outside its closure (so UI tests still cannot
 * import the engine).
 */
function contextFor(path: string, module: string, policy: BoundaryPolicy): FileContext {
  const test = policy.testModules.includes(module) || isTestFile(path);
  const direct = policy.allowed[module] ?? [];
  if (!test) {
    const nodeAllowed = policy.nodeModules.includes(module) || Object.values(policy.nodeEntries).includes(path);
    return {
      path,
      module,
      test,
      nodeAllowed,
      internal: new Set(direct),
      npm: new Set(policy.allowedNpm[module] ?? []),
    };
  }
  const internal = new Set([
    module,
    'fixtures',
    ...closure(module, policy.allowed),
    ...closure('fixtures', policy.allowed),
  ]);
  const npm = new Set([...policy.testNpm, ...[...internal].flatMap((m) => policy.allowedNpm[m] ?? [])]);
  return { path, module, test, nodeAllowed: true, internal, npm };
}

type Finding = Omit<Violation, 'file' | 'line' | 'specifier'>;

function checkModuleRef(
  target: { module: string; deep: boolean },
  specifier: string,
  ctx: FileContext,
  policy: BoundaryPolicy,
): Finding | null {
  if (!(target.module in policy.moduleDirs)) {
    return { kind: 'unknown-module', message: `"${specifier}" names no module; see SAD section 6.1.` };
  }
  const nodeEntry = specifier in policy.nodeEntries;
  if (target.deep && !nodeEntry) {
    return {
      kind: 'deep-import',
      message: `Deep import "${specifier}": import "@tw/${target.module}" and export what you need from its index.ts.`,
    };
  }
  if (nodeEntry && !ctx.nodeAllowed) {
    return { kind: 'node-only', message: `"${specifier}" is Node-only; browser code must not import it.` };
  }
  if (target.module === ctx.module) {
    return ctx.test
      ? null
      : {
          kind: 'self-import',
          message: `A module must not import itself through "${specifier}"; use a relative path.`,
        };
  }
  if (ctx.internal.has(target.module)) return null;
  const allowed = [...ctx.internal].sort().join(', ') || 'nothing';
  return {
    kind: 'forbidden-module',
    message: `${ctx.module} may not depend on ${target.module} (allowed: ${allowed}); see SAD section 6.1.`,
  };
}

/** TypeScript ESM code may name a file as `x`, `x.ts` or `x.js`; all three are the same module. */
function withoutExtension(path: string): string {
  return path.replace(/\.(?:[cm]?[jt]s|tsx|jsx)$/, '');
}

function checkRelativeRef(path: string, kind: RefKind, ctx: FileContext, policy: BoundaryPolicy): Finding | null {
  const owner = moduleOf(path, policy.moduleDirs);
  const nodeEntry = Object.values(policy.nodeEntries).some(
    (entry) => withoutExtension(entry) === withoutExtension(path),
  );
  if (owner === ctx.module) {
    return nodeEntry && !ctx.nodeAllowed
      ? { kind: 'node-only', message: `${path} is Node-only; browser code must not import it.` }
      : null;
  }
  // A worker or asset URL into another module is a dependency like any other.
  if (kind === 'url' && owner !== null && ctx.internal.has(owner)) return null;
  return {
    kind: 'cross-module-relative',
    message: `Relative path leaves module ${ctx.module} (reaches ${owner ?? path}); import "@tw/<module>" instead.`,
  };
}

function checkRef(ref: ImportRef, ctx: FileContext, policy: BoundaryPolicy): Finding | null {
  if (ref.kind === 'computed') {
    return {
      kind: 'computed-import',
      message: `Computed module specifier ${ref.specifier || '(none)'}: use a string literal so the boundary check can verify it.`,
    };
  }
  if (ref.kind === 'jsx' && !ctx.npm.has('react')) {
    return {
      kind: 'forbidden-package',
      message: `JSX compiles to an import of ${JSX_RUNTIME}, and ${ctx.module} may not use React.`,
    };
  }
  // A negated glob pattern ('!./x.ts') still names the folder it reaches into.
  const specifier = ref.kind === 'glob' ? ref.specifier.replace(/^!/, '') : ref.specifier;
  const target = classify(specifier, ctx.path);
  switch (target.kind) {
    case 'module':
      return checkModuleRef(target, specifier, ctx, policy);
    case 'relative':
      return checkRelativeRef(target.path, ref.kind, ctx, policy);
    case 'builtin':
      return ctx.nodeAllowed
        ? null
        : { kind: 'node-only', message: `Node built-in "${ref.specifier}" in code that runs in the browser.` };
    case 'package':
      return ctx.npm.has(target.name)
        ? null
        : {
            kind: 'forbidden-package',
            message: `${ctx.module} may not import the npm package "${target.name}"${ctx.test ? ' in tests' : ''}.`,
          };
  }
}

/** Checks every file against the policy and returns the violations in file and line order. */
export function checkBoundaries(files: readonly SourceFile[], policy: BoundaryPolicy): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const module = moduleOf(file.path, policy.moduleDirs);
    if (module === null) {
      if (!file.path.endsWith('.d.ts')) {
        violations.push({
          file: file.path,
          line: 1,
          specifier: '',
          kind: 'outside-module',
          message: `${file.path} belongs to no module; move it into a module folder (SAD section 5.2).`,
        });
      }
      continue;
    }
    const ctx = contextFor(file.path, module, policy);
    const { refs, jsxLine } = scanSource(file.source, file.path);
    const implicit: ImportRef[] = jsxLine === null ? [] : [{ specifier: JSX_RUNTIME, line: jsxLine, kind: 'jsx' }];
    for (const ref of [...refs, ...implicit]) {
      const finding = checkRef(ref, ctx, policy);
      if (finding) violations.push({ file: file.path, line: ref.line, specifier: ref.specifier, ...finding });
    }
  }
  // Code-point order, not locale order, so the report reads the same on every machine.
  return violations.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations.map((v) => `${v.file}:${v.line} [${v.kind}] ${v.message}`).join('\n');
}

// ---------------------------------------------------------------------------------------------
// File system (the only part that touches disk)

function walk(root: string, rel: string, skip: ReadonlySet<string>): string[] {
  let entries;
  try {
    entries = readdirSync(posix.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return skip.has(path) ? [] : walk(root, path, skip);
    return entry.isFile() && isSourcePath(entry.name) ? [path] : [];
  });
}

/** TypeScript and JavaScript files of the given folders under root, read into memory. */
export function readSourceFiles(root: string, folders: readonly string[], skip: readonly string[] = []): SourceFile[] {
  const skipSet = new Set(skip);
  return folders
    .flatMap((folder) => walk(root, folder, skipSet))
    .sort()
    .map((path) => ({ path, source: readFileSync(posix.join(root, path), 'utf8') }));
}
