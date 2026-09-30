import { Logo } from '../components/Logo';
import { Mascot } from '../components/Mascot';
import { LANGUAGES } from '../lib/format';
import { rememberLanguage, useT } from '../lib/i18n';
import { navigate } from '../lib/router';

// First visit (brief's onboarding, step 1): choose a language. English at launch; Hindi and
// Tamil are shown so people know they're coming, but can't be chosen yet.
export default function Language() {
  const t = useT();
  const choose = (code: string) => {
    rememberLanguage(code);
    navigate('/login', true);
  };
  return (
    <main className="auth-page">
      <section className="auth-card lang-card">
        <Logo />
        <Mascot size={120} className="mascot-hop" label={t('Pip, the PhoneMail carrier pigeon, bringing a letter')} />
        <h1 className="auth-title">{t('Choose your language')}</h1>
        <p className="auth-sub">{t('You can change it later in Settings.')}</p>
        <ul className="lang-list" role="list">
          {LANGUAGES.map((l) => (
            <li key={l.code}>
              <button type="button" className="lang-option" disabled={!l.enabled} onClick={() => choose(l.code)} lang={l.code}>
                <span className="lang-native">{l.native}</span>
                <span className="lang-name">{l.enabled ? (l.name !== l.native ? l.name : '') : `${l.name} · ${t('coming soon')}`}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
