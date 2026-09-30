import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { attachmentUrl, mail, uploadAttachment, type Attachment } from '../lib/api';
import { useT } from '../lib/i18n';
import { Icon } from './Icon';
import { Viewer, viewable } from './Viewer';

const MAX_FILE = 25 << 20;
const MAX_TOTAL = 25 << 20;
const MAX_FILES = 20;

export const fileSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 102.4) / 10} KB` : `${Math.round(n / 104857.6) / 10} MB`;

export function fileIcon(type: string, name = '') {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (type.startsWith('image/')) return '🖼';
  if (type === 'application/pdf' || ext === 'pdf') return '📄';
  if (type.startsWith('audio/')) return '🎵';
  if (type.startsWith('video/')) return '🎬';
  if (/zip|compressed|tar|rar|7z/.test(type) || ['zip', 'rar', '7z', 'gz'].includes(ext)) return '🗜';
  if (/sheet|excel|csv/.test(type) || ['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (/presentation|powerpoint/.test(type) || ['ppt', 'pptx'].includes(ext)) return '📽';
  if (/word|document|text/.test(type) || ['doc', 'docx', 'txt', 'odt'].includes(ext)) return '📝';
  return '📎';
}

type Upload = { key: number; name: string; size: number; type: string; progress: number; id?: number; draftId?: number; error?: string; abort?: () => void };

// Files attached to a message being written. Each uploads as soon as it is added, onto the
// message's draft (the api keeps attachments on drafts until the draft is sent), so the
// first file creates the draft: ensureDraft() returns its id.
export function useUploads(ensureDraft: () => Promise<number>) {
  const t = useT();
  const [items, setItems] = useState<Upload[]>([]);
  /** Shows files already on a draft (reopening it); they're removable like new ones. */
  const seed = useCallback((draftId: number, files: Attachment[]) => {
    setItems(files.map((a) => ({ key: a.id, name: a.filename, size: a.size_bytes, type: a.content_type, progress: 1, id: a.id, draftId })));
  }, []);
  const [error, setError] = useState('');
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const update = (key: number, change: Partial<Upload>) => setItems((list) => list.map((u) => (u.key === key ? { ...u, ...change } : u)));

  const add = useCallback(
    (files: FileList | File[]) => {
      setError('');
      const current = itemsRef.current.filter((u) => !u.error);
      let total = current.reduce((a, u) => a + u.size, 0);
      let count = current.length;
      const accepted: Upload[] = [];
      for (const f of Array.from(files)) {
        if (f.size > MAX_FILE) { setError(t('{name} is larger than 25 MB', { name: f.name })); continue; }
        if (total + f.size > MAX_TOTAL) { setError(t('Attachments may total at most 25 MB')); continue; }
        if (count + 1 > MAX_FILES) { setError(t('At most 20 files per message')); break; }
        total += f.size;
        count++;
        const u: Upload = { key: Date.now() + Math.random(), name: f.name, size: f.size, type: f.type || 'application/octet-stream', progress: 0 };
        ensureDraft().then((draftId) => {
          const job = uploadAttachment(draftId, f, (p) => update(u.key, { progress: p }));
          update(u.key, { abort: job.abort, draftId });
          return job.promise;
        }).then(
          (a) => update(u.key, { id: a.id, progress: 1, abort: undefined }),
          (e: Error) => update(u.key, { error: e.message || t('Could not upload {name}', { name: f.name }), abort: undefined }),
        );
        accepted.push(u);
      }
      if (accepted.length) setItems((list) => [...list, ...accepted]);
    },
    [t, ensureDraft],
  );

  const remove = useCallback((key: number) => {
    const u = itemsRef.current.find((x) => x.key === key);
    if (u?.abort) u.abort();
    if (u?.id && u.draftId) mail.removeAttachment(u.draftId, u.id).catch(() => {});
    setItems((list) => list.filter((x) => x.key !== key));
  }, []);

  // Stop uploads still in progress (closing the message). Finished ones stay on the draft.
  const abortAll = useCallback(() => {
    for (const u of itemsRef.current) if (u.abort) u.abort();
  }, []);

  const ids = items.filter((u) => u.id && !u.error).map((u) => u.id!);
  const uploading = items.some((u) => !u.id && !u.error);
  return { items, ids, uploading, error, add, remove, abortAll, seed, reset: () => setItems([]) };
}

export function AttachButton({ onFiles, id }: { onFiles: (f: FileList) => void; id: string }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="icon-btn attach-btn" aria-label={t('Attach files')} title={t('Attach files')} onClick={() => input.current?.click()}><Icon name="clip" /></button>
      <input ref={input} id={id} type="file" multiple hidden
        onChange={(e) => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = ''; }} />
    </>
  );
}

export function UploadChips({ items, onRemove }: { items: Upload[]; onRemove: (key: number) => void }) {
  const t = useT();
  if (!items.length) return null;
  return (
    <ul className="att-chips uploads">
      {items.map((u) => (
        <li key={u.key} className={u.error ? 'att-chip failed' : u.id ? 'att-chip done' : 'att-chip busy'} data-state={u.error ? 'error' : u.id ? 'done' : 'uploading'}>
          <span className="att-icon" aria-hidden="true">{fileIcon(u.type, u.name)}</span>
          <span className="att-name" title={u.name}>{u.name}</span>
          <span className="att-size">{u.error ? u.error : u.id ? fileSize(u.size) : `${Math.round(u.progress * 100)}%`}</span>
          <button type="button" className="att-remove" aria-label={t('Remove {name}', { name: u.name })} onClick={() => onRemove(u.key)}>✕</button>
          {!u.id && !u.error ? <span className="att-progress" style={{ width: `${Math.max(4, u.progress * 100)}%` }} /> : null}
        </li>
      ))}
    </ul>
  );
}

// Wraps a message editor: dropping files onto it attaches them.
export function DropZone({ onFiles, children, className }: { onFiles: (f: FileList) => void; children: ReactNode; className?: string }) {
  const t = useT();
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  return (
    <div
      className={(className || '') + (over ? ' drop-over' : '')}
      onDragEnter={(e) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setOver(true); }}
      onDragOver={(e) => { if (hasFiles(e)) e.preventDefault(); }}
      onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); }}
      onDrop={(e) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current = 0; setOver(false); if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files); }}
    >
      {children}
      {over ? <div className="drop-hint" aria-hidden="true"><span>📎 {t('Drop files to attach')}</span></div> : null}
    </div>
  );
}

// Files on a received or sent message. Pictures and PDFs open in the viewer (with a
// download button there); other files download. Small images get a preview.
export function AttachmentList({ attachments }: { attachments?: Attachment[] }) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(null);
  if (!attachments?.length) return null;
  const shown = attachments.filter(viewable);
  const inner = (a: Attachment) => (
    <>
      {a.content_type.startsWith('image/') && a.size_bytes < 8 << 20
        ? <img className="att-preview" src={attachmentUrl(a.id)} alt="" loading="lazy" />
        : <span className="att-icon" aria-hidden="true">{fileIcon(a.content_type, a.filename)}</span>}
      <span className="att-name">{a.filename}</span>
      <span className="att-size">{fileSize(a.size_bytes)}</span>
    </>
  );
  return (
    <>
      <ul className="att-chips received" aria-label={t('Attachments')}>
        {attachments.map((a) => (
          <li key={a.id} className="att-chip done">
            {viewable(a) ? (
              <button type="button" className="att-open" title={t('View {name}', { name: a.filename })} onClick={() => setOpen(shown.indexOf(a))}>{inner(a)}</button>
            ) : (
              <a className="att-open" href={attachmentUrl(a.id)} download={a.filename} title={t('Download {name}', { name: a.filename })}>{inner(a)}</a>
            )}
          </li>
        ))}
      </ul>
      {open !== null ? <Viewer files={shown} start={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
