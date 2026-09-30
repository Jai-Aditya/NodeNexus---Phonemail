import { useState } from 'react';
import { mail, type Message } from '../lib/api';
import { useT } from '../lib/i18n';

// An email's text. Lists carry only the first 100 characters of long emails (truncated);
// "Read more" fetches the whole email. Formatted (HTML) bodies are shown as formatting: the
// mail service cleans every HTML body when it's stored (no scripts, frames, forms or
// javascript: links), and the page's Content-Security-Policy blocks scripts on top of that.
export function MessageBody({ m, onExpanded }: { m: Message; onExpanded?: (full: Message) => void }) {
  const t = useT();
  const [full, setFull] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = full || m;

  const readMore = async () => {
    setBusy(true);
    try {
      const whole = await mail.message(m.id, m.conversation_id);
      setFull(whole);
      onExpanded?.(whole);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mail-body">
      {shown.body_html && !shown.truncated
        ? <div className="mail-html" dangerouslySetInnerHTML={{ __html: shown.body_html }} />
        : <div className="mail-text">{shown.body_text || (shown.truncated ? '' : shown.snippet)}</div>}
      {shown.truncated ? (
        <button type="button" className="btn-link read-more" onClick={readMore} disabled={busy}>
          {busy ? t('Opening…') : t('Read more')}
        </button>
      ) : null}
    </div>
  );
}
