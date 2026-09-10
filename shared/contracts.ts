/** Version 1 desktop contract. No filesystem paths or secrets in library snapshots. */
export type SectionId = 'information' | 'method' | 'notes' | 'data';
export type Status = 'todo' | 'progress' | 'complete';
export type DocNode = { type: string; text?: string; attrs?: Record<string, unknown>; marks?: {type: string; attrs?: Record<string, unknown>}[]; content?: DocNode[] };
export type SectionDocuments = Record<SectionId, DocNode>;
export interface NotebookRecord { id: string; name: string; description: string; discipline: string; color: 'sage' | 'blue' | 'clay'; revision: number; createdAt: string; updatedAt: string; trashedAt: string | null }
export interface ExperimentRecord { id: string; notebookId: string; label: string; experimentNumber: number; revision: number; createdAt: string; updatedAt: string; trashedAt: string | null }
export interface RunRecord { id: string; notebookId: string; experimentId: string; label: string; experimentNumber: number; runNumber: number; title: string; date: string; author: string; status: Status; documents: SectionDocuments; revision: number; createdAt: string; updatedAt: string; trashedAt: string | null }
export interface AttachmentRecord { id: string; runId: string; name: string; mime: string; size: number; hash: string; caption: string; kind: 'image' | 'pdf' | 'spreadsheet' | 'scientific' | 'file'; createdAt: string }
export interface SchemeRecord { id: string; notebookId: string; name: string; description: string; runIds: string[]; revision: number }
export type PaletteId = 'sage' | 'ocean' | 'lavender' | 'terracotta' | 'rose' | 'graphite' | 'midnight';
export interface Preferences { appearance: number; palette: PaletteId; layout: 'continuous' | 'tabs'; directoryView: 'grid' | 'list'; sort: string }
export interface LibrarySnapshot { schemaVersion: number; notebooks: NotebookRecord[]; experiments: ExperimentRecord[]; runs: RunRecord[]; attachments: AttachmentRecord[]; schemes: SchemeRecord[]; preferences: Preferences }
export interface BackupStatus { configured: boolean; destinationLabel?: string; destinationAvailable?: boolean; lastBackupAt?: string; lastAttemptAt?: string; lastFailure?: {at: string; message: string}; progress?: JobEvent; message?: string; running?: boolean }
export interface DictationCapabilities { available: boolean; reason?: string; locales: {id: string; name: string; installed: boolean}[] }
export interface DictationEvent { sessionId: string; state: 'preparing' | 'ready' | 'recording' | 'stopped' | 'cancelled' | 'error'; transcript?: string; final?: boolean; message?: string }
export interface JobEvent { jobId: string; operation: string; phase: string; completed?: number; total?: number; message?: string }
export interface Preview { kind: 'image' | 'pdf' | 'spreadsheet' | 'unsupported'; mime?: string; bytes?: Uint8Array; sheets?: {name: string; rows: string[][]}[]; message?: string }
export interface ExportRequest { scope: 'entry' | 'selected' | 'notebook'; notebookId: string; runIds: string[]; format: 'txt' | 'md' | 'html' | 'rtf' | 'docx'; order: string; schemeId?: string; sections: SectionId[]; data: 'none' | 'captions' | 'previews'; jobId: string }
type Op<I, O = LibrarySnapshot> = { input: I; output: O };
export interface Operations {
 'records.snapshot': Op<undefined>;
 'records.createNotebook': Op<{name: string; description: string; discipline: string; color: NotebookRecord['color']}>;
 'records.updateNotebook': Op<{id: string; expectedRevision: number; changes: Partial<Pick<NotebookRecord, 'name'|'description'|'discipline'|'color'>>}>;
 'records.createExperiment': Op<{notebookId: string; label: string; title: string; date: string; author: string}>;
 'records.updateExperiment': Op<{id: string; expectedRevision: number; label: string}>;
 'records.repeatRun': Op<{runId: string; date: string}>;
 'records.updateRun': Op<{id: string; expectedRevision: number; changes: Partial<Pick<RunRecord, 'title'|'date'|'author'|'status'>>}>;
 'documents.save': Op<{runId: string; expectedRevision: number; documents: SectionDocuments}>;
 'yield.copy': Op<{starting: {text: string; manual?: import('./material-yield.cjs').ManualMaterial}; product: {text: string; manual?: import('./material-yield.cjs').ManualMaterial}}, {copied: boolean; summary: string}>;
 'schemes.create': Op<{notebookId: string; name: string; description: string; runIds?: string[]}>;
 'schemes.update': Op<{id: string; expectedRevision: number; name?: string; description?: string; runIds?: string[]}>;
 'schemes.remove': Op<{id: string; expectedRevision: number}>;
 'preferences.update': Op<Partial<Preferences>>;
 'trash.move': Op<{kind: 'notebook'|'experiment'|'run'; id: string; expectedRevision: number}>;
 'trash.restore': Op<{kind: 'notebook'|'experiment'|'run'; id: string; expectedRevision: number}>;
 'trash.purge': Op<{kind: 'notebook'|'experiment'|'run'; id: string; expectedRevision: number}>;
 'attachments.import': Op<{runId: string; jobId: string}>;
 'attachments.preview': Op<{id: string; jobId: string}, Preview>;
 'attachments.open': Op<{id: string}, {opened: boolean}>;
 'attachments.update': Op<{id: string; caption: string}>;
 'attachments.remove': Op<{id: string}>;
 'exports.write': Op<ExportRequest, {cancelled: boolean; name?: string; warnings?: string[]}>;
 'backups.status': Op<undefined, BackupStatus>;
 'backups.configure': Op<{password: string}, BackupStatus>;
 'backups.changeDestination': Op<undefined, BackupStatus>;
 'backups.revealDestination': Op<undefined, {opened: boolean}>;
 'backups.run': Op<{jobId: string}, BackupStatus>;
 'backups.restore': Op<{password: string; jobId: string}>;
 'jobs.cancel': Op<{jobId: string}, {cancelled: boolean}>;
 'dictation.capabilities': Op<undefined, DictationCapabilities>;
 'dictation.prepare': Op<{sessionId: string; locale: string}, {ready: boolean}>;
 'dictation.start': Op<{sessionId: string; locale: string}, {started: boolean}>;
 'dictation.stop': Op<{sessionId: string}, {stopped: boolean}>;
 'dictation.cancel': Op<{sessionId: string}, {cancelled: boolean}>;
}
export type Result<T> = {ok: true; value: T} | {ok: false; error: {code: string; message: string}};
type OperationFunction<K extends keyof Operations> = Operations[K]['input'] extends undefined
 ? (input?: undefined) => Promise<Result<Operations[K]['output']>>
 : (input: Operations[K]['input']) => Promise<Result<Operations[K]['output']>>;
type Namespace<N extends string> = { [K in keyof Operations as K extends `${N}.${infer M}` ? M : never]: OperationFunction<K> };
export type LabmateAPI = { [N in 'records'|'documents'|'yield'|'schemes'|'preferences'|'trash'|'attachments'|'exports'|'backups'|'jobs'|'dictation']: Namespace<N> } & {
 onDictation: (listener: (event: DictationEvent) => void) => () => void;
 onProgress: (listener: (event: JobEvent) => void) => () => void;
 onBeforeClose: (listener: () => Promise<boolean>) => () => void;
};
declare global { interface Window { labmate?: LabmateAPI } }
