import { useEffect } from 'react';
import { brand } from './brand';
import MailApp from './mail/MailApp';
import Forgot from './pages/Forgot';
import Language from './pages/Language';
import Login from './pages/Login';
import Register from './pages/Register';
import Terms from './pages/Terms';
import { ENABLED, hasChosenLanguage, rememberLanguage, storedLanguage } from './lib/i18n';
import { navigate, useLocation } from './lib/router';
import { useSession } from './lib/session';

const TITLES: Record<string, string> = { '/welcome': 'Welcome', '/terms': 'Terms', '/forgot': 'Forgot password', '/login': 'Sign in' };

export default function App() {
  const { path } = useLocation();
  const { ready, user } = useSession();

  const publicPage = path.startsWith('/register') || path === '/terms' || path === '/forgot' || path === '/welcome';
  useEffect(() => {
    if (!ready || publicPage) return;
    // First visit: choose a language, then sign in (the brief's onboarding order).
    if (!user && !hasChosenLanguage()) navigate('/welcome', true);
    else if (!user && path !== '/login') navigate('/login', true);
    else if (user && path === '/login') navigate('/', true);
  }, [ready, user, path, publicPage]);

  // The page language follows the profile, and is remembered for the sign-in screen next time.
  useEffect(() => {
    const lang = user?.language || storedLanguage();
    if (user?.language && hasChosenLanguage()) rememberLanguage(user.language);
    document.documentElement.lang = ENABLED.includes(lang) ? lang : 'en';
  }, [user?.language]);

  useEffect(() => {
    const title = path.startsWith('/register') ? 'Sign-up portal' : TITLES[path];
    document.title = title ? `${title} · ${brand.name}` : brand.name;
  }, [path]);

  if (path.startsWith('/register')) return <Register />;
  if (path === '/terms') return <Terms />;
  if (path === '/forgot') return <Forgot />;
  if (path === '/welcome') return <Language />;
  if (!ready) return <div className="boot" aria-busy="true" />;
  if (!user) return <Login />;
  return <MailApp />;
}
