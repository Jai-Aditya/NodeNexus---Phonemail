import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { mail, REACTIONS, type Message } from '../lib/api';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';

/** You can react unless you were Bcc'd (a reaction would show everyone you got it). */
export const canReact = (m: Message, meId?: number) =>
  !(m.recipients || []).some((r) => r.kind === 'bcc' && r.person?.user_id === meId && !m.is_mine);

// Emoji reactions under an email (WhatsApp's six). One per person: picking another replaces
// yours, picking yours again takes it off. Everyone with the email sees them live; they
// never send an alert.
export function Reactions({ m, onChanged, compact }: { m: Message; onChanged: () => void; compact?: boolean }) {
  const t = useT();
  const { user } = useSession();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const mine = m.reactions?.find((r) => r.mine)?.emoji;
  const allowed = canReact(m, user?.id);

  useEffect(() => {
    if (!picking) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setPicking(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [picking]);

  const choose = async (emoji: string) => {
    setPicking(false);
    setError('');
    try {
      if (emoji === mine) await mail.unreact(m.id);
      else await mail.react(m.id, emoji);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Could not react'));
    }
  };

  if (!allowed && !m.reactions?.length) return null;
  return (
    <div className={compact ? 'reactions compact' : 'reactions'} ref={box}>
      {(m.reactions || []).map((r) => (
        <button key={r.emoji} type="button" className={r.mine ? 'reaction mine' : 'reaction'} disabled={!allowed}
          title={r.names.join(', ')} aria-label={t('{emoji} from {names}', { emoji: r.emoji, names: r.names.join(', ') })}
          aria-pressed={Boolean(r.mine)} onClick={() => choose(r.emoji)}>
          <span aria-hidden="true">{r.emoji}</span> {r.count}
        </button>
      ))}
      {allowed ? (
        <button type="button" className="reaction add" aria-label={t('React')} title={t('React')} aria-expanded={picking} onClick={() => setPicking(!picking)}>
          <Icon name="smile" size={16} />
        </button>
      ) : null}
      {picking ? (
        <div className="reaction-picker" role="menu" aria-label={t('Reactions')}>
          {REACTIONS.map((e) => (
            <button key={e} type="button" role="menuitem" className={e === mine ? 'mine' : ''} aria-label={t('React with {emoji}', { emoji: e })} onClick={() => choose(e)}>{e}</button>
          ))}
        </div>
      ) : null}
      {error ? <span className="form-error small">{error}</span> : null}
    </div>
  );
}
