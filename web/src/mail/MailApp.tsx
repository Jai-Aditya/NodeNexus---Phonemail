import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AttachmentList } from '../components/Attachments';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { Mascot } from '../components/Mascot';
import { ApiError, displayName, mail, type Draft, type Message, type SearchResult } from '../lib/api';
import { fullDate, listDate } from '../lib/format';
import { useT } from '../lib/i18n';
import { DRAFT_BACK, OutboxContext, type Outbox, type Pending, type ToastAction } from '../lib/outbox';
import { Link, navigate, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import { SHORTCUTS, useShortcuts } from '../lib/shortcuts';
import { usePhone } from '../lib/useMedia';
import { Compose, type ComposeRequest } from './Compose';
import { ConversationView } from './Conversation';
import { FILTERS, Inbox } from './Inbox';
import { MessageBody } from './MessageBody';
import { SearchFilters } from './SearchFilters';
import { Settings } from './Settings';
import { whenText } from './When';

const FOLDERS = [
  { to: '/drafts', label: 'Drafts', icon: 'draft' },
  { to: '/scheduled', label: 'Scheduled', icon: 'scheduled' },
  { to: '/spam', label: 'Spam', icon: 'spam' },
  { to: '/trash', label: 'Trash', icon: 'trash' },
];

type Toast = { text: string; action?: ToastAction; until?: number };

// The signed-in app. Wide screens: Gmail-style (top bar, folders on the left, list or email on
// the right; brief: "no chat-style interface" on the web). Phones: WhatsApp-style chat list
// with filter chips and a compose button, and conversations as chat bubbles.
export default function MailApp() {
  const { user, signOut, onLive } = useSession();
  const t = useT();
  const phone = usePhone();
  const { path, search } = useLocation();
  const params = new URLSearchParams(search);
  const [compose, setCompose] = useState<ComposeRequest | null>(null);
  const [query, setQuery] = useState(path === '/search' ? params.get('q') || '' : '');
  const [menuOpen, setMenuOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [, tick] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (path !== '/search') setQuery('');
    setNavOpen(false);
    setFiltersOpen(false);
  }, [path]);

  // A short notice at the bottom, maybe with a button (Undo). A new one replaces the old one.
  const toastTimer = useRef(0);
  const flash = useCallback((text: string, action?: ToastAction, ms = action ? 6000 : 3200) => {
    window.clearTimeout(toastTimer.current);
    setToast({ text, action });
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);
  const openCompose = useCallback((r: Omit<ComposeRequest, 'key'> = {}) => setCompose({ key: Date.now(), ...r }), []);

  // An email waiting out its Undo window: "Sending… Undo" with the seconds left.
  const track = useCallback((p: Pending) => {
    const until = Date.now() + p.seconds * 1000;
    const undo = async () => {
      window.clearTimeout(toastTimer.current);
      setToast(null);
      try {
        const d = await mail.unschedule(p.draftId);
        flash(t('Sending undone'));
        if (d.conversation_id) {
          navigate(`/c/${d.conversation_id}`);
          window.dispatchEvent(new CustomEvent(DRAFT_BACK, { detail: d }));
        } else {
          openCompose({ draft: d });
        }
      } catch (e) {
        flash(e instanceof ApiError && e.code === 'already_sent' ? t('Too late: it has already been sent.') : e instanceof Error ? e.message : t('Could not undo'));
      }
    };
    window.clearTimeout(toastTimer.current);
    setToast({ text: t('Sending…'), action: { label: t('Undo'), run: undo }, until });
    toastTimer.current = window.setTimeout(() => {
      setToast({ text: t('Sent') });
      toastTimer.current = window.setTimeout(() => setToast(null), 2500);
    }, p.seconds * 1000);
  }, [flash, openCompose, t]);
  useEffect(() => {
    if (!toast?.until) return;
    const i = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(i);
  }, [toast?.until]);

  // A scheduled email that couldn't go comes back to Drafts: say so.
  useEffect(() => onLive((e) => {
    if (e.type === 'draft_failed') flash(t("A scheduled email couldn't be sent. It's back in Drafts."), { label: t('Open'), run: () => navigate('/drafts') }, 10000);
  }), [onLive, flash, t]);

  const outbox: Outbox = useMemo(() => ({ flash, track }), [flash, track]);
  const filter = path === '/' ? params.get('f') || 'all' : '';

  useShortcuts({
    c: () => openCompose(),
    '/': () => { searchRef.current?.focus(); },
    '?': () => setHelp((h) => !h),
  });

  let view;
  const chatMatch = /^\/c\/(\d+)$/.exec(path);
  const msgMatch = /^\/m\/(\d+)$/.exec(path);
  if (chatMatch) view = <ConversationView key={chatMatch[1]} id={Number(chatMatch[1])} onCompose={openCompose} />;
  else if (msgMatch) view = <MessageDetail id={Number(msgMatch[1])} conversationId={Number(params.get('c')) || undefined} onCompose={openCompose} />;
  else if (path === '/search') view = <SearchResults q={params.get('q') || ''} onCompose={openCompose} />;
  else if (path === '/spam' || path === '/trash') view = <FolderList name={path.slice(1) as 'spam' | 'trash'} />;
  else if (path === '/drafts') view = <Drafts onOpen={(d) => openCompose({ draft: d })} />;
  else if (path === '/scheduled') view = <Scheduled onOpen={(d) => openCompose({ draft: d })} />;
  else if (path === '/settings') view = <Settings onToast={flash} />;
  else view = <Inbox filter={filter} phone={phone} />;

  const inConversation = Boolean(chatMatch || msgMatch);
  const doSearch = (e?: FormEvent, q = query) => {
    e?.preventDefault();
    setFiltersOpen(false);
    if (q.trim()) {
      setQuery(q.trim());
      navigate(`/search?q=${encodeURIComponent(q.trim())}`);
    }
  };
  const me = user!;
  const left = toast?.until ? Math.max(0, Math.ceil((toast.until - Date.now()) / 1000)) : 0;

  return (
    <OutboxContext.Provider value={outbox}>
      <div className={`mail-app${phone ? ' is-phone' : ''}${inConversation ? ' in-conversation' : ''}`}>
        <header className="topbar">
          <button className="icon-btn nav-toggle" aria-label={t('Menu')} onClick={() => setNavOpen(!navOpen)}><Icon name="menu" /></button>
          <Link to="/" className="topbar-logo"><Logo compact /></Link>
          <div className="search-wrap">
            <form className="search" onSubmit={doSearch} role="search">
              <Icon name="search" size={18} />
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search mail, people and groups')} aria-label={t('Search mail')}
                onKeyDown={(e) => { if (e.key === 'Escape') (e.target as HTMLInputElement).blur(); }} />
              <button type="button" className="icon-btn" aria-label={t('Search options')} title={t('Search options')} aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen(!filtersOpen)}><Icon name="filter" size={18} /></button>
            </form>
            {filtersOpen ? <SearchFilters query={query} onSearch={(q) => doSearch(undefined, q)} onClose={() => setFiltersOpen(false)} /> : null}
          </div>
          <div className="profile">
            <button className="avatar-btn" aria-label={t('Account')} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
              <Avatar address={me.address} name={me.display_name} avatarUrl={me.avatar_url} size="small" />
            </button>
            {menuOpen && (
              <>
                <button className="scrim" aria-label={t('Close')} onClick={() => setMenuOpen(false)} />
                <div className="profile-menu" role="menu">
                  <Avatar address={me.address} name={me.display_name} avatarUrl={me.avatar_url} size="large" />
                  <strong>{me.display_name || t('{brand} user')}</strong>
                  <span className="muted small">{me.address}</span>
                  <Link to="/settings" onClick={() => setMenuOpen(false)} className="btn-outline"><Icon name="settings" size={18} />{t('Profile and settings')}</Link>
                  <button className="btn-link" onClick={async () => { await signOut(); navigate('/login', true); }}><Icon name="logout" size={18} />{t('Sign out')}</button>
                </div>
              </>
            )}
          </div>
        </header>

        {navOpen ? <button className="scrim nav-scrim" aria-label={t('Close menu')} onClick={() => setNavOpen(false)} /> : null}
        <nav className={navOpen ? 'sidebar open' : 'sidebar'} aria-label={t('Folders')}>
          <button className="btn-compose" onClick={() => { setNavOpen(false); openCompose(); }}><Icon name="pen" />{t('Compose')}</button>
          {FILTERS.map((f) => {
            const to = f.key === 'all' ? '/' : `/?f=${f.key}`;
            return (
              <Link key={f.key} to={to} className={filter === f.key ? 'nav-item active' : 'nav-item'}>
                <Icon name={f.icon} />{t(f.label)}
              </Link>
            );
          })}
          <hr className="nav-rule" />
          {FOLDERS.map((f) => (
            <Link key={f.to} to={f.to} className={path === f.to ? 'nav-item active' : 'nav-item'}><Icon name={f.icon} />{t(f.label)}</Link>
          ))}
          <Link to="/settings" className={path === '/settings' ? 'nav-item active' : 'nav-item'}><Icon name="settings" />{t('Settings')}</Link>
          {!phone ? <button className="nav-item nav-help" onClick={() => setHelp(true)}><Icon name="keyboard" />{t('Keyboard shortcuts')}</button> : null}
        </nav>

        <main className="content">{view}</main>

        {phone && !inConversation && path !== '/settings' ? (
          <button className="fab" aria-label={t('Compose')} onClick={() => openCompose()}><Icon name="pen" size={24} /></button>
        ) : null}

        {compose ? (
          <Compose key={compose.key} req={compose} fullScreen={phone}
            // Closing saves the draft first; by then another Compose may be open: only close this one.
            onClose={(saved) => {
              const key = compose.key;
              setCompose((c) => (c?.key === key ? null : c));
              if (saved) {
                flash(t('Saved to Drafts'));
                window.dispatchEvent(new Event('phonemail:refresh')); // an open Drafts list shows it
              }
            }}
            onSent={(r) => {
              const key = compose.key;
              setCompose((c) => (c?.key === key ? null : c));
              window.dispatchEvent(new Event('phonemail:refresh'));
              if (r.pending) track({ draftId: r.pending.id, seconds: me.undo_send_seconds });
              else if (r.scheduled) flash(t('Scheduled for {when}', { when: whenText(r.scheduled.send_at!) }), { label: t('View'), run: () => navigate('/scheduled') });
              else if (r.sent) {
                flash(t('Sent'));
                if (r.sent.conversation_ids.length === 1) navigate(`/c/${r.sent.conversation_ids[0]}`);
              }
            }} />
        ) : null}
        {toast ? (
          <div className="toast" role="status">
            {toast.text === t('Sent') ? <Mascot size={30} className="mascot-toast" /> : null}
            <span>{toast.text}{toast.until ? ` ${left}s` : ''}</span>
            {toast.action ? <button className="toast-action" onClick={() => { const a = toast.action!; setToast(null); a.run(); }}>{toast.action.label}</button> : null}
          </div>
        ) : null}
        {help ? <ShortcutHelp onClose={() => setHelp(false)} /> : null}
      </div>
    </OutboxContext.Provider>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === '?') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <>
      <button className="scrim" aria-label={t('Close')} onClick={onClose} />
      <div className="help-card" role="dialog" aria-label={t('Keyboard shortcuts')}>
        <header className="sheet-head"><h2>{t('Keyboard shortcuts')}</h2><button className="icon-btn" aria-label={t('Close')} onClick={onClose}><Icon name="close" /></button></header>
        <dl className="keys">
          {SHORTCUTS.map(([k, what]) => (
            <div key={k}><dt><kbd>{k}</kbd></dt><dd>{t(what)}</dd></div>
          ))}
        </dl>
        <p className="muted small">{t('Turn them off in Settings.')}</p>
      </div>
    </>
  );
}

/** Loads now, again on new mail and on "phonemail:refresh". */
export function useReload(load: () => void) {
  const { onLive } = useSession();
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onLive(() => load()), [onLive, load]);
  useEffect(() => {
    window.addEventListener('phonemail:refresh', load);
    return () => window.removeEventListener('phonemail:refresh', load);
  }, [load]);
}

// Spam or Trash: single emails, each opened on its own.
function FolderList({ name }: { name: 'spam' | 'trash' }) {
  const t = useT();
  const [rows, setRows] = useState<Message[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    mail.folder(name).then((p) => { setRows(p.items); setError(''); }, (e: Error) => setError(e.message));
  }, [name]);
  useReload(load);
  const title = t(name === 'spam' ? 'Spam' : 'Trash');
  return (
    <section className="list-view">
      <div className="list-title-row">
        <h1 className="list-title">{title}</h1>
        {name === 'trash' && rows?.length ? (
          <button className="btn-outline danger" onClick={async () => { await mail.emptyTrash(); load(); }}>{t('Empty Trash now')}</button>
        ) : null}
      </div>
      {name === 'trash' ? <p className="muted small pad">{t('Emails in Trash are deleted for good after 30 days.')}</p> : null}
      {name === 'spam' ? <p className="muted small pad">{t('Mail from people you blocked lands here too.')}</p> : null}
      {error ? <p className="form-error pad">{error}</p> : null}
      {rows && rows.length === 0 ? <div className="empty"><Icon name={name === 'spam' ? 'spam' : 'trash'} size={36} /><p>{t('{folder} is empty.', { folder: title })}</p></div> : null}
      <MessageRows rows={rows || []} />
    </section>
  );
}

/** Single emails in a list. Ones in the inbox open their conversation; Spam and Trash open alone. */
function MessageRows({ rows }: { rows: Message[] }) {
  const t = useT();
  return (
    <ul className="chat-list">
      {rows.map((m) => {
        const who = m.is_mine ? t('me') : displayName(m.sender, t('Deleted account'));
        return (
          <li key={`${m.id}-${m.conversation_id}`}>
            <Link to={m.folder !== 'inbox' ? `/m/${m.id}?c=${m.conversation_id}` : `/c/${m.conversation_id}`} className="chat-row">
              <Avatar address={m.sender.address} name={m.sender.display_name} avatarUrl={m.sender.avatar_url} />
              <span className="chat-row-main">
                <span className="chat-row-top">
                  <span className="chat-row-title">{who}</span>
                  <span className="chat-row-date">{listDate(m.sent_at)}</span>
                </span>
                <span className="chat-row-snippet">
                  {m.has_attachments ? <Icon name="clip" size={14} /> : null}
                  {m.subject ? <strong>{m.subject} </strong> : null}{m.body_text || m.snippet}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function SearchResults({ q, onCompose }: { q: string; onCompose: (r: Omit<ComposeRequest, 'key'>) => void }) {
  const t = useT();
  const [res, setRes] = useState<SearchResult | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setRes(null);
    setError('');
    mail.search(q).then(setRes, (e: Error) => setError(e.message));
  }, [q]);
  const nothing = res && !res.messages.length && !res.people.length && !res.groups.length;
  return (
    <section className="list-view">
      <h1 className="list-title">{t('Results for “{q}”', { q })}</h1>
      {error ? <p className="form-error pad">{error}</p> : null}
      {nothing ? (
        <div className="empty">
          <Icon name="search" size={36} />
          <p>{t('Nothing matched. Words need at least 2 letters.')}</p>
          <p className="muted small">{t('Try from:, to:, has:attachment, after:2026-09-01, in:anywhere or is:unread, or the search options.')}</p>
        </div>
      ) : null}
      {res?.people.length ? (
        <>
          <h2 className="section-title">{t('People')}</h2>
          <ul className="chat-list">
            {res.people.map((p) => (
              <li key={p.user_id}>
                <button className="chat-row as-button" onClick={() => (p.conversation_id ? navigate(`/c/${p.conversation_id}`) : onCompose({ to: p.address }))}>
                  <Avatar address={p.address} name={p.display_name} avatarUrl={p.avatar_url} />
                  <span className="chat-row-main">
                    <span className="chat-row-title">{displayName(p)}</span>
                    <span className="chat-row-snippet">{p.conversation_id ? t('Open your conversation') : t('Write to {who}', { who: p.address })}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {res?.groups.length ? (
        <>
          <h2 className="section-title">{t('Groups')}</h2>
          <ul className="chat-list">
            {res.groups.map((g) => (
              <li key={g.conversation_id}>
                <Link to={`/c/${g.conversation_id}`} className="chat-row">
                  <Avatar name={g.name} group />
                  <span className="chat-row-main"><span className="chat-row-title">{g.name}</span></span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {res?.messages.length ? (
        <>
          <h2 className="section-title">{t('Emails')}</h2>
          <MessageRows rows={res.messages} />
        </>
      ) : null}
    </section>
  );
}

// One email on its own (from Spam or Trash): full text, move back, or open its conversation.
function MessageDetail({ id, conversationId, onCompose }: { id: number; conversationId?: number; onCompose: (r: Omit<ComposeRequest, 'key'>) => void }) {
  const t = useT();
  const [m, setM] = useState<Message | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    mail.message(id, conversationId).then(setM, (e: Error) => setError(e.message));
  }, [id, conversationId]);
  if (error) return <p className="form-error pad">{error}</p>;
  if (!m) return <p className="muted pad">{t('Loading…')}</p>;
  return (
    <div className="thread">
      <div className="thread-head">
        <button className="icon-btn" aria-label={t('Back')} onClick={() => window.history.back()}><Icon name="back" /></button>
        <h1 className="thread-title">{m.subject || t('(no subject)')}</h1>
        {m.folder !== 'inbox' ? <span className="label">{t(m.folder === 'spam' ? 'Spam' : 'Trash')}</span> : null}
      </div>
      <article className="mail-card open">
        <header className="mail-card-head">
          <Avatar address={m.sender.address} name={m.sender.display_name} avatarUrl={m.sender.avatar_url} />
          <span className="mail-card-from">
            <strong>{m.is_mine ? t('me') : displayName(m.sender, t('Deleted account'))}</strong>
            <Recipients m={m} />
          </span>
          <span className="muted small nowrap">{fullDate(m.sent_at)}</span>
        </header>
        <div className="mail-card-body">
          <MessageBody m={m} />
          <AttachmentList attachments={m.attachments} />
          <div className="mail-actions">
            {m.folder !== 'inbox' ? (
              <button className="btn-outline" onClick={async () => { await mail.flag(m.id, m.conversation_id, { folder: 'inbox' }); navigate(`/c/${m.conversation_id}`); }}>{t('Move to Inbox')}</button>
            ) : (
              <button className="btn-outline" onClick={() => navigate(`/c/${m.conversation_id}`)}>{t('Open conversation')}</button>
            )}
            <button className="btn-outline" onClick={() => onCompose({ forward: m })}><Icon name="forward" size={18} />{t('Forward')}</button>
          </div>
        </div>
      </article>
    </div>
  );
}

export function Recipients({ m }: { m: Message }) {
  const t = useT();
  const list = (k: string) => (m.recipients || []).filter((r) => r.kind === k)
    .map((r) => r.group_name || (r.person ? displayName(r.person) : '')).filter(Boolean).join(', ');
  const to = list('to'), cc = list('cc'), bcc = list('bcc');
  return (
    <span className="muted small recipients">
      {t('to')} {to}{cc ? ` · cc ${cc}` : ''}{bcc ? ` · bcc ${bcc}` : ''}
    </span>
  );
}

const draftTo = (d: Draft) => {
  const to = d.recipients.to;
  const list = Array.isArray(to) ? to : to ? [to] : [];
  return list.map((r) => r.address || r.group || '').filter(Boolean).join(', ');
};

function Drafts({ onOpen }: { onOpen: (d: Draft) => void }) {
  const t = useT();
  const [rows, setRows] = useState<Draft[] | null>(null);
  const load = useCallback(() => {
    // Drafts written inside a conversation wait in that conversation, not here (unless a
    // scheduled send of theirs failed: then they're listed here with the reason).
    mail.drafts().then((ds) => setRows(ds.filter((d) => !d.send_at && (!d.conversation_id || d.send_error))), () => setRows([]));
  }, []);
  useReload(load);
  return (
    <section className="list-view">
      <h1 className="list-title">{t('Drafts')}</h1>
      {rows && rows.length === 0 ? <div className="empty"><Icon name="draft" size={36} /><p>{t('No drafts. Closing an unsent email keeps it here.')}</p></div> : null}
      <ul className="chat-list">
        {(rows || []).map((d) => (
          <li key={d.id}>
            <button className="chat-row as-button" onClick={() => (d.conversation_id ? navigate(`/c/${d.conversation_id}`) : onOpen(d))}>
              <span className="avatar draft-mark"><Icon name="draft" /></span>
              <span className="chat-row-main">
                <span className="chat-row-top">
                  <span className="chat-row-title">{draftTo(d) || (d.conversation_id ? t('Email in a conversation') : t('No recipient yet'))}</span>
                  <span className="chat-row-date">{listDate(d.updated_at)}</span>
                </span>
                {d.send_error ? <span className="form-error small">{t("Couldn't send: {why}", { why: d.send_error })}</span> : null}
                <span className="chat-row-snippet">{d.subject ? <strong>{d.subject} </strong> : null}{d.body_text.slice(0, 120)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Emails waiting to be sent at a chosen time. "Cancel send" turns one back into a draft.
function Scheduled({ onOpen }: { onOpen: (d: Draft) => void }) {
  const t = useT();
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    // Emails inside their few seconds of Undo don't count as scheduled.
    mail.drafts().then((ds) => setRows(ds.filter((d) => d.send_at && new Date(d.send_at).getTime() - Date.now() > 60_000)
      .sort((a, b) => a.send_at!.localeCompare(b.send_at!))), () => setRows([]));
  }, []);
  useReload(load);
  const cancel = async (d: Draft) => {
    setError('');
    try {
      const back = await mail.unschedule(d.id);
      if (back.conversation_id) navigate(`/c/${back.conversation_id}`);
      else onOpen(back);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Something went wrong'));
      load();
    }
  };
  return (
    <section className="list-view">
      <h1 className="list-title">{t('Scheduled')}</h1>
      {error ? <p className="form-error pad">{error}</p> : null}
      {rows && rows.length === 0 ? <div className="empty"><Icon name="scheduled" size={36} /><p>{t('Nothing scheduled. Use the arrow next to Send to send an email later.')}</p></div> : null}
      <ul className="chat-list">
        {(rows || []).map((d) => (
          <li key={d.id}>
            <div className="chat-row">
              <span className="avatar draft-mark"><Icon name="clock" /></span>
              <span className="chat-row-main">
                <span className="chat-row-top">
                  <span className="chat-row-title">{draftTo(d) || t('Email in a conversation')}</span>
                  <span className="chat-row-date">{whenText(d.send_at!)}</span>
                </span>
                <span className="chat-row-snippet">{d.subject ? <strong>{d.subject} </strong> : null}{d.body_text.slice(0, 120)}</span>
              </span>
              <button className="btn-outline" onClick={() => cancel(d)}>{t('Cancel send')}</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
