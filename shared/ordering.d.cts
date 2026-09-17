import type { RunRecord } from './contracts';
export type ExportOrder = 'newest' | 'oldest' | 'title-az' | 'title-za' | 'label-az' | 'author-az' | 'number-asc' | 'number-desc' | 'scheme';
export const EXPORT_ORDERS: readonly ExportOrder[];
export function normalizeOrder(order: string): string;
export function compareRuns(a: RunRecord, b: RunRecord, order: string, locale?: string): number;
