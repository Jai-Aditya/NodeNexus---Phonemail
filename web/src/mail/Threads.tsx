import { useEffect, useMemo, useState } from 'react';
import { AttachmentList } from '../components/Attachments';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { displayName, mail, type Message } from '../lib/api';
import { fullDate, listDate } from '../lib/format';
import { useT } from '../lib/i18n';
import { Recipients } from './MailApp';
import { MessageBody } from './MessageBody';
import { Reactions } from './Reactions';
import { SwipeToReply } from './Swipe';

// Threads: every email knows the one it answers (parent) and the email that started its
// thread (root), so each thread is a tree. Wide screens show a thread Gmail-style, its emails
// one below the other in time order; phones show it Reddit-style, each reply nested under
// the email it answers, joined by a line.

export type FlagChange = Parameters<typeof mail.flag>[2];
type Actions = {
  canReply: boolean; onReply: (m: Message) => void; onFlag: (m: Message, c: FlagChange) => void;
  onForward: (m: Message) => void; onChanged: () => void; // reactions changed: reload
};

const byTime = (a: Message, b: Message) => a.sent_at.localeCompare(b.sent_at) || a.id - b.id;
const who = (m: Message, t: (s: string) => string) => (m.is_mine ? t('me') : displayName(m.sender, t('Deleted account')));
const threadSubject = (msgs: Message[]) => msgs.find((m) => m.depth === 0)?.subject || msgs.find((m) => m.subject)?.subject?.replace(/^re:\s*/i, '') || '';

// ---------- wide screens: Gmail-style ----------

/** One thread as a block: its subject, then its emails in time order. Older emails fold to one
 *  line, and a long middle folds into "N more emails", as Gmail does. */
export function GmailThread({ msgs, ...actions }: { msgs: Message[] } & Actions) {
  const t = useT();
  const sorted = useMemo(() => [...msgs].sort(byTime), [msgs]);
  const last = sorted[sorted.length - 1];
  const [open, setOpen] = useState<Set<number>>(() => new Set([last.id, ...sorted.filter((m) => !m.is_read).map((m) => m.id)]));
  const [showAll, setShowAll] = useState(false);
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // A new email in the thread opens; whatever you opened or closed stays as you left it.
  useEffect(() => {
    setOpen((s) => (s.has(last.id) ? s : new Set([...s, last.id])));
  }, [last.id]);

  const fold = !showAll && sorted.length > 4;
  const shown = fold ? [sorted[0], ...sorted.slice(-2)] : sorted;
  const byId = new Map(sorted.map((m) => [m.id, m]));
  return (
    <section className="gthread" aria-label={threadSubject(sorted) || t('(no subject)')} data-root={sorted[0].root_id}>
      <header className="gthread-head">
        <h2>{threadSubject(sorted) || t('(no subject)')}</h2>
        <span className="muted small">{sorted.length === 1 ? t('1 email') : t('{n} emails', { n: sorted.length })}</span>
      </header>
      {shown.map((m, i) => {
        const prev = sorted[sorted.indexOf(m) - 1];
        return (
          <div key={m.id}>
            {fold && i === 1 ? (
              <button className="gthread-more" onClick={() => setShowAll(true)}>
                <span>{t('{n} more emails', { n: sorted.length - 3 })}</span>
              </button>
            ) : null}
            <Card m={m} open={open.has(m.id)} onToggle={() => toggle(m.id)}
              // "In reply to …" only when it answers something other than the email just above it
              parent={m.parent_id && m.parent_id !== prev?.id ? byId.get(m.parent_id) : undefined} {...actions} />
          </div>
        );
      })}
    </section>
  );
}

function Card({ m, parent, open, onToggle, ...actions }: { m: Message; parent?: Message; open: boolean; onToggle: () => void } & Actions) {
  const t = useT();
  return (
    <article className={open ? 'mail-card open' : 'mail-card'} data-id={m.id}>
      <header className="mail-card-head" onClick={onToggle}>
        <Avatar address={m.sender.address} name={m.sender.display_name || who(m, t)} avatarUrl={m.sender.avatar_url} />
        <span className="mail-card-from">
          <strong>{who(m, t)}</strong>
          {open ? <Recipients m={m} /> : <span className="muted snippet-line">{m.has_attachments ? '📎 ' : ''}{m.body_text || m.snippet}</span>}
        </span>
        <span className="muted small nowrap">{fullDate(m.sent_at)}</span>
        <button className={m.is_favourite ? 'icon-btn star on' : 'icon-btn star'} aria-label={m.is_favourite ? t('Unstar') : t('Star')} aria-pressed={m.is_favourite}
          onClick={(e) => { e.stopPropagation(); actions.onFlag(m, { is_favourite: !m.is_favourite }); }}><Icon name="star" filled={m.is_favourite} /></button>
      </header>
      {open && (
        <div className="mail-card-body">
          {parent ? (
            <blockquote className="quote">
              <span className="small muted">{t('In reply to {who}:', { who: parent.is_mine ? t('you') : displayName(parent.sender, t('Deleted account')) })}</span>
              <span className="quote-text">{(parent.body_text || parent.snippet).slice(0, 160)}</span>
            </blockquote>
          ) : null}
          <MessageBody m={m} />
          <AttachmentList attachments={m.attachments} />
          <Reactions m={m} onChanged={actions.onChanged} />
          <MessageActions m={m} {...actions} buttons />
        </div>
      )}
    </article>
  );
}

function MessageActions({ m, canReply, onReply, onFlag, onForward, buttons }: { m: Message; buttons?: boolean } & Actions) {
  const t = useT();
  const cls = buttons ? 'btn-outline' : 'rnode-action';
  return (
    <div className={buttons ? 'mail-actions' : 'rnode-actions'}>
      {canReply ? (
        <button className={cls} disabled={m.is_replied} title={m.is_replied ? t("You've already replied to this email") : undefined} onClick={() => onReply(m)}>
          <Icon name={m.is_replied ? 'check' : 'reply'} size={buttons ? 18 : 16} />{m.is_replied ? t('Replied') : t('Reply')}
        </button>
      ) : null}
      {!buttons ? (
        <button className={m.is_favourite ? `${cls} on` : cls} aria-pressed={m.is_favourite} onClick={() => onFlag(m, { is_favourite: !m.is_favourite })}>
          <Icon name="star" size={16} filled={m.is_favourite} />{m.is_favourite ? t('Starred') : t('Star')}
        </button>
      ) : null}
      <button className={cls} onClick={() => onForward(m)}><Icon name="forward" size={buttons ? 18 : 16} />{t('Forward')}</button>
      {!m.is_mine ? <button className={cls} onClick={() => onFlag(m, { is_read: false })}><Icon name="unread" size={buttons ? 18 : 16} />{t('Mark unread')}</button> : null}
      {!m.is_mine ? <button className={cls} onClick={() => onFlag(m, { folder: 'spam' })}><Icon name="spam" size={buttons ? 18 : 16} />{t('Spam')}</button> : null}
      <button className={`${cls} danger`} onClick={() => onFlag(m, { folder: 'trash' })}><Icon name="trash" size={buttons ? 18 : 16} />{t('Delete')}</button>
    </div>
  );
}

// ---------- phones: Reddit-style ----------

type Node = { m: Message; children: Node[] };
/** Past this depth the indent stops and "Continue this thread" opens the rest. */
export const MAX_DEPTH = 4;

/** Builds the reply tree. A reply whose parent isn't here (e.g. it was deleted) hangs off the
 *  nearest thing we have: the thread's first email, or the top. */
export function buildTree(msgs: Message[]): Node[] {
  const sorted = [...msgs].sort(byTime);
  const nodes = new Map(sorted.map((m) => [m.id, { m, children: [] as Node[] }]));
  const roots: Node[] = [];
  for (const n of nodes.values()) {
    const parent = (n.m.parent_id && nodes.get(n.m.parent_id)) || (n.m.id !== n.m.root_id ? nodes.get(n.m.root_id) : undefined);
    if (parent && parent !== n) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}

const countAll = (n: Node): number => n.children.reduce((a, c) => a + 1 + countAll(c), 0);

export function RedditThread({ msgs, ...actions }: { msgs: Message[] } & Actions) {
  const t = useT();
  const roots = useMemo(() => buildTree(msgs), [msgs]);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [focus, setFocus] = useState<number | null>(null); // "Continue this thread": show one branch
  const toggle = (id: number) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const find = (list: Node[], id: number): Node | undefined => {
    for (const n of list) {
      if (n.m.id === id) return n;
      const f = find(n.children, id);
      if (f) return f;
    }
    return undefined;
  };
  const focused = focus ? find(roots, focus) : undefined;

  const render = (n: Node, depth: number) => {
    const shut = collapsed.has(n.m.id);
    const hidden = countAll(n);
    return (
      <div key={n.m.id} className={depth === 0 ? 'rnode rnode-root' : 'rnode'} data-id={n.m.id} data-depth={depth}>
        <SwipeToReply enabled={actions.canReply && !n.m.is_replied} onReply={() => actions.onReply(n.m)}>
        <div className="rnode-head">
          <Avatar address={n.m.sender.address} name={n.m.sender.display_name || who(n.m, t)} avatarUrl={n.m.sender.avatar_url} size="tiny" />
          <strong className={n.m.is_mine ? 'rnode-who mine' : 'rnode-who'}>{who(n.m, t)}</strong>
          <span className="muted small">· {listDate(n.m.sent_at)}</span>
          {n.m.is_favourite ? <Icon name="star" size={12} filled className="star-on" /> : null}
          <button className="rnode-toggle" aria-expanded={!shut} aria-label={shut ? t('Expand') : t('Collapse')} onClick={() => toggle(n.m.id)}>
            {shut ? `[+${hidden ? ` ${hidden}` : ''}]` : '[–]'}
          </button>
        </div>
        {shut ? null : (
          <>
            {n.m.depth === 0 && n.m.subject ? <strong className="rnode-subject">{n.m.subject}</strong> : null}
            <MessageBody m={n.m} />
          </>
        )}
        </SwipeToReply>
        {shut ? null : (
          <>
            <AttachmentList attachments={n.m.attachments} />
            <Reactions m={n.m} onChanged={actions.onChanged} compact />
            <MessageActions m={n.m} {...actions} />
            {n.children.length ? (
              depth >= MAX_DEPTH ? (
                <button className="rnode-continue" onClick={() => setFocus(n.m.id)}>
                  {t('Continue this thread')} ({hidden}) <Icon name="back" size={14} className="flip" />
                </button>
              ) : (
                <div className="rnode-children">
                  <button className="rnode-line" aria-label={t('Collapse this reply and the ones under it')} onClick={() => toggle(n.m.id)} />
                  {n.children.map((c) => render(c, depth + 1))}
                </div>
              )
            ) : null}
          </>
        )}
      </div>
    );
  };

  return (
    <section className="rthread" aria-label={threadSubject(msgs) || t('(no subject)')} data-root={msgs[0]?.root_id}>
      {focused ? (
        <>
          <strong className="rnode-subject">{threadSubject(msgs) || t('(no subject)')}</strong>
          <button className="rnode-back" onClick={() => setFocus(null)}><Icon name="back" size={16} />{t('Back to the whole thread')}</button>
          {render(focused, 0)}
        </>
      ) : roots.map((r) => render(r, 0))}
    </section>
  );
}
