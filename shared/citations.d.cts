import type {CitationBibliography, CitationStyle, Preferences} from './contracts';
export const CITATION_STYLES: Readonly<Record<CitationStyle, string>>;
export function citationLabel(snapshot: CitationBibliography, preferences: Pick<Preferences,'citationLabel'|'citationStyle'>): string;
