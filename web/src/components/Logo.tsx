import { brand } from '../brand';

// The product mark: the brand's own image when VITE_BRAND_LOGO is set, otherwise the built-in
// mark (Pip the carrier pigeon, in silhouette), followed by the name.
export function Logo({ compact = false, hideName = false }: { compact?: boolean; hideName?: boolean }) {
  const size = compact ? 30 : 40;
  return (
    <span className={compact ? 'logo logo-compact' : 'logo'}>
      {brand.logo ? (
        <img src={brand.logo} width={size} height={size} alt="" aria-hidden="true" />
      ) : (
        <LogoMark size={size} />
      )}
      {hideName ? null : <span className="logo-text">{brand.name}</span>}
    </span>
  );
}

export function LogoMark({ size = 40 }: { size?: number }) {
  // Pip, the carrier-pigeon mascot, in silhouette, with a letter in its beak. The same drawing as
  // public/favicon.svg and the app icons (web/e2e/make-icons.mjs), in the theme's colours.
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className="logo-mark">
      <rect width="64" height="64" rx="15" fill="var(--brand)" />
      <g transform="translate(32 32) scale(1.08) translate(-32.8 -32.4)">
        <path fill="#fff" d="M40.5 13.5C46.5 13.2 50.6 17.4 50.9 22.6L56.8 25.2L50.6 27.3C51.4 34.8 47 41.8 38.6 44.4C32 46.4 24.8 45.6 19.4 42.6L8.6 47.6L12.4 40.8L6.8 36.4L18.6 35.6C21.6 29.6 27.4 26.4 31.4 25.4C31.2 18.8 34.6 13.8 40.5 13.5Z" />
        <path fill="#C9C3F7" d="M20.8 36.2C26.6 30.2 36.4 29.6 43.2 33.2C38.2 39.8 29 41.6 20.8 36.2Z" />
        <circle cx="44.2" cy="20.4" r="2" fill="var(--brand)" />
        <path d="M31.5 45.2L30.4 51.2M37.8 44.9L38.4 51.2" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" />
        <g transform="rotate(-8 52 34)">
          <rect x="45.6" y="28.8" width="13.4" height="9.6" rx="1.6" fill="var(--accent)" />
          <path d="M46.4 29.8L52.3 34.2L58.2 29.8" fill="none" stroke="var(--brand)" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
        </g>
      </g>
    </svg>
  );
}
