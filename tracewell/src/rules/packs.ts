/**
 * The built-in rule packs and pack loading. Pack text is kept byte for byte, because its SHA-256 is
 * recorded in every project and export so a reviewer can see exactly which rules were applied.
 */
import { sha256Hex } from '@tw/io';
import { EngineError, schemas, type RuleDef, type RulePack, type RulePackRef } from '@tw/model';
import genericText from './packs/generic-dq-0.1.0.json?raw';
import systemText from './packs/system-0.1.0.json?raw';

export function parseRulePack(json: unknown): RulePack {
  const checked = schemas.rulePack.safeParse(json);
  if (checked.success) return checked.data;
  const issue = checked.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? 'the top level' : issue.path.join('.');
  throw new EngineError(
    'INVALID_INPUT',
    `The rule pack is not valid at ${where}: ${issue?.message ?? 'invalid value'}.`,
    'Correct the rule pack so it matches the rule-pack format.',
    { path: where },
  );
}

export function rulePackRef(pack: RulePack, jsonText: string): RulePackRef {
  return { id: pack.id, version: pack.version, sha256: sha256Hex(jsonText) };
}

export const BUILTIN_PACK_JSON: Record<'tracewell.generic-dq' | 'tracewell.system', string> = Object.freeze({
  'tracewell.generic-dq': genericText,
  'tracewell.system': systemText,
});

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    for (const child of Object.values(v)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

export const GENERIC_DQ: RulePack = deepFreeze(parseRulePack(JSON.parse(genericText)));
export const SYSTEM_RULES: RulePack = deepFreeze(parseRulePack(JSON.parse(systemText)));

export function findRule(packs: RulePack[], ruleId: string): { pack: RulePack; rule: RuleDef } | undefined {
  for (const pack of packs) {
    const rule = pack.rules.find((r) => r.id === ruleId);
    if (rule !== undefined) return { pack, rule };
  }
  return undefined;
}
