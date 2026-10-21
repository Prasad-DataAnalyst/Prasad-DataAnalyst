/**
 * Skips the physical lines before the header (title and preamble rows) at the text level, before
 * tokenizing. A title such as `"Daily report` with an unclosed quote would otherwise swallow the
 * header and the data into one quoted field.
 */

const LF = 0x0a;
const CR = 0x0d;

export class LineSkipper {
  #remaining: number;
  /** The last character consumed was a CR at the end of a chunk; an LF opening the next one belongs to it. */
  #afterCR = false;

  constructor(lines: number) {
    this.#remaining = lines;
  }

  /** The number of lines still to skip. */
  get remaining(): number {
    return this.#remaining;
  }

  /** Returns what is left of `text` once the lines are skipped ('' while still skipping). */
  take(text: string): string {
    let i = 0;
    if (this.#afterCR && text.length > 0) {
      this.#afterCR = false;
      if (text.charCodeAt(0) === LF) i = 1;
    }
    while (this.#remaining > 0 && i < text.length) {
      const c = text.charCodeAt(i++);
      if (c === LF) {
        this.#remaining--;
      } else if (c === CR) {
        this.#remaining--;
        if (i === text.length) this.#afterCR = true;
        else if (text.charCodeAt(i) === LF) i++;
      }
    }
    if (this.#remaining > 0) return '';
    return i === 0 ? text : text.slice(i);
  }
}

/** Physical lines in `text` that end with a line break (LF, CR or CRLF). */
export function countLineBreaks(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === LF) count++;
    else if (c === CR) {
      count++;
      if (text.charCodeAt(i + 1) === LF) i++;
    }
  }
  return count;
}

/**
 * `text` up to and including its last line break. Used on a sample cut from a longer file, whose
 * last line is usually incomplete; text without any line break is returned unchanged.
 */
export function throughLastLineBreak(text: string): string {
  const at = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
  return at < 0 ? text : text.slice(0, at + 1);
}
