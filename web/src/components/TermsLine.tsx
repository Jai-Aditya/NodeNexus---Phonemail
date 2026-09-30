import { useT } from '../lib/i18n';
import { Link } from '../lib/router';

// Brief: "By signing up, you agree to the Terms of Service", with Terms of Service linked. The sentence is
// translated whole, since Hindi and Tamil place the link in the middle of it.
export function TermsLine() {
  const t = useT();
  const [before, after = ''] = t('By signing up, you agree to the {terms}').split('{terms}');
  return (
    <p className="terms-line">
      {before}<Link to="/terms">{t('Terms of Service (link)')}</Link>{after}
    </p>
  );
}
