export type YieldUnit = 'mol' | 'mmol' | 'µmol' | 'nmol';
export interface YieldInputs { version: 1; materialLabel: string; productLabel: string; startingAmount: string; startingUnit: YieldUnit; productAmount: string; productUnit: YieldUnit; startingEquivalents: string; productEquivalents: string }
export type YieldResult = { status: 'incomplete' | 'invalid'; message: string } | { status: 'valid'; theoreticalMol: number; theoreticalAmount: number; percentage: number; above100: boolean };
declare const yieldMath: {
  UNITS: Record<YieldUnit, number>;
  DEFAULT_YIELD_INPUTS: Readonly<YieldInputs>;
  validateYieldInputs(value: unknown): value is YieldInputs;
  calculateYield(inputs: YieldInputs): YieldResult;
  formatAmount(value: number): string;
  formatPercentage(value: number): string;
  yieldSummary(inputs: YieldInputs): string[];
};
export default yieldMath;
