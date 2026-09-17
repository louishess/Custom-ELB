import {citationLabel, CITATION_STYLES} from '../shared/citations.cjs';
import { useEffect, useRef, useState } from 'react';
import { Check, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Modal } from './components';
import ZoteroConnection from './ZoteroConnection';
import type { CitationIdentity, CitationRecord, CitationTarget, LibrarySnapshot, Result, ZoteroCollection, ZoteroItem, ZoteroLibrary, ZoteroStatus } from '../shared/contracts';

const identity = ({sourceInstance, libraryType, libraryId, itemKey}: CitationIdentity): CitationIdentity => ({sourceInstance, libraryType, libraryId, itemKey});
const itemKey = (item: CitationIdentity) => [item.sourceInstance, item.libraryType, item.libraryId, item.itemKey].join('/');
const authors = (item: ZoteroItem) => item.snapshot.creators.map(c => c.name).filter(Boolean).join('; ');

function Bibliography({item}: {item: ZoteroItem}) {
  const s = item.snapshot;
  return <div className="citation-bibliography"><h3>{s.title || 'Untitled reference'}</h3>
    {authors(item) && <p>{authors(item)}</p>}
    <dl>{[['Formatted citation', s.formattedCitation ? `${s.formattedCitation.text} · ${CITATION_STYLES[s.formattedCitation.style]}` : ''], ['Date', s.date], ['Publication', s.publication], ['Volume / issue / pages', [s.volume, s.issue, s.pages].filter(Boolean).join(' / ')], ['DOI', s.doi], ['URL', s.url], ['Library', s.libraryLabel]].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <small>Saved reference details · {new Date(s.fetchedAt).toLocaleDateString()}</small>
  </div>;
}

export default function ZoteroPanel({snapshot, experimentId, citationId, readOnly, onSnapshot, onClose}: {
  snapshot: LibrarySnapshot; experimentId?: string; citationId?: string; readOnly: boolean; onSnapshot: (snapshot: LibrarySnapshot) => void; onClose: () => void;
}) {
  const [destination, setDestination] = useState(experimentId || '');
  const [connection, setConnection] = useState<ZoteroStatus | null>(null);
  const [libraries, setLibraries] = useState<ZoteroLibrary[]>([]);
  const [libraryNext, setLibraryNext] = useState<number|null>(null);
  const [libraryId, setLibraryId] = useState('user/0');
  const [collections, setCollections] = useState<ZoteroCollection[]>([]);
  const [collectionNext, setCollectionNext] = useState<number|null>(null);
  const [collectionKey, setCollectionKey] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ZoteroItem[]>([]);
  const [nextStart, setNextStart] = useState<number|null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<ZoteroItem | CitationRecord | null>(() => snapshot.citations.find(c => c.id === citationId && c.experimentId === experimentId) || null);
  const [candidate, setCandidate] = useState<{token: string; item: ZoteroItem; target: CitationTarget}|null>(null);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sessionId = useRef(crypto.randomUUID());
  const mounted = useRef(true);
  const queryEpoch = useRef(0);
  const sourceEpoch = useRef(0);
  const activeExperiments = snapshot.experiments.filter(e => !e.trashedAt && snapshot.notebooks.some(n => n.id === e.notebookId && !n.trashedAt));
  const experiment = activeExperiments.find(e => e.id === destination);
  const citations = snapshot.citations.filter(c => c.experimentId === experiment?.id);
  const added = new Set(citations.map(itemKey));
  const library = libraries.find(l => `${l.libraryType}/${l.libraryId}` === libraryId);
  const style = snapshot.preferences.citationStyle || undefined;
  const connected = connection?.state === 'connected';
  const target = (): CitationTarget => ({experimentId: experiment!.id, expectedRevision: experiment!.revision, libraryGeneration:snapshot.libraryGeneration});
  const isSaved = detail && 'id' in detail ? citations.find(c => c.id === detail.id) : undefined;

  useEffect(() => {
    mounted.current = true;
    const activeSession = crypto.randomUUID(); sessionId.current = activeSession;
    return () => { mounted.current = false; queryEpoch.current++; sourceEpoch.current++; if (!readOnly) void window.labmate?.zotero.cancel({sessionId:activeSession}); };
  }, [readOnly]);
  const failure = (message: string) => { if (mounted.current) setError(message); };

  useEffect(() => {
    const epoch = ++sourceEpoch.current;
    setLibraries([]); setCollections([]); setItems([]); setSelected([]); setCandidate(null); setLibraryNext(null); setNextStart(null);
    if (!connected || !connection) return;
    void window.labmate?.zotero.libraries({generation:connection.generation, start:0}).then(result => {
      if (!mounted.current || epoch !== sourceEpoch.current) return;
      if (result.ok) { setLibraries(result.value.items); setLibraryNext(result.value.nextStart); setLibraryId('user/0'); }
      else failure(result.error.message);
    });
  }, [connection?.generation, connected]);

  useEffect(() => {
    let cancelled = false;
    setCollections([]); setCollectionKey(''); setCollectionNext(null);
    if (!connected || !connection || !library) return;
    void window.labmate?.zotero.collections({generation:connection.generation, libraryType:library.libraryType, libraryId:library.libraryId, start:0}).then(result => {
      if (cancelled || !mounted.current) return;
      if (result.ok) { setCollections(result.value.items); setCollectionNext(result.value.nextStart); }
      else failure(result.error.message);
    });
    return () => { cancelled = true; };
  }, [connection?.generation, connected, libraryId, !!library]);

  useEffect(() => {
    const epoch = ++queryEpoch.current;
    setItems([]); setSelected([]); setNextStart(null); setSearching(false);
    if (!connected || !connection || !library) return;
    setSearching(true);
    const timer = setTimeout(() => {
      void window.labmate?.zotero.search({generation:connection.generation, libraryType:library.libraryType, libraryId:library.libraryId, query, start:0, style, ...(collectionKey ? {collectionKey} : {})}).then(result => {
        if (!mounted.current || epoch !== queryEpoch.current) return;
        setSearching(false);
        if (result.ok) { setItems(result.value.items); setNextStart(result.value.nextStart); }
        else failure(result.error.message);
      });
    }, 250);
    return () => { clearTimeout(timer); queryEpoch.current++; };
  }, [query, collectionKey, libraryId, !!library, connected, connection?.generation, style]);

  const more = async (kind: 'libraries'|'collections'|'items') => {
    if (!connection || !library) return;
    const source = sourceEpoch.current, epoch = queryEpoch.current;
    setBusy(true); setError('');
    try {
      if (kind === 'libraries' && libraryNext !== null) {
        const result = await window.labmate?.zotero.libraries({generation:connection.generation,start:libraryNext});
        if (!mounted.current || source !== sourceEpoch.current) return;
        if (result?.ok) { setLibraries(old => [...old, ...result.value.items]); setLibraryNext(result.value.nextStart); }
        else if(result) failure(result.error.message);
      } else if (kind === 'collections' && collectionNext !== null) {
        const result = await window.labmate?.zotero.collections({generation:connection.generation,libraryType:library.libraryType,libraryId:library.libraryId,start:collectionNext});
        if (!mounted.current || epoch !== queryEpoch.current) return;
        if (result?.ok) { setCollections(old => [...old, ...result.value.items]); setCollectionNext(result.value.nextStart); }
        else if(result) failure(result.error.message);
      } else if (kind === 'items' && nextStart !== null) {
        const result = await window.labmate?.zotero.search({generation:connection.generation,libraryType:library.libraryType,libraryId:library.libraryId,query,start:nextStart,style,...(collectionKey?{collectionKey}:{})});
        if (!mounted.current || epoch !== queryEpoch.current) return;
        if (result?.ok) { setItems(old => [...new Map([...old,...result.value.items].map(item => [itemKey(item),item])).values()]); setNextStart(result.value.nextStart); }
        else if(result) failure(result.error.message);
      }
    } finally { if(mounted.current) setBusy(false); }
  };
  const mutate = async (operation: () => Promise<Result<LibrarySnapshot> | undefined>, message: string) => {
    if (!experiment || readOnly || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await operation();
      if (!mounted.current) return;
      if (result?.ok) { onSnapshot(result.value); setNotice(message); setSelected([]); setCandidate(null); setDetail(null); }
      else {
        failure(result ? result.error.message : 'The desktop connection is unavailable.');
        if (result && !result.ok && result.error.code === 'STALE_REVISION') {
          const latest = await window.labmate?.records.snapshot();
          if (mounted.current && latest?.ok && latest.value.libraryGeneration === snapshot.libraryGeneration) onSnapshot(latest.value);
        }
      }
    } finally { if(mounted.current) setBusy(false); }
  };
  const refresh = async () => {
    if (!isSaved || !experiment || !connection || !connected) return;
    setBusy(true); setError(''); setCandidate(null);
    const captured = target();
    try {
      const result = await window.labmate?.citations.previewRefresh({...captured,id:isSaved.id,generation:connection.generation,sessionId:sessionId.current});
      if (!mounted.current) return;
      if (result?.ok) setCandidate({...result.value,target:captured});
      else failure(result ? result.error.message : 'The desktop connection is unavailable.');
    } finally { if(mounted.current) setBusy(false); }
  };

  return <Modal title="Citation library" eyebrow={experiment ? `${experiment.label} · Shared across all runs` : 'References'} onClose={onClose} wide>
    <div className="modal-body citation-panel">
      <ZoteroConnection readOnly={readOnly} onStatus={setConnection} />
      {!experimentId && <label className="field-label">Add references to experiment<select aria-label="Citation destination experiment" value={destination} disabled={busy} onChange={e => {setDestination(e.target.value);setDetail(null);setCandidate(null);setSelected([]);}}><option value="">Choose an experiment</option>{activeExperiments.map(e => <option key={e.id} value={e.id}>{snapshot.notebooks.find(n => n.id===e.notebookId)?.name} · {e.experimentNumber} — {e.label}</option>)}</select></label>}
      {snapshot.legacyCitationCount > 0 && <p className="panel-warning">{snapshot.legacyCitationCount} older run references were preserved in the library and need migration review.</p>}
      {experiment && <section className="experiment-references" aria-label="Experiment citations"><h3>Experiment references <span>({citations.length})</span></h3><p className="field-help">Shared across all runs, including completed runs.</p>{citations.length ? citations.map(c => <button type="button" className="saved-citation" key={c.id} disabled={busy} onClick={() => {setDetail(c);setCandidate(null);}}><Check size={14}/><span>{citationLabel(c.snapshot,snapshot.preferences)}<small>{snapshot.preferences.citationLabel==='formatted'?c.snapshot.title:authors(c)}{c.snapshot.date ? ` · ${c.snapshot.date}` : ''}</small></span></button>) : <p className="muted-note">No citations are associated with this experiment yet.</p>}</section>}
      {connected && <>
        <div className="form-columns"><label className="field-label">Zotero library<select aria-label="Zotero library" value={libraryId} disabled={busy} onChange={e => {setLibraryId(e.target.value);setDetail(null);setCandidate(null);}}>{libraries.map(l => <option key={`${l.libraryType}/${l.libraryId}`} value={`${l.libraryType}/${l.libraryId}`}>{l.name}</option>)}</select></label><label className="field-label">Collection<select aria-label="Zotero collection" value={collectionKey} disabled={busy} onChange={e=>setCollectionKey(e.target.value)}><option value="">All references</option>{collections.map(c => <option key={c.key} value={c.key}>{c.parentKey ? `${collections.find(p=>p.key===c.parentKey)?.name || 'Subcollection'} / ` : ''}{c.name}</option>)}</select></label></div>
        <div className="citation-actions">{libraryNext!==null && <button className="text-button" disabled={busy} onClick={()=>void more('libraries')}>More libraries</button>}{collectionNext!==null && <button className="text-button" disabled={busy} onClick={()=>void more('collections')}>More collections</button>}</div>
        <div className="search-field"><Search size={16}/><input aria-label="Search Zotero references" placeholder="Search title, author, or year" value={query} disabled={busy} onChange={e=>setQuery(e.target.value)}/></div>
        <div className="citation-results" aria-label="Zotero search results" aria-busy={searching}>{searching ? <p role="status">Searching Zotero…</p> : items.length ? items.map(item => {
          const key=itemKey(item); return <div className="citation-result" key={key}><input type="checkbox" aria-label={`Select ${item.snapshot.title || 'Untitled reference'}`} checked={added.has(key)||selected.includes(key)} disabled={busy||added.has(key)||!experiment||readOnly} onChange={e=>setSelected(old=>e.target.checked?[...old,key]:old.filter(id=>id!==key))}/><button type="button" disabled={busy} onClick={()=>{setDetail(item);setCandidate(null);}}><strong>{citationLabel(item.snapshot,snapshot.preferences)}</strong>{snapshot.preferences.citationLabel==='formatted'&&<small>{item.snapshot.title}</small>}<small>{authors(item)}{item.snapshot.date?` · ${item.snapshot.date}`:''}</small><small>{item.snapshot.publication}</small></button>{added.has(key)&&<span className="soft-badge">Added</span>}</div>;
        }) : <p className="muted-note">No references on this page.{nextStart!==null?' Continue to the next page.':''}</p>}</div>
        {nextStart!==null && <button className="button button-small" disabled={busy||searching} onClick={()=>void more('items')}>Load more references</button>}
      </>}
      {detail && <section className="citation-detail-card" aria-label="Reference details"><Bibliography item={detail}/>{isSaved && <div className="citation-actions"><button className="button button-small" disabled={busy||!connected||readOnly} onClick={()=>void refresh()}><RefreshCw size={14}/>Refresh details</button><button className="button button-small danger-outline" disabled={busy||readOnly} onClick={()=>void mutate(()=>window.labmate!.citations.remove({...target(),id:isSaved.id}),'Citation removed from every run of this experiment.')}><Trash2 size={14}/>Remove from experiment</button></div>}</section>}
      {candidate && <section className="citation-detail-card" aria-label="Updated reference preview"><h3>Updated Zotero details</h3><p className="field-help">Review these details before updating the reference for every run.</p><Bibliography item={candidate.item}/><div className="citation-actions"><button className="button button-primary" disabled={busy} onClick={()=>void mutate(()=>window.labmate!.citations.applyRefresh({...candidate.target,token:candidate.token,sessionId:sessionId.current}),'Reference details updated for every run.')} >Use updated details</button><button className="button" disabled={busy} onClick={()=>setCandidate(null)}>Keep saved details</button></div></section>}
      {error && <p className="panel-warning" role="alert">{error}</p>}{notice && <p className="panel-status" role="status">{notice}</p>}
    </div>
    <div className="modal-footer"><span>{busy?'Saving or loading…':experiment?'Citations are shared across this experiment’s runs.':'Select an experiment to associate references.'}</span><div className="citation-actions"><button className="button" onClick={onClose}>Done</button><button className="button button-primary" disabled={busy||searching||!connected||!experiment||!selected.length||readOnly} onClick={()=>void mutate(()=>window.labmate!.citations.add({...target(),generation:connection!.generation,sessionId:sessionId.current,items:items.filter(i=>selected.includes(itemKey(i))).map(identity)}),'Citations added to every run of this experiment.')}><Plus size={15}/>Add to experiment{selected.length?` (${selected.length})`:''}</button></div></div>
  </Modal>;
}
