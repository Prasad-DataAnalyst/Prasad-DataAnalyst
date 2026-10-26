import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@tw/io';
import { BUILTIN_PACK_JSON, CHECKS, GENERIC_DQ, SYSTEM_RULES, findRule, parseRulePack, rulePackRef } from './index';

const ALL = [GENERIC_DQ, SYSTEM_RULES];

describe('built-in packs', () => {
  it('parse and carry the planned ids and versions', () => {
    expect([GENERIC_DQ.id, GENERIC_DQ.version]).toEqual(['tracewell.generic-dq', '0.1.0']);
    expect([SYSTEM_RULES.id, SYSTEM_RULES.version]).toEqual(['tracewell.system', '0.1.0']);
    expect(GENERIC_DQ.rules).toHaveLength(22);
    expect(SYSTEM_RULES.rules).toHaveLength(13);
  });

  it('have unique, well-formed rule IDs', () => {
    const ids = ALL.flatMap((p) => p.rules.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^TW-(DQ|UNIT|TIME|GEO|IMP|PRJ|EXP)-\d{3}$/);
  });

  it('explain and cite every rule', () => {
    for (const r of ALL.flatMap((p) => p.rules)) {
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.source.length, r.id).toBeGreaterThan(5);
      expect(r.message, r.id).not.toMatch(/\{(?!column|count|unit|min|max|detail)\w+\}/);
    }
  });

  it('implement every check kind they use', () => {
    for (const r of ALL.flatMap((p) => p.rules)) expect(CHECKS[r.check.kind], r.id).toBeTypeOf('function');
  });

  it('hash their exact text into the pack reference', () => {
    const text = BUILTIN_PACK_JSON['tracewell.generic-dq'];
    expect(rulePackRef(GENERIC_DQ, text)).toEqual({ id: GENERIC_DQ.id, version: '0.1.0', sha256: sha256Hex(text) });
  });

  it('are frozen', () => {
    expect(Object.isFrozen(GENERIC_DQ.rules[0])).toBe(true);
  });
});

describe('parseRulePack', () => {
  it('rejects a malformed pack with the path of the problem', () => {
    const bad = JSON.parse(BUILTIN_PACK_JSON['tracewell.generic-dq']) as { rules: { severity: string }[] };
    if (bad.rules[0] !== undefined) bad.rules[0].severity = 'fatal';
    expect(() => parseRulePack(bad)).toThrow(/rules\.0\.severity/);
  });

  it('rejects duplicate rule IDs', () => {
    const pack = JSON.parse(BUILTIN_PACK_JSON['tracewell.system']) as { rules: unknown[] };
    pack.rules.push(pack.rules[0]);
    expect(() => parseRulePack(pack)).toThrow();
  });
});

describe('findRule', () => {
  it('finds rules across packs', () => {
    expect(findRule(ALL, 'TW-EXP-002')?.pack.id).toBe('tracewell.system');
    expect(findRule(ALL, 'TW-NOPE-001')).toBeUndefined();
  });
});
