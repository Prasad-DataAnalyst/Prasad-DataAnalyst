/** Rewrites a saved `.twp` the way someone editing it by hand would, for the tamper tests. */
import { checksumsFile, readZip, sha256Hex, writeZip } from '@tw/io';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type TwpFiles = Map<string, Uint8Array>;

export function text(files: TwpFiles, path: string): string {
  const bytes = files.get(path);
  if (bytes === undefined) throw new Error(`no ${path} in the project`);
  return decoder.decode(bytes);
}

export function setText(files: TwpFiles, path: string, value: string): void {
  files.set(path, encoder.encode(value));
}

/**
 * Applies `edit` to the archive's entries. With `recompute`, the manifest's entry checksums and
 * CHECKSUMS.sha256 are brought up to date afterwards, as a careful forger would do.
 */
export function rewriteTwp(bytes: Uint8Array, edit: (files: TwpFiles) => void, recompute = true): Uint8Array {
  const zip = readZip(bytes);
  const files: TwpFiles = new Map(zip.paths().map((p) => [p, zip.read(p)]));
  edit(files);
  if (recompute) {
    const manifest = JSON.parse(text(files, 'manifest.json')) as {
      entries: { path: string; size: number; sha256: string }[];
    };
    for (const e of manifest.entries) {
      const data = files.get(e.path);
      if (data === undefined) continue;
      e.size = data.length;
      e.sha256 = sha256Hex(data);
    }
    setText(files, 'manifest.json', `${JSON.stringify(manifest)}\n`);
    const listed = [...files.keys()].filter((p) => p !== 'CHECKSUMS.sha256');
    setText(
      files,
      'CHECKSUMS.sha256',
      checksumsFile(listed.map((p) => ({ path: p, sha256: sha256Hex(files.get(p) as Uint8Array) }))),
    );
  }
  const mimetype = files.get('mimetype') as Uint8Array;
  const rest = [...files].filter(([p]) => p !== 'mimetype').map(([path, data]) => ({ path, data }));
  return writeZip([{ path: 'mimetype', data: mimetype, store: true }, ...rest]);
}
