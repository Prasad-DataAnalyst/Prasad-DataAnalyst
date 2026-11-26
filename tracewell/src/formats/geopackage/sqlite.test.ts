/**
 * The SQLite writer and reader, checked against SQLite itself (Python's sqlite3 module, SAD
 * section 13.1): every database written passes PRAGMA integrity_check and reads back as written,
 * and databases SQLite writes read as SQLite reads them. Skipped where Python 3 is not installed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SqliteDatabase,
  SqliteFormatError,
  columnValue,
  decodeRecord,
  encodeRecord,
  parseCreateTable,
  varintBytes,
  writeSqlite,
  type SqlValue,
  type SqliteTableDef,
} from './sqlite';

const PYTHON = spawnSync('python3', ['-I', '-c', 'import sqlite3'], { stdio: 'ignore' }).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'tw-sqlite-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs Python with the sqlite3 module on the given files; its printed JSON. */
function python(script: string, ...args: string[]): unknown {
  const r = spawnSync('python3', ['-I', '-c', script, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

/** What SQLite makes of each file: its integrity check and every table's rows, by rowid. */
const DUMP = String.raw`
import base64, json, sqlite3, sys
out = []
for path in sys.argv[1:]:
    con = sqlite3.connect('file:' + path + '?mode=ro', uri=True)
    check = [r[0] for r in con.execute('PRAGMA integrity_check')]
    tables = {}
    for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"):
        rows = []
        for row in con.execute('SELECT rowid, * FROM "%s" ORDER BY rowid' % name.replace('"', '""')):
            rows.append([
                {'b': base64.b64encode(v).decode()} if isinstance(v, bytes)
                else {'i': str(v)} if isinstance(v, int) and not isinstance(v, bool)
                else v
                for v in row
            ])
        tables[name] = rows
    meta = {k: con.execute('PRAGMA ' + k).fetchone()[0] for k in ['application_id', 'user_version', 'page_size', 'encoding']}
    out.append({'check': check, 'tables': tables, 'meta': meta})
print(json.dumps(out))
`;

type Dumped = {
  check: string[];
  tables: Record<string, (string | number | null | { i: string } | { b: string })[][]>;
  meta: Record<string, string | number>;
};

/** A value as the dump writes it. */
function dumped(v: SqlValue): string | number | null | { i: string } | { b: string } {
  if (typeof v === 'bigint') return { i: String(v) };
  if (v instanceof Uint8Array) return { b: Buffer.from(v).toString('base64') };
  return v;
}

let n = 0;
function save(bytes: Uint8Array): string {
  const path = join(dir, `db-${++n}.sqlite`);
  writeFileSync(path, bytes);
  return path;
}

function table(name: string, sql: string, rows: [bigint, SqlValue[]][], indexes?: SqliteTableDef['indexes']) {
  return { name, sql, rows, ...(indexes === undefined ? {} : { indexes }) };
}

describe('varints and records', () => {
  it('writes varints as the file format does, the ninth byte holding eight bits', () => {
    expect(varintBytes(0)).toEqual([0]);
    expect(varintBytes(127)).toEqual([0x7f]);
    expect(varintBytes(128)).toEqual([0x81, 0x00]);
    expect(varintBytes(16_383)).toEqual([0xff, 0x7f]);
    expect(varintBytes(16_384)).toEqual([0x81, 0x80, 0x00]);
    expect(varintBytes(2n ** 56n - 1n)).toHaveLength(8);
    expect(varintBytes(2n ** 56n)).toHaveLength(9);
    expect(varintBytes(-1)).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(varintBytes(2 ** 48)).toEqual(varintBytes(2n ** 48n));
  });

  it('gives each integer the fewest bytes and reads every value back', () => {
    const values: SqlValue[] = [
      null,
      0n,
      1n,
      2n,
      -1n,
      127n,
      128n,
      -128n,
      -129n,
      32_767n,
      32_768n,
      8_388_607n,
      8_388_608n,
      2_147_483_647n,
      2_147_483_648n,
      0x7fff_ffff_ffffn,
      0x8000_0000_0000n,
      -(2n ** 63n),
      2n ** 63n - 1n,
      0.1,
      -0,
      1e308,
      '',
      'Brent — 北海',
      new Uint8Array([0, 255, 7]),
    ];
    const record = encodeRecord(values);
    // Serial types: 0, 8, 9, then int8 for 2 and -1, and the sizes as SQLite chooses them.
    expect([...record.subarray(1, 20)]).toEqual([0, 8, 9, 1, 1, 1, 2, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 6]);
    expect(decodeRecord(record)).toEqual(values);
  });

  it('refuses a record that runs past its end or uses a reserved type', () => {
    expect(() => decodeRecord(new Uint8Array([2, 21]))).toThrow(SqliteFormatError);
    expect(() => decodeRecord(new Uint8Array([2, 10]))).toThrow('reserved serial type 10');
    expect(() => decodeRecord(new Uint8Array([5, 1]))).toThrow(SqliteFormatError);
  });
});

describe('parseCreateTable', () => {
  it('finds the columns, their declared types and the rowid alias', () => {
    expect(
      parseCreateTable(
        'CREATE TABLE "my ""t""" ( "fid" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, [geom] POINT, -- a note\n' +
          "`a b` VARCHAR(20) DEFAULT 'x,y', c DOUBLE PRECISION, d, e INTEGER, CONSTRAINT u UNIQUE (c, d))",
      ),
    ).toEqual({
      name: 'my "t"',
      withoutRowid: false,
      columns: [
        { name: 'fid', type: 'INTEGER', rowid: true },
        { name: 'geom', type: 'POINT', rowid: false },
        { name: 'a b', type: 'VARCHAR(20)', rowid: false },
        { name: 'c', type: 'DOUBLE PRECISION', rowid: false },
        { name: 'd', type: '', rowid: false },
        { name: 'e', type: 'INTEGER', rowid: false },
      ],
    });
    const pk = (sql: string) => parseCreateTable(sql).columns.map((c) => c.rowid);
    expect(pk('CREATE TABLE t (a integer, b TEXT, PRIMARY KEY (a))')).toEqual([true, false]);
    expect(pk('CREATE TABLE t (a INTEGER PRIMARY KEY DESC)')).toEqual([false]);
    expect(pk('CREATE TABLE t (a INT PRIMARY KEY)')).toEqual([false]);
    expect(pk('CREATE TABLE t (a INTEGER, b INTEGER, PRIMARY KEY (a, b))')).toEqual([false, false]);
    expect(pk('CREATE TABLE t (a INTEGER PRIMARY KEY, b) WITHOUT ROWID')).toEqual([false, false]);
    expect(parseCreateTable('create temp table if not exists main.x(y)').name).toBe('x');
    expect(() => parseCreateTable('CREATE TABLE t AS SELECT 1')).toThrow(SqliteFormatError);
    expect(() => parseCreateTable('CREATE TABLE t (a')).toThrow(SqliteFormatError);
  });
});

describe.skipIf(!PYTHON)('writeSqlite against SQLite', () => {
  it('writes small tables, an automatic index, negative and large rowids, and the header fields', () => {
    const bytes = writeSqlite({ applicationId: 0x47504b47, userVersion: 10200 }, [
      table(
        't',
        'CREATE TABLE t (a TEXT NOT NULL PRIMARY KEY, b, c)',
        [[1n, ['k', 2.5, new Uint8Array([1, 2])]]],
        [{ name: 'sqlite_autoindex_t_1', entries: [['k', 1n]] }],
      ),
      table(
        'r',
        'CREATE TABLE r (id INTEGER PRIMARY KEY, v)',
        [-(2n ** 63n), -1n, 0n, 1n, 2n ** 40n, 2n ** 62n].map((id): [bigint, SqlValue[]] => [id, [null, String(id)]]),
      ),
      table('empty', 'CREATE TABLE empty (x)', []),
    ]);
    expect(bytes.length % 4096).toBe(0);
    const [db] = python(DUMP, save(bytes)) as Dumped[];
    expect(db?.check).toEqual(['ok']);
    expect(db?.meta).toEqual({ application_id: 0x47504b47, user_version: 10200, page_size: 4096, encoding: 'UTF-8' });
    expect(db?.tables['t']).toEqual([[{ i: '1' }, 'k', 2.5, { b: 'AQI=' }]]);
    expect(db?.tables['r']?.map((r) => r[0])).toEqual(
      ['-9223372036854775808', '-1', '0', '1', '1099511627776', '4611686018427387904'].map((i) => ({ i })),
    );
    expect(db?.tables['r']?.map((r) => r[2])).toEqual(db?.tables['r']?.map((r) => (r[0] as { i: string }).i));
    expect(db?.tables['empty']).toEqual([]);
  });

  it('writes deep trees, records that spill to overflow pages, and reads them back as SQLite does', () => {
    const big = 'x'.repeat(10_000);
    const rows = (count: number, value: (i: number) => SqlValue[]): [bigint, SqlValue[]][] =>
      Array.from({ length: count }, (_, i) => [BigInt(i + 1), value(i)]);
    const tables = [
      // 1,500-byte records, two to a leaf: three levels of pages.
      table(
        'wide',
        'CREATE TABLE wide (a)',
        rows(1_200, (i) => [`${i}`.padEnd(1_500, '.')]),
      ),
      // Many small records: hundreds of leaves under one interior page.
      table(
        'narrow',
        'CREATE TABLE narrow (a, b)',
        rows(60_000, (i) => [BigInt(i * 7919), i / 3]),
      ),
      // Records a little past one page, and far past many.
      table(
        'spill',
        'CREATE TABLE spill (a, b)',
        rows(40, (i) => [big.slice(0, 3_990 + i * 97), new Uint8Array(i * 401)]),
      ),
    ];
    const bytes = writeSqlite({ applicationId: 0, userVersion: 0 }, tables);
    const [db] = python(DUMP, save(bytes)) as Dumped[];
    expect(db?.check).toEqual(['ok']);
    for (const t of tables) {
      expect(db?.tables[t.name], t.name).toEqual(t.rows.map(([id, vs]) => [dumped(id), ...vs.map(dumped)]));
    }
    const ours = new SqliteDatabase(bytes);
    const roots = new Map(ours.schema().map((s) => [s.name, s.root]));
    for (const t of tables) {
      const read = [...ours.rows(roots.get(t.name) as number)].map((r) => [r.rowid, ...r.values]);
      expect(read, t.name).toEqual(t.rows.map(([id, vs]) => [id, ...vs]));
    }
  });

  it('puts the schema on leaves below page 1 when it does not fit there, at every size near the edge', () => {
    // Statements of growing length: the schema fits page 1, then fits one leaf but not page 1, then needs two.
    const files: string[] = [];
    const sizes: number[] = [];
    for (let pad = 3_700; pad <= 4_200; pad += 7) {
      sizes.push(pad);
      files.push(
        save(
          writeSqlite({ applicationId: 0, userVersion: 0 }, [
            table('a', `CREATE TABLE a (x /*${'a'.repeat(pad)}*/)`, [[1n, [1n]]]),
          ]),
        ),
      );
    }
    files.push(
      save(
        writeSqlite(
          { applicationId: 0, userVersion: 0 },
          Array.from({ length: 150 }, (_, i) =>
            table(`t${i}`, `CREATE TABLE t${i} (x, y /*${'z'.repeat(i * 3)}*/)`, []),
          ),
        ),
      ),
    );
    const dbs = python(DUMP, ...files) as Dumped[];
    dbs.forEach((db, i) => expect(db.check, `case ${sizes[i] ?? 'many tables'}`).toEqual(['ok']));
    expect(Object.keys(dbs[dbs.length - 1]?.tables ?? {})).toHaveLength(150);
  });

  it('reads what SQLite writes: other page sizes, UTF-16 text, deleted rows and overflow', () => {
    const made = String.raw`
import json, sqlite3, sys
for path, page, enc in zip(sys.argv[1::3], sys.argv[2::3], sys.argv[3::3]):
    con = sqlite3.connect(path)
    con.execute('PRAGMA page_size = ' + page)
    con.execute('PRAGMA encoding = "' + enc + '"')
    con.execute('CREATE TABLE "a ""b""" (id INTEGER PRIMARY KEY, t TEXT, r REAL, b BLOB, i INTEGER)')
    rows = [(i * 3, ('wells ' * (i % 900)) + 'Ø', i / 7, bytes(range(i % 256)) * (i % 50), (-1) ** i * i * 2 ** (i % 50))
            for i in range(1, 3000)]
    con.executemany('INSERT INTO "a ""b""" VALUES (?, ?, ?, ?, ?)', rows)
    con.execute('DELETE FROM "a ""b""" WHERE id % 5 = 0')
    con.commit()
    con.close()
print(json.dumps([]))
`;
    const cases = [
      ['512', 'UTF-8'],
      ['65536', 'UTF-16le'],
      ['4096', 'UTF-16be'],
    ] as const;
    const paths = cases.map((_, i) => join(dir, `made-${i}.sqlite`));
    python(made, ...cases.flatMap(([page, enc], i) => [paths[i] as string, page, enc]));
    const dumps = python(DUMP, ...paths) as Dumped[];
    cases.forEach((_, i) => {
      const db = new SqliteDatabase(new Uint8Array(readFileSync(paths[i] as string)));
      const schema = db.schema();
      expect(schema.map((s) => s.name)).toEqual(['a "b"']);
      const t = parseCreateTable(schema[0]?.sql ?? '');
      const rows = [...db.rows(schema[0]?.root ?? 0)].map((r) => [
        r.rowid,
        ...t.columns.map((c, j) => (c.rowid ? r.rowid : columnValue(c, r.values[j] ?? null))),
      ]);
      expect(rows.map((r) => r.map((v) => dumped(v as SqlValue)))).toEqual(dumps[i]?.tables['a "b"']);
    });
  });
});

describe('SqliteDatabase', () => {
  it('refuses a file that is not SQLite, and pages that point outside the file or loop', () => {
    expect(() => new SqliteDatabase(new Uint8Array(200))).toThrow('does not start with the SQLite header');
    const bytes = writeSqlite({ applicationId: 0, userVersion: 0 }, [
      table(
        't',
        'CREATE TABLE t (a)',
        Array.from({ length: 600 }, (_, i): [bigint, SqlValue[]] => [BigInt(i + 1), [`${i}`.repeat(20)]]),
      ),
    ]);
    const db = new SqliteDatabase(bytes);
    const root = db.schema()[0]?.root as number;
    // The root is an interior page; point its right child at itself, then past the end.
    const looped = bytes.slice();
    const at = (root - 1) * 4096;
    new DataView(looped.buffer).setUint32(at + 8, root, false);
    expect(() => [...new SqliteDatabase(looped).rows(root)]).toThrow(`visits page ${root} twice`);
    new DataView(looped.buffer).setUint32(at + 8, 9_999, false);
    expect(() => [...new SqliteDatabase(looped).rows(root)]).toThrow('page 9999, outside the file');
    expect(() => [...new SqliteDatabase(bytes.subarray(0, 4096 * 3)).rows(root)]).toThrow(SqliteFormatError);
  });
});
