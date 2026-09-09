import type {
  AttachmentRecord,
  ExperimentRecord,
  LibrarySnapshot,
  NotebookRecord,
  Preferences,
  RunRecord,
  SchemeRecord,
  SectionDocuments,
  SectionId,
  Status,
} from '../shared/contracts';

export type { SectionId, SectionDocuments };
export type { LibrarySnapshot } from '../shared/contracts';
export type EntryLayout = Preferences['layout'];
export type EntryStatus = Status;
export type AttachmentKind = AttachmentRecord['kind'];
export type Attachment = AttachmentRecord;
export type Entry = RunRecord & { attachments?: AttachmentRecord[] };
export type Experiment = ExperimentRecord;
export type Notebook = NotebookRecord;
export type Scheme = SchemeRecord;

export type SettingsTab = 'general' | 'backups' | 'trash';

export type Panel =
  | { kind: 'settings'; tab?: SettingsTab }
  | { kind: 'new-notebook' }
  | { kind: 'new-experiment' }
  | { kind: 'repeat'; runId?: string }
  | { kind: 'attachment'; attachment: Attachment }
  | { kind: 'export'; scope: 'entry' | 'selected' | 'notebook' }
  | { kind: 'scheme'; schemeId?: string }
  | { kind: 'metadata'; target: 'notebook' | 'experiment' | 'run' }
  | { kind: 'citations' };

export type AppMode = 'real' | 'demo';
export type SnapshotState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: LibrarySnapshot }
  | { status: 'error'; message: string };
