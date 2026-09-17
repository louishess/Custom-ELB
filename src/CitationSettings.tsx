import { desktopAPI } from './desktop-api';
import {useEffect, useRef, useState} from 'react';
import {CITATION_STYLES} from '../shared/citations.cjs';
import type {CitationStyle, LibrarySnapshot, Preferences} from '../shared/contracts';

export default function CitationSettings({snapshot, readOnly, updatePreference, onSnapshot}: {
  snapshot: LibrarySnapshot; readOnly: boolean;
  updatePreference: (changes: Partial<Preferences>) => Promise<LibrarySnapshot | undefined>;
  onSnapshot: (snapshot: LibrarySnapshot) => void;
}) {
  const [busy,setBusy]=useState(false), [message,setMessage]=useState('');
  const session=useRef<string|null>(null), mounted=useRef(true), changing=useRef(false);
  const cancel=()=>{const id=session.current;session.current=null;if(id)void desktopAPI?.zotero.cancel({sessionId:id});};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;cancel();};},[]);
  const active=(s:LibrarySnapshot)=>s.citations.filter(c=>s.experiments.some(e=>e.id===c.experimentId&&!e.trashedAt&&s.notebooks.some(n=>n.id===e.notebookId&&!n.trashedAt)));
  const pending=active(snapshot).filter(c=>!snapshot.preferences.citationStyle||c.snapshot.formattedCitation?.style!==snapshot.preferences.citationStyle).length;
  async function updateLabels(base:LibrarySnapshot, missingOnly=false) {
    if(readOnly||session.current||!base.preferences.citationStyle) return;
    const references=active(base).filter(c=>!missingOnly||c.snapshot.formattedCitation?.style!==base.preferences.citationStyle);
    if(!references.length) return;
    const id=crypto.randomUUID();session.current=id;setBusy(true);setMessage('Checking Zotero…');
    const current=()=>mounted.current&&session.current===id;
    let latest=base, updated=0, failed=0, reason='';
    try {
      const status=await desktopAPI?.zotero.status();if(!current())return;
      if(!status?.ok||status.value.state!=='connected') {setMessage('Connect Zotero, then choose Update citation labels. Saved labels remain available offline.');return;}
      for(const reference of references) {
        if(!current())return;
        const experiment=latest.experiments.find(e=>e.id===reference.experimentId)!;
        setMessage(`Updating labels ${updated+failed+1} of ${references.length}…`);
        const result=await desktopAPI!.citations.refreshLabel({id:reference.id,experimentId:experiment.id,expectedRevision:experiment.revision,libraryGeneration:latest.libraryGeneration,generation:status.value.generation,sessionId:id});
        if(!current())return;
        if(result.ok) {latest=result.value;updated++;onSnapshot(latest);}
        else {failed++;reason=result.error.message;if(['STALE_REVISION','CANCELLED'].includes(result.error.code))break;}
      }
      if(current())setMessage(`${updated} citation ${updated===1?'label':'labels'} updated.${failed?` ${reason} Previously saved details were kept.`:''}`);
    } catch {if(current())setMessage('Labels could not be retrieved. Saved references are unchanged. Retry when Zotero is available.');}
    finally {if(session.current===id){session.current=null;if(mounted.current)setBusy(false);}}
  }
  async function change(changes:Partial<Preferences>) {
    if(busy||changing.current)return;
    changing.current=true;setBusy(true);
    try {
      const next=await updatePreference(changes);if(!mounted.current||!next)return;
      setMessage('');
      if(next.preferences.citationLabel==='formatted'&&next.preferences.citationStyle) await updateLabels(next,true);
    } finally {changing.current=false;if(mounted.current&&!session.current)setBusy(false);}
  }
  return <section className="citation-label-settings" aria-label="Citation label settings">
    <h3>Citation labels</h3><p className="field-help">Choose how references are named throughout LabMate. Saved labels also work offline.</p>
    <div className="form-columns">
      <label className="field-label">Show citations as<select aria-label="Show citations as" value={snapshot.preferences.citationLabel} disabled={busy} onChange={e=>void change({citationLabel:e.target.value as Preferences['citationLabel']})}><option value="title">Paper title</option><option value="formatted">Formatted citation</option></select></label>
      <label className="field-label">Citation style<select aria-label="Citation style" value={snapshot.preferences.citationStyle} disabled={busy} onChange={e=>void change({citationStyle:e.target.value as CitationStyle|''})}><option value="">Choose a citation style…</option>{Object.entries(CITATION_STYLES).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
    </div>
    <p className="field-help">Zotero formats labels in the style you choose here. For numbered styles, the full reference identifies the paper. This setting changes labels; exported reference lists keep their existing format.</p>
    {snapshot.preferences.citationLabel==='formatted'&&<>
      {!snapshot.preferences.citationStyle?<p className="muted-note">Choose a citation style to use formatted labels. Paper titles are shown until then.</p>:<p className="muted-note">{pending?`${pending} linked ${pending===1?'reference needs':'references need'} a label in this style. Paper titles are shown until labels are retrieved.`:'All linked references have saved labels in this style.'}</p>}
      <div className="citation-actions"><button className="button button-small" disabled={readOnly||busy||!snapshot.preferences.citationStyle||!active(snapshot).length} onClick={()=>void updateLabels(snapshot)}>Update citation labels</button>{busy&&<button className="button button-small" onClick={()=>{cancel();setBusy(false);setMessage('Label update cancelled. Completed labels were saved.');}}>Cancel update</button>}</div>
    </>}
    {message&&<p role="status" className="field-help">{message}</p>}
  </section>;
}
