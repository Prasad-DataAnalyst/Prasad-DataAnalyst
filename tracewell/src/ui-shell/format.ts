/** Display formatting of cell values and counts. Display only: exports never use these strings. */
import { canonicalCell, type CellValue, type LogicalType } from '@tw/model';

const COUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** '12,345'. Counts are whole numbers; anything else is shown as given rather than rounded silently. */
export function formatCount(n: number): string {
  return Number.isSafeInteger(n) ? COUNT.format(n) : String(n);
}

/**
 * The text a grid cell shows. Dates are ISO; numbers keep up to 15 significant digits, which is
 * all a double reliably holds, with trailing zeros dropped. The canonical value is available from
 * cellTooltip for a tooltip, so a rounded display never hides the stored value.
 */
export function formatCell(v: CellValue, type: LogicalType): string {
  if (v === null) return '';
  if (typeof v === 'number') return type === 'integer' && Number.isSafeInteger(v) ? String(v) : formatNumber(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  if ('date' in v) return v.date;
  if ('datetime' in v) return v.datetime.replace('.000Z', 'Z');
  return geometrySummary(v.geometry);
}

/** The exact stored value, for a tooltip next to a rounded display. */
export function cellTooltip(v: CellValue): string {
  return v === null ? 'empty' : canonicalCell(v);
}

function formatNumber(v: number): string {
  if (Object.is(v, -0)) return '0';
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) return v.toPrecision(15).replace(/\.?0+e/, 'e');
  const fixed = Number(v.toPrecision(15));
  return String(fixed);
}

function geometrySummary(g: { type: string; coordinates?: unknown }): string {
  if (g.type === 'Point' && Array.isArray(g.coordinates)) {
    const [lon, lat] = g.coordinates as number[];
    return `POINT (${formatNumber(lon ?? 0)} ${formatNumber(lat ?? 0)})`;
  }
  return g.type.toUpperCase();
}
