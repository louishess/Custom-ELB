export type SaveState = 'saved' | 'saving' | 'failed' | 'stale';

export interface AutosaveSchedulerOptions<T> {
  save: (value: T) => Promise<void>;
  idleMs?: number;
  maxMs?: number;
  onState?: (state: SaveState) => void;
}

/**
 * Schedules one serialized save after an idle period and guarantees a save
 * at the maximum continuous-editing deadline. `flush` is safe to call during
 * navigation and close handshakes and resolves only after the latest draft has
 * either been saved or rejected by the caller.
 */
export function createAutosaveScheduler<T>({ save, idleMs = 750, maxMs = 5000, onState }: AutosaveSchedulerOptions<T>) {
  let latest: T | undefined;
  let dirty = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<boolean> | undefined;
  let generation = 0;

  const clearTimers = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    idleTimer = undefined;
    maxTimer = undefined;
  };

  const persist = async (): Promise<boolean> => {
    if (saving) {
      const result = await saving;
      return result ? persist() : false;
    }
    if (!dirty || latest === undefined) return true;
    const value = latest;
    const startedAtGeneration = generation;
    dirty = false;
    clearTimers();
    onState?.('saving');
    const operation = save(value).then(() => true).catch(error => {
      onState?.(error?.code === 'STALE_REVISION' ? 'stale' : 'failed');
      return false;
    });
    saving = operation;
    const result = await operation;
    if (saving === operation) saving = undefined;
    if (!result) {
      dirty = true;
      return false;
    }
    // A keystroke landed while the request was in flight. Continue with that
    // newer generation before reporting the draft as saved.
    if (generation !== startedAtGeneration) {
      dirty = true;
      return persist();
    }
    onState?.('saved');
    return true;
  };

  const schedule = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { void persist(); }, idleMs);
    if (!maxTimer) maxTimer = setTimeout(() => { void persist(); }, maxMs);
  };

  return {
    markDirty(value: T) {
      latest = value;
      dirty = true;
      generation += 1;
      onState?.('saving');
      schedule();
    },
    flush: persist,
    isDirty: () => dirty,
    dispose() { clearTimers(); latest = undefined; dirty = false; generation += 1; },
  };
}
