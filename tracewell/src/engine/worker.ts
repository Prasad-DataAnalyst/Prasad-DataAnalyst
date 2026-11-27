/**
 * The engine worker entry: app wiring, so this is the one engine file that creates the real clock
 * and the random ID source. Everything else receives them injected (SAD section 2.1, goal 6).
 */
import { serve, type MessagePortLike } from '@tw/engine-api';
import type { Clock, IdSource, RulePackPolicy } from '@tw/model';
import { parsePolicy } from '@tw/rules';
import { LocalEngine } from './engine';
import { opfsJournalStore } from './journal-store';
import { opfsTemplateStore } from './template-store';

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

/**
 * The administrator's rule-pack policy (FR-RUL-04) for this build: the text of the policy file,
 * given as VITE_RULEPACK_POLICY when the Lite edition is built. Without one, or with one that is
 * not valid, no publisher is trusted and no rule-pack file installs.
 */
function buildPolicy(text: string | undefined): RulePackPolicy | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  try {
    return parsePolicy(text);
  } catch {
    return undefined;
  }
}
const policy = buildPolicy(env['VITE_RULEPACK_POLICY']);
// The app names the worker 'budget=<bytes>' to lower the memory budget (the ?budget= URL parameter).
const budget = /^budget=(\d+)$/.exec(self.name)?.[1];

serve(
  new LocalEngine({
    appVersion: env['VITE_APP_VERSION'] ?? '0.1.0',
    owner: env['VITE_OWNER'] ?? '',
    clock: systemClock,
    ids: randomIds,
    // Mapping templates outlive the page: they are kept in the browser's private file storage.
    templates: opfsTemplateStore(),
    // Each tab's unsaved work is journalled under its own session, recoverable once the tab is gone.
    journal: opfsJournalStore(randomHex(16)),
    ...(budget === undefined ? {} : { memoryBudgetBytes: Number(budget) }),
    ...(policy === undefined ? {} : { policy }),
  }),
  // The worker's global scope is the port: calls arrive on it and answers and events leave by it.
  self as unknown as MessagePortLike,
);
