/** Unit registry vocabulary (SAD section 7.5). The registry itself is data owned by the units module. */
import type { QuantityKind } from './schema';

/** Reference conditions a unit is tied to; units with different conventions are never converted silently. */
export type UnitConvention = 'gauge' | 'std-60F-14.696psia' | 'std-15C-101.325kPa' | 'std-0C-101.325kPa';

export interface UnitDef {
  code: string;
  label: string;
  aliases: string[];
  quantity: QuantityKind;
  /** SI value = x * factor + offset. */
  toSI: { factor: number; offset: number };
  /** True when the factor is exact by definition rather than rounded. */
  exact: boolean;
  convention: UnitConvention | null;
  /** Citation, e.g. 'NIST SP 811 (2008) Appendix B.8'. */
  source: string;
}

/** How one conversion was done, recorded in the audit log: y = ((x * fromFactor + fromOffset) - toOffset) / toFactor. */
export interface ConversionMethod {
  from: string;
  to: string;
  fromFactor: number;
  fromOffset: number;
  toFactor: number;
  toOffset: number;
  formula: string;
  source: string;
  registryVersion: string;
}

export interface UnitInfo {
  code: string;
  label: string;
  quantity: QuantityKind;
  convention: UnitConvention | null;
}
