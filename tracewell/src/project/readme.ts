/**
 * README.txt inside a `.twp` (SAD section 11): what the archive holds and how anyone can verify it
 * without Tracewell. It is written from the manifest alone, never from the entries list, because
 * the README's own checksum is part of that list.
 */
import type { ProjectManifest } from '@tw/model';

export function twpReadme(m: Omit<ProjectManifest, 'entries'>): string {
  const lines = [
    `Tracewell project: ${m.name}`,
    `Project ID: ${m.projectId}`,
    `Created: ${m.createdAt}`,
    `Saved: ${m.savedAt} by ${m.savedBy}`,
    `Format: ${m.format} ${m.formatVersion} (written by Tracewell ${m.appVersion})`,
    `Unit system: ${m.unitSystem}`,
    `Audit log: ${m.auditHead.seq} entries, last entry hash ${m.auditHead.hash}`,
    '',
    'WHAT THIS FILE IS',
    'This .twp file is an ordinary ZIP archive. Rename it to .zip, or open it with any ZIP tool,',
    'to look inside. Nothing in it is encrypted.',
    '',
    'CONTENTS',
    '  mimetype            identifies the file as a Tracewell project',
    '  manifest.json       project details and the SHA-256 of every other entry',
    '  audit.jsonl         every action taken in the project, one JSON entry per line,',
    '                      each linked to the one before it by its SHA-256 hash',
    '  originals/          the imported files, byte for byte; each folder is named after',
    '                      the SHA-256 of the file inside it',
    '  rulepacks/          the exact check rules used',
    '  units/              the exact unit registry used',
    '  CHECKSUMS.sha256    the SHA-256 of every entry except itself',
    '',
    'HOW TO VERIFY',
    '  1. Extract the archive into an empty folder.',
    '  2. In that folder run:  sha256sum -c CHECKSUMS.sha256',
    '     Every line must end in OK. On Windows PowerShell, compare the output of',
    '     Get-FileHash -Algorithm SHA256 <file> with the matching line instead.',
    '  3. For each original, the folder name must equal the SHA-256 of the file inside it.',
    'When Tracewell opens the project it repeats these checks, verifies the audit chain and',
    'rebuilds every dataset from the originals and the audit log. If anything does not match,',
    'the project opens read-only and the Open report says why; nothing is repaired silently.',
    '',
    `ORIGINAL FILES (${m.originals.length})`,
    ...(m.originals.length === 0
      ? ['  none']
      : m.originals.map((o) => `  ${o.name}  ${o.size} bytes  SHA-256 ${o.fileId}`)),
    '',
    `RULE PACKS (${m.rulePacks.length})`,
    ...(m.rulePacks.length === 0 ? ['  none'] : m.rulePacks.map((r) => `  ${r.id} ${r.version}  SHA-256 ${r.sha256}`)),
    '',
    `UNIT REGISTRY: ${m.unitRegistry.version}  SHA-256 ${m.unitRegistry.sha256}`,
    '',
  ];
  return lines.join('\n');
}
