/**
 * The shared string table (xl/sharedStrings.xml). Each <si> is plain text in one <t>, or rich text
 * in runs <r><t>…</t></r> whose texts are joined; phonetic guides (<rPh>) are not part of the text.
 */
import { decodeXstring, parseXml } from './xml';

export function parseSharedStrings(bytes: Uint8Array, part: string): string[] {
  const strings: string[] = [];
  let inItem = false;
  let inText = false;
  let phoneticDepth = 0;
  let text = '';
  parseXml(bytes, part, {
    open(name) {
      if (name === 'si') {
        inItem = true;
        text = '';
      } else if (name === 'rPh') {
        phoneticDepth += 1;
      } else if (name === 't') {
        inText = inItem && phoneticDepth === 0;
      }
    },
    close(name) {
      if (name === 't') {
        inText = false;
      } else if (name === 'rPh') {
        phoneticDepth -= 1;
      } else if (name === 'si') {
        strings.push(decodeXstring(text));
        inItem = false;
      }
    },
    text(t) {
      if (inText) text += t;
    },
  });
  return strings;
}
