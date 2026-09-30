import { useEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { Avatar } from '../components/Avatar';
import { displayName, mail, type Group, type Suggestion, type Suggestions } from '../lib/api';
import { useT, type T } from '../lib/i18n';

/** "with Asha, Ravi and 3 more": a group's other members, to tell same-named groups apart. */
export function membersLine(g: Group, meId: number | undefined, t: T) {
  const others = g.members.filter((m) => m.user_id !== meId).map((m) => displayName(m));
  const shown = others.slice(0, 3).join(', ');
  return others.length > 3 ? t('with {names} and {n} more', { names: shown, n: others.length - 3 }) : t('with {names}', { names: shown || t('only you') });
}

type Item = { kind: 'person'; p: Suggestion } | { kind: 'group'; g: Group };

// A To / Cc / Bcc field: recipients separated by commas, with suggestions for the one being
// typed. First the people you already share a conversation with and your groups (by name,
// number or alias); anyone else on PhoneMail appears only when their exact number, address
// or alias is typed. Picking a group remembers which one it was (onPickGroup), so groups
// with the same name never get mixed up.
export function RecipientInput({ id, value, onChange, onPickGroup, placeholder, meId, inputRef, peopleOnly, exclude, label }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onPickGroup?: (name: string, id: number) => void;
  placeholder?: string;
  meId?: number;
  inputRef?: Ref<HTMLInputElement>;
  peopleOnly?: boolean; // adding group members: no groups, and not people already in (exclude)
  exclude?: number[];
  label?: string;
}) {
  const t = useT();
  const [res, setRes] = useState<Suggestions | null>(null);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);

  const parts = value.split(/([,;])/);
  const current = (parts[parts.length - 1] || '').trim();

  // Look up what's being typed, 180 ms after typing pauses; stale answers are dropped.
  useEffect(() => {
    if (!current || !open) {
      setRes(null);
      return;
    }
    const n = ++seq.current;
    const timer = window.setTimeout(() => {
      mail.suggest(current).then((r) => { if (n === seq.current) { setRes(r); setActive(0); } }, () => {});
    }, 180);
    return () => window.clearTimeout(timer);
  }, [current, open]);

  const items: Item[] = [
    ...(res?.people || []).filter((p) => !exclude?.includes(p.user_id)).map((p) => ({ kind: 'person' as const, p })),
    ...(peopleOnly ? [] : res?.groups || []).map((g) => ({ kind: 'group' as const, g })),
  ];
  const showList = open && current !== '' && items.length > 0;

  const pick = (it: Item) => {
    const text = it.kind === 'person' ? it.p.address : it.g.name;
    if (it.kind === 'group') onPickGroup?.(it.g.name, it.g.conversation_id);
    const before = parts.slice(0, -1).join('');
    onChange(`${before}${before ? ' ' : ''}${text}, `);
    setRes(null);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!showList) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(items[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  const listId = `${id}-suggestions`;
  return (
    <span className="recipient-input">
      <input id={id} ref={inputRef} value={value} autoComplete="off" placeholder={placeholder} aria-label={label}
        role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={showList ? `${listId}-${active}` : undefined}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKey} />
      {showList ? (
        <ul id={listId} className="suggestions" role="listbox" aria-label={t('Suggestions')}>
          {items.map((it, i) => (
            <li key={it.kind === 'person' ? `p${it.p.user_id}` : `g${it.g.conversation_id}`} id={`${listId}-${i}`} role="option"
              aria-selected={i === active} className={i === active ? 'suggestion active' : 'suggestion'}
              onMouseDown={(e) => { e.preventDefault(); pick(it); }} onMouseEnter={() => setActive(i)}>
              {it.kind === 'person' ? (
                <>
                  <Avatar address={it.p.address} name={it.p.display_name} avatarUrl={it.p.avatar_url} size="small" />
                  <span className="suggestion-main">
                    <strong>{displayName(it.p)}</strong>
                    <span className="muted small">{it.p.display_name ? it.p.address : ''}{!it.p.known ? `${it.p.display_name ? ' · ' : ''}${t('on PhoneMail · no conversation yet')}` : ''}</span>
                  </span>
                </>
              ) : (
                <>
                  <Avatar name={it.g.name} group size="small" />
                  <span className="suggestion-main">
                    <strong>{it.g.name}</strong>
                    <span className="muted small">{t('Group')} · {membersLine(it.g, meId, t)}</span>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}
