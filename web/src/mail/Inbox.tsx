import { useCallback, useEffect, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Mascot } from '../components/Mascot';
import { chatTitle, mail, type Chat, type ChatAction, type Draft, type Page } from '../lib/api';
import { listDate } from '../lib/format';
import { useT } from '../lib/i18n';
import { useOutbox } from '../lib/outbox';
import { Link, navigate } from '../lib/router';
import { useShortcuts } from '../lib/shortcuts';
import { useReload } from './MailApp';
import { snoozeChoices, WhenMenu, whenText } from './When';

export const FILTERS = [
  { key: 'all', label: 'Inbox', chip: 'All', icon: 'inbox' },
  { key: 'unread', label: 'Unread', chip: 'Unread', icon: 'unread' },
  { key: 'attachments', label: 'With attachments', chip: 'Attachments', icon: 'clip' },
  { key: 'favorites', label: 'Starred', chip: 'Favourites', icon: 'star' },
  { key: 'snoozed', label: 'Snoozed', chip: 'Snoozed', icon: 'clock' },
  { key: 'everything', label: 'All mail', chip: 'All mail', icon: 'allmail' },
];

// The conversation list (Home). Conversations can be picked with their tick boxes (on phones,
// after "Select") and then archived, deleted, marked read or unread, or snoozed together.
// Keys: j/k move, o/Enter open, x picks, e archives, # deletes, Shift+I/U mark read/unread.
export function Inbox({ filter, phone }: { filter: string; phone: boolean }) {
  const t = useT();
  const { flash } = useOutbox();
  const [page, setPage] = useState<Page<Chat> | null>(null);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Map<number, Draft>>(new Map()); // conversation id -> its unsent draft
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [selecting, setSelecting] = useState(false); // phones: tick boxes shown
  const [cursor, setCursor] = useState(-1); // keyboard position
  const [snoozing, setSnoozing] = useState(false);

  const load = useCallback(() => {
    mail.home(filter).then((p) => { setPage(p); setError(''); }, (e: Error) => setError(e.message));
    mail.drafts().then((ds) => setDrafts(new Map(ds.filter((d) => d.conversation_id && !d.send_at).map((d) => [d.conversation_id!, d]))), () => {});
  }, [filter]);
  useReload(load);
  useEffect(() => { setPicked(new Set()); setSelecting(false); setCursor(-1); }, [filter]);

  const rows = page?.items || [];
  // Picked conversations still in the list (the list may have changed underneath).
  const chosen = rows.filter((c) => picked.has(c.conversation_id));
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const act = async (action: ChatAction, ids: number[], until?: Date) => {
    if (!ids.length) return;
    try {
      await mail.chatAction(ids, action, until?.toISOString());
    } catch (e) {
      return flash(e instanceof Error ? e.message : t('Something went wrong'));
    }
    setPicked(new Set());
    setSelecting(false);
    load();
    const n = ids.length;
    const undo = (back: ChatAction) => ({ label: t('Undo'), run: () => mail.chatAction(ids, back).then(load, () => {}) });
    if (action === 'archive') flash(n === 1 ? t('Conversation archived') : t('{n} conversations archived', { n }), undo('unarchive'));
    else if (action === 'unarchive') flash(n === 1 ? t('Moved to Inbox') : t('{n} conversations moved to Inbox', { n }));
    else if (action === 'trash') flash(n === 1 ? t('Conversation moved to Trash') : t('{n} conversations moved to Trash', { n }));
    else if (action === 'snooze') flash(t('Snoozed until {when}', { when: whenText(until!) }), undo('unsnooze'));
    else if (action === 'unsnooze') flash(t('Back in your Inbox'));
    else if (action === 'read' || action === 'unread') flash(action === 'read' ? t('Marked as read') : t('Marked as unread'));
  };

  // Keyboard: acts on the picked conversations, or else the one under the cursor.
  const targets = () => (chosen.length ? chosen.map((c) => c.conversation_id) : rows[cursor] ? [rows[cursor].conversation_id] : []);
  useShortcuts({
    j: () => setCursor((i) => Math.min(rows.length - 1, i + 1)),
    k: () => setCursor((i) => Math.max(0, i - 1)),
    o: () => { if (rows[cursor]) navigate(`/c/${rows[cursor].conversation_id}`); },
    Enter: () => (rows[cursor] ? navigate(`/c/${rows[cursor].conversation_id}`) : false),
    x: () => { if (rows[cursor]) { toggle(rows[cursor].conversation_id); setSelecting(true); } },
    e: () => { act('archive', targets()); },
    '#': () => { act('trash', targets()); },
    I: () => { act('read', targets()); },
    U: () => { act('unread', targets()); },
  });
  useEffect(() => {
    document.querySelector('.chat-row.cursor')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const more = async () => {
    if (!page?.next) return;
    const p = await mail.home(filter, page.next);
    setPage({ items: [...page.items, ...p.items], next: p.next });
  };
  const current = FILTERS.find((f) => f.key === filter) || FILTERS[0];
  const showTicks = !phone || selecting;
  const allArchived = chosen.length > 0 && chosen.every((c) => c.archived);
  const ids = chosen.map((c) => c.conversation_id);

  return (
    <section className="list-view">
      {phone ? (
        <div className="chips" role="tablist">
          {FILTERS.map((f) => (
            <Link key={f.key} to={f.key === 'all' ? '/' : `/?f=${f.key}`} role="tab" aria-selected={f.key === filter}
              className={f.key === filter ? 'chip active' : 'chip'}>{t(f.chip)}</Link>
          ))}
        </div>
      ) : null}
      {chosen.length ? (
        <div className="bulk-bar" role="toolbar" aria-label={t('Selected conversations')}>
          <label className="tick" title={t('Select all')}>
            <input type="checkbox" checked={chosen.length === rows.length} aria-label={t('Select all')}
              onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((c) => c.conversation_id)) : new Set())} />
          </label>
          <span className="bulk-count">{t('{n} selected', { n: chosen.length })}</span>
          {allArchived
            ? <button className="icon-btn" aria-label={t('Move to Inbox')} title={t('Move to Inbox')} onClick={() => act('unarchive', ids)}><Icon name="inbox" /></button>
            : <button className="icon-btn" aria-label={t('Archive')} title={t('Archive')} onClick={() => act('archive', ids)}><Icon name="archive" /></button>}
          <button className="icon-btn" aria-label={t('Delete')} title={t('Delete')} onClick={() => act('trash', ids)}><Icon name="trash" /></button>
          <button className="icon-btn" aria-label={t('Mark as read')} title={t('Mark as read')} onClick={() => act('read', ids)}><Icon name="read" /></button>
          <button className="icon-btn" aria-label={t('Mark as unread')} title={t('Mark as unread')} onClick={() => act('unread', ids)}><Icon name="unread" /></button>
          {filter === 'snoozed'
            ? <button className="btn-link small" onClick={() => act('unsnooze', ids)}>{t('Unsnooze')}</button>
            : (
              <span className="menu-anchor">
                <button className="icon-btn" aria-label={t('Snooze')} title={t('Snooze')} onClick={() => setSnoozing(!snoozing)}><Icon name="clock" /></button>
                {snoozing ? <WhenMenu title={t('Snooze until…')} choices={snoozeChoices(t)} onClose={() => setSnoozing(false)}
                  onPick={(d) => { setSnoozing(false); act('snooze', ids, d); }} /> : null}
              </span>
            )}
          <button className="btn-link small bulk-cancel" onClick={() => { setPicked(new Set()); setSelecting(false); }}>{t('Cancel')}</button>
        </div>
      ) : (
        <div className="list-title-row">
          {phone ? <span /> : <h1 className="list-title">{t(current.label)}</h1>}
          {phone && rows.length ? <button className="btn-link small" onClick={() => setSelecting(!selecting)}>{selecting ? t('Cancel') : t('Select')}</button> : null}
        </div>
      )}
      {filter === 'snoozed' ? <p className="muted small pad">{t('Snoozed conversations come back to the top of your Inbox, unread, at the time you chose.')}</p> : null}
      {filter === 'everything' ? <p className="muted small pad">{t('Every conversation, including archived ones. Archived conversations come back to the Inbox when new mail arrives.')}</p> : null}
      {error ? <p className="form-error pad">{error}</p> : null}
      {page && rows.length === 0 ? (
        <div className="empty">
          {filter === 'all' ? <Mascot size={116} className="mascot-hop" /> : <Icon name={current.icon} size={36} />}
          <p>{filter === 'all' ? t('No mail yet. Press Compose to write your first email.') : filter === 'snoozed' ? t('Nothing snoozed.') : t('Nothing here.')}</p>
        </div>
      ) : null}
      {!page && !error ? <ListSkeleton /> : null}
      <ul className="chat-list">
        {rows.map((c, i) => {
          const title = chatTitle(c);
          const draft = drafts.get(c.conversation_id);
          const on = picked.has(c.conversation_id);
          return (
            <li key={c.conversation_id} className={showTicks ? 'with-tick' : ''}>
              {showTicks ? (
                <label className="tick">
                  <input type="checkbox" checked={on} onChange={() => toggle(c.conversation_id)} aria-label={t('Select {name}', { name: title })} />
                </label>
              ) : null}
              <Link to={`/c/${c.conversation_id}`}
                onClick={(e) => { if (phone && selecting) { e.preventDefault(); toggle(c.conversation_id); } }}
                className={['chat-row', c.unread_count > 0 ? 'unread' : '', on ? 'picked' : '', i === cursor ? 'cursor' : ''].filter(Boolean).join(' ')}>
                <Avatar address={c.peer?.address} name={c.kind === 'group' ? c.name : c.peer?.display_name || (c.peer ? '' : title)}
                  avatarUrl={c.peer?.avatar_url} group={c.kind === 'group'} />
                <span className="chat-row-main">
                  <span className="chat-row-top">
                    <span className="chat-row-title">
                      {title}
                      {c.muted ? <Icon name="mute" size={14} className="muted-mark" /> : null}
                    </span>
                    <span className="chat-row-date">{listDate(c.last_message_at)}</span>
                  </span>
                  <span className="chat-row-bottom">
                    {draft ? (
                      <span className="chat-row-snippet"><span className="draft-tag">{t('Draft:')}</span>{draft.body_text || draft.subject || t('(attachment)')}</span>
                    ) : (
                      <span className="chat-row-snippet">
                        {c.archived && filter === 'everything' ? <span className="label">{t('Archived')}</span> : null}
                        {c.snoozed_until && new Date(c.snoozed_until) > new Date() ? <span className="label snooze-label">{t('Until {when}', { when: whenText(c.snoozed_until) })}</span> : null}
                        {c.favourite_count > 0 ? <Icon name="star" size={14} filled className="star-on" /> : null}
                        {c.has_attachments ? <Icon name="clip" size={14} /> : null}
                        {c.snippet || (c.kind === 'group' ? t('Group created') : '')}
                      </span>
                    )}
                    {c.unread_count > 0 ? <span className="badge" aria-label={t('{n} unread', { n: c.unread_count })}>{c.unread_count}</span> : null}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {page?.next ? <button className="btn-link load-more" onClick={more}>{t('Load older')}</button> : null}
    </section>
  );
}

export function ListSkeleton() {
  return (
    <ul className="chat-list skeleton" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => <li key={i}><span className="chat-row"><span className="avatar" /><span className="chat-row-main"><span className="bar" /><span className="bar short" /></span></span></li>)}
    </ul>
  );
}
