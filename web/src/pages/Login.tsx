import { useEffect, useState, type FormEvent } from 'react';
import { brand } from '../brand';
import { Logo } from '../components/Logo';
import { Mascot } from '../components/Mascot';
import { TermsLine } from '../components/TermsLine';
import { api, ApiError, type AuthConfig, type User } from '../lib/api';
import { useT } from '../lib/i18n';
import { Link, navigate } from '../lib/router';
import { useSession } from '../lib/session';

// Brief: "A single screen with the phone number, OTP and one Next button. Above the button,
// display 'By signing up, you agree to the Terms of Service', with Terms of Service hyperlinked."
// A new number is signed up by the same steps. Without an SMS code provider the second
// field is a password (the brief's fallback).
export default function Login() {
  const { signedIn } = useSession();
  const t = useT();
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [phone, setPhone] = useState('');
  const [secret, setSecret] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<AuthConfig>('GET', '/api/auth/config').then(setConfig, (e: Error) => setError(e.message));
  }, []);

  const digits = phone.replace(/\D/g, '').slice(-10);
  const phoneOk = /^[6-9]\d{9}$/.test(digits);
  const otp = config?.mode === 'otp' && !usePassword;

  const done = (u: User) => {
    signedIn(u);
    navigate('/', true);
  };

  const next = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!phoneOk) return setError(t('Enter your 10-digit mobile number'));
    setBusy(true);
    try {
      if (otp && !codeSent) {
        await api('POST', '/api/auth/otp/start', { phone: digits });
        setCodeSent(true);
      } else if (otp) {
        const r = await api<{ user: User }>('POST', '/api/auth/otp/verify', { phone: digits, code: secret, client: 'web' });
        done(r.user);
      } else {
        if (secret.length < 8) throw new Error(t('Your password has at least 8 characters'));
        try {
          done((await api<{ user: User }>('POST', '/api/auth/login', { phone: digits, password: secret })).user);
        } catch (err) {
          // Password mode: an unknown number with a new password signs up.
          if (!(err instanceof ApiError) || err.status !== 401 || config?.mode !== 'password') throw err;
          try {
            done((await api<{ user: User }>('POST', '/api/auth/register', { phone: digits, password: secret, client: 'web' })).user);
          } catch (err2) {
            if (err2 instanceof ApiError && err2.code === 'account_exists') throw new Error(t('Wrong password for this number'));
            throw err2;
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={next} noValidate>
        <Logo />
        <Mascot size={84} className="mascot-login" />
        <h1 className="auth-title">{t('Sign in to {brand}')}</h1>
        <p className="auth-sub">{t('Your phone number is your email address.')}</p>

        <label className="field">
          <span className="field-label">{t('Phone number')}</span>
          <span className="phone-input">
            <span className="cc">+91</span>
            <input id="phone" inputMode="numeric" autoComplete="tel-national" placeholder="98765 43210" value={phone}
              onChange={(e) => { setPhone(e.target.value); setCodeSent(false); }} autoFocus />
          </span>
          <span className="field-hint">{phoneOk ? t('Your address: {address}', { address: `${digits}@${brand.domain}` }) : ' '}</span>
        </label>

        <label className="field">
          <span className="field-label">{otp ? t('OTP') : t('Password')}</span>
          <input id="secret" type={otp ? 'text' : 'password'} inputMode={otp ? 'numeric' : undefined}
            autoComplete={otp ? 'one-time-code' : 'current-password'} value={secret}
            placeholder={otp ? (codeSent ? t('6-digit code') : t('Sent after you press Next')) : t('At least 8 characters')}
            disabled={otp && !codeSent} onChange={(e) => setSecret(otp ? e.target.value.replace(/\D/g, '').slice(0, 6) : e.target.value)} />
          {otp && codeSent ? <span className="field-hint">{t('We texted a code to +91 {number}.', { number: digits })}</span> : null}
          {!otp && config?.password_reset ? <span className="field-hint"><Link to="/forgot">{t('Forgot password?')}</Link></span> : null}
        </label>

        {error ? <p className="form-error" role="alert">{error}</p> : null}

        <TermsLine />
        <button className="btn-primary" type="submit" disabled={busy || !config}>
          {busy ? t('Please wait…') : t('Next')}
        </button>

        {config?.mode === 'otp' ? (
          <button type="button" className="btn-link" onClick={() => { setUsePassword(!usePassword); setSecret(''); setCodeSent(false); setError(''); }}>
            {usePassword ? t('Use an SMS code instead') : t('Use a password instead')}
          </button>
        ) : null}
        {config?.signup_number ? (
          // The brief's phone sign-up: call and press 1, or send a text. PhoneMail never calls anyone.
          <p className="auth-phone-signup small muted">
            {t('No app or internet? Call')} <a href={`tel:${config.signup_number}`}>{config.signup_number}</a> {t('and press 1, or')}{' '}
            <a href={`sms:${config.signup_number}?&body=JOIN`}>{t('text JOIN')}</a> {t('to it.')}
          </p>
        ) : null}
      </form>
      <p className="auth-foot">
        {t('Creating accounts for others?')} <Link to="/register/">{t('Open the sign-up portal')}</Link>
      </p>
    </main>
  );
}
