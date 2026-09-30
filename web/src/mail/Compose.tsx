import { useCallback, useEffect, useRef, useState } from 'react';
import { AttachButton, DropZone, fileIcon, UploadChips, useUploads } from '../components/Attachments';
import { Icon } from '../components/Icon';
import { ApiError, displayName, mail, splitRecipients, type Attachment, type Draft, type Group, type Message, type Recipient, type Recipients, type SendResult } from '../lib/api';
import { fullDate } from '../lib/format';
import { deliver } from '../lib/outbox';
import { useSession } from '../lib/session';
import { RichEditor, signatureHtml, textToHtml, type EditorHandle, type EditorValue } from './Editor';
import { membersLine, RecipientInput } from './RecipientInput';
import { scheduleChoices, WhenMenu } from './When';
import { useT } from '../lib/i18n';

export type ComposeRequest = {
  key: number; // changes whenever a new compose is opened
  draft?: Draft;
  to?: string;
  forward?: Message; // Forward: a new email carrying this one (and its files)
};

/** What happened on Send: sent now, waiting out the Undo window, or scheduled for later. */
export type SendOutcome = { sent?: SendResult; pending?: Draft; scheduled?: Draft };

/** The quoted block of a forwarded email, Gmail's layout. */
const forwardHtml = (m: Message) => {
  const from = m.sender.address ? `${displayName(m.sender)} <${m.sender.address}>` : displayName(m.sender, 'Deleted account');
  const body = m.body_html || textToHtml(m.body_text);
  return `<div><br></div><div>---------- Forwarded message ---------<br>From: ${textToHtml(from)}<br>`
    + `Date: ${textToHtml(fullDate(m.sent_at))}<br>Subject: ${textToHtml(m.subject)}<br><br></div><div>${body}</div>`;
};

const asList = (r?: Recipient | Recipient[]) => (Array.isArray(r) ? r : r ? [r] : []);
/** A draft's recipients as the text of a field. A group saved by id shows its name (once the
 *  groups have loaded), and the id is remembered in `picked` so the text maps back to it. */
const toText = (r: Recipient | Recipient[] | undefined, groups: Group[], picked: Record<string, number>) => asList(r).map((x) => {
  if (!x.group_id) return x.address || x.group || '';
  const g = groups.find((y) => y.conversation_id === x.group_id);
  if (!g) return '';
  picked[g.name.toLowerCase()] = g.conversation_id;
  return g.name;
}).filter(Boolean).join(', ');


// A new email (Gmail-style window on wide screens, full screen on phones). To takes phone
// numbers, addresses, aliases or the name of one of your groups. Two or more people in To
// start a new group, which needs a name (an existing group is reached by its name instead).
// Everything is kept as a draft while you write, so closing never loses anything.
export function Compose({ req, fullScreen, onClose, onSent }: {
  req: ComposeRequest; fullScreen?: boolean; onClose: (savedDraft: boolean) => void; onSent: (r: SendOutcome) => void;
}) {
  const t = useT();
  const { user } = useSession();
  const d = req.draft;
  const [groups, setGroups] = useState<Group[]>([]);
  // Group names that match more than one of your groups: which one was chosen (name -> id).
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [to, setTo] = useState(toText(d?.recipients.to, [], {}) || req.to || '');
  const [cc, setCc] = useState(toText(d?.recipients.cc, [], {}));
  const [bcc, setBcc] = useState(toText(d?.recipients.bcc, [], {}));
  const [showCc, setShowCc] = useState(Boolean(cc || bcc));
  const [groupName, setGroupName] = useState(d?.recipients.group_name || '');
  const fwd = req.forward;
  const [subject, setSubject] = useState(d?.subject ?? (fwd ? `Fwd: ${fwd.subject.replace(/^fwd:\s*/i, '')}` : ''));
  // The email's text: formatted (html) and plain (text). A new email starts with the signature.
  const [initialHtml] = useState(() => (d ? d.body_html || textToHtml(d.body_text) : signatureHtml(user?.signature || '')));
  const [body, setBodyValue] = useState<EditorValue>({ html: d?.body_html || '', text: d?.body_text || '' });
  const startText = useRef<string | null>(null); // the untouched text (just a signature): not worth a draft
  const setBody = (v: EditorValue) => {
    if (startText.current === null) startText.current = body.text;
    setBodyValue(v);
  };
  const editor = useRef<EditorHandle>(null);
  const [forwardedId] = useState<number | undefined>(d?.forwarded_from_id ?? fwd?.id);
  const [forwardedFiles, setForwardedFiles] = useState<Attachment[]>(fwd?.attachments || []);
  const [scheduling, setScheduling] = useState(false);
  const [minimised, setMinimised] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [existingGroup, setExistingGroup] = useState('');
  const draftId = useRef<number | null>(d?.id ?? null);
  const creating = useRef<Promise<number> | null>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const groupRef = useRef<HTMLInputElement>(null);

  // Your groups: to tell apart groups that share a name, and to show a draft's groups by name.
  const loadGroups = useCallback(() => mail.groups().then((gs) => {
    setGroups(gs);
    if (d && [d.recipients.to, d.recipients.cc, d.recipients.bcc].some((r) => asList(r).some((x) => x.group_id))) {
      const p: Record<string, number> = {};
      setTo(toText(d.recipients.to, gs, p) || req.to || '');
      setCc(toText(d.recipients.cc, gs, p));
      setBcc(toText(d.recipients.bcc, gs, p));
      setPicked(p);
    }
    return gs;
  }, () => groups), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // Forwarding: the whole email goes under the signature (lists carry only its start).
  useEffect(() => {
    if (!fwd) return;
    mail.message(fwd.id, fwd.conversation_id).then((full) => {
      editor.current?.setHtml(signatureHtml(user?.signature || '') + forwardHtml(full));
      setForwardedFiles(full.attachments || []);
    }, () => editor.current?.setHtml(signatureHtml(user?.signature || '') + forwardHtml(fwd)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A forwarded draft reopened: show which files go along.
  useEffect(() => {
    if (d?.forwarded_from_id) mail.message(d.forwarded_from_id).then((m) => setForwardedFiles(m.attachments || []), () => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toList = splitRecipients(to);
  const makesGroup = toList.length > 1;
  const namesakes = (entry: string) => groups.filter((g) => g.name.toLowerCase() === entry.trim().toLowerCase());
  // Entries naming 2+ of your groups, not yet chosen: asked below the fields before sending.
  const unclear = [...new Set([...toList, ...splitRecipients(cc), ...splitRecipients(bcc)].map((e) => e.trim().toLowerCase()))]
    .filter((e) => namesakes(e).length > 1 && !picked[e]);
  const chosen = Object.entries(picked).filter(([name]) =>
    [...toList, ...splitRecipients(cc), ...splitRecipients(bcc)].some((e) => e.trim().toLowerCase() === name));
  // A group chosen from the suggestions: remember which one, even if others share its name.
  const pickGroup = (name: string, gid: number) => {
    setPicked((p) => ({ ...p, [name.trim().toLowerCase()]: gid }));
  };
  const recipient = useCallback((entry: string): Recipient => {
    const id = picked[entry.trim().toLowerCase()];
    return id ? { group_id: id } : { address: entry };
  }, [picked]);
  const recipients = useCallback((): Recipients => {
    const people = splitRecipients(to).map(recipient);
    return {
      to: people.length === 1 ? people[0] : people,
      cc: splitRecipients(cc).map(recipient),
      bcc: splitRecipients(bcc).map(recipient),
      group_name: people.length > 1 ? groupName.trim() || undefined : undefined,
    };
  }, [to, cc, bcc, groupName, recipient]);

  const content = () => ({ recipients: recipients(), subject, body_text: body.text, body_html: body.html, forwarded_from_id: forwardedId });
  const typed = body.text.trim() !== '' && body.text !== (startText.current ?? body.text);
  const hasContent = Boolean(typed || (d && body.text.trim()) || subject.trim() || to.trim() || fwd);

  // The draft is created on first need (autosave or the first attachment) and updated after.
  const ensureDraft = useCallback(async () => {
    if (draftId.current) return draftId.current;
    if (!creating.current) creating.current = mail.saveDraft(null, content()).then((x) => (draftId.current = x.id));
    return creating.current;
  }, [recipients, subject, body]); // eslint-disable-line react-hooks/exhaustive-deps
  const files = useUploads(ensureDraft);

  useEffect(() => {
    if (!req.to && !req.draft) toRef.current?.focus();
  }, [req]);

  // Autosave 1.5 s after typing stops.
  useEffect(() => {
    if (!hasContent) return;
    const timer = window.setTimeout(async () => {
      try {
        const id = await ensureDraft();
        await mail.saveDraft(id, content());
      } catch {
        /* autosave is best effort; closing saves again */
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [to, cc, bcc, groupName, subject, body.html, body.text, picked]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = async () => {
    files.abortAll();
    if (hasContent || files.ids.length) {
      try {
        await mail.saveDraft(await ensureDraft(), content());
        return onClose(true);
      } catch {
        /* closing must never fail */
      }
    } else if (draftId.current) {
      await mail.deleteDraft(draftId.current).catch(() => {});
    }
    onClose(false);
  };

  const discard = async () => {
    files.abortAll();
    if (draftId.current) await mail.deleteDraft(draftId.current).catch(() => {});
    onClose(false);
  };

  // Send: through the draft, so "Undo" (and a scheduled time) can take it back.
  const send = async (when?: Date) => {
    setError('');
    setExistingGroup('');
    setScheduling(false);
    if (toList.length === 0) return setError(t('Add at least one recipient'));
    if (!body.text.trim() && files.ids.length === 0 && !forwardedId) return setError(t('Write a message'));
    if (files.uploading) return setError(t('Wait for the files to finish uploading'));
    if (unclear.length) return setError(t('Choose which group you mean.'));
    if (makesGroup && !groupName.trim()) {
      groupRef.current?.focus();
      return setError(t('Name the new group'));
    }
    setBusy(true);
    try {
      const id = await ensureDraft();
      await mail.saveDraft(id, content());
      if (when) onSent({ scheduled: await mail.scheduleDraft(id, { send_at: when.toISOString() }) });
      else onSent(await deliver(id, user?.undo_send_seconds ?? 0));
      files.reset();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'group_exists') {
        setExistingGroup(groupName.trim());
        setError(t('You already have the group “{name}” with these people.', { name: groupName.trim() }));
      } else if (e instanceof ApiError && e.code === 'ambiguous_group') {
        await loadGroups(); // someone added you to another group of that name meanwhile
        setError(t('Choose which group you mean.'));
      } else if (e instanceof ApiError && e.code === 'group_name_required') {
        groupRef.current?.focus();
        setError(t('Name the new group'));
      } else {
        setError(e instanceof Error ? e.message : t('Could not send'));
      }
    } finally {
      setBusy(false);
    }
  };

  const cls = ['compose', minimised && !fullScreen ? 'compose-min' : '', fullScreen ? 'compose-full' : ''].filter(Boolean).join(' ');
  return (
    <section className={cls} aria-label={t('New email')} role="dialog">
      <header className="compose-head" onClick={() => minimised && setMinimised(false)}>
        {fullScreen ? <button type="button" className="icon-btn" aria-label={t('Close')} onClick={close}><Icon name="back" /></button> : null}
        <span className="compose-title">{subject || t('New email')}</span>
        <span className="compose-head-actions">
          {!fullScreen ? (
            <button type="button" className="icon-btn" aria-label={minimised ? t('Expand') : t('Minimise')} onClick={(e) => { e.stopPropagation(); setMinimised(!minimised); }}>
              <Icon name={minimised ? 'expand' : 'minimise'} size={18} />
            </button>
          ) : null}
          {!fullScreen ? (
            <button type="button" className="icon-btn" aria-label={t('Save draft and close')} title={t('Save draft and close')} onClick={(e) => { e.stopPropagation(); close(); }}>
              <Icon name="close" size={18} />
            </button>
          ) : (
            <button type="button" className="btn-send" onClick={() => send()} disabled={busy}><Icon name="send" size={18} />{busy ? t('Sending…') : t('Send')}</button>
          )}
        </span>
      </header>
      {!minimised && (
        <DropZone className="compose-body" onFiles={files.add}>
          <div className="compose-row">
            <label htmlFor="c-to">{t('To')}</label>
            <RecipientInput id="c-to" inputRef={toRef} value={to} onChange={setTo} onPickGroup={pickGroup} meId={user?.id}
              placeholder={t('Name, number, address or group')} />
            {!showCc ? <button type="button" className="btn-link small" onClick={() => setShowCc(true)}>{t('Cc Bcc')}</button> : null}
          </div>
          {showCc && (
            <>
              <div className="compose-row">
                <label htmlFor="c-cc">Cc</label>
                <RecipientInput id="c-cc" value={cc} onChange={setCc} onPickGroup={pickGroup} meId={user?.id} />
              </div>
              <div className="compose-row">
                <label htmlFor="c-bcc">Bcc</label>
                <RecipientInput id="c-bcc" value={bcc} onChange={setBcc} onPickGroup={pickGroup} meId={user?.id} />
              </div>
            </>
          )}
          {makesGroup && (
            <div className="compose-group">
              <Icon name="group" />
              <div>
                <p>{t('{n} people in To start a new group. Later emails to just one of them stay in your one-to-one chat.', { n: toList.length })}</p>
                <input ref={groupRef} value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={100}
                  placeholder={t('Group name (required)')} aria-label={t('Group name')} />
              </div>
            </div>
          )}
          {unclear.map((name) => (
            <fieldset key={name} className="group-choice">
              <legend>{t('You have {n} groups called “{name}”. Which one?', { n: namesakes(name).length, name: namesakes(name)[0].name })}</legend>
              {namesakes(name).map((g) => (
                <label key={g.conversation_id} className="group-option">
                  <input type="radio" name={`pick-${name}`} onChange={() => { setPicked((p) => ({ ...p, [name]: g.conversation_id })); setError(''); }} />
                  <Icon name="group" size={18} />
                  <span><strong>{g.name}</strong> <span className="muted small">{membersLine(g, user?.id, t)}</span></span>
                </label>
              ))}
            </fieldset>
          ))}
          {chosen.map(([name, id]) => {
            const g = groups.find((x) => x.conversation_id === id);
            return g && namesakes(name).length > 1 ? (
              <p key={name} className="group-picked small">
                <Icon name="group" size={16} />{t('“{name}” {members}', { name: g.name, members: membersLine(g, user?.id, t) })}
                <button type="button" className="btn-link small" onClick={() => setPicked((p) => { const n = { ...p }; delete n[name]; return n; })}>{t('Change')}</button>
              </p>
            ) : null;
          })}
          <div className="compose-row">
            <input id="c-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t('Subject')} aria-label={t('Subject')} maxLength={255} />
          </div>
          <RichEditor id="c-body" label={t('Message')} placeholder={t('Write your email')} initialHtml={initialHtml} editorRef={editor}
            onChange={setBody} onSubmit={() => send()} rows={fullScreen ? 10 : 8} autoFocus={Boolean(req.to || fwd)} />
          {forwardedId && forwardedFiles.length ? (
            <ul className="att-chips" aria-label={t('Forwarded files')}>
              {forwardedFiles.map((a) => (
                <li key={a.id} className="att-chip done" title={t('Goes along with the forwarded email')}>
                  <span className="att-icon" aria-hidden="true">{fileIcon(a.content_type, a.filename)}</span>
                  <span className="att-name">{a.filename}</span>
                  <span className="att-size">{t('forwarded')}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <UploadChips items={files.items} onRemove={files.remove} />
          {files.error ? <p className="form-error">{files.error}</p> : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}{' '}
              {existingGroup ? (
                <button type="button" className="btn-link" onClick={() => { setTo(existingGroup); setGroupName(''); setError(''); setExistingGroup(''); }}>
                  {t('Send to “{name}” instead', { name: existingGroup })}
                </button>
              ) : null}
            </p>
          ) : null}
          <footer className="compose-foot">
            <span className="compose-foot-left">
              {!fullScreen ? <button type="button" className="btn-send split" onClick={() => send()} disabled={busy}><Icon name="send" size={18} />{busy ? t('Sending…') : t('Send')}</button> : null}
              <span className="menu-anchor">
                <button type="button" className={fullScreen ? 'icon-btn' : 'btn-send split-arrow'} aria-label={t('Schedule send')} title={t('Schedule send')}
                  aria-expanded={scheduling} disabled={busy} onClick={() => setScheduling(!scheduling)}>
                  <Icon name={fullScreen ? 'clock' : 'down'} size={18} />
                </button>
                {scheduling ? <WhenMenu title={t('Schedule send')} choices={scheduleChoices(t)} onPick={(when) => send(when)} onClose={() => setScheduling(false)} /> : null}
              </span>
              <AttachButton id="c-files" onFiles={files.add} />
            </span>
            <button type="button" className="icon-btn" aria-label={t('Discard draft')} title={t('Discard draft')} onClick={discard}><Icon name="trash" /></button>
          </footer>
        </DropZone>
      )}
    </section>
  );
}
