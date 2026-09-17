import type { DocNode, LibrarySnapshot, RunRecord, SectionDocuments, SectionId } from '../shared/contracts';

export const sectionIds: SectionId[] = ['information', 'method', 'notes', 'data'];

export function cloneDocuments(documents: SectionDocuments): SectionDocuments {
  return structuredClone(documents);
}

export function plainTextFromDoc(node: DocNode | null | undefined): string {
  if (!node) return '';
  return [node.text ?? '', ...(node.content ?? []).map(child => plainTextFromDoc(child))].filter(Boolean).join(' ');
}

export function plainTextFromDocuments(documents: SectionDocuments): string {
  return sectionIds.map(id => plainTextFromDoc(documents[id])).join(' ').replace(/\s+/g, ' ').trim();
}

export function runSearchText(run: RunRecord): string {
  return [run.title, run.label, run.author, plainTextFromDocuments(run.documents)].join(' ').toLocaleLowerCase();
}

export function matchesRun(run: RunRecord, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized.length === 0 || runSearchText(run).includes(normalized);
}

export function isActiveRun(snapshot: LibrarySnapshot, run: RunRecord): boolean {
  const notebook = snapshot.notebooks.find(item => item.id === run.notebookId);
  const experiment = snapshot.experiments.find(item => item.id === run.experimentId);
  return Boolean(notebook && experiment && !run.trashedAt && !notebook.trashedAt && !experiment.trashedAt);
}

export { compareRuns } from '../shared/ordering.cjs';
import { compareRuns } from '../shared/ordering.cjs';

/** Map sort names used by early renderer builds to the current UI values. */
export function normalizeSort(sort: string): string {
  if (sort === 'az') return 'title-az';
  if (sort === 'za') return 'title-za';
  return sort;
}

export function runsForNotebook(snapshot: LibrarySnapshot, notebookId: string, schemeId: string | null, query: string, sort: string): RunRecord[] {
  const active = snapshot.runs.filter(run => run.notebookId === notebookId && isActiveRun(snapshot, run) && matchesRun(run, query));
  const scheme = schemeId ? snapshot.schemes.find(candidate => candidate.id === schemeId && candidate.notebookId === notebookId) : undefined;
  if (!scheme) return [...active].sort((a, b) => compareRuns(a, b, sort));
  const order = new Map(scheme.runIds.map((id, index) => [id, index]));
  return active.filter(run => order.has(run.id)).sort((a, b) => (order.get(a.id)! - order.get(b.id)!) || a.id.localeCompare(b.id));
}

export function todayLocalDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function newJobId(prefix: string): string {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

export function activeTrash(snapshot: LibrarySnapshot): { kind: 'notebook' | 'experiment' | 'run'; id: string; name: string; ancestorId?: string; ancestorName?: string }[] {
  const notebooks = new Map(snapshot.notebooks.map(item => [item.id, item]));
  const experiments = new Map(snapshot.experiments.map(item => [item.id, item]));
  const result: { kind: 'notebook' | 'experiment' | 'run'; id: string; name: string; ancestorId?: string; ancestorName?: string }[] = [];
  for (const notebook of snapshot.notebooks.filter(item => item.trashedAt)) result.push({ kind: 'notebook', id: notebook.id, name: notebook.name });
  for (const experiment of snapshot.experiments.filter(item => item.trashedAt)) {
    const ancestor = notebooks.get(experiment.notebookId);
    result.push({ kind: 'experiment', id: experiment.id, name: experiment.label, ancestorId: ancestor?.trashedAt ? ancestor.id : undefined, ancestorName: ancestor?.trashedAt ? ancestor.name : undefined });
  }
  for (const run of snapshot.runs.filter(item => item.trashedAt)) {
    const experiment = experiments.get(run.experimentId);
    const notebook = notebooks.get(run.notebookId);
    const ancestor = experiment?.trashedAt ? experiment : notebook?.trashedAt ? notebook : undefined;
    result.push({ kind: 'run', id: run.id, name: run.title, ancestorId: ancestor?.id, ancestorName: ancestor && ('label' in ancestor ? ancestor.label : ancestor.name) });
  }
  return result;
}
