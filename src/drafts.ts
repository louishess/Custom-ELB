/** Drafts owned by panels participate in navigation and normal window close. */
const flushers = new Set<() => Promise<boolean>>();
export function registerDraft(flush: () => Promise<boolean>) {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}
export async function flushPanelDrafts(): Promise<boolean> {
  for (const flush of [...flushers]) {
    try { if (!(await flush())) return false; } catch { return false; }
  }
  return true;
}
