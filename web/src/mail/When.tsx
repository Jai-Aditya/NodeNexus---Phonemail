import { useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n';

// Choosing a time: when a snoozed conversation comes back, or when a scheduled email goes.
// A few ready choices (Gmail's), or any date and time.

type Choice = { label: string; at: Date };

const at = (days: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
};
const daysUntil = (weekday: number) => ((weekday - new Date().getDay() + 7) % 7) || 7; // 0 = Sunday

export function snoozeChoices(t: (s: string) => string): Choice[] {
  const list: Choice[] = [];
  const now = new Date();
  if (now.getHours() < 18) list.push({ label: t('Later today'), at: at(0, 18) });
  list.push({ label: t('Tomorrow'), at: at(1, 8) });
  if (![5, 6, 0].includes(now.getDay())) list.push({ label: t('This weekend'), at: at(daysUntil(6), 8) });
  list.push({ label: t('Next week'), at: at(daysUntil(1), 8) });
  return list;
}

export function scheduleChoices(t: (s: string) => string): Choice[] {
  return [
    { label: t('Tomorrow morning'), at: at(1, 8) },
    { label: t('Tomorrow afternoon'), at: at(1, 13) },
    { label: t('Monday morning'), at: at(daysUntil(1), 8) },
  ];
}

export const whenText = (d: Date | string) =>
  new Date(d).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** A small menu of times; "Pick date and time" opens a date-time field. */
export function WhenMenu({ title, choices, onPick, onClose }: {
  title: string; choices: Choice[]; onPick: (d: Date) => void; onClose: () => void;
}) {
  const t = useT();
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);

  const pickCustom = () => {
    const d = new Date(value);
    if (!value || Number.isNaN(d.getTime())) return setError(t('Choose a date and time'));
    if (d.getTime() <= Date.now()) return setError(t('Choose a time in the future'));
    onPick(d);
  };

  return (
    <div className="when-menu" ref={box} role="menu" aria-label={title}>
      <p className="when-title">{title}</p>
      {choices.map((c) => (
        <button key={c.label} type="button" role="menuitem" className="when-item" onClick={() => onPick(c.at)}>
          <span>{c.label}</span><span className="muted small">{whenText(c.at)}</span>
        </button>
      ))}
      {custom ? (
        <div className="when-custom">
          <input type="datetime-local" aria-label={t('Date and time')} value={value} onChange={(e) => { setValue(e.target.value); setError(''); }} />
          {error ? <p className="form-error small">{error}</p> : null}
          <button type="button" className="btn-outline" onClick={pickCustom}>{t('Save')}</button>
        </div>
      ) : (
        <button type="button" role="menuitem" className="when-item" onClick={() => setCustom(true)}>{t('Pick date and time')}</button>
      )}
    </div>
  );
}
