import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { mail, type Folder } from '../lib/api';
import { useT } from '../lib/i18n';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';

// The user's own folders for conversations. A conversation is filed in at most one folder;
// filing it also archives it (it leaves the Inbox), and new mail brings it back to the Inbox
// while it stays in its folder. A folder lists with the Inbox filter "folder:<id>".

const CHANGED = 'phonemail:folders';
/** Tells every folder list on the page to load again (after a create, rename, delete or move). */
export const foldersChanged = () => window.dispatchEvent(new Event(CHANGED));

/** The folder id of an Inbox filter "folder:<id>", or undefined. */
export const folderOf = (filter: string) => (/^folder:(\d+)$/.exec(filter) ? Number(filter.slice(7)) : undefined);

/** The user's folders, kept fresh: loads now, on live changes and after foldersChanged(). */
export function useFolders() {
  const { onLive } = useSession();
  const [folders, setFolders] = useState<Folder[]>([]);
  const load = useCallback(() => { mail.folders().then(setFolders, () => {}); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onLive((e) => { if (e.type === 'chats' || e.type === 'message') load(); }), [onLive, load]);
  useEffect(() => {
    window.addEventListener(CHANGED, load);
    return () => window.removeEventListener(CHANGED, load);
  }, [load]);
  return folders;
}

/** A small name field for a new folder (or a new name). */
function NameField({ initial = '', label, onDone, onCancel }: {
  initial?: string; label: string; onDone: (name: string) => Promise<void>; onCancel: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onDone(name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong'));
    }
    setBusy(false);
  };
  return (
    <form className="folder-name" onSubmit={submit}>
      <input autoFocus value={name} maxLength={40} aria-label={label} placeholder={label}
        onChange={(e) => { setName(e.target.value); setError(''); }}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }} />
      <button type="submit" className="btn-link small" disabled={!name.trim() || busy}>{t('Save')}</button>
      <button type="button" className="btn-link small" onClick={onCancel}>{t('Cancel')}</button>
      {error ? <p className="form-error small">{error}</p> : null}
    </form>
  );
}

/** The "Folders" part of the menu: each folder with its unread count, and New folder. */
export function FolderNav({ filter }: { filter: string }) {
  const t = useT();
  const folders = useFolders();
  const [adding, setAdding] = useState(false);
  return (
    <div className="nav-folders">
      <p className="nav-heading">{t('Folders')}</p>
      {folders.map((f) => (
        <Link key={f.id} to={`/?f=folder:${f.id}`} className={filter === `folder:${f.id}` ? 'nav-item active' : 'nav-item'}>
          <Icon name="folder" /><span className="nav-label">{f.name}</span>
          {f.unread_count > 0 ? <span className="nav-count" aria-label={t('{n} unread', { n: f.unread_count })}>{f.unread_count}</span> : null}
        </Link>
      ))}
      {adding ? (
        <NameField label={t('Folder name')} onCancel={() => setAdding(false)}
          onDone={async (name) => { await mail.createFolder(name); setAdding(false); foldersChanged(); }} />
      ) : (
        <button className="nav-item" onClick={() => setAdding(true)}><Icon name="plus" />{t('New folder')}</button>
      )}
    </div>
  );
}

/** "Move to folder": the folders to pick from, and a new one made on the spot. */
export function FolderMenu({ current, onPick, onClose }: { current?: number; onPick: (id: number) => void; onClose: () => void }) {
  const t = useT();
  const folders = useFolders();
  const [adding, setAdding] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  return (
    <div className="when-menu" ref={box} role="menu" aria-label={t('Move to folder')}>
      <p className="when-title">{t('Move to folder')}</p>
      {folders.length === 0 && !adding ? <p className="muted small pad-x">{t('No folders yet.')}</p> : null}
      {folders.map((f) => (
        <button key={f.id} type="button" role="menuitem" className="when-item" disabled={f.id === current} onClick={() => onPick(f.id)}>
          <Icon name="folder" size={18} /><span>{f.name}</span>
        </button>
      ))}
      {adding ? (
        <NameField label={t('Folder name')} onCancel={() => setAdding(false)}
          onDone={async (name) => { const f = await mail.createFolder(name); foldersChanged(); onPick(f.id); }} />
      ) : (
        <button type="button" role="menuitem" className="when-item" onClick={() => setAdding(true)}><Icon name="plus" size={18} />{t('New folder')}</button>
      )}
    </div>
  );
}

/** Rename and delete, at the top of a folder's list. */
export function FolderTools({ folder, onDeleted, onToast }: { folder: Folder; onDeleted: () => void; onToast: (text: string) => void }) {
  const t = useT();
  const [renaming, setRenaming] = useState(false);
  if (renaming) {
    return (
      <NameField initial={folder.name} label={t('New name')} onCancel={() => setRenaming(false)}
        onDone={async (name) => { await mail.renameFolder(folder.id, name); setRenaming(false); foldersChanged(); onToast(t('Folder renamed')); }} />
    );
  }
  const remove = async () => {
    if (!window.confirm(t('Delete the folder “{name}”? Its conversations stay in All mail.', { name: folder.name }))) return;
    try {
      await mail.deleteFolder(folder.id);
      foldersChanged();
      onToast(t('Folder deleted'));
      onDeleted();
    } catch (e) {
      onToast(e instanceof Error ? e.message : t('Something went wrong'));
    }
  };
  return (
    <span className="folder-tools">
      <button className="btn-link small" onClick={() => setRenaming(true)}>{t('Rename')}</button>
      <button className="btn-link small danger" onClick={remove}>{t('Delete folder')}</button>
    </span>
  );
}
