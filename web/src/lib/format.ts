// Gmail-style list dates: time today, "27 Sep" this year, dd/mm/yy before that.
export function listDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export const fullDate = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export const initials = (s: string) =>
  s
    .replace(/@.*/, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '#';

// A stable colour per person for avatars (Gmail does the same).
export function avatarColor(s: string) {
  const palette = ['#4B3FB0', '#B4521F', '#2E7D5B', '#9C3D7A', '#1F6E8C', '#8A6A12', '#5B4FC4', '#A23B3B'];
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

// The language screen shows these; only enabled ones can be chosen (English at launch).
export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', enabled: true },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', enabled: false },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்', enabled: false },
];
