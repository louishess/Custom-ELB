import type { Attachment, Citation, Entry, EntryStatus, Notebook, Scheme, SectionId } from './types';

export const statusOptions: { id: EntryStatus; name: string; description: string }[] = [
  { id: 'todo', name: 'To-Do', description: 'Good questions. Next steps.' },
  { id: 'progress', name: 'In Progress', description: 'A little discovery in the making.' },
  { id: 'complete', name: 'Complete', description: 'Recorded, reviewed, and wrapped up.' },
];

export const initialStatuses: Record<string, EntryStatus> = {
  'cat-12-2': 'progress',
  'cat-12-1': 'complete',
  'cat-11-1': 'todo',
  'cat-2-1': 'complete',
  'mat-3-2': 'progress',
  'mat-3-1': 'complete',
  'ana-10-1': 'todo',
};

export const sections: { id: SectionId; name: string; short: string }[] = [
  { id: 'information', name: 'Experimental information', short: 'Information' },
  { id: 'method', name: 'Method', short: 'Method' },
  { id: 'notes', name: 'Notes', short: 'Notes' },
  { id: 'data', name: 'Data', short: 'Data' },
];

export const sortOptions = [
  ['newest', 'Date · newest first'], ['oldest', 'Date · oldest first'],
  ['az', 'Title · A to Z'], ['za', 'Title · Z to A'],
  ['number-asc', 'Entry number · ascending'], ['number-desc', 'Entry number · descending'],
  ['scheme', 'Scheme order'],
] as const;

export const notebooks: Notebook[] = [
  { id: 'catalysis', name: 'Catalysis & synthesis', description: 'Reaction development, catalyst screening, and repeat experiments.', discipline: 'Organic chemistry', color: 'sage', modified: '2026-09-08' },
  { id: 'materials', name: 'Functional materials', description: 'Thin films, surface treatments, and material characterization.', discipline: 'Materials science', color: 'blue', modified: '2026-09-07' },
  { id: 'analytical', name: 'Analytical methods', description: 'Method development, calibration, and instrument observations.', discipline: 'Analytical chemistry', color: 'clay', modified: '2026-09-06' },
];

export const citations: Citation[] = [
  { id: 'ref-1', title: 'Ligand effects in model cross-coupling reactions', authors: 'Rivera, A.; Chen, M.', year: '2025', journal: 'Example Journal of Catalysis · 12, 101–112', collection: 'Reaction development' },
  { id: 'ref-2', title: 'A practical guide to reproducible catalyst screening', authors: 'Morgan, E.; Patel, S.', year: '2024', journal: 'Illustrative Methods in Chemistry · 8, 44–58', collection: 'Reaction development' },
  { id: 'ref-3', title: 'Surface preparation for polymer thin films', authors: 'Lee, J.; Novak, R.', year: '2025', journal: 'Sample Materials Research · 4, 201–215', collection: 'Materials & surfaces' },
  { id: 'ref-4', title: 'Calibration strategies for routine chromatography', authors: 'Bennett, C.; Rao, D.', year: '2026', journal: 'Example Analytical Methods · 3, 19–27', collection: 'Analytical methods' },
];

const sampleAttachments: Attachment[] = [
  { id: 'image', name: 'reaction-observation.png', kind: 'image', size: '1.8 MB', caption: 'Illustrative sample appearance after the observation period.' },
  { id: 'pdf', name: 'instrument-report.pdf', kind: 'pdf', size: '428 KB', caption: 'Example instrument report and acquisition summary.' },
  { id: 'sheet', name: 'screening-results.csv', kind: 'spreadsheet', size: '4 KB', caption: 'Fictional comparative measurements across three samples.' },
  { id: 'scientific', name: 'characterization.fid', kind: 'scientific', size: '12.4 MB', caption: 'Example raw instrument data. A dedicated viewer is planned.' },
];

export const entries: Entry[] = [
  {
    id: 'cat-12-2', notebookId: 'catalysis', title: 'Catalyst loading study', label: 'Catalyst-screen', experimentNumber: 12, runNumber: 2, date: '2026-09-08', author: 'Alex Rivera',
    objective: 'Compare a lower catalyst loading with the baseline run while keeping the remaining screening conditions consistent.',
    description: 'Second run in the catalyst screening series. This entry brings the experimental context, method, observations, and supporting files into one record.',
    method: ['Label the sample set and record the starting materials in the table below.', 'Prepare the comparison series according to the established screening protocol.', 'Record visual observations at consistent intervals and retain the instrument output.'],
    observation: 'The comparison sample developed a pale amber color. No visible precipitation was recorded during the observation period.',
    nextStep: 'Compare the analytical traces with run 1 before selecting the next screening condition.', reagent: 'Model substrate A', amount: '0.50 mmol', citationIds: ['ref-1', 'ref-2'], attachments: sampleAttachments,
  },
  {
    id: 'cat-12-1', notebookId: 'catalysis', title: 'Catalyst loading baseline', label: 'Catalyst-screen', experimentNumber: 12, runNumber: 1, date: '2026-09-06', author: 'Alex Rivera',
    objective: 'Establish a reference condition for the catalyst loading comparison.', description: 'Initial screening run used as the reference for later experiments in this notebook.',
    method: ['Prepare a labeled baseline sample.', 'Record the reference condition and observation times.', 'Collect the example analytical output for comparison.'], observation: 'The baseline sample remained homogeneous throughout the recorded observations.', nextStep: 'Repeat with a lower relative catalyst loading.', reagent: 'Model substrate A', amount: '0.50 mmol', citationIds: ['ref-1'], attachments: sampleAttachments.slice(1, 3),
  },
  {
    id: 'cat-11-1', notebookId: 'catalysis', title: 'Solvent comparison', label: 'Solvent-study', experimentNumber: 11, runNumber: 1, date: '2026-09-05', author: 'Alex Rivera',
    objective: 'Document differences in sample appearance across a model solvent series.', description: 'A preliminary comparison informing the next stage of reaction development.', method: ['Assign an identifier to each comparison sample.', 'Follow the model solvent-screening procedure.', 'Record the appearance of each sample under the same lighting.'], observation: 'Sample B showed the clearest visual separation from the rest of the set.', nextStep: 'Carry the selected reference condition into the catalyst study.', reagent: 'Comparison sample', amount: '3 samples', citationIds: ['ref-2'], attachments: sampleAttachments.slice(0, 1),
  },
  {
    id: 'cat-2-1', notebookId: 'catalysis', title: 'Initial reaction survey', label: 'Reaction-survey', experimentNumber: 2, runNumber: 1, date: '2026-09-02', author: 'Alex Rivera',
    objective: 'Define the initial comparison set and establish notebook conventions.', description: 'An exploratory entry at the beginning of the reaction development sequence.', method: ['Review the fictional reference procedure.', 'Assign labels to the proposed comparison set.', 'Record the criteria for selecting subsequent experiments.'], observation: 'The initial comparison set was documented for the next round of screening.', nextStep: 'Evaluate solvent conditions before catalyst loading.', reagent: 'Reference set', amount: '1 set', citationIds: ['ref-1'], attachments: [],
  },
  {
    id: 'mat-3-2', notebookId: 'materials', title: 'Polymer film repeat', label: 'Film-prep', experimentNumber: 3, runNumber: 2, date: '2026-09-07', author: 'Jamie Lee',
    objective: 'Compare the appearance of a repeated film preparation with the reference sample.', description: 'A second film preparation documenting visual consistency across repeated runs.', method: ['Assign sample labels before preparation.', 'Follow the established example film-preparation method.', 'Document the resulting surface with consistent lighting.'], observation: 'The example film appeared uniform at the center with a slight edge variation.', nextStep: 'Compare surface images with the first preparation.', reagent: 'Model polymer', amount: '1 sample', citationIds: ['ref-3'], attachments: sampleAttachments.slice(0, 2),
  },
  {
    id: 'mat-3-1', notebookId: 'materials', title: 'Reference film preparation', label: 'Film-prep', experimentNumber: 3, runNumber: 1, date: '2026-09-04', author: 'Jamie Lee',
    objective: 'Document a reference polymer film for future surface comparisons.', description: 'Baseline preparation for the functional materials notebook.', method: ['Identify the reference sample.', 'Record the preparation sequence.', 'Capture an illustrative surface image.'], observation: 'The reference film showed a consistent central region.', nextStep: 'Repeat the preparation to compare uniformity.', reagent: 'Model polymer', amount: '1 sample', citationIds: ['ref-3'], attachments: sampleAttachments.slice(0, 1),
  },
  {
    id: 'ana-10-1', notebookId: 'analytical', title: 'Calibration series', label: 'Calibration', experimentNumber: 10, runNumber: 1, date: '2026-09-06', author: 'Casey Bennett',
    objective: 'Document an illustrative calibration series and its supporting measurements.', description: 'A method-development entry connecting reference information and sample data.', method: ['Label the example reference series.', 'Record the acquisition sequence.', 'Compare the tabulated responses across the sample set.'], observation: 'The illustrative responses increased across the reference series.', nextStep: 'Review the example results before a repeat acquisition.', reagent: 'Reference series', amount: '3 samples', citationIds: ['ref-4'], attachments: sampleAttachments.slice(1),
  },
];

export const schemes: Scheme[] = [
  { id: 'route-a', notebookId: 'catalysis', name: 'Route A · development', description: 'From the initial survey to the latest catalyst comparison.', entryIds: ['cat-2-1', 'cat-11-1', 'cat-12-1', 'cat-12-2'] },
  { id: 'loading', notebookId: 'catalysis', name: 'Loading comparison', description: 'Two runs viewed together in their experimental sequence.', entryIds: ['cat-12-1', 'cat-12-2'] },
  { id: 'films', notebookId: 'materials', name: 'Film reproducibility', description: 'Reference preparation followed by a repeat run.', entryIds: ['mat-3-1', 'mat-3-2'] },
  { id: 'calibration', notebookId: 'analytical', name: 'Method development', description: 'The initial calibration entry in the planned method sequence.', entryIds: ['ana-10-1'] },
];

export function entryCode(entry: Entry) { return `${entry.label}-${entry.experimentNumber}-${entry.runNumber}`; }
export function formatDate(date: string) { return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`)); }
