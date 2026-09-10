import type { YieldUnit } from './yield.cjs';
export interface ParsedMaterial {
  status: 'valid';
  label: string;
  molarAmount: string;
  molarUnit: YieldUnit;
  equivalents: string;
  quantity?: { amount: string; unit: string; kind: 'mass' | 'volume' };
}
export type MaterialParseResult = ParsedMaterial | { status: 'invalid'; message: string };
export interface ManualMaterial { version: 1; sourceText: string; label: string; molarAmount: string; molarUnit: YieldUnit; equivalents: string }
export interface MarkedMaterial { id: string; text: string; manual?: ManualMaterial }
export interface MarkedMaterials { starting: MarkedMaterial[]; product: MarkedMaterial[]; errors: string[] }
export type MarkedYieldResult = { status: 'incomplete' | 'invalid'; message: string } | {
  status: 'valid'; starting: ParsedMaterial; product: ParsedMaterial;
  theoreticalAmount: number; percentage: number; above100: boolean; summary: string;
};
declare const materialYield: {
  parseMaterial(text: string): MaterialParseResult;
  validateManualMaterial(value: unknown): value is ManualMaterial;
  resolveMaterial(text: string, manual?: ManualMaterial): MaterialParseResult;
  collectMarkedMaterials(documents: unknown): MarkedMaterials;
  calculateMarkedYield(documents: unknown): MarkedYieldResult;
};
export default materialYield;
