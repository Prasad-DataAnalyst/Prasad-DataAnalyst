/**
 * XML for the XLSX adapter: a small event layer over saxes for reading package parts, and the
 * escaping the writer needs.
 *
 * saxes expands only the five predefined entities and character references, never a DTD, so a
 * workbook cannot pull in external entities (SAD section 12). SpreadsheetML never has a DTD, so a
 * part that declares one is refused outright.
 *
 * Text in cells is ST_Xstring (ECMA-376 Part 1, 22.9.2.19): characters XML cannot carry, such as
 * control characters, are written as _xHHHH_, and a literal '_x0041_' has its underscore written
 * as _x005F_. Carriage returns are encoded the same way, because XML parsers turn them into line feeds.
 */
import { SaxesParser } from 'saxes';
import { EngineError } from '@tw/model';
import { damagedWorkbook } from './errors';

export type Attributes = Readonly<Record<string, string>>;

/** Element names are given without their namespace prefix: <x:c> and <c> are both 'c'. */
export interface XmlHandler {
  open?(name: string, attrs: Attributes, selfClosing: boolean): void;
  close?(name: string): void;
  /** Character data, possibly in several pieces; CDATA sections arrive here too. */
  text?(text: string): void;
}

/** Bytes decoded per step, so a large sheet never becomes one huge string. */
const DECODE_CHUNK = 1 << 20;

export function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

/**
 * An attribute by its local name: 'r' finds r="A1", and 'id' finds r:id="rId1" whatever the prefix.
 * An unprefixed attribute of that name wins over a prefixed one.
 */
export function attr(attrs: Attributes, local: string): string | undefined {
  const exact = attrs[local];
  if (exact !== undefined) return exact;
  const suffix = `:${local}`;
  for (const key of Object.keys(attrs)) {
    if (key.endsWith(suffix)) return attrs[key];
  }
  return undefined;
}

/** SpreadsheetML booleans are '1'/'0' or 'true'/'false'. */
export function xmlBool(value: string | undefined): boolean | undefined {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
}

function decoderFor(bytes: Uint8Array): { decoder: TextDecoder; skip: number } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { decoder: new TextDecoder('utf-16le', { fatal: true }), skip: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { decoder: new TextDecoder('utf-16be', { fatal: true }), skip: 2 };
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return { decoder: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), skip: bom };
}

function parser(part: string, handler: XmlHandler): SaxesParser<{ xmlns: false; position: false }> {
  const sax = new SaxesParser<{ xmlns: false; position: false }>({ xmlns: false, position: false });
  sax.on('error', (e) => {
    throw damagedWorkbook(`the part ${part} is not well-formed XML (${e.message}).`, { part });
  });
  sax.on('doctype', () => {
    throw damagedWorkbook(`the part ${part} declares a document type, which workbook parts never do.`, { part });
  });
  const { open, close, text } = handler;
  if (open) sax.on('opentag', (tag) => open(localName(tag.name), tag.attributes, tag.isSelfClosing));
  if (close) sax.on('closetag', (tag) => close(localName(tag.name)));
  if (text) {
    sax.on('text', text);
    sax.on('cdata', text);
  }
  return sax;
}

/**
 * Parses one package part, calling the handler for each element and text run. Throws
 * EngineError('PARSE_FAILED') naming the part when it is not well-formed or not valid text;
 * errors thrown by the handler pass through unchanged.
 */
export function parseXml(bytes: Uint8Array, part: string, handler: XmlHandler): void {
  const { decoder, skip } = decoderFor(bytes);
  const sax = parser(part, handler);
  try {
    for (let at = skip; at < bytes.length; at += DECODE_CHUNK) {
      sax.write(decoder.decode(bytes.subarray(at, Math.min(at + DECODE_CHUNK, bytes.length)), { stream: true }));
    }
    sax.write(decoder.decode());
    sax.close();
  } catch (e) {
    if (e instanceof EngineError) throw e;
    if (e instanceof TypeError) throw damagedWorkbook(`the part ${part} is not valid text.`, { part });
    throw damagedWorkbook(`the part ${part} cannot be parsed (${e instanceof Error ? e.message : String(e)}).`, {
      part,
    });
  }
}

/** Reverses the _xHHHH_ escapes of ST_Xstring. */
export function decodeXstring(s: string): string {
  if (!s.includes('_x')) return s;
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

const ESCAPED_HEX = /^x[0-9A-Fa-f]{4}_/;

function hex4(code: number): string {
  return `_x${code.toString(16).toUpperCase().padStart(4, '0')}_`;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The text of one UTF-16 unit or pair at `i` as XML character data, and how many units it used. */
function escapeUnit(s: string, i: number): [string, number] {
  const code = s.charCodeAt(i);
  if (code === 0x26) return ['&amp;', 1];
  if (code === 0x3c) return ['&lt;', 1];
  if (code === 0x3e) return ['&gt;', 1];
  if (code === 0x5f) return [ESCAPED_HEX.test(s.slice(i + 1, i + 7)) ? '_x005F_' : '_', 1];
  if (code < 0x20) return [code === 0x09 || code === 0x0a ? s.charAt(i) : hex4(code), 1];
  if (code === 0xfffe || code === 0xffff) return [hex4(code), 1];
  if (code >= 0xd800 && code <= 0xdbff) {
    return isLowSurrogate(s.charCodeAt(i + 1)) ? [s.slice(i, i + 2), 2] : [hex4(code), 1];
  }
  if (isLowSurrogate(code)) return [hex4(code), 1];
  return [s.charAt(i), 1];
}

/** True for units that need more than a copy: markup, '_', controls, U+FFFE/U+FFFF and surrogates. */
function needsEscape(code: number): boolean {
  if (code < 0x20) return code !== 0x09 && code !== 0x0a;
  if (code === 0x26 || code === 0x3c || code === 0x3e || code === 0x5f) return true;
  return (code >= 0xd800 && code <= 0xdfff) || code >= 0xfffe;
}

/** Cell or metadata text as XML character data, with ST_Xstring escapes for what XML cannot carry. */
export function xmlText(s: string): string {
  let plain = true;
  for (let i = 0; i < s.length && plain; i++) plain = !needsEscape(s.charCodeAt(i));
  if (plain) return s;
  let out = '';
  for (let i = 0; i < s.length; ) {
    const [piece, used] = escapeUnit(s, i);
    out += piece;
    i += used;
  }
  return out;
}

/**
 * An attribute value. Tabs and line breaks become character references, because attribute-value
 * normalisation would otherwise turn them into spaces.
 */
export function xmlAttr(s: string): string {
  return s.replace(/[&<>"\t\n\r]/g, (ch) => ATTR_ESCAPES[ch] ?? ch);
}

const ATTR_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\t': '&#9;',
  '\n': '&#10;',
  '\r': '&#13;',
};
