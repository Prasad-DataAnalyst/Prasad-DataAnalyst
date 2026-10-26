/**
 * Runs the independent Python oracles in tests/oracle (python3 -I, so nothing beside the input
 * files is imported) and LibreOffice, and returns what they report.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORACLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'oracle');

export type OracleScript = 'check_csv.py' | 'check_xlsx.py' | 'check_geojson.py' | 'check_package.py' | 'canonical.py';

export function runOracle(script: OracleScript, args: string[]): Record<string, unknown> {
  const r = spawnSync('python3', ['-I', join(ORACLE_DIR, script), ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 ** 2,
  });
  if (r.status !== 0)
    throw new Error(`${script} failed: ${r.stderr || r.error?.message || `exit ${String(r.status)}`}`);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

/** The first sheet of a workbook as LibreOffice reads it, as rows of text. */
export function libreOfficeRoundTrip(xlsxPath: string): string[][] {
  const dir = mkdtempSync(join(tmpdir(), 'tw-lo-'));
  try {
    const r = spawnSync('sh', [join(ORACLE_DIR, 'lo_roundtrip.sh'), xlsxPath, dir], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 ** 2,
    });
    if (r.status !== 0) throw new Error(`LibreOffice round trip failed: ${r.stderr}`);
    return JSON.parse(r.stdout) as string[][];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Extracts one entry of a ZIP package to a file, with Python's zipfile. */
export function extract(zipPath: string, entry: string, to: string): void {
  const r = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      'import sys, zipfile; open(sys.argv[3], "wb").write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))',
      zipPath,
      entry,
      to,
    ],
    {
      encoding: 'utf8',
    },
  );
  if (r.status !== 0) throw new Error(`extracting ${entry} failed: ${r.stderr}`);
}

export const CANONICAL_VECTORS = join(ORACLE_DIR, '..', '..', 'src', 'model', '__fixtures__', 'canonical-vectors.json');
