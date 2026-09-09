import { useEffect, useRef, useState } from 'react';
import { Download, Mic, Square } from 'lucide-react';
import { Modal } from './components';
import type { DictationCapabilities, DictationEvent } from '../shared/contracts';
import './dictation.css';

export default function DictationDialog({ sessionId, originLabel, onInsert, onCancel }: {
  sessionId: string; originLabel: string; onInsert: (text: string) => void; onCancel: () => void;
}) {
  const [capabilities, setCapabilities] = useState<DictationCapabilities | null>(null);
  const [locale, setLocale] = useState('en-US');
  const [transcript, setTranscript] = useState('');
  const [state, setState] = useState<DictationEvent['state']>('ready');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Checking on-device speech support…');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const mounted = useRef(true);
  const prefix = useRef('');
  const acceptingTranscript = useRef(false);
  const requestEpoch = useRef(0);
  const terminalState = useRef<'error' | 'cancelled' | null>(null);
  const stateRef = useRef(state); stateRef.current = state;
  const busyRef = useRef(busy); busyRef.current = busy;
  const transcriptRef = useRef(transcript); transcriptRef.current = transcript;
  const available = Boolean(capabilities?.available);
  const selected = capabilities?.locales.find(item => item.id === locale);
  const recording = state === 'recording';

  useEffect(() => {
    mounted.current = true;
    const api = window.labmate;
    if (!api?.dictation) { setMessage('Integrated dictation is available in the LabMate desktop app on macOS 26 or later.'); return; }
    let live = true;
    void api.dictation.capabilities().then(result => {
      if (!live) return;
      if (!result.ok) { setMessage(result.error.message); return; }
      setCapabilities(result.value);
      const english = result.value.locales.find(item => item.id.toLowerCase() === 'en-us');
      setLocale(english?.id ?? result.value.locales[0]?.id ?? 'en-US');
      setMessage(result.value.available ? 'Ready when you are. Review the transcript before inserting it.' : result.value.reason ?? 'On-device speech recognition is unavailable.');
    }).catch(() => { if (live) setMessage('Unable to check speech support. Close this dialog and try again.'); });
    const unsubscribe = api.onDictation(event => {
      if (!live || event.sessionId !== sessionId) return;
      setState(event.state);
      if (event.state === 'error' || event.state === 'cancelled') { terminalState.current = event.state; acceptingTranscript.current = false; }
      // Preparing or cancelling must not overwrite a corrected review draft.
      if (acceptingTranscript.current && event.transcript !== undefined && (event.state === 'recording' || event.state === 'stopped')) setTranscript(prefix.current + event.transcript);
      if (event.message) setMessage(event.message);
      else if (event.state === 'recording') setMessage('Listening on this Mac…');
      else if (event.state === 'stopped') setMessage('Recording stopped. Correct the transcript, then insert it.');
    });
    const unregisterClose = api.onBeforeClose(async () => {
      // A close attempt stops capture but retains this unresolved draft.
      if (stateRef.current === 'recording' || busyRef.current) {
        requestEpoch.current += 1;
        acceptingTranscript.current = false;
        await api.dictation.cancel({ sessionId });
        if (live) { setBusy(false); setState('stopped'); }
      }
      if (live) setMessage('Insert or discard this transcript before closing LabMate.');
      return false;
    });
    return () => {
      live = false; mounted.current = false; requestEpoch.current += 1;
      unsubscribe(); unregisterClose();
      void api.dictation.cancel({ sessionId });
    };
  }, [sessionId]);

  async function prepare() {
    const api = window.labmate;
    if (!api || busy) return;
    const epoch = ++requestEpoch.current;
    const current = () => mounted.current && requestEpoch.current === epoch;
    terminalState.current = null;
    setBusy(true); setMessage('Preparing language assets. An initial download may be needed.');
    try {
      const result = await api.dictation.prepare({ sessionId, locale });
      if (!current()) return;
      if (!result.ok) { setState('error'); setMessage(result.error.message); }
      else if (!terminalState.current) { setCapabilities(current => current && ({ ...current, locales: current.locales.map(item => item.id === locale ? { ...item, installed: true } : item) })); setState('ready'); setMessage('Language ready. Start recording when you are ready.'); }
    } catch { if (current()) { setState('error'); setMessage('Language preparation failed. Try again.'); } }
    finally { if (current()) setBusy(false); }
  }
  async function start() {
    const api = window.labmate;
    if (!api || busy) return;
    const epoch = ++requestEpoch.current;
    const current = () => mounted.current && requestEpoch.current === epoch;
    terminalState.current = null;
    acceptingTranscript.current = true;
    prefix.current = transcriptRef.current ? `${transcriptRef.current.trimEnd()} ` : '';
    setBusy(true); setMessage('Preparing on-device speech…');
    try {
      // A language listed by macOS is not necessarily ready for this app's exact
      // transcription configuration. Finish preparation before opening audio.
      const prepared = await api.dictation.prepare({ sessionId, locale });
      if (!current()) return;
      if (!prepared.ok) { acceptingTranscript.current = false; setState('error'); setMessage(prepared.error.message); return; }
      if (terminalState.current) return;
      setCapabilities(value => value && ({...value, locales: value.locales.map(item => item.id === locale ? {...item, installed: true} : item)}));
      setMessage('Starting the microphone…');
      const result = await api.dictation.start({ sessionId, locale });
      if (!current()) return;
      if (!result.ok) { acceptingTranscript.current = false; setState('error'); setMessage(result.error.message); }
      else if (!terminalState.current) setState('recording');
    } catch { if (current()) { acceptingTranscript.current = false; setState('error'); setMessage('The microphone could not start. Try again.'); } }
    finally { if (current()) setBusy(false); }
  }
  async function stop() {
    const api = window.labmate;
    if (!api || busy) return;
    const epoch = ++requestEpoch.current;
    const current = () => mounted.current && requestEpoch.current === epoch;
    setBusy(true); setMessage('Finishing the transcript…');
    try {
      const result = await api.dictation.stop({ sessionId });
      if (!current()) return;
      acceptingTranscript.current = false;
      setState(result.ok ? 'stopped' : 'error');
      if (!result.ok) setMessage(result.error.message);
    } catch { if (current()) { acceptingTranscript.current = false; setState('error'); setMessage('Recording stopped unexpectedly. Review the available transcript.'); } }
    finally { if (current()) setBusy(false); }
  }
  async function requestClose() {
    if (recording || busy) {
      requestEpoch.current += 1;
      acceptingTranscript.current = false;
      await window.labmate?.dictation.cancel({ sessionId });
      if (!mounted.current) return;
      setBusy(false); setState('stopped');
    }
    if (transcriptRef.current.trim()) setConfirmDiscard(true);
    else onCancel();
  }
  return <Modal title="Dictation" eyebrow={originLabel} onClose={() => { void requestClose(); }} wide>
    <div className="modal-body dictation-body">
      <p className="dictation-privacy">Speech is processed on this Mac. LabMate records only after you choose Start and never saves audio. Language assets may need an initial download.</p>
      <label className="field-label">Dictation language<select aria-label="Dictation language" value={locale} disabled={!available || busy || recording} onChange={event => setLocale(event.target.value)}>
        {!capabilities?.locales.length && <option value="en-US">English (United States)</option>}
        {capabilities?.locales.map(item => <option key={item.id} value={item.id}>{item.name}{item.installed ? '' : ' — download needed'}</option>)}
      </select></label>
      <div className="dictation-controls">
        {!selected?.installed && available && <button className="button" disabled={busy || recording} onClick={() => { void prepare(); }}><Download size={16} />Prepare language</button>}
        <button className="button button-primary" disabled={!available || !selected || busy || recording} onClick={() => { void start(); }}><Mic size={16} />Start</button>
        <button className="button" disabled={!recording || busy} onClick={() => { void stop(); }}><Square size={14} />Stop</button>
        <span className={`dictation-status ${recording ? 'is-recording' : ''}`} role="status" aria-live="polite">{message}</span>
      </div>
      <label className="field-label" htmlFor="dictation-transcript">Review transcript<textarea id="dictation-transcript" aria-label="Review transcript" value={transcript} readOnly={recording || busy} placeholder="Your transcript will appear here. You can correct it after stopping." rows={9} maxLength={1_000_000} onChange={event => { setTranscript(event.target.value); setConfirmDiscard(false); }} /></label>
      <p className="muted-note">Insert adds this text at the saved selection in {originLabel}. Recording again appends to your review draft.</p>
      {confirmDiscard && <div className="dictation-discard" role="alert"><p>Discard this transcript? It has not been inserted into your entry.</p><button className="button" onClick={() => setConfirmDiscard(false)}>Keep reviewing</button><button className="button" onClick={onCancel}>Discard transcript</button></div>}
    </div>
    <div className="modal-footer"><button className="button" onClick={() => { void requestClose(); }}>Cancel</button><button className="button button-primary" disabled={recording || busy || !transcript.trim()} onClick={() => { try { onInsert(transcript.trim()); } catch (error) { setMessage(error instanceof Error ? error.message : "The original selection is unavailable. Copy the transcript before closing."); } }}>Insert transcript</button></div>
  </Modal>;
}
