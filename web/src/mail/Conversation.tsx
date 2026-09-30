import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AttachButton, DropZone, UploadChips, useUploads } from '../components/Attachments';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { ApiError, displayName, mail, splitRecipients, type Chat, type ChatAction, type ChatEvent, type ChatPage, type Draft, type Group, type Message, type Person } from '../lib/api';
import { listDate } from '../lib/format';
import { useT } from '../lib/i18n';
import { deliver, DRAFT_BACK, useOutbox } from '../lib/outbox';
import { navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { useShortcuts } from '../lib/shortcuts';
import { usePhone } from '../lib/useMedia';
import type { ComposeRequest } from './Compose';
import { RichEditor, textToHtml, type EditorValue } from './Editor';
import { RecipientInput } from './RecipientInput';
import { GmailThread, RedditThread, type FlagChange } from './Threads';
import { scheduleChoices, snoozeChoices, WhenMenu, whenText } from './When';

type Item = { kind: 'thread'; at: string; root: number; msgs: Message[] } | { kind: 'event'; at: string; e: ChatEvent };

// One conversation (a direct chat or a group), as its threads: each new email starts a thread
// and replies grow it. Threads are ordered by their latest email, so a thread that just got a
// reply moves to the bottom, next to where you write. Wide screens show each thread Gmail-style,
// phones Reddit-style (see Threads.tsx). Replies stay in the conversation, to the same people
// (brief: recipients are locked), and each email can be replied to once per person.
// The header archives, snoozes, mutes, blocks (one-to-one chats), marks unread or deletes it.
export function ConversationView({ id, onCompose }: { id: number; onCompose: (r: Omit<ComposeRequest, 'key'>) => void }) {
  const { user, onLive } = useSession();
  const { flash } = useOutbox();
  const t = useT();
  const phone = usePhone();
  const [page, setPage] = useState<ChatPage | null>(null);
  const [older, setOlder] = useState<ChatPage | null>(null);
  const [threads, setThreads] = useState<Map<number, Message[]>>(new Map());
  const [group, setGroup] = useState<Group | null | undefined>(undefined); // null = a direct chat
  const [info, setInfo] = useState<Chat | null>(null); // your settings for it: muted, archived, snoozed
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  // What you were writing here and didn't send (WhatsApp-style: it waits in this chat).
  const [draft, setDraft] = useState<Draft | null | undefined>(undefined);
  const [writerKey, setWriterKey] = useState(0);
  const [showInfo, setShowInfo] = useState(false);
  const [menu, setMenu] = useState<'' | 'snooze' | 'more'>('');
  const [blocked, setBlocked] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  // A page of the chat names the threads active in it; each is then loaded whole, so a thread
  // shows every reply the person can see, even ones older than the page.
  const fillThreads = useCallback(async (msgs: Message[]) => {
    const roots = [...new Set(msgs.map((m) => m.root_id))];
    const whole = await Promise.all(roots.map((r) =>
      mail.thread(r, id).then((x) => [r, x.items] as const, () => [r, msgs.filter((m) => m.root_id === r)] as const)));
    return new Map(whole);
  }, [id]);

  const load = useCallback(async () => {
    try {
      const p = await mail.chat(id); // the first page also marks the chat read
      const all = [...(olderRef.current?.items || []), ...p.items];
      setThreads(await fillThreads(all));
      setPage(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Could not open the conversation'));
    }
    mail.group(id).then(setGroup, () => setGroup(null));
    mail.chatInfo(id).then(setInfo, () => setInfo(null));
  }, [id, fillThreads]); // eslint-disable-line react-hooks/exhaustive-deps
  const olderRef = useRef<ChatPage | null>(null);
  olderRef.current = older;

  const loadDraft = useCallback(() => {
    mail.drafts().then((ds) => {
      const mine = ds.filter((d) => d.conversation_id === id && !d.send_at).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      setDraft(mine[0] || null);
    }, () => setDraft(null));
  }, [id]);
  useEffect(() => {
    load();
    loadDraft();
  }, [load, loadDraft]);
  const shown = useRef<Set<number>>(new Set());
  useEffect(() => onLive((e) => {
    if (e.conversation_id === id) load();
    else if (e.type === 'reaction' && e.message_id && shown.current.has(e.message_id)) load();
  }), [onLive, load, id]);
  // "Undo" on an email sent from here: it comes back into the writer.
  useEffect(() => {
    const back = (e: Event) => {
      const d = (e as CustomEvent<Draft>).detail;
      if (d.conversation_id !== id) return;
      setReplyTo(null);
      setDraft(d);
      setWriterKey((k) => k + 1);
    };
    window.addEventListener(DRAFT_BACK, back);
    return () => window.removeEventListener(DRAFT_BACK, back);
  }, [id]);

  const events = useMemo(() => [...(older?.events || []), ...(page?.events || [])], [page, older]);
  const items: Item[] = useMemo(() => {
    const list: Item[] = [...threads.entries()].filter(([, msgs]) => msgs.length).map(([root, msgs]) => ({
      kind: 'thread' as const, root, msgs, at: msgs.reduce((a, m) => (m.sent_at > a ? m.sent_at : a), ''),
    }));
    for (const e of events) list.push({ kind: 'event', at: e.at, e });
    return list.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === 'event' ? -1 : 1));
  }, [threads, events]);
  const messages = useMemo(() => [...threads.values()].flat(), [threads]);
  shown.current = new Set(messages.map((m) => m.id));

  // Open at the newest email (the bottom). Later, when new mail arrives, follow it only if you
  // are already near the bottom, so reading older emails isn't interrupted.
  const opened = useRef(false);
  useEffect(() => {
    if (!page || !threads.size || !bottom.current) return; // not on screen yet (still loading)
    const box = bottom.current.closest('.content');
    const nearBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 240;
    if (!opened.current || nearBottom) {
      requestAnimationFrame(() => {
        const el = bottom.current?.closest('.content');
        if (el) el.scrollTop = el.scrollHeight; // to the very end: the docked writer sits below the newest email
      });
      opened.current = true;
    }
  }, [page, threads, group, draft]);

  // A reply draft: pick up which email it answers once that email is on screen.
  useEffect(() => {
    if (draft?.parent_id && !replyTo) {
      const m = [...threads.values()].flat().find((x) => x.id === draft.parent_id);
      if (m) setReplyTo(m);
    }
  }, [draft, threads]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadOlder = async () => {
    const next = (older || page)?.next;
    if (!next) return;
    const p = await mail.chat(id, next);
    const merged = { items: [...(older?.items || []), ...p.items], events: [...(older?.events || []), ...p.events], next: p.next };
    const extra = await fillThreads(p.items.filter((m) => !threads.has(m.root_id)));
    setOlder(merged);
    setThreads((cur) => new Map([...extra, ...cur]));
  };

  const flag = async (m: Message, change: FlagChange) => {
    await mail.flag(m.id, id, change);
    if (change.folder === 'trash') flash(t('Moved to Trash'), { label: t('Undo'), run: () => mail.flag(m.id, id, { folder: 'inbox' }).then(load) });
    if (change.folder === 'spam') flash(t('Moved to Spam'), { label: t('Undo'), run: () => mail.flag(m.id, id, { folder: 'inbox' }).then(load) });
    if (change.is_read === false) flash(t('Marked as unread'));
    load();
  };

  // Whole-conversation actions. Leaving ones (archive, delete, snooze, unread) go back to the list.
  const chatAct = async (action: ChatAction, until?: Date) => {
    setMenu('');
    try {
      await mail.chatAction([id], action, until?.toISOString());
    } catch (e) {
      return flash(e instanceof Error ? e.message : t('Something went wrong'));
    }
    const undo = (back: ChatAction) => ({ label: t('Undo'), run: () => { mail.chatAction([id], back).then(() => navigate(`/c/${id}`), () => {}); } });
    switch (action) {
      case 'archive': flash(t('Conversation archived'), undo('unarchive')); break;
      case 'unarchive': flash(t('Moved to Inbox')); break;
      case 'trash': flash(t('Conversation moved to Trash')); break;
      case 'snooze': flash(t('Snoozed until {when}', { when: whenText(until!) }), undo('unsnooze')); break;
      case 'unsnooze': flash(t('Back in your Inbox')); break;
      case 'unread': flash(t('Marked as unread')); break;
      case 'mute': flash(t('Muted: no alerts for this conversation')); break;
      case 'unmute': flash(t('Alerts are back on')); break;
    }
    if (['archive', 'trash', 'snooze', 'unread'].includes(action)) navigate('/');
    else load();
  };

  // The other person of a direct chat; none if they deleted their account (no user id left).
  const exists = (p?: Person) => (p && p.user_id > 0 ? p : undefined);
  const peer: Person | undefined = group ? undefined
    : exists(messages.find((m) => !m.is_mine)?.sender)
      || exists(messages.flatMap((m) => m.recipients || []).find((r) => r.person && r.person.user_id !== user?.id)?.person);
  const canWrite = Boolean(group || peer);

  useEffect(() => {
    if (menu === 'more' && peer && blocked === null) mail.blocks().then((b) => setBlocked(b.some((x) => x.user_id === peer.user_id)), () => {});
  }, [menu, peer, blocked]);
  const toggleBlock = async () => {
    if (!peer) return;
    setMenu('');
    try {
      if (blocked) {
        await mail.unblock(peer.user_id);
        flash(t('{name} is unblocked', { name: displayName(peer) }));
      } else {
        await mail.block(peer.address);
        flash(t("{name} is blocked. Their emails will go to Spam.", { name: displayName(peer) }));
      }
      setBlocked(!blocked);
    } catch (e) {
      flash(e instanceof Error ? e.message : t('Something went wrong'));
    }
  };

  // The newest email someone else sent that you haven't answered: what "r" replies to.
  const newest = [...messages].sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  useShortcuts({
    e: () => { chatAct(info?.archived ? 'unarchive' : 'archive'); },
    '#': () => { chatAct('trash'); },
    U: () => { chatAct('unread'); },
    u: () => navigate('/'),
    r: () => { const m = newest.find((x) => !x.is_mine && !x.is_replied); if (m && canWrite) setReplyTo(m); },
    f: () => { if (newest[0]) onCompose({ forward: newest[0] }); },
  });

  if (error) return <p className="form-error pad">{error}</p>;
  if (!page || group === undefined || draft === undefined) return <p className="muted pad">{t('Loading…')}</p>;

  const title = group ? group.name : peer ? displayName(peer, t('Deleted account')) : t('Deleted account');
  const subtitle = group ? t('{n} members', { n: group.members.length }) : peer?.display_name ? peer.address : '';
  const actions = { canReply: canWrite, onReply: setReplyTo, onFlag: flag, onForward: (m: Message) => onCompose({ forward: m }), onChanged: load };
  const snoozed = info?.snoozed_until && new Date(info.snoozed_until) > new Date();

  return (
    <div className={phone ? 'thread chat-mode' : 'thread'}>
      <div className="thread-head">
        <button className="icon-btn" aria-label={t('Back')} onClick={() => navigate('/')}><Icon name="back" /></button>
        <button className="thread-who" onClick={() => group && setShowInfo(true)} disabled={!group}>
          <Avatar address={peer?.address} name={group ? group.name : peer?.display_name || title} avatarUrl={peer?.avatar_url} group={Boolean(group)} size="small" />
          <span>
            <span className="thread-title">{title}{info?.muted ? <Icon name="mute" size={14} className="muted-mark" /> : null}</span>
            <span className="muted small">{subtitle}</span>
          </span>
        </button>
        <span className="thread-tools">
          {group ? <button className="icon-btn" aria-label={t('Group info')} title={t('Group info')} onClick={() => setShowInfo(true)}><Icon name="group" /></button> : null}
          {info?.archived
            ? <button className="icon-btn" aria-label={t('Move to Inbox')} title={t('Move to Inbox')} onClick={() => chatAct('unarchive')}><Icon name="inbox" /></button>
            : <button className="icon-btn" aria-label={t('Archive')} title={t('Archive (e)')} onClick={() => chatAct('archive')}><Icon name="archive" /></button>}
          <span className="menu-anchor">
            <button className="icon-btn" aria-label={t('Snooze')} title={t('Snooze')} aria-expanded={menu === 'snooze'} onClick={() => setMenu(menu === 'snooze' ? '' : 'snooze')}><Icon name="clock" /></button>
            {menu === 'snooze' ? <WhenMenu title={t('Snooze until…')} choices={snoozeChoices(t)} onClose={() => setMenu('')} onPick={(d) => chatAct('snooze', d)} /> : null}
          </span>
          <span className="menu-anchor">
            <button className="icon-btn" aria-label={t('More')} title={t('More')} aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? '' : 'more')}><Icon name="more" /></button>
            {menu === 'more' ? (
              <MoreMenu onClose={() => setMenu('')}>
                <button role="menuitem" className="when-item" onClick={() => chatAct('unread')}><Icon name="unread" size={18} />{t('Mark as unread')}</button>
                <button role="menuitem" className="when-item" onClick={() => chatAct(info?.muted ? 'unmute' : 'mute')}>
                  <Icon name={info?.muted ? 'bell' : 'mute'} size={18} />{info?.muted ? t('Unmute') : t('Mute (no alerts)')}
                </button>
                {snoozed ? <button role="menuitem" className="when-item" onClick={() => chatAct('unsnooze')}><Icon name="clock" size={18} />{t('Unsnooze')}</button> : null}
                {peer ? (
                  <button role="menuitem" className="when-item danger" onClick={toggleBlock} disabled={blocked === null}>
                    <Icon name="block" size={18} />{blocked ? t('Unblock {name}', { name: displayName(peer) }) : t('Block {name}', { name: displayName(peer) })}
                  </button>
                ) : null}
                <button role="menuitem" className="when-item danger" onClick={() => chatAct('trash')}><Icon name="trash" size={18} />{t('Delete conversation')}</button>
              </MoreMenu>
            ) : null}
          </span>
        </span>
      </div>
      {snoozed ? <p className="notice small"><Icon name="clock" size={16} />{t('Snoozed until {when}', { when: whenText(info!.snoozed_until!) })}</p> : null}
      {info?.muted ? <p className="notice small"><Icon name="mute" size={16} />{t('Muted: new emails here arrive without alerts.')}</p> : null}

      {(older || page).next ? <button className="btn-link load-more" onClick={loadOlder}>{t('Load older emails')}</button> : null}
      {items.length === 0 ? <p className="muted pad">{t('No emails in this conversation yet.')}</p> : null}

      <div className="timeline">
        {items.map((it) => it.kind === 'event' ? (
          <p key={`e${it.e.id}`} className="event-line"><span>{it.e.text} · {listDate(it.e.at)}</span></p>
        ) : phone ? (
          <RedditThread key={`t${it.root}`} msgs={it.msgs} {...actions} />
        ) : (
          <GmailThread key={`t${it.root}`} msgs={it.msgs} {...actions} />
        ))}
      </div>
      <div ref={bottom} />

      <Writer key={writerKey} conversationId={id} replyTo={replyTo} draft={draft} phone={phone} canWrite={canWrite}
        onCancelReply={() => setReplyTo(null)} onSent={() => { setReplyTo(null); setDraft(null); load(); }} />

      {showInfo && group ? <GroupInfo group={group} onClose={() => setShowInfo(false)} onChanged={() => mail.group(id).then(setGroup, () => navigate('/'))} onToast={flash} /> : null}
    </div>
  );
}

/** A small menu that closes on a click elsewhere or Escape. */
function MoreMenu({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  return <div className="when-menu" role="menu" aria-label={t('More')} ref={box}>{children}</div>;
}

// Writing inside a conversation: a reply to one email, or a new email (new thread) to the same
// people. Recipients are fixed by the conversation. Like WhatsApp, what you write waits here:
// it's kept as this conversation's draft (on the server, so on every device) and comes back
// when you return, still a reply to the same email. It stays out of the Drafts folder; the
// chat list shows "Draft: …". Files attach onto that draft. ✕ discards it. Sending goes
// through the draft too, so Undo and Schedule send work here as in Compose.
function Writer({ conversationId, replyTo, draft, phone, canWrite, onCancelReply, onSent }: {
  conversationId: number; replyTo: Message | null; draft: Draft | null; phone: boolean; canWrite: boolean;
  onCancelReply: () => void; onSent: () => void;
}) {
  const t = useT();
  const { user } = useSession();
  const { track, flash } = useOutbox();
  const [open, setOpen] = useState(Boolean(replyTo || draft));
  const [subject, setSubject] = useState(draft && !draft.parent_id ? draft.subject : '');
  const [initialHtml] = useState(() => (draft ? draft.body_html || textToHtml(draft.body_text) : ''));
  const [body, setBody] = useState<EditorValue>({ html: draft?.body_html || '', text: draft?.body_text || '' });
  const [editorKey, setEditorKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const draftId = useRef<number | null>(draft?.id ?? null);
  const creating = useRef<Promise<number> | null>(null);
  const latest = useRef({ subject, body, replyTo });
  latest.current = { subject, body, replyTo };

  const content = useCallback(() => ({
    recipients: {}, conversation_id: conversationId, parent_id: latest.current.replyTo?.id,
    subject: latest.current.replyTo ? '' : latest.current.subject, body_text: latest.current.body.text, body_html: latest.current.body.html,
  }), [conversationId]);
  const ensureDraft = useCallback(async () => {
    if (draftId.current) return draftId.current;
    if (!creating.current) creating.current = mail.saveDraft(null, content()).then((d) => (draftId.current = d.id));
    return creating.current;
  }, [content]);
  const files = useUploads(ensureDraft);
  const seeded = useRef(false);
  useEffect(() => {
    if (draft && !seeded.current) {
      seeded.current = true;
      files.seed(draft.id, draft.attachments || []);
    }
  }, [draft, files]);
  useEffect(() => {
    if (replyTo) setOpen(true);
  }, [replyTo]);
  // When the box opens (or grows), keep the newest email just above it, not under it.
  const dockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      const el = dockRef.current?.closest('.content');
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [open, replyTo?.id]);

  // Keep the draft up to date a second after typing stops (and when the reply target changes).
  const dirty = useRef(false);
  const save = useCallback(async () => {
    dirty.current = false;
    const { subject: sub, body: text } = latest.current;
    if (!text.text.trim() && !sub.trim() && !files.ids.length) {
      if (draftId.current && !files.items.length) { // emptied: nothing to keep
        mail.deleteDraft(draftId.current).catch(() => {});
        draftId.current = null;
        creating.current = null;
      }
      return;
    }
    try {
      await mail.saveDraft(await ensureDraft(), content());
    } catch {
      /* best effort; the next change saves again */
    }
  }, [content, ensureDraft, files.ids.length, files.items.length]);
  const saveRef = useRef(save);
  saveRef.current = save;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; } // opening isn't a change
    dirty.current = true;
    const timer = window.setTimeout(() => saveRef.current(), 1000);
    return () => window.clearTimeout(timer);
  }, [subject, body.text, body.html, replyTo?.id]);
  // Leaving the conversation: save what's unsaved (nothing is thrown away).
  useEffect(() => () => {
    if (dirty.current) saveRef.current();
  }, []);

  const clear = () => {
    draftId.current = null;
    creating.current = null;
    dirty.current = false;
    files.reset();
    setBody({ html: '', text: '' });
    setSubject('');
    setEditorKey((k) => k + 1);
  };
  const discard = () => {
    files.abortAll();
    if (draftId.current) mail.deleteDraft(draftId.current).catch(() => {});
    clear();
  };

  if (!canWrite) return <p className="muted pad small">{t('This person deleted their account. You can still read your conversation.')}</p>;

  const send = async (e?: FormEvent, when?: Date) => {
    e?.preventDefault();
    setScheduling(false);
    if (!body.text.trim() && files.ids.length === 0) return setError(t('Write something first'));
    if (files.uploading) return setError(t('Wait for the files to finish uploading'));
    setBusy(true);
    setError('');
    try {
      const id = await ensureDraft();
      await mail.saveDraft(id, content());
      if (when) {
        const d = await mail.scheduleDraft(id, { send_at: when.toISOString() });
        flash(t('Scheduled for {when}', { when: whenText(d.send_at!) }), { label: t('View'), run: () => navigate('/scheduled') });
      } else {
        const r = await deliver(id, user?.undo_send_seconds ?? 0);
        if (r.pending) track({ draftId: id, seconds: user!.undo_send_seconds, conversationId });
      }
      clear();
      setOpen(false);
      onSent();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'already_replied' ? t("You've already replied to this email.") : err instanceof Error ? err.message : t('Could not send'));
    } finally {
      setBusy(false);
    }
  };

  if (!open && !replyTo) {
    return phone ? (
      <button className="write-bar" onClick={() => setOpen(true)}><Icon name="pen" size={18} />{t('Write an email…')}</button>
    ) : (
      <div className="writer-dock"><button className="btn-outline" onClick={() => setOpen(true)}><Icon name="pen" size={18} />{t('New email in this conversation')}</button></div>
    );
  }
  return (
    <div className={phone ? '' : 'writer-dock'} ref={dockRef}>
      <DropZone className={phone ? 'writer writer-phone' : 'writer'} onFiles={files.add}>
        <form className="writer-form" onSubmit={send}>
          <p className="small muted writer-label">
            {replyTo
              ? t('Replying to {who}', { who: replyTo.is_mine ? t('your email') : displayName(replyTo.sender, t('Deleted account')) })
              : t('New email to this conversation')}
            <button type="button" className="icon-btn" aria-label={t('Discard')} title={t('Discard')}
              onClick={() => { discard(); setOpen(false); onCancelReply(); }}><Icon name="close" size={16} /></button>
          </p>
          {replyTo ? <span className="quote-text small">{(replyTo.body_text || replyTo.snippet).slice(0, 120)}</span> : (
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t('Subject')} aria-label={t('Subject')} maxLength={255} />
          )}
          <RichEditor key={editorKey} id="w-body" label={replyTo ? t('Reply') : t('Message')} autoFocus initialHtml={editorKey ? '' : initialHtml}
            placeholder={replyTo ? t('Write your reply (one reply per email)') : t('Write your email')} rows={phone ? 3 : 4}
            onChange={setBody} onSubmit={() => send()} />
          <UploadChips items={files.items} onRemove={files.remove} />
          {files.error ? <p className="form-error">{files.error}</p> : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="mail-actions">
            <span className="send-group">
              <button className="btn-send split" type="submit" disabled={busy}><Icon name="send" size={18} />{busy ? t('Sending…') : t('Send')}</button>
              <span className="menu-anchor">
                <button type="button" className="btn-send split-arrow" aria-label={t('Schedule send')} title={t('Schedule send')} aria-expanded={scheduling}
                  disabled={busy} onClick={() => setScheduling(!scheduling)}><Icon name="down" size={18} /></button>
                {scheduling ? <WhenMenu title={t('Schedule send')} choices={scheduleChoices(t)} onPick={(when) => send(undefined, when)} onClose={() => setScheduling(false)} /> : null}
              </span>
            </span>
            <AttachButton id="w-files" onFiles={files.add} />
          </div>
        </form>
      </DropZone>
    </div>
  );
}

// Group members and admin tools (add, remove, admins), and leaving.
function GroupInfo({ group, onClose, onChanged, onToast }: { group: Group; onClose: () => void; onChanged: () => void; onToast: (s: string) => void }) {
  const { user } = useSession();
  const t = useT();
  const [add, setAdd] = useState('');
  const [error, setError] = useState('');
  const me = group.members.find((m) => m.user_id === user?.id);
  const admin = me?.role === 'admin';
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError('');
    try {
      await fn();
      onToast(ok);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Something went wrong'));
    }
  };
  return (
    <>
      <button className="scrim" aria-label={t('Close')} onClick={onClose} />
      <aside className="sheet" aria-label={t('Group info')}>
        <header className="sheet-head">
          <Avatar name={group.name} group size="large" />
          <div><h2>{group.name}</h2><p className="muted small">{t('{n} members', { n: group.members.length })}</p></div>
          <button className="icon-btn" aria-label={t('Close')} onClick={onClose}><Icon name="close" /></button>
        </header>
        <ul className="member-list">
          {group.members.map((m) => (
            <li key={m.user_id}>
              <Avatar address={m.address} name={m.display_name} avatarUrl={m.avatar_url} size="small" />
              <span className="member-name">{m.user_id === user?.id ? t('You') : displayName(m)}{m.role === 'admin' ? <span className="label">{t('Admin')}</span> : null}</span>
              {admin && m.user_id !== user?.id ? (
                <span className="member-actions">
                  <button className="btn-link small" onClick={() => run(() => mail.setRole(group.conversation_id, m.user_id, m.role === 'admin' ? 'member' : 'admin'), t('Updated'))}>
                    {m.role === 'admin' ? t('Remove admin') : t('Make admin')}
                  </button>
                  <button className="btn-link small danger" onClick={() => run(() => mail.removeMember(group.conversation_id, m.user_id), t('Removed'))}>{t('Remove')}</button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {admin ? (
          // Search as in Compose: people you know by name, number or alias; anyone else on PhoneMail
          // by their exact number or address. Several at once, separated by commas.
          <form className="inline add-member" onSubmit={(e) => { e.preventDefault(); run(async () => { await mail.addMembers(group.conversation_id, splitRecipients(add)); setAdd(''); }, t('Added')); }}>
            <RecipientInput id="add-member" value={add} onChange={setAdd} peopleOnly exclude={group.members.map((m) => m.user_id)}
              meId={user?.id} placeholder={t('Search by name, number or address')} label={t('Add member')} />
            <button className="btn-outline" disabled={!add.trim()}>{t('Add')}</button>
          </form>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
        <button className="btn-outline danger leave" onClick={() => run(async () => { await mail.leave(group.conversation_id); onClose(); navigate('/'); }, t('You left the group'))}>
          {t('Leave group')}
        </button>
      </aside>
    </>
  );
}
