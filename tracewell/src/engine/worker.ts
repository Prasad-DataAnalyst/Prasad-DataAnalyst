/**
 * The engine worker entry: app wiring, so this is the one engine file that creates the real clock
 * and the random ID source. Everything else receives them injected (SAD section 2.1, goal 6).
 */
import { serve, type MessagePortLike } from '@tw/engine-api';
import type { Clock, IdSource } from '@tw/model';
import { LocalEngine } from './engine';

const systemClock: Clock = { now: () => new Date() };

function randomHex(chars: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(chars / 2)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, chars);
}

const randomIds: IdSource = {
  newProjectId: () => `p_${randomHex(16)}`,
  newExportId: () => `e_${randomHex(8)}`,
};

const env = import.meta.env as Record<string, string | undefined>;
// The app names the worker 'budget=<bytes>' to lower the memory budget (the ?budget= URL parameter).
const budget = /^budget=(\d+)$/.exec(self.name)?.[1];

serve(
  new LocalEngine({
    appVersion: env['VITE_APP_VERSION'] ?? '0.1.0',
    owner: env['VITE_OWNER'] ?? '',
    clock: systemClock,
    ids: randomIds,
    ...(budget === undefined ? {} : { memoryBudgetBytes: Number(budget) }),
  }),
  // The worker's global scope is the port: calls arrive on it and answers and events leave by it.
  self as unknown as MessagePortLike,
);
