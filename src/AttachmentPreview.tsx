import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileWarning, LoaderCircle } from 'lucide-react';
import { AnnotationMode, GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { JobEvent, Preview } from '../shared/contracts';
import './attachment-preview.css';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PreviewState =
  | { status: 'loading'; progress?: JobEvent }
  | { status: 'ready'; preview: Preview }
  | { status: 'error'; message: string };

function createJobId() {
  try { return crypto.randomUUID(); }
  catch { return `preview-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}

function bytesFromUnknown(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value && typeof value === 'object' && 'data' in value) {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data) && data.every(item => typeof item === 'number')) return new Uint8Array(data);
  }
  return null;
}

function usePreviewUrl(bytes: Uint8Array | null, mime: string) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) {
      setUrl(null);
      return undefined;
    }
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    const nextUrl = URL.createObjectURL(new Blob([copy], { type: mime }));
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [bytes, mime]);
  return url;
}

function LoadingPreview({ progress }: { progress?: JobEvent }) {
  const detail = progress?.message || (progress?.phase === 'parse' ? 'Reading spreadsheet contents…' : 'Preparing attachment preview…');
  const hasProgress = progress?.completed !== undefined && progress.total !== undefined && progress.total > 0;
  const percentage = hasProgress ? Math.min(100, Math.round((progress.completed! / progress.total!) * 100)) : undefined;
  return <div className="attachment-preview-status" role="status" aria-live="polite">
    <LoaderCircle className="attachment-preview-spinner" size={25} aria-hidden="true" />
    <strong>{detail}</strong>
    {percentage !== undefined && <><span className="attachment-preview-progress-text">{percentage}%</span><progress max="100" value={percentage} aria-label="Preview progress" /></>}
  </div>;
}

function UnsupportedPreview({ message }: { message: string }) {
  return <div className="attachment-preview-status attachment-preview-unsupported" role="status">
    <FileWarning size={28} aria-hidden="true" />
    <strong>Preview unavailable</strong>
    <span>{message}</span>
  </div>;
}

function ImagePreview({ bytes, mime }: { bytes: Uint8Array; mime: string }) {
  const url = usePreviewUrl(bytes, mime);
  if (!url) return <LoadingPreview />;
  return <img className="attachment-preview-image" src={url} alt="Attachment preview" draggable={false} />;
}

const MAX_PDF_CANVAS_PIXELS = 8_000_000;

function PdfPreview({ bytes }: { bytes: Uint8Array }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [documentState, setDocumentState] = useState<{ document: PDFDocumentProxy; pageCount: number } | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [status, setStatus] = useState<'loading' | 'rendering' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setStatus('loading');
    setError(null);
    setDocumentState(null);
    setPageNumber(1);
    if (loadingTaskRef.current) void loadingTaskRef.current.destroy().catch(() => {});
    loadingTaskRef.current = null;
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;

    // PDF.js transfers typed-array data to its worker.  Give it a copy so a
    // stale render cannot mutate the Preview object held by React state.
    const data = bytes.slice();
    // pdfjs-dist 6 removed the former isEvalSupported option. This viewer
    // rasterizes pages only, disables annotations/XFA, never asks PDF.js for
    // JavaScript or URL actions, and runs under Electron's denied-network
    // session policy.
    const loadingTask = getDocument({
      data,
      disableAutoFetch: true,
      disableFontFace: true,
      disableRange: true,
      disableStream: true,
      enableXfa: false,
      useSystemFonts: false,
    });
    loadingTaskRef.current = loadingTask;
    void loadingTask.promise.then(document => {
      if (!active) {
        void loadingTask.destroy().catch(() => {});
        return;
      }
      setDocumentState({ document, pageCount: document.numPages });
      setStatus('rendering');
    }).catch(reason => {
      if (!active) return;
      setError(reason instanceof Error && reason.message ? reason.message : 'The PDF could not be rendered safely.');
      setStatus('error');
    });

    return () => {
      active = false;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      if (loadingTaskRef.current) void loadingTaskRef.current.destroy().catch(() => {});
      loadingTaskRef.current = null;
    };
  }, [bytes]);

  useEffect(() => {
    if (!documentState) return undefined;
    let active = true;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    setStatus('rendering');
    setError(null);
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;
    canvas.width = 0;
    canvas.height = 0;
    let pageToClean: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null;

    void documentState.document.getPage(pageNumber).then(page => {
      if (!active) {
        page.cleanup();
        return;
      }
      pageToClean = page;
      const baseViewport = page.getViewport({ scale: 1 });
      if (!Number.isFinite(baseViewport.width) || !Number.isFinite(baseViewport.height) || baseViewport.width <= 0 || baseViewport.height <= 0) throw new Error('The PDF page has invalid dimensions.');
      const basePixels = baseViewport.width * baseViewport.height;
      const scale = Math.min(1.35, Math.sqrt(MAX_PDF_CANVAS_PIXELS / basePixels));
      if (!Number.isFinite(scale) || scale <= 0) throw new Error('The PDF page is too large to preview safely.');
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      if (width * height > MAX_PDF_CANVAS_PIXELS) throw new Error('The PDF page is too large to preview safely.');
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('The PDF preview canvas is unavailable.');
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const renderTask = page.render({ canvas, canvasContext: context, viewport, annotationMode: AnnotationMode.DISABLE });
      renderTaskRef.current = renderTask;
      return renderTask.promise;
    }).then(() => {
      if (active) setStatus('ready');
    }).catch(reason => {
      if (!active || reason?.name === 'RenderingCancelledException') return;
      setError(reason instanceof Error && reason.message ? reason.message : 'The PDF page could not be rendered safely.');
      setStatus('error');
    });

    return () => {
      active = false;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      pageToClean?.cleanup();
    };
  }, [documentState, pageNumber]);

  if (status === 'error') return <UnsupportedPreview message={error || 'The PDF could not be rendered safely.'} />;
  return <div className="attachment-preview-pdf-wrap">
    <div className="attachment-preview-pdf-toolbar" aria-label="PDF pages">
      <button className="icon-button" type="button" aria-label="Previous page" disabled={!documentState || pageNumber <= 1 || status === 'rendering'} onClick={() => setPageNumber(value => Math.max(1, value - 1))}><ChevronLeft size={16} /></button>
      <span>{documentState ? `Page ${pageNumber} of ${documentState.pageCount}` : 'Loading PDF…'}</span>
      <button className="icon-button" type="button" aria-label="Next page" disabled={!documentState || pageNumber >= documentState.pageCount || status === 'rendering'} onClick={() => setPageNumber(value => Math.min(documentState?.pageCount || value, value + 1))}><ChevronRight size={16} /></button>
    </div>
    <div className="attachment-preview-pdf-canvas-wrap"><canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} /></div>
    {status === 'rendering' && <span className="attachment-preview-pdf-status" role="status">Rendering page…</span>}
  </div>;
}

function SpreadsheetPreview({ preview }: { preview: Preview }) {
  const sheets = preview.sheets || [];
  if (!sheets.length) return <UnsupportedPreview message="The spreadsheet contains no previewable worksheet cells." />;
  return <div className="attachment-preview-spreadsheet">
    {sheets.map(sheet => <section key={sheet.name} className="attachment-preview-sheet">
      <h4>{sheet.name}</h4>
      <div className="attachment-preview-table-wrap"><table><tbody>{sheet.rows.map((row, rowIndex) => <tr key={`${sheet.name}-${rowIndex}`}>{row.map((cell, columnIndex) => <td key={`${rowIndex}-${columnIndex}`}>{cell}</td>)}</tr>)}</tbody></table></div>
    </section>)}
    {preview.message && <p className="attachment-preview-limit" role="status">{preview.message}</p>}
  </div>;
}

/** Render a preview by managed attachment ID; renderer code never receives a filesystem path. */
export default function AttachmentPreview({ attachmentId }: { attachmentId: string }) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    const api = window.labmate;
    const jobId = createJobId();
    if (!api) {
      setState({ status: 'error', message: 'Attachment previews are unavailable until the desktop bridge is connected.' });
      return () => { active = false; };
    }
    setState({ status: 'loading' });
    const unsubscribe = api.onProgress?.(event => {
      if (active && event.jobId === jobId) setState(current => current.status === 'loading' ? { status: 'loading', progress: event } : current);
    });
    void api.attachments.preview({ id: attachmentId, jobId }).then(result => {
      if (!active) return;
      if (!result.ok) {
        setState({ status: 'error', message: result.error.message });
        return;
      }
      setState({ status: 'ready', preview: result.value });
    }).catch(error => {
      if (!active) return;
      setState({ status: 'error', message: error instanceof Error ? error.message : 'The attachment preview failed.' });
    });
    return () => {
      active = false;
      unsubscribe?.();
      void api.jobs.cancel({ jobId }).catch(() => {});
    };
  }, [attachmentId]);

  if (state.status === 'loading') return <LoadingPreview progress={state.progress} />;
  if (state.status === 'error') return <UnsupportedPreview message={state.message} />;
  if (state.preview.kind === 'unsupported') return <UnsupportedPreview message={state.preview.message || 'This attachment format does not have a safe preview.'} />;
  if (state.preview.kind === 'spreadsheet') return <SpreadsheetPreview preview={state.preview} />;
  const bytes = bytesFromUnknown(state.preview.bytes);
  if (!bytes) return <UnsupportedPreview message="The desktop bridge returned no preview bytes." />;
  if (state.preview.kind === 'image') return <ImagePreview bytes={bytes} mime={state.preview.mime || 'image/png'} />;
  return <PdfPreview bytes={bytes} />;
}
