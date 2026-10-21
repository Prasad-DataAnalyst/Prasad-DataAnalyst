// @ts-check
/**
 * Streams a large, seeded daily well report to disk for the @slow tests and benchmarks (SAD section
 * 13.2, "Generated in tests"). Never committed.
 *
 * Usage: node fixtures/generators/gen-large-csv.mjs --rows 1000000 --seed 42 --out <path>
 *
 * The columns are those of csv_well_daily_golden.csv plus a water rate: 10 in all. Rows run date by
 * date over 500 wells. The same seed and row count always give the same bytes: the values use only
 * the seeded generator, basic arithmetic and toFixed, which ECMAScript defines exactly (no Math.sin,
 * whose precision may differ between engines).
 */
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { isEntryScript, mulberry32 } from './shared.mjs';

export const HEADER =
  'well_id,date,latitude,longitude,Pressure (psia),Temperature (degF),Oil (bbl/d),Gas (Mscf/d),Water (bbl/d),Water cut (%)';

const WELLS = 500;
const START = Date.UTC(2000, 0, 1);
const DAY_MS = 86_400_000;
/** Rows joined into one write; large enough to keep the stream busy, small enough to stay in memory. */
const ROWS_PER_CHUNK = 10_000;

/**
 * @typedef {{ id: string; lat: string; lon: string; p: number; t: number; oil: number; gor: number; water: number;
 *   decline: number }} Well
 */

/**
 * Fixed per-well parameters, drawn first so that a longer file starts with the same rows.
 * @param {() => number} rand
 * @returns {Well[]}
 */
function makeWells(rand) {
  /** @type {Well[]} */
  const wells = [];
  for (let i = 0; i < WELLS; i++) {
    wells.push({
      id: `W-${String(i + 1).padStart(5, '0')}`,
      lat: (56 + rand() * 4).toFixed(5),
      lon: (1 + rand() * 3).toFixed(5),
      p: 1500 + rand() * 1000,
      t: 170 + rand() * 25,
      oil: 800 + rand() * 2800,
      gor: 0.8 + rand() * 0.8,
      water: 50 + rand() * 600,
      decline: 0.0001 + rand() * 0.0004,
    });
  }
  return wells;
}

/**
 * One data row. The decline is a fraction per day, floored so rates stay positive.
 * @param {Well} w
 * @param {number} day
 * @param {string} date
 * @param {() => number} rand
 */
function row(w, day, date, rand) {
  const factor = Math.max(0.05, 1 - w.decline * day);
  const oil = w.oil * factor * (0.98 + rand() * 0.04);
  const gas = oil * w.gor * (0.98 + rand() * 0.04);
  const water = w.water * (2 - factor) * (0.97 + rand() * 0.06);
  const pressure = Math.max(50, w.p * factor + (rand() - 0.5) * 8);
  const temperature = w.t + (rand() - 0.5) * 1.2;
  const cut = (water / (oil + water)) * 100;
  return [
    w.id,
    date,
    w.lat,
    w.lon,
    pressure.toFixed(1),
    temperature.toFixed(2),
    oil.toFixed(1),
    gas.toFixed(1),
    water.toFixed(1),
    cut.toFixed(2),
  ].join(',');
}

/**
 * Yields the file in chunks of whole lines, header first.
 * @param {number} rows
 * @param {number} seed
 */
export function* largeCsvChunks(rows, seed) {
  const rand = mulberry32(seed);
  const wells = makeWells(rand);
  yield `${HEADER}\n`;
  let lines = [];
  for (let n = 0; n < rows; n++) {
    const day = Math.floor(n / WELLS);
    const well = wells[n % WELLS];
    if (well === undefined) throw new Error('unreachable: well index out of range');
    lines.push(row(well, day, new Date(START + day * DAY_MS).toISOString().slice(0, 10) + 'T06:00:00', rand));
    if (lines.length === ROWS_PER_CHUNK) {
      yield `${lines.join('\n')}\n`;
      lines = [];
    }
  }
  if (lines.length > 0) yield `${lines.join('\n')}\n`;
}

/**
 * Writes the file, waiting whenever the stream's buffer is full so memory stays flat.
 * @param {{ rows: number; seed: number; out: string }} options
 */
export async function writeLargeCsv({ rows, seed, out }) {
  const stream = createWriteStream(out);
  const failed = once(stream, 'error').then(([e]) => Promise.reject(e));
  // Keeps an early failure from surfacing as an unhandled rejection before it is awaited.
  failed.catch(() => {});
  for (const chunk of largeCsvChunks(rows, seed)) {
    if (!stream.write(chunk)) await Promise.race([once(stream, 'drain'), failed]);
  }
  stream.end();
  await Promise.race([once(stream, 'finish'), failed]);
  return stream.bytesWritten;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i] ?? '', argv[i + 1]];
    if (!['--rows', '--seed', '--out'].includes(flag) || value === undefined) {
      throw new Error(`unknown or incomplete option "${flag}"`);
    }
    values[flag.slice(2)] = value;
  }
  const rows = Number(values['rows']);
  const seed = Number(values['seed'] ?? '42');
  if (!Number.isSafeInteger(rows) || rows < 0) throw new Error('--rows must be a whole number');
  if (!Number.isSafeInteger(seed)) throw new Error('--seed must be a whole number');
  if (!values['out']) throw new Error('--out <path> is required');
  return { rows, seed, out: values['out'] };
}

const USAGE = 'usage: node fixtures/generators/gen-large-csv.mjs --rows <n> [--seed <n>] --out <path>';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bytes = await writeLargeCsv(options);
  console.log(`gen-large-csv: ${options.rows} rows, ${bytes} bytes written to ${options.out}`);
}

if (isEntryScript(import.meta.url)) {
  main().catch((e) => {
    console.error(`gen-large-csv: ${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    process.exitCode = 1;
  });
}
