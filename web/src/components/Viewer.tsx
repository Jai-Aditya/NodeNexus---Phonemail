import { useEffect, useState } from 'react';
import { attachmentUrl, fetchAttachment, type Attachment } from '../lib/api';
import { useT } from '../lib/i18n';
import { fileSize } from './Attachments';
import { Icon } from './Icon';

/** Files the viewer can show: pictures and PDFs. Everything else downloads. */
export const viewable = (a: Attachment) =>
  /^image\/(png|jpe?g|gif|webp|bmp|avif)$/.test(a.content_type) || a.content_type === 'application/pdf' || /\.pdf$/i.test(a.filename);

// Pictures and PDFs open over the page, with the email's other viewable files a swipe (or
// arrow key) away. A PDF is fetched and shown from a local copy (a blob: address), the way
// the browser's own PDF viewer can read it without the file being served as a page.
export function Viewer({ files, start, onClose }: { files: Attachment[]; start: number; onClose: () => void }) {
  const t = useT();
  const [i, setI] = useState(start);
  const [pdf, setPdf] = useState<string | null>(null);
  const [error, setError] = useState('');
  const a = files[i];
  const isPdf = a.content_type === 'application/pdf' || /\.pdf$/i.test(a.filename);

  useEffect(() => {
    setPdf(null);
    setError('');
    if (!isPdf) return;
    let url = '';
    let live = true;
    fetchAttachment(a.id).then((b) => {
      url = URL.createObjectURL(new Blob([b], { type: 'application/pdf' }));
      if (live) setPdf(url);
    }, (e: Error) => live && setError(e.message));
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [a.id, isPdf]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setI((x) => Math.min(files.length - 1, x + 1));
      else if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [files.length, onClose]);

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={a.filename}>
      <header className="viewer-bar">
        <span className="viewer-name" title={a.filename}>{a.filename} <span className="muted small">· {fileSize(a.size_bytes)}{files.length > 1 ? ` · ${i + 1}/${files.length}` : ''}</span></span>
        <a className="icon-btn" href={attachmentUrl(a.id)} download={a.filename} aria-label={t('Download {name}', { name: a.filename })}><Icon name="download" /></a>
        <button className="icon-btn" aria-label={t('Close')} onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="viewer-stage" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {i > 0 ? <button className="viewer-nav prev" aria-label={t('Previous')} onClick={() => setI(i - 1)}><Icon name="left" size={28} /></button> : null}
        {isPdf ? (
          error ? <p className="form-error">{error}</p>
            : pdf ? <iframe className="viewer-pdf" src={pdf} title={a.filename} />
              : <p className="muted">{t('Opening…')}</p>
        ) : (
          <img className="viewer-img" src={attachmentUrl(a.id)} alt={a.filename} />
        )}
        {i < files.length - 1 ? <button className="viewer-nav next" aria-label={t('Next')} onClick={() => setI(i + 1)}><Icon name="right" size={28} /></button> : null}
      </div>
    </div>
  );
}
