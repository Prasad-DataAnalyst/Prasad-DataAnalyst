/**
 * Recognises a units row under a header: cells such as 'psi', 'bbl/d', '[degC]' or '(m3/d)'. The
 * list only has to tell a units row from a row of sub-headers ('Max', 'Min'); the units module
 * still parses every header the reader produces.
 */

// Lower case, without spaces. A compound unit is recognised when each of its parts is listed.
const KNOWN_UNITS: ReadonlySet<string> = new Set(
  [
    'psi psia psig kpa kpaa kpag mpa pa bar bara barg mbar atm inhg mmhg',
    'degc degf degr degk °c °f °r c f k deg °',
    'm km cm mm ft in mi yd ha acre',
    'bbl stb bopd bwpd bfpd sm3 nm3 scf mscf mmscf mmscfd mcf mmcf bcf boe',
    'l ml gal gpm kl',
    'kg g t tonne tonnes lb lbm klb kt',
    's sec min h hr hrs d day days yr',
    '% ppm ppb ppmv ppmw mol% vol% wt% frac fraction',
    'api °api sg',
    'w kw mw gw kwh mwh gj mj kj j btu mmbtu kcal',
    'v a hz rpm cp cst kn knots mph',
    'co2e tco2e kgco2e',
  ]
    .join(' ')
    .split(' '),
);

/** Placeholders a units row may hold for columns without a unit. */
const NO_UNIT: ReadonlySet<string> = new Set(['-', '–', '—', 'n/a', 'na', 'none', '']);

/** Date and time format hints such as 'yyyy-mm-dd' or 'hh:mm' that a units row may hold above dates. */
const FORMAT_HINT = /^[ymdhs]{1,4}(?:[-/.: T][ymdhs]{1,4})*$/i;

const BRACKETED = /^[[(](.+)[\])]$/;

/** 'm3', 'ft²' and 'm^3' name the same parts as 'm', 'ft' and 'm'. */
function withoutPower(part: string): string {
  return part.replace(/(?:\^?-?[0-9]|[²³])+$/u, '');
}

function isKnownUnit(text: string): boolean {
  const compact = text.toLowerCase().replace(/\s+/g, '');
  if (KNOWN_UNITS.has(compact)) return true;
  const parts = compact.split(/[/·*]/);
  return parts.length <= 4 && parts.every((part) => part !== '' && KNOWN_UNITS.has(withoutPower(part)));
}

/** True for text that names a unit: anything in brackets, or a listed (possibly compound) unit. */
export function isUnitText(text: string): boolean {
  const t = text.trim();
  const inner = BRACKETED.exec(t)?.[1]?.trim();
  if (inner !== undefined) return inner.length > 0 && inner.length <= 24;
  return isKnownUnit(t);
}

/** True for a cell a units row may hold where a column has no unit: a dash, 'n/a' or a date format hint. */
export function isNoUnitText(text: string): boolean {
  const t = text.trim().toLowerCase();
  return NO_UNIT.has(t) || FORMAT_HINT.test(t);
}

/** The unit without its brackets: '[psi]' and '(psi)' give 'psi'. */
export function unitName(text: string): string {
  const t = text.trim();
  return (BRACKETED.exec(t)?.[1] ?? t).trim();
}
