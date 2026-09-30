import { useEffect, useRef, useState, type FormEvent } from 'react';
import { brand } from '../brand';
import { Avatar, NumberBloom } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { api, apiRaw, displayName, mail, type Blocked, type User } from '../lib/api';
import { setShortcutsOn, shortcutsOn } from '../lib/shortcuts';
import { initials, LANGUAGES } from '../lib/format';
import { renderStyles, squareCrop, STYLE_NAMES, STYLES, toJpeg, type Style } from '../lib/photoStyles';
import { useT } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useSession } from '../lib/session';

// Profile and settings.
export function Settings({ onToast }: { onToast: (s: string) => void }) {
  const { user, refreshUser, signOut } = useSession();
  const t = useT();
  const [name, setName] = useState(user?.display_name || '');
  const [alias, setAlias] = useState('');
  const [pw, setPw] = useState({ current: '', next: '', again: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string; where: string } | null>(null);
  if (!user) return null;

  const act = async (where: string, fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      await refreshUser();
      onToast(ok);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : t('Something went wrong'), where });
    }
  };
  const note = (where: string) => (msg?.where === where ? <p className={msg.ok ? 'form-success' : 'form-error'} role="alert">{msg.text}</p> : null);

  return (
    <section className="settings">
      <h1 className="list-title">{t('Profile and settings')}</h1>

      <div className="settings-card profile-card">
        <Avatar address={user.address} name={user.display_name} avatarUrl={user.avatar_url} size="xl" />
        <div>
          <strong className="settings-name">{user.display_name || t('Add your name below')}</strong>
          <span className="settings-address">{user.address}</span>
          <span className="muted small">{user.phone}</span>
        </div>
      </div>

      <PictureStudio user={user} onDone={async (text) => { await refreshUser(); onToast(text); }} />

      <div className="settings-card">
        <label htmlFor="s-name" className="field-label">{t('Name')}</label>
        <p className="muted small">{t('Shown to people you email, next to your number.')}</p>
        <form className="inline" onSubmit={(e) => { e.preventDefault(); act('name', () => api('PATCH', '/api/me', { display_name: name.trim() }), t('Name saved')); }}>
          <input id="s-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t('Your name')} />
          <button className="btn-outline" type="submit" disabled={name.trim() === user.display_name}>{t('Save')}</button>
        </form>
        {note('name')}
      </div>

      <div className="settings-card">
        <span className="field-label">{t('Language')}</span>
        <div className="lang-row" role="radiogroup" aria-label={t('Language')}>
          {LANGUAGES.map((l) => (
            <button key={l.code} role="radio" aria-checked={user.language === l.code} disabled={!l.enabled} lang={l.code}
              aria-label={l.enabled ? `${l.name} (${l.native})` : `${l.name} (${l.native}), ${t('coming soon')}`}
              className={user.language === l.code ? 'chip active' : 'chip'}
              onClick={() => act('lang', () => api('PATCH', '/api/me', { language: l.code }), t('Language saved'))}>
              {l.native}{l.enabled ? '' : ` · ${t('soon')}`}
            </button>
          ))}
        </div>
        {note('lang')}
      </div>

      <div className="settings-card">
        <span className="field-label">{user.has_password ? t('Change password') : t('Set a password')}</span>
        <p className="muted small">
          {user.has_password ? t('Changing it signs you out on your other devices.') : t('You sign in with an SMS code. A password lets you sign in without one.')}
        </p>
        <form className="stack" onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (pw.next !== pw.again) return setMsg({ ok: false, text: t("The new passwords don't match"), where: 'pw' });
          act('pw', async () => {
            await api('PUT', '/api/me/password', { current_password: pw.current || undefined, new_password: pw.next });
            setPw({ current: '', next: '', again: '' });
          }, user.has_password ? t('Password changed') : t('Password set'));
        }}>
          {user.has_password ? (
            <input type="password" autoComplete="current-password" placeholder={t('Current password')} aria-label={t('Current password')}
              value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          ) : null}
          <input type="password" autoComplete="new-password" placeholder={t('New password (8+ characters)')} aria-label={t('New password')}
            value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <input type="password" autoComplete="new-password" placeholder={t('New password again')} aria-label={t('New password again')}
            value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} />
          <button className="btn-outline" type="submit" disabled={pw.next.length < 8}>{user.has_password ? t('Change password') : t('Set password')}</button>
        </form>
        {note('pw')}
      </div>

      <div className="settings-card">
        <span className="field-label">{t('Aliases')}</span>
        <p className="muted small">{t('Extra addresses (up to 5) that reach you, e.g. a name instead of your number.')}</p>
        <ul className="alias-list">
          {user.aliases.map((a) => (
            <li key={a}>
              <span>{a}</span>
              <button className="btn-link danger" onClick={() => act('alias', () => api('DELETE', `/api/me/aliases/${encodeURIComponent(a)}`), t('Alias removed'))}>{t('Remove')}</button>
            </li>
          ))}
        </ul>
        {user.aliases.length < 5 ? (
          <form className="inline" onSubmit={(e) => { e.preventDefault(); act('alias', async () => { await api('POST', '/api/me/aliases', { alias }); setAlias(''); }, t('Alias added')); }}>
            <span className="alias-input"><input value={alias} onChange={(e) => setAlias(e.target.value.toLowerCase())} placeholder={t('your.name')} aria-label={t('New alias')} /><span className="muted">@{brand.domain}</span></span>
            <button className="btn-outline" type="submit" disabled={!alias}>{t('Add')}</button>
          </form>
        ) : null}
        {note('alias')}
      </div>

      <Notifications user={user} onChanged={refreshUser} onToast={onToast} />

      <SendingSettings user={user} onSaved={async (text) => { await refreshUser(); onToast(text); }} />

      <BlockedPeople onToast={onToast} />

      <div className="settings-card">
        <span className="field-label">{t('Your data')}</span>
        <p className="muted small">{t('Download everything we keep about you: your account, groups, drafts and every email, as one file.')}</p>
        <a className="btn-outline" href="/api/me/export" download="phonemail-export.json"><Icon name="download" size={18} />{t('Download my data')}</a>
      </div>

      <div className="settings-card">
        <span className="field-label">{t('Devices')}</span>
        <button className="btn-outline" onClick={async () => { await signOut(true); navigate('/login', true); }}><Icon name="logout" size={18} />{t('Sign out everywhere')}</button>
      </div>

      <DeleteAccount user={user} />
    </section>
  );
}

// Profile picture: the number bloom (drawn from the number, the default) or a photo. A chosen
// photo is cropped and styled here in the browser; only the picture picked is uploaded, and
// the server removes any location or camera details from it.
function PictureStudio({ user, onDone }: { user: User; onDone: (text: string) => Promise<void> }) {
  const t = useT();
  const [styled, setStyled] = useState<Record<Style, string> | null>(null);
  const canvases = useRef<Record<Style, HTMLCanvasElement> | null>(null);
  const [style, setStyle] = useState<Style>('original');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const digits = user.address.split('@')[0];

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await onDone(ok);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Something went wrong'));
    } finally {
      setBusy(false);
    }
  };
  const choose = (file: File) => run(async () => {
    if (!file.type.startsWith('image/')) throw new Error(t('That file is not an image'));
    const all = await renderStyles(await squareCrop(file));
    canvases.current = all;
    setStyled(Object.fromEntries(STYLES.map((s) => [s, all[s].toDataURL('image/jpeg', 0.85)])) as Record<Style, string>);
    setStyle('original');
  }, t('Choose a style'));

  return (
    <div className="settings-card studio">
      <span className="field-label">{t('Profile picture')}</span>
      <div className="studio-options">
        <button className={!user.avatar_url ? 'studio-option on' : 'studio-option'} disabled={busy || !user.avatar_url}
          onClick={() => run(async () => { await api('DELETE', '/api/me/avatar'); setStyled(null); }, t('Back to your number bloom'))}>
          <NumberBloom digits={digits} label={user.display_name ? initials(user.display_name) : digits.slice(-2)} className="avatar large" />
          <span>{t('Number bloom')}</span>
          <span className="muted small">{!user.avatar_url ? t('In use') : t('Drawn from your number')}</span>
        </button>
        <button className={user.avatar_url ? 'studio-option on' : 'studio-option'} disabled={busy} onClick={() => fileRef.current?.click()}>
          {user.avatar_url ? <img className="avatar large avatar-photo" src={user.avatar_url} alt="" /> : <span className="avatar large studio-photo"><Icon name="person" size={28} /></span>}
          <span>{t('Photo')}</span>
          <span className="muted small">{user.avatar_url ? t('In use · choose another') : t('Upload one')}</span>
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) choose(f); e.target.value = ''; }} />
      {styled ? (
        <div className="style-picker">
          <div className="style-tiles" role="radiogroup" aria-label={t('Style')}>
            {STYLES.map((s) => (
              <button key={s} role="radio" aria-checked={style === s} className={style === s ? 'style-tile on' : 'style-tile'} onClick={() => setStyle(s)}>
                <img src={styled[s]} alt="" />
                <span>{t(STYLE_NAMES[s])}</span>
              </button>
            ))}
          </div>
          <p className="muted small">{t('Styles are made on your device; only the picture you choose is uploaded.')}</p>
          <div className="inline">
            <button className="btn-primary" disabled={busy} onClick={() => run(async () => {
              await apiRaw('PUT', '/api/me/avatar', await toJpeg(canvases.current![style]), 'image/jpeg');
              setStyled(null);
              canvases.current = null;
            }, t('Profile picture saved'))}>{t('Use this picture')}</button>
            <button className="btn-link" onClick={() => setStyled(null)}>{t('Cancel')}</button>
          </div>
        </div>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

// Push notifications on this browser. With them on, new mail arrives as a notification and
// the SMS alerts stop (the brief sends SMS only to people without the app).
function Notifications({ user, onChanged, onToast }: { user: User; onChanged: () => Promise<void>; onToast: (s: string) => void }) {
  const t = useT();
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [sub, setSub] = useState<PushSubscription | null | undefined>(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.getRegistration('/').then((r) => r?.pushManager.getSubscription() ?? null).then(setSub, () => setSub(null));
  }, [supported]);

  const enable = async () => {
    setError('');
    try {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error(t('Notifications are blocked for this site in your browser settings.'));
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const { public_key } = await api<{ public_key: string }>('GET', '/api/push/public-key');
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(public_key) });
      await api('POST', '/api/push/subscriptions', s.toJSON());
      setSub(s);
      await onChanged();
      onToast(t('Notifications on'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Something went wrong'));
    }
  };
  const disable = async () => {
    if (!sub) return;
    await api('DELETE', '/api/push/subscriptions', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    setSub(null);
    await onChanged();
    onToast(t('Notifications off'));
  };

  return (
    <div className="settings-card">
      <span className="field-label">{t('Notifications')}</span>
      <p className="muted small">
        {user.has_push ? t('New mail reaches you as a notification, so we don’t send SMS alerts.') : t('Without notifications on any device, we text you when new mail arrives.')}
      </p>
      {!supported ? <p className="muted small">{t('This browser can’t show notifications.')}</p> : sub ? (
        <button className="btn-outline" onClick={disable}><Icon name="bell" size={18} />{t('Turn off on this device')}</button>
      ) : (
        <button className="btn-outline" onClick={enable} disabled={sub === undefined}><Icon name="bell" size={18} />{t('Turn on for this device')}</button>
      )}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

function urlBase64ToBytes(s: string) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

// Delete my account: confirmed with the password, or a fresh SMS code for accounts without one.
function DeleteAccount({ user }: { user: User }) {
  const { signOut } = useSession();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (!user.has_password && !codeSent) {
        await api('POST', '/api/auth/otp/start', { phone: user.phone });
        setCodeSent(true);
        return;
      }
      await api('DELETE', '/api/me', user.has_password ? { password: secret } : { code: secret });
      await signOut().catch(() => {});
      navigate('/login', true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card danger-zone">
      <span className="field-label">{t('Delete account')}</span>
      <p className="muted small">{t('Erases your number, profile, aliases and your copy of every email. Emails you sent stay with the people who got them, shown as from “Deleted account”. This can’t be undone.')}</p>
      {!open ? <button className="btn-outline danger" onClick={() => setOpen(true)}>{t('Delete my account…')}</button> : (
        <form className="stack" onSubmit={confirm}>
          {user.has_password ? (
            <input type="password" autoComplete="current-password" placeholder={t('Your password')} aria-label={t('Your password')} value={secret} onChange={(e) => setSecret(e.target.value)} />
          ) : codeSent ? (
            <input inputMode="numeric" autoComplete="one-time-code" placeholder={t('6-digit code')} aria-label={t('Code')} value={secret} onChange={(e) => setSecret(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          ) : <p className="small">{t('We’ll text a code to {phone} to confirm.', { phone: user.phone })}</p>}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="inline">
            <button className="btn-danger" type="submit" disabled={busy || ((user.has_password || codeSent) && !secret)}>
              {!user.has_password && !codeSent ? t('Send code') : t('Delete my account for good')}
            </button>
            <button type="button" className="btn-link" onClick={() => { setOpen(false); setSecret(''); setCodeSent(false); }}>{t('Cancel')}</button>
          </div>
        </form>
      )}
    </div>
  );
}

// Writing and sending: signature, Undo send, keyboard shortcuts.
function SendingSettings({ user, onSaved }: { user: User; onSaved: (text: string) => Promise<void> }) {
  const t = useT();
  const [signature, setSignature] = useState(user.signature || '');
  const [keys, setKeys] = useState(shortcutsOn());
  const [error, setError] = useState('');
  const save = async (change: Partial<User>, ok: string) => {
    setError('');
    try {
      await api('PATCH', '/api/me', change);
      await onSaved(ok);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Something went wrong'));
    }
  };
  return (
    <div className="settings-card">
      <label htmlFor="s-signature" className="field-label">{t('Signature')}</label>
      <p className="muted small">{t('Added under every new email you write. Leave it empty for none.')}</p>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save({ signature }, t('Signature saved')); }}>
        <textarea id="s-signature" rows={3} maxLength={1000} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={t('e.g. Asha Rao · Chennai')} />
        <button className="btn-outline" type="submit" disabled={signature.trim() === (user.signature || '')}>{t('Save signature')}</button>
      </form>

      <label htmlFor="s-undo" className="field-label">{t('Undo send')}</label>
      <p className="muted small">{t('After you press Send, the email waits this long, so you can take it back.')}</p>
      <select id="s-undo" value={user.undo_send_seconds} onChange={(e) => save({ undo_send_seconds: Number(e.target.value) }, t('Saved'))}>
        <option value={0}>{t('Off: send at once')}</option>
        {[5, 10, 20, 30].map((n) => <option key={n} value={n}>{t('{n} seconds', { n })}</option>)}
      </select>

      <span className="field-label">{t('Keyboard shortcuts')}</span>
      <label className="check-line">
        <input type="checkbox" checked={keys} onChange={(e) => { setShortcutsOn(e.target.checked); setKeys(e.target.checked); }} />
        {t('Use keyboard shortcuts on this device (press ? to see them)')}
      </label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
  );
}

// People you blocked: their emails to you go to Spam. Unblock them here.
function BlockedPeople({ onToast }: { onToast: (s: string) => void }) {
  const t = useT();
  const [list, setList] = useState<Blocked[] | null>(null);
  const [add, setAdd] = useState('');
  const [error, setError] = useState('');
  const load = () => mail.blocks().then(setList, () => setList([]));
  useEffect(() => {
    load();
  }, []);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError('');
    try {
      await fn();
      onToast(ok);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Something went wrong'));
    }
  };
  return (
    <div className="settings-card">
      <span className="field-label">{t('Blocked people')}</span>
      <p className="muted small">{t('Emails they send you go straight to Spam, without an alert. Groups you share are not affected.')}</p>
      {list && list.length === 0 ? <p className="muted small">{t("You haven't blocked anyone.")}</p> : null}
      <ul className="member-list">
        {(list || []).map((b) => (
          <li key={b.user_id}>
            <Avatar address={b.address} name={b.display_name} avatarUrl={b.avatar_url} size="small" />
            <span className="member-name">{displayName(b)}<span className="muted small"> {b.display_name ? b.address : ''}</span></span>
            <button className="btn-link small" onClick={() => run(() => mail.unblock(b.user_id), t('{name} is unblocked', { name: displayName(b) }))}>{t('Unblock')}</button>
          </li>
        ))}
      </ul>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); run(async () => { await mail.block(add.trim()); setAdd(''); }, t('Blocked')); }}>
        <input value={add} onChange={(e) => setAdd(e.target.value)} placeholder={t('Block a number or address')} aria-label={t('Block a number or address')} />
        <button className="btn-outline" disabled={!add.trim()}>{t('Block')}</button>
      </form>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
  );
}
