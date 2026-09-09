import type {
  AttachmentRecord,
  DocNode,
  LibrarySnapshot,
  SectionDocuments,
  SectionId,
  Status,
} from '../shared/contracts';

export const sections: { id: SectionId; name: string; short: string }[] = [
  { id: 'information', name: 'Experimental information', short: 'Information' },
  { id: 'method', name: 'Method', short: 'Method' },
  { id: 'notes', name: 'Notes', short: 'Notes' },
  { id: 'data', name: 'Data', short: 'Data' },
];

export const statusOptions: { id: Status; name: string; description: string }[] = [
  { id: 'todo', name: 'To-Do', description: 'Good questions. Next steps.' },
  { id: 'progress', name: 'In Progress', description: 'A little discovery in the making.' },
  { id: 'complete', name: 'Complete', description: 'Recorded, reviewed, and wrapped up.' },
];

export const sortOptions = [
  ['newest', 'Date · newest first'],
  ['oldest', 'Date · oldest first'],
  ['title-az', 'Title · A to Z'],
  ['title-za', 'Title · Z to A'],
  ['label-az', 'Label · A to Z'],
  ['author-az', 'Author · A to Z'],
  ['number-asc', 'Entry number · ascending'],
  ['number-desc', 'Entry number · descending'],
  ['scheme', 'Scheme order'],
] as const;

const paragraph = (text: string): DocNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const heading = (text: string, level = 3): DocNode => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const bulletList = (items: string[]): DocNode => ({ type: 'bulletList', content: items.map(item => ({ type: 'listItem', content: [paragraph(item)] })) });

function documents(information: string, method: string[], notes: string, data: string): SectionDocuments {
  return {
    information: { type: 'doc', content: [paragraph(information)] },
    method: { type: 'doc', content: [heading('Procedure'), { type: 'orderedList', content: method.map(item => ({ type: 'listItem', content: [paragraph(item)] })) }] },
    notes: { type: 'doc', content: [paragraph(notes), { type: 'blockquote', content: [paragraph('Keep supporting observations with the experimental record.')] }, bulletList(['Use repeat-run numbers to connect related entries.'])] },
    data: { type: 'doc', content: [paragraph(data)] },
  };
}

const attachments: AttachmentRecord[] = [
  { id: 'demo-image', runId: 'demo-cat-12-2', name: 'reaction-observation.png', mime: 'image/png', size: 1887436, hash: 'demo-image-hash', caption: 'Illustrative sample appearance after the observation period.', kind: 'image', createdAt: '2026-09-08T10:00:00.000Z' },
  { id: 'demo-pdf', runId: 'demo-cat-12-2', name: 'instrument-report.pdf', mime: 'application/pdf', size: 438272, hash: 'demo-pdf-hash', caption: 'Example instrument report and acquisition summary.', kind: 'pdf', createdAt: '2026-09-08T10:00:00.000Z' },
  { id: 'demo-sheet', runId: 'demo-cat-12-2', name: 'screening-results.csv', mime: 'text/csv', size: 4096, hash: 'demo-sheet-hash', caption: 'Fictional comparative measurements across three samples.', kind: 'spreadsheet', createdAt: '2026-09-08T10:00:00.000Z' },
  { id: 'demo-scientific', runId: 'demo-cat-12-2', name: 'characterization.fid', mime: 'application/octet-stream', size: 13002342, hash: 'demo-scientific-hash', caption: 'Example raw instrument data. A dedicated viewer is deferred.', kind: 'scientific', createdAt: '2026-09-08T10:00:00.000Z' },
];

const times = ['2026-09-08T10:00:00.000Z', '2026-09-07T10:00:00.000Z', '2026-09-06T10:00:00.000Z', '2026-09-05T10:00:00.000Z', '2026-09-04T10:00:00.000Z', '2026-09-03T10:00:00.000Z', '2026-09-02T10:00:00.000Z'];
const run = (id: string, notebookId: string, experimentId: string, label: string, experimentNumber: number, runNumber: number, title: string, date: string, author: string, information: string, method: string[], notes: string, data: string, status: Status) => ({ id, notebookId, experimentId, label, experimentNumber, runNumber, title, date, author, status, documents: documents(information, method, notes, data), revision: 1, createdAt: times[Math.min(runNumber + experimentNumber - 2, times.length - 1)], updatedAt: times[Math.min(runNumber + experimentNumber - 2, times.length - 1)], trashedAt: null });

/**
 * Fictional content used only after the user explicitly chooses demonstration
 * mode. It is never sent through window.labmate and is kept separate from the
 * real library snapshot.
 */
export const demoSnapshot: LibrarySnapshot = {
  schemaVersion: 1,
  notebooks: [
    { id: 'demo-catalysis', name: 'Catalysis & synthesis', description: 'Reaction development, catalyst screening, and repeat experiments.', discipline: 'Organic chemistry', color: 'sage', revision: 1, createdAt: times[6], updatedAt: times[0], trashedAt: null },
    { id: 'demo-materials', name: 'Functional materials', description: 'Thin films, surface treatments, and material characterization.', discipline: 'Materials science', color: 'blue', revision: 1, createdAt: times[6], updatedAt: times[1], trashedAt: null },
    { id: 'demo-analytical', name: 'Analytical methods', description: 'Method development, calibration, and instrument observations.', discipline: 'Analytical chemistry', color: 'clay', revision: 1, createdAt: times[6], updatedAt: times[2], trashedAt: null },
  ],
  experiments: [
    { id: 'demo-exp-cat-12', notebookId: 'demo-catalysis', label: 'Catalyst-screen', experimentNumber: 12, revision: 1, createdAt: times[2], updatedAt: times[0], trashedAt: null },
    { id: 'demo-exp-cat-11', notebookId: 'demo-catalysis', label: 'Solvent-study', experimentNumber: 11, revision: 1, createdAt: times[3], updatedAt: times[3], trashedAt: null },
    { id: 'demo-exp-cat-2', notebookId: 'demo-catalysis', label: 'Reaction-survey', experimentNumber: 2, revision: 1, createdAt: times[6], updatedAt: times[6], trashedAt: null },
    { id: 'demo-exp-mat-3', notebookId: 'demo-materials', label: 'Film-prep', experimentNumber: 3, revision: 1, createdAt: times[4], updatedAt: times[1], trashedAt: null },
    { id: 'demo-exp-ana-10', notebookId: 'demo-analytical', label: 'Calibration', experimentNumber: 10, revision: 1, createdAt: times[2], updatedAt: times[2], trashedAt: null },
  ],
  runs: [
    run('demo-cat-12-2', 'demo-catalysis', 'demo-exp-cat-12', 'Catalyst-screen', 12, 2, 'Catalyst loading study', '2026-09-08', 'Alex Rivera', 'Compare a lower catalyst loading with the baseline run while keeping the remaining screening conditions consistent.', ['Label the sample set and record the starting materials.', 'Prepare the comparison series according to the established screening protocol.', 'Record observations at consistent intervals.'], 'The comparison sample developed a pale amber color. No visible precipitation was recorded.', 'Supporting example files are attached to this run.', 'progress'),
    run('demo-cat-12-1', 'demo-catalysis', 'demo-exp-cat-12', 'Catalyst-screen', 12, 1, 'Catalyst loading baseline', '2026-09-06', 'Alex Rivera', 'Establish a reference condition for the catalyst loading comparison.', ['Prepare a labeled baseline sample.', 'Record the reference condition and observation times.', 'Collect the example analytical output.'], 'The baseline sample remained homogeneous throughout the observations.', 'Reference report and screening results.', 'complete'),
    run('demo-cat-11-1', 'demo-catalysis', 'demo-exp-cat-11', 'Solvent-study', 11, 1, 'Solvent comparison', '2026-09-05', 'Alex Rivera', 'Document differences in sample appearance across a model solvent series.', ['Assign an identifier to each comparison sample.', 'Follow the model solvent-screening procedure.', 'Record the appearance under consistent lighting.'], 'Sample B showed the clearest visual separation from the rest of the set.', 'Carry the selected condition into the catalyst study.', 'todo'),
    run('demo-cat-2-1', 'demo-catalysis', 'demo-exp-cat-2', 'Reaction-survey', 2, 1, 'Initial reaction survey', '2026-09-02', 'Alex Rivera', 'Define the initial comparison set and establish notebook conventions.', ['Review the fictional reference procedure.', 'Assign labels to the comparison set.', 'Record criteria for selecting subsequent experiments.'], 'The initial comparison set was documented for the next round of screening.', 'Evaluate solvent conditions before catalyst loading.', 'complete'),
    run('demo-mat-3-2', 'demo-materials', 'demo-exp-mat-3', 'Film-prep', 3, 2, 'Polymer film repeat', '2026-09-07', 'Jamie Lee', 'Compare the appearance of a repeated film preparation with the reference sample.', ['Assign sample labels before preparation.', 'Follow the film-preparation method.', 'Document the surface with consistent lighting.'], 'The example film appeared uniform at the center with a slight edge variation.', 'Compare surface images with the first preparation.', 'progress'),
    run('demo-mat-3-1', 'demo-materials', 'demo-exp-mat-3', 'Film-prep', 3, 1, 'Reference film preparation', '2026-09-04', 'Jamie Lee', 'Document a reference polymer film for future surface comparisons.', ['Identify the reference sample.', 'Record the preparation sequence.', 'Capture an illustrative surface image.'], 'The reference film showed a consistent central region.', 'Repeat the preparation to compare uniformity.', 'complete'),
    run('demo-ana-10-1', 'demo-analytical', 'demo-exp-ana-10', 'Calibration', 10, 1, 'Calibration series', '2026-09-06', 'Casey Bennett', 'Document an illustrative calibration series and its supporting measurements.', ['Label the reference series.', 'Record the acquisition sequence.', 'Compare responses across the sample set.'], 'The illustrative responses increased across the reference series.', 'Review the example results before a repeat acquisition.', 'todo'),
  ],
  attachments,
  schemes: [
    { id: 'demo-route-a', notebookId: 'demo-catalysis', name: 'Route A · development', description: 'From the initial survey to the latest catalyst comparison.', runIds: ['demo-cat-2-1', 'demo-cat-11-1', 'demo-cat-12-1', 'demo-cat-12-2'], revision: 1 },
    { id: 'demo-loading', notebookId: 'demo-catalysis', name: 'Loading comparison', description: 'Two runs viewed together in their experimental sequence.', runIds: ['demo-cat-12-1', 'demo-cat-12-2'], revision: 1 },
    { id: 'demo-films', notebookId: 'demo-materials', name: 'Film reproducibility', description: 'Reference preparation followed by a repeat run.', runIds: ['demo-mat-3-1', 'demo-mat-3-2'], revision: 1 },
    { id: 'demo-calibration', notebookId: 'demo-analytical', name: 'Method development', description: 'The initial calibration entry in the method sequence.', runIds: ['demo-ana-10-1'], revision: 1 },
  ],
  preferences: { appearance: 0, layout: 'continuous', directoryView: 'grid', sort: 'newest' },
};

export function cloneDemoSnapshot(): LibrarySnapshot {
  return structuredClone(demoSnapshot);
}

export function emptyDocuments(): SectionDocuments {
  return {
    information: { type: 'doc', content: [{ type: 'paragraph' }] },
    method: { type: 'doc', content: [{ type: 'paragraph' }] },
    notes: { type: 'doc', content: [{ type: 'paragraph' }] },
    data: { type: 'doc', content: [{ type: 'paragraph' }] },
  };
}

export function entryCode(entry: { label: string; experimentNumber: number; runNumber: number }): string {
  return `${entry.label}-${entry.experimentNumber}-${entry.runNumber}`;
}

export function formatDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(parsed);
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
