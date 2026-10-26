/**
 * The UI refuses an engine whose protocol has another major version (SAD section 4.2): every
 * message shape may differ, so working on would risk silently wrong results.
 */
import { PROTOCOL_VERSION } from '@tw/engine-api';
import { EngineError } from '@tw/model';

function major(version: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m === null ? null : Number(m[1]);
}

export function checkProtocol(engineProtocol: string, uiProtocol: string = PROTOCOL_VERSION): void {
  const a = major(engineProtocol);
  const b = major(uiProtocol);
  if (a === null || b === null || a !== b) {
    throw new EngineError(
      'PROTOCOL_MISMATCH',
      `The engine speaks protocol ${engineProtocol}, but this window speaks ${uiProtocol}.`,
      'Use a Tracewell window and engine from the same release: reload the page, or reinstall the desktop edition.',
      { engine: engineProtocol, ui: uiProtocol },
    );
  }
}
