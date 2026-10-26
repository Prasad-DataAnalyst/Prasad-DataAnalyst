/**
 * Column and view digests (SAD section 9.4, normative). Export read-back, `.twp` replay, the
 * conformance suite and the Python oracle all compare these hashes, so the byte stream must match
 * the specification exactly: for each cell, len(utf8(C)) in ASCII decimal, ':', then utf8(C).
 */
import { sha256, sha256Hex } from '@tw/io';
import {
  canonicalCell,
  canonicalJson,
  utf8,
  type CellValue,
  type ColumnId,
  type LogicalType,
  type Sha256Hex,
} from '@tw/model';
import type { View } from './view';

export interface ViewDigest {
  rowCount: number;
  columns: { id: ColumnId; name: string; unit: string | null; type: LogicalType; sha256: Sha256Hex }[];
  sha256: Sha256Hex;
}

/** Text is gathered into blocks of about this many UTF-16 units before encoding and hashing. */
const FLUSH_UNITS = 1 << 16;

/** UTF-8 length of a string, matching TextEncoder (a lone surrogate becomes the 3-byte U+FFFD). */
function utf8Length(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u < 0x80) continue;
    if (u < 0x800) {
      n += 1;
    } else if (u >= 0xd800 && u <= 0xdbff && isLowSurrogate(s.charCodeAt(i + 1))) {
      // A surrogate pair is two units and four bytes.
      n += 2;
      i++;
    } else {
      n += 2;
    }
  }
  return n;
}

function isLowSurrogate(u: number): boolean {
  return u >= 0xdc00 && u <= 0xdfff;
}

export function columnDigest(values: Iterable<CellValue>): Sha256Hex {
  const hash = sha256();
  let block = '';
  for (const v of values) {
    const cell = canonicalCell(v);
    block += `${utf8Length(cell)}:${cell}`;
    if (block.length >= FLUSH_UNITS) {
      hash.update(utf8(block));
      block = '';
    }
  }
  // A block boundary never splits a surrogate pair: each block ends at a whole cell.
  if (block.length > 0) hash.update(utf8(block));
  return hash.hex();
}

function* columnValues(v: View, c: ColumnId): IterableIterator<CellValue> {
  for (const r of v.rows()) yield v.value(r, c);
}

/** Digests of every visible column in display order, and of the view as a whole. */
export function viewDigest(v: View): ViewDigest {
  const columns = v.columnIds().map((id) => {
    const schema = v.columnSchema(id);
    return {
      id,
      name: schema.name,
      unit: schema.unit.value,
      type: schema.type.value,
      sha256: columnDigest(columnValues(v, id)),
    };
  });
  const summary = {
    rowCount: v.rowCount,
    columns: columns.map(({ name, unit, type, sha256: hash }) => ({ name, unit, type, sha256: hash })),
  };
  return { rowCount: v.rowCount, columns, sha256: sha256Hex(canonicalJson(summary)) };
}
