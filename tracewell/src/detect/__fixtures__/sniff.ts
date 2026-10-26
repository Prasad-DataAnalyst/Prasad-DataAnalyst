/**
 * Test helpers over the sniff snapshots in ./sniffs: for each messy-library fixture, the header
 * and sample rows its format reader's sniff() returns, with the detect options ingest derives from
 * the sniff result. detect may not depend on the format readers (SAD section 6.1), so their
 * output is committed here as named fixtures. Regenerate a snapshot whenever a reader's sniff
 * output for that fixture changes; the golden test then shows what that does to detection.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FixtureName } from '@tw/fixtures';
import type { ColumnPlan, RawField, RawRow, SourceFormat } from '@tw/model';
import { detectColumns, type DetectOptions } from '../index';

export interface SniffSnapshot {
  fixture: FixtureName;
  format: SourceFormat;
  options: DetectOptions;
  header: string[][];
  sampleRows: RawRow[];
}

const SNIFF_DIR = fileURLToPath(new URL('./sniffs/', import.meta.url));

export function sniffFixture(name: FixtureName): SniffSnapshot {
  const text = readFileSync(join(SNIFF_DIR, `${name}.json`), 'utf8');
  return JSON.parse(text) as SniffSnapshot;
}

export function planFixture(name: FixtureName): { sniff: SniffSnapshot; plans: ColumnPlan[] } {
  const sniff = sniffFixture(name);
  return { sniff, plans: detectColumns(sniff.header, sniff.sampleRows, sniff.options) };
}

/** The sample's raw fields of the column whose header cell is `header`. */
export function columnFields(sniff: SniffSnapshot, header: string): RawField[] {
  const index = sniff.header[0]?.indexOf(header) ?? -1;
  if (index < 0) throw new Error(`no column "${header}"`);
  return sniff.sampleRows.map((r) => r.fields[index] ?? null);
}

export function planNamed(plans: ColumnPlan[], name: string): ColumnPlan {
  const plan = plans.find((p) => p.name === name);
  if (plan === undefined) throw new Error(`no planned column "${name}"`);
  return plan;
}
