import { brand } from '../brand';
import { avatarColor, initials } from '../lib/format';

// A person's picture:
//   an uploaded photo (avatar_url, e.g. /api/avatars/12-abc.jpg) -> the photo, round
//   no photo, a PhoneMail number -> the "number bloom" drawn from its 10 digits
//   anyone else (a deleted account, an outside address) -> initials on a stable colour
const ourNumber = () => new RegExp(`^(\\d{10})@(${[brand.domain, ...brand.legacyDomains].map((d) => d.replace(/[.]/g, '\\.')).join('|')})$`, 'i');

type Props = {
  address?: string;
  name?: string | null;
  avatarUrl?: string | null;
  size?: 'tiny' | 'small' | 'large' | 'xl';
  group?: boolean;
  className?: string;
};

export function Avatar({ address = '', name, avatarUrl, size, group, className = '' }: Props) {
  const cls = ['avatar', size || '', className].filter(Boolean).join(' ');
  if (group) {
    return (
      <span className={cls + ' avatar-group'} style={{ background: avatarColor(name || address) }} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="60%" height="60%"><path fill="currentColor" d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9 13c-3.3 0-7 1.7-7 4.5V20h14v-2.5C16 14.7 12.3 13 9 13Zm7.5.2c1.5.9 2.5 2.4 2.5 4.3V20h3v-2.2c0-2.3-2.7-4.1-5.5-4.6Z" /></svg>
      </span>
    );
  }
  if (avatarUrl) return <img className={cls + ' avatar-photo'} src={avatarUrl} alt="" draggable={false} />;
  const m = ourNumber().exec(address.trim());
  if (m) return <NumberBloom digits={m[1]} label={name ? initials(name) : m[1].slice(-2)} className={cls} />;
  return <span className={cls} style={{ background: avatarColor(name || address || '?') }} aria-hidden="true">{initials(name || address || '?')}</span>;
}

// The number bloom: ten petals, one per digit, clockwise from the top; a bigger digit makes a longer, brighter
// petal. The hue comes from the digits too, so every number has its own flower.
export function bloomHue(digits: string) {
  const sum = [...digits].reduce((a, c) => a + Number(c), 0);
  return (sum * 37 + Number(digits.slice(-4))) % 360;
}

export function NumberBloom({ digits, label, className }: { digits: string; label: string; className?: string }) {
  const H = bloomHue(digits);
  const r = 50;
  return (
    <svg className={(className || 'avatar') + ' bloom'} viewBox="0 0 100 100" role="img" aria-label={`Number bloom for ${digits}`}>
      <circle cx="50" cy="50" r={r} fill={`hsl(${H}, 55%, 42%)`} />
      {[...digits].map((ch, i) => {
        const d = Number(ch);
        const inner = r * 0.22;
        const outer = r * (0.46 + 0.05 * d);
        const angle = -90 + i * 36;
        return (
          <ellipse key={i} cx={50 + (inner + outer) / 2} cy="50" rx={(outer - inner) / 2} ry={r * 0.11} fill="#fff" opacity={0.35 + 0.065 * d}
            transform={`rotate(${angle} 50 50)`} />
        );
      })}
      <circle cx="50" cy="50" r={r * 0.26} fill={`hsl(${H}, 55%, 30%)`} />
      <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize={label.length > 1 ? 14 : 17} fontWeight="600"
        fontFamily="inherit">{label}</text>
    </svg>
  );
}
