/**
 * JSON Lines encoding of the audit log: one canonicalJson(entry) per line, each line ending in '\n'.
 * Decoding is lenient about what it keeps and strict about what it reports: every line that is a
 * well-formed entry is kept, and the first line that is not is reported as a chain break.
 */
import { canonicalJson, schemas, type AuditEntry, type AuditSeq, type JsonValue } from '@tw/model';

export function encodeJsonl(entries: readonly AuditEntry[]): string {
  return entries.map((e) => `${canonicalJson(e as unknown as JsonValue)}\n`).join('');
}

export interface DecodedJsonl {
  entries: AuditEntry[];
  /** The first line that could not be read, as the seq it would have had, with the reason. */
  firstBadLine?: { at: AuditSeq; reason: string };
}

export function decodeJsonl(text: string): DecodedJsonl {
  const result: DecodedJsonl = { entries: [] };
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const outcome = decodeLine(lines[i] as string);
    if (typeof outcome === 'string') {
      result.firstBadLine ??= { at: i + 1, reason: `Line ${i + 1} ${outcome}` };
    } else {
      result.entries.push(outcome);
    }
  }
  return result;
}

// Only the final terminator is dropped, so an empty line in the middle still counts as a line
// and its absence from the chain is reported. CRLF is accepted because editors add it on Windows.
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function decodeLine(line: string): AuditEntry | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return 'is not valid JSON.';
  }
  const checked = schemas.auditEntry.safeParse(parsed);
  return checked.success ? checked.data : 'is not a well-formed audit entry.';
}
