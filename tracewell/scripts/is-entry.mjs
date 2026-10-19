// @ts-check
/**
 * Shared by the gate scripts: decides whether a module is the script Node was started with.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when `metaUrl` (a module's import.meta.url) is the file Node was started with. Node reports
 * the module by its real path but keeps argv[1] as typed, so both are resolved through symlinks;
 * a plain comparison would make a gate started via a symlinked folder skip its work and exit 0.
 * @param {string} metaUrl
 * @param {string | undefined} [invokedPath] defaults to process.argv[1]
 * @returns {boolean}
 */
export function isEntryScript(metaUrl, invokedPath = process.argv[1]) {
  if (!invokedPath) return false;
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
