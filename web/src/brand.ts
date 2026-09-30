// White-label settings. Everything the user sees that names the product comes from here, so the same code can be
// presented under another name, domain and colour. Set them at build time in the project's .env (see .env.example):
//   VITE_BRAND_NAME, VITE_MAIL_DOMAIN, VITE_BRAND_COLOR, VITE_BRAND_COLOR_DARK, VITE_BRAND_LOGO, VITE_LEGACY_DOMAINS
const env = import.meta.env;

export const brand = {
  /** Product name shown in titles, the logo and messages. */
  name: env.VITE_BRAND_NAME || 'PhoneMail',
  /** Mail domain: addresses are <10-digit number>@domain. Replaced at start by the server's (/api/auth/config). */
  domain: (env.VITE_MAIL_DOMAIN || 'phonemail.net').toLowerCase(),
  /** Main colour (buttons, links, logo background) and a darker shade for hover. */
  color: env.VITE_BRAND_COLOR || '#4B3FB0', // indigo; marigold accents are in index.css
  colorDark: env.VITE_BRAND_COLOR_DARK || '#3A2F95',
  /** Optional logo image (a path under web/public, e.g. /brand/logo.svg). Empty = the built-in mark in brand.color. */
  logo: env.VITE_BRAND_LOGO || '',
  /** Earlier domains whose 10-digit addresses belong to the same accounts (comma-separated). */
  legacyDomains: (env.VITE_LEGACY_DOMAINS || '').split(',').map((d: string) => d.trim().toLowerCase()).filter(Boolean),
};

/** Applies the brand colours to the page (the CSS uses --brand and --brand-dark). */
export function applyBrandColours() {
  const root = document.documentElement.style;
  root.setProperty('--brand', brand.color);
  root.setProperty('--brand-dark', brand.colorDark);
}
