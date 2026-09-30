import { brand } from '../brand';
import { Logo } from '../components/Logo';
import { useT } from '../lib/i18n';
import { Link } from '../lib/router';

export default function Terms() {
  const t = useT();
  return (
    <main className="terms-page">
      <Logo />
      <h1>{t('Terms of Service')}</h1>
      <p className="muted">Last updated 27 September 2026</p>
      <ol>
        <li>{brand.name} gives you an email address made from your mobile number, for example 9876543210@{brand.domain}.</li>
        <li>You may only register a mobile number that you own and can receive text messages on.</li>
        <li>Your number is used to create your address, to verify you, and to send SMS alerts about new email when you do not use the app.</li>
        <li>Do not use {brand.name} to send spam, fraud or unlawful content. Accounts that do may be closed.</li>
        <li>Contacts on your phone are read only when you choose someone to write to, and are never uploaded.</li>
        <li>{brand.name} is a buildathon project, provided as is, without guarantees of availability.</li>
      </ol>
      <p>
        <Link to="/login">{t('Back to sign in')}</Link>
      </p>
    </main>
  );
}
