import type { LabmateAPI, LibrarySnapshot, MutationUpdate } from '../shared/contracts';

// IPC carries affected records only. Merge in the renderer so large document
// collections do not cross the sandbox boundary after every keystroke save.
const collections = ['notebooks', 'experiments', 'runs', 'attachments', 'schemes', 'citations'] as const;
export function mergeMutation(current: LibrarySnapshot, update: MutationUpdate): LibrarySnapshot {
  if (current.libraryGeneration !== update.libraryGeneration) throw new Error('The library changed. Reload before saving again.');
  const next = { ...current, preferences: update.preferences, legacyCitationCount: update.legacyCitationCount };
  for (const key of collections) {
    const replacements = new Map(update[key].map(row => [row.id, row]));
    const touched = new Set(update.replaceIds[key]);
    const rows: {id: string}[] = current[key].flatMap(row => {
      const replacement = replacements.get(row.id);
      if (replacement) { replacements.delete(row.id); return [replacement]; }
      return touched.has(row.id) ? [] : [row];
    });
    rows.push(...replacements.values());
    (next[key] as {id: string}[]) = rows;
  }
  return next;
}

function createAPI(raw: LabmateAPI | undefined): LabmateAPI | undefined {
  if (!raw) return undefined;
  let current: LibrarySnapshot | null = null;
  const api: Record<string, unknown> = {};
  for (const [key, namespace] of Object.entries(raw)) {
    if (typeof namespace === 'function') { api[key] = namespace; continue; }
    api[key] = Object.fromEntries(Object.entries(namespace).map(([name, operation]) => [name, async (input: unknown) => {
      const result = await operation(input);
      if (!result?.ok || !result.value?.libraryGeneration) return result;
      const value = result.value as LibrarySnapshot | MutationUpdate;
      if ('kind' in value && value.kind === 'mutation') {
        if (!current || current.libraryGeneration !== value.libraryGeneration) return {ok:false, error:{code:'STALE_REVISION', message:'The library was reopened or restored. Reload before saving again.'}};
        current = mergeMutation(current, value);
      } else current = value;
      return {ok:true, value: current};
    }]));
  }
  return api as LabmateAPI;
}
export const desktopAPI = createAPI(typeof window === 'undefined' ? undefined : window.labmate);
