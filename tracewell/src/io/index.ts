// Public entry point of the io module, imported elsewhere as '@tw/io': byte sources and sinks,
// SHA-256, text encodings, deterministic ZIP writing, guarded ZIP reading and checksum files.
// The Node-only file adapter is a separate entry point, '@tw/io/node' (src/io/node.ts).

export { blobSource, bytesSource, memorySink } from './source';

export type { Sha256 } from './sha256';
export { sha256, sha256Hex, sha256OfSource, teeHash } from './sha256';

export { decodeAll, decodeStream, sniffEncoding } from './encoding';

export type { ZipEntryInput } from './zip-write';
export { writeZip } from './zip-write';

export type { ZipReader } from './zip-read';
export { readZip } from './zip-read';

export { checksumsFile, parseChecksumsFile } from './checksums';
