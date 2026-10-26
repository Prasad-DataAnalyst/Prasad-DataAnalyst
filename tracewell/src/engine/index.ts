// Public entry point of the engine module, imported elsewhere as '@tw/engine': the TypeScript
// engine behind the engine protocol, and the deterministic clock and IDs used to test it. The
// worker entry (src/engine/worker.ts) is bundled separately and imports nothing from here.

export type { FileSystem, LocalEngineOptions } from './engine';
export { ENGINE_NAME, LocalEngine } from './engine';
export { fixedClock, seededIds } from './testing';
