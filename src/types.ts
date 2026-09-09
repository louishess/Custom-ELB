export type SectionId = 'information' | 'method' | 'notes' | 'data';
export type EntryLayout = 'continuous' | 'tabs';
export type EntryStatus = 'todo' | 'progress' | 'complete';
export type AttachmentKind = 'image' | 'pdf' | 'spreadsheet' | 'scientific';

export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  size: string;
  caption: string;
}

export interface Citation {
  id: string;
  title: string;
  authors: string;
  year: string;
  journal: string;
  collection: string;
}

export interface Entry {
  id: string;
  notebookId: string;
  title: string;
  label: string;
  experimentNumber: number;
  runNumber: number;
  date: string;
  author: string;
  objective: string;
  description: string;
  method: string[];
  observation: string;
  nextStep: string;
  reagent: string;
  amount: string;
  citationIds: string[];
  attachments: Attachment[];
}

export interface Notebook {
  id: string;
  name: string;
  description: string;
  discipline: string;
  color: 'sage' | 'blue' | 'clay';
  modified: string;
}

export interface Scheme {
  id: string;
  notebookId: string;
  name: string;
  description: string;
  entryIds: string[];
}

export type Panel =
  | { kind: 'settings' }
  | { kind: 'new-notebook' }
  | { kind: 'new-experiment' }
  | { kind: 'repeat' }
  | { kind: 'citations' }
  | { kind: 'attachment'; attachment: Attachment }
  | { kind: 'export'; scope: 'entry' | 'selected' | 'notebook' };
