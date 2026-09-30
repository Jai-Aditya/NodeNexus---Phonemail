// One small line-icon set (24×24, stroke = currentColor) so every icon matches the text around it.
const PATHS: Record<string, string> = {
  inbox: 'M4 13h4l1.5 3h5L16 13h4M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z',
  star: 'm12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z',
  unread: 'M4 6h16v12H4ZM4 7l8 6 8-6M19 4.5a2.5 2.5 0 1 1 0 .01',
  clip: 'm20 11.5-8.3 8.3a5 5 0 0 1-7-7L13 4.5a3.3 3.3 0 0 1 4.7 4.7L9.4 17.5a1.7 1.7 0 0 1-2.4-2.4l7.7-7.6',
  draft: 'M4 20h4L19 9l-4-4L4 16Zm9-13 4 4',
  spam: 'M12 3 2.5 20h19ZM12 10v4.5M12 17.2v.1',
  trash: 'M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13M10 11v6M14 11v6',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm4.7-1.8L20 20',
  menu: 'M4 7h16M4 12h16M4 17h16',
  back: 'M19 12H5m6-6-6 6 6 6',
  reply: 'M10 7 4 12l6 5M4 12h9a7 7 0 0 1 7 7',
  send: 'M4 12 20 4l-4 16-4-7Zm8 1 8-9',
  pen: 'M4 20h4L19 9l-4-4L4 16Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4',
  close: 'M6 6l12 12M18 6 6 18',
  minimise: 'M5 18h14',
  group: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.3c2 .8 3 2.8 3 5.7',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  download: 'M12 4v11m-5-5 5 5 5-5M5 20h14',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8c0-3.9 3.1-7 7-7s7 3.1 7 7',
  shield: 'M12 3 5 6v5.5c0 4.3 3 8 7 9.5 4-1.5 7-5.2 7-9.5V6Z',
  bell: 'M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15ZM10 21h4',
  expand: 'M8 10l4 4 4-4',
  bold: 'M7 5h6a3.5 3.5 0 0 1 0 7H7Zm0 7h7a3.5 3.5 0 0 1 0 7H7Z',
  italic: 'M10 5h8M6 19h8M14 5l-4 14',
  underline: 'M7 4v7a5 5 0 0 0 10 0V4M5 20h14',
  bullets: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  numbers: 'M10 6h10M10 12h10M10 18h10M4 4.5l1.5-.8V9M3.6 14a1.3 1.3 0 1 1 2 1.4L3.5 18h3',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  clear: 'M7 5h11M13 5l-3 14M4 4l16 16',
  archive: 'M4 5h16v4H4ZM5 9v10h14V9M10 13h4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v4.5l3 2',
  mute: 'M6 17v-6a6 6 0 0 1 9.5-4.9M18 11v6l1.5 2H9M10 21h4M3 3l18 18',
  block: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
  forward: 'M14 7l6 5-6 5M20 12h-9a7 7 0 0 0-7 7',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01',
  filter: 'M4 7h9m4 0h3M4 17h3m4 0h9M15 5v4M9 15v4',
  down: 'm6 9 6 6 6-6',
  left: 'm15 6-6 6 6 6',
  right: 'm9 6 6 6-6 6',
  keyboard: 'M3 6h18v12H3ZM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  read: 'M4 10l8-5 8 5v9H4ZM4 10l8 5 8-5',
  allmail: 'M4 9h16v10H4ZM6 6h12M8 3h8',
  scheduled: 'M4 12 20 4l-4 16-4-7ZM12 13l8-9',
};

export function Icon({ name, size = 20, filled = false, className = '' }: { name: keyof typeof PATHS | string; size?: number; filled?: boolean; className?: string }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name] || ''} />
    </svg>
  );
}
