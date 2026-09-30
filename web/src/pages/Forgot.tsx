import { useState, type FormEvent } from 'react';
import { Logo } from '../components/Logo';
import { api, type User } from '../lib/api';
import { useT } from '../lib/i18n';
import { Link, navigate } from '../lib/router';
import { useSession } from '../lib/session';

// Forgot password: prove the number with a code by SMS, then choose a new one. Everyone
// signed in with the old password is signed out; this browser is signed in.
export default function Forgot() {
  const { signedIn } = useSession();
  const t = useT();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState({ next: '', again: '' });
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const digits = phone.replace(/\D/g, '').slice(-10);
  const phoneOk = /^[6-9]\d{9}$/.test(digits);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!phoneOk) return setError(t('Enter your 10-digit mobile number'));
    setBusy(true);
    try {
      if (!sent) {
        await api('POST', '/api/auth/password/reset/start', { phone: digits });
        setSent(true);
      } else {
        if (pw.next.length < 8) throw new Error(t('Use at least 8 characters for your password.'));
        if (pw.next !== pw.again) throw new Error(t("The new passwords don't match"));
        const r = await api<{ user: User }>('POST', '/api/auth/password/reset', { phone: digits, code, new_password: pw.next, client: 'web' });
        signedIn(r.user);
        navigate('/', true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit} noValidate>
        <Logo />
        <h1 className="auth-title">{t('Reset your password')}</h1>
        <p className="auth-sub">{sent ? t('If {number} has an account, we texted it a code.', { number: `+91 ${digits}` }) : t("We'll text a code to your number.")}</p>
        <label className="field">
          <span className="field-label">{t('Phone number')}</span>
          <span className="phone-input">
            <span className="cc">+91</span>
            <input inputMode="numeric" autoComplete="tel-national" placeholder="98765 43210" value={phone} disabled={sent}
              onChange={(e) => setPhone(e.target.value)} autoFocus />
          </span>
        </label>
        {sent ? (
          <>
            <label className="field">
              <span className="field-label">{t('Code')}</span>
              <input inputMode="numeric" autoComplete="one-time-code" placeholder={t('6-digit code')} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            </label>
            <label className="field">
              <span className="field-label">{t('New password')}</span>
              <input type="password" autoComplete="new-password" placeholder={t('At least 8 characters')} value={pw.next}
                onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">{t('New password again')}</span>
              <input type="password" autoComplete="new-password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} />
            </label>
          </>
        ) : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="btn-primary" type="submit" disabled={busy}>{busy ? t('Please wait…') : sent ? t('Set new password') : t('Send code')}</button>
      </form>
      <p className="auth-foot"><Link to="/login">{t('Back to sign in')}</Link></p>
    </main>
  );
}
