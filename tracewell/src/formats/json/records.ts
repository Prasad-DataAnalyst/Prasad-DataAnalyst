/**
 * Streaming JSON record parsers over decoded text, one per layout:
 *
 * - 'array': the document is an array of objects; element i is record i (0-based).
 * - 'member': the document is an object whose member `member` is an array of objects; element i is
 *   record i. Other members (counts, paging, metadata) are skipped.
 * - 'lines': one object per line (JSON Lines, NDJSON); the record's locator is its 1-based line.
 *   Blank lines are skipped.
 *
 * Records are handed over one at a time and dropped from the parser's tree, so memory stays
 * bounded by the largest single record.
 */
import { JSONParser } from '@streamparser/json';
import { EngineError, type JsonOptions } from '@tw/model';
import { brokenJson, formatCount, notRecords } from './errors';

export interface ParsedRecord {
  /** The 0-based record index ('array', 'member') or the 1-based line ('lines'). */
  srcLoc: number;
  value: Record<string, unknown>;
}

export interface RecordParser {
  /** Records handed over so far. */
  readonly records: number;
  write(text: string): void;
  /** Ends the document; throws when it was incomplete. */
  finish(): void;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function kindOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`;
}

function notAnObject(where: string, value: unknown): EngineError {
  return notRecords(`${where} is ${kindOf(value)}, not an object, so it cannot be read as a row.`, {
    found: kindOf(value),
  });
}

interface EmittedValue {
  value?: unknown;
  key?: string | number | undefined;
  parent?: unknown;
  stack: readonly { key?: string | number | undefined }[];
}

/** Records that are elements of the top-level array, or of one member array of the top-level object. */
class TreeRecords implements RecordParser {
  private readonly parser: JSONParser;
  private count = 0;
  private sawRoot = false;
  private finished = false;

  constructor(
    private readonly options: JsonOptions,
    private readonly onRecord: (r: ParsedRecord) => void,
  ) {
    const paths = options.layout === 'array' ? ['$.*'] : ['$.*.*'];
    this.parser = new JSONParser({ paths, keepStack: false });
    this.parser.onValue = (info) => {
      this.handle(info as EmittedValue);
    };
  }

  get records(): number {
    return this.count;
  }

  write(text: string): void {
    if (!this.sawRoot) this.checkRoot(text);
    try {
      this.parser.write(text);
    } catch (e) {
      throw this.parseError(e);
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.sawRoot) throw notRecords('The file is empty: it holds no JSON.');
    if (!this.parser.isEnded) {
      try {
        this.parser.end();
      } catch (e) {
        throw this.parseError(e);
      }
    }
  }

  private checkRoot(text: string): void {
    const first = /\S/.exec(text)?.[0];
    if (first === undefined) return;
    const expected = this.options.layout === 'array' ? '[' : '{';
    if (first !== expected) {
      throw notRecords(
        this.options.layout === 'array'
          ? 'The file was read as an array of records, but its top level is not an array.'
          : `The file was read as an object holding records under "${this.options.member}", but its top level is not an object.`,
        { firstChar: first },
      );
    }
    this.sawRoot = true;
  }

  private handle(info: EmittedValue): void {
    if (this.options.layout === 'member') {
      // '$.*.*' also passes the children of other members; only the chosen array's elements count.
      if (info.stack[1]?.key !== this.options.member) return;
      if (!Array.isArray(info.parent)) {
        throw notRecords(`The member "${this.options.member}" is not an array.`, { member: this.options.member });
      }
    }
    if (!isRecord(info.value)) throw notAnObject(`Record ${formatCount(this.count)}`, info.value);
    this.onRecord({ srcLoc: this.count, value: info.value });
    this.count++;
  }

  private parseError(e: unknown): Error {
    // Errors raised by this class from inside the JSON parser's callback pass through unchanged.
    if (e instanceof EngineError) return e;
    const reason = e instanceof Error ? e.message : String(e);
    return brokenJson(`${reason} (after ${formatCount(this.count)} records).`, { recordsRead: this.count });
  }
}

/** One record per line; each line is parsed on its own, so a broken line is reported by number. */
class LineRecords implements RecordParser {
  private carry = '';
  private line = 0;
  private count = 0;

  constructor(private readonly onRecord: (r: ParsedRecord) => void) {}

  get records(): number {
    return this.count;
  }

  write(text: string): void {
    const parts = (this.carry + text).split('\n');
    this.carry = parts.pop() ?? '';
    for (const part of parts) this.take(part);
  }

  finish(): void {
    if (this.carry !== '') this.take(this.carry);
    this.carry = '';
    if (this.count === 0) throw notRecords('The file holds no JSON records: every line is blank.');
  }

  private take(text: string): void {
    this.line++;
    const body = text.endsWith('\r') ? text.slice(0, -1) : text;
    if (body.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw brokenJson(`line ${formatCount(this.line)}: ${reason}`, { line: this.line });
    }
    if (!isRecord(value)) throw notAnObject(`Line ${formatCount(this.line)}`, value);
    this.onRecord({ srcLoc: this.line, value });
    this.count++;
  }
}

export function recordParser(options: JsonOptions, onRecord: (r: ParsedRecord) => void): RecordParser {
  return options.layout === 'lines' ? new LineRecords(onRecord) : new TreeRecords(options, onRecord);
}
