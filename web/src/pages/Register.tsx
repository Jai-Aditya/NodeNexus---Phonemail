import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Logo } from '../components/Logo';
import { TermsLine } from '../components/TermsLine';
import { api, type AuthConfig } from '../lib/api';
import { useT } from '../lib/i18n';
import { Link } from '../lib/router';

// Sign-up portal (brief): "Just two fields (Phone Number and OTP). This portal is exclusively for
// account creation. On creation, the fields must reset for the next account creation."
// It never signs this browser in (client "portal"), so a kiosk can sign up one person after another.
export default function Register() {
  const t = useT();
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ address: string; isNew: boolean } | null>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<AuthConfig>('GET', '/api/auth/config').then(setConfig, (e: Error) => setError(e.message));
  }, []);

  const digits = phone.replace(/\D/g, '').slice(-10);
  const phoneOk = /^[6-9]\d{9}$/.test(digits);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setCreated(null);
    if (!phoneOk) return setError(t('Enter a 10-digit mobile number'));
    if (config?.mode !== 'otp') return setError(t('Sign-up by SMS code is not available right now. Use the sign-in page.'));
    setBusy(true);
    try {
      if (!codeSent) {
        await api('POST', '/api/auth/otp/start', { phone: digits });
        setCodeSent(true);
      } else {
        const r = await api<{ created: boolean; address: string }>('POST', '/api/auth/otp/verify', { phone: digits, code: otp, client: 'portal' });
        setCreated({ address: r.address, isNew: r.created });
        setPhone('');
        setOtp('');
        setCodeSent(false);
        phoneRef.current?.focus();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page portal">
      <form className="auth-card" onSubmit={submit} noValidate>
        <Logo />
        <span className="portal-tag">{t('Sign-up portal')}</span>
        <h1 className="auth-title">{t('Create a {brand} account')}</h1>
        <p className="auth-sub">{t('Enter a mobile number and the code texted to it. The form clears for the next person.')}</p>
        {created ? (
          <p className="form-success" role="status">
            {created.isNew ? t('Account created:') : t('Already registered:')} <strong>{created.address}</strong>
          </p>
        ) : null}
        <label className="field">
          <span className="field-label">{t('Phone number')}</span>
          <span className="phone-input">
            <span className="cc">+91</span>
            <input ref={phoneRef} id="portal-phone" inputMode="numeric" autoComplete="off" placeholder="98765 43210" value={phone}
              onChange={(e) => { setPhone(e.target.value); setCodeSent(false); }} autoFocus />
          </span>
        </label>
        <label className="field">
          <span className="field-label">{t('OTP')}</span>
          <input id="portal-otp" inputMode="numeric" autoComplete="one-time-code" value={otp} disabled={!codeSent}
            placeholder={codeSent ? t('6-digit code') : t('Sent after you press Next')}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <TermsLine />
        <button className="btn-primary" type="submit" disabled={busy || !config}>{busy ? t('Please wait…') : t('Next')}</button>
      </form>
      <p className="auth-foot"><Link to="/login">{t('Back to sign in')}</Link></p>
    </main>
  );
}
