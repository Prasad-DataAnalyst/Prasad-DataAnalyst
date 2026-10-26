// Public entry point of the rules module, imported elsewhere as '@tw/rules': the built-in rule
// packs, pack loading, the check primitives, the runner, issue identity and message rendering.

export { BUILTIN_PACK_JSON, GENERIC_DQ, SYSTEM_RULES, findRule, parseRulePack, rulePackRef } from './packs';
export type { RuleContext, RuleNote } from './context';
export type { CheckFn } from './checks';
export { CHECKS } from './checks';
export { selectColumns } from './select';
export { runRules, systemIssue } from './run';
export { issueId } from './id';
export { renderMessage } from './message';
export { flatlineRuns, hampelOutliers, MAD_SCALE } from './hampel';
