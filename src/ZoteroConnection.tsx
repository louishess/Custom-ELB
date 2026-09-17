import { desktopAPI } from './desktop-api';
import { useEffect, useState } from 'react';
import type { ZoteroStatus } from '../shared/contracts';

export default function ZoteroConnection({ readOnly = false, onStatus }: {readOnly?: boolean; onStatus?: (status: ZoteroStatus) => void}) {
  const [status, setStatus] = useState<ZoteroStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    setBusy(true);
    void desktopAPI?.zotero.status().then(result => {
      if (cancelled) return;
      if (result.ok) { setStatus(result.value); onStatus?.(result.value); }
      else setError(result.error.message);
    }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [readOnly, onStatus]);
  const change = async (operation: 'connect'|'disconnect'|'status') => {
    setBusy(true); setError('');
    try {
      const result = await desktopAPI?.zotero[operation]();
      if (!result) { setError('The desktop connection is unavailable.'); return; }
      if (!result.ok) { setError(result.error.message); return; }
      setStatus(result.value); onStatus?.(result.value);
    } finally { setBusy(false); }
  };
  return <section className="zotero-connection" aria-label="Zotero connection">
    <div><strong>Zotero</strong><p role="status">{readOnly ? 'Zotero is available in your working library.' : busy ? 'Checking Zotero…' : status?.message || 'Connect the Zotero library on this Mac.'}</p>
      {status?.clientVersion && <small>Zotero {status.clientVersion}</small>}</div>
    <div className="citation-actions">
      <button className="button button-small" disabled={busy || readOnly} onClick={() => void change(status?.state === 'connected' ? 'status' : 'connect')}>{status?.state === 'connected' ? 'Check connection' : status?.enabled ? 'Retry connection' : 'Connect Zotero'}</button>
      {status?.enabled && <button className="text-button" disabled={busy || readOnly} onClick={() => void change('disconnect')}>Disconnect</button>}
    </div>
    {error && <p className="panel-warning" role="alert">{error}</p>}
  </section>;
}
