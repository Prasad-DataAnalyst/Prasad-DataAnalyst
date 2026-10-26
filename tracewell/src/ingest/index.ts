// Public entry point of the ingest module, imported elsewhere as '@tw/ingest': format detection,
// the import preview, the full streaming import, overrides and column re-parsing.

export type { ImportSpec } from './spec';
export { datasetNameFor } from './spec';
export { detectFormat, importerFor } from './format';
export { PREVIEW_ROWS, previewSource } from './preview';
export type { ImportContext, ImportOutcome, IngestNote } from './import';
export { importSource, reparseColumn } from './import';
export { applyOverrides } from './overrides';
export { detectOptionsFor } from './options';
