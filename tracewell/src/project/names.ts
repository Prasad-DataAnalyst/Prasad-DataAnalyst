/**
 * File and entry names derived from user text. A project name or an original's file name can hold
 * anything a user typed, so both are cleaned before they become a download name or a ZIP path.
 */

// Characters Windows, macOS or Linux refuse in file names, plus C0/C1 control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g;
// Device names Windows reserves regardless of extension, such as CON.txt or com1.twp.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_STEM = 100;

/** A safe single path segment: unsafe characters become '_', surrounding dots and spaces go. */
export function safeSegment(text: string, fallback: string): string {
  const cleaned = text
    .normalize('NFC')
    .replace(UNSAFE, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  const bounded = truncate(cleaned, MAX_STEM).replace(/[\s.]+$/g, '');
  if (bounded === '' || /^_+$/.test(bounded)) return fallback;
  return RESERVED.test(bounded) ? `_${bounded}` : bounded;
}

/** A safe download name for a project: the cleaned project name with a '.twp' extension. */
export function suggestedFileName(projectName: string): string {
  const stem = safeSegment(projectName.replace(/\.twp$/i, ''), 'project');
  return `${stem}.twp`;
}

// Cuts by code point so a surrogate pair is never split into an unencodable half.
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}
