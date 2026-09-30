// Pip in silhouette: the PhoneMail logo. "node make-icons.mjs icons ../public" writes favicon.svg and the app icons;
// "node make-icons.mjs preview out.png" shows it at several sizes.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

export const MARK = (bg = '#4B3FB0') => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="15" fill="${bg}"/>
  <g transform="translate(32 32) scale(1.08) translate(-32.8 -32.4)">
  <!-- Pip in silhouette: a carrier pigeon, facing right -->
  <path fill="#FFFFFF" d="
    M40.5 13.5
    C46.5 13.2 50.6 17.4 50.9 22.6
    L56.8 25.2
    L50.6 27.3
    C51.4 34.8 47 41.8 38.6 44.4
    C32 46.4 24.8 45.6 19.4 42.6
    L8.6 47.6
    L12.4 40.8
    L6.8 36.4
    L18.6 35.6
    C21.6 29.6 27.4 26.4 31.4 25.4
    C31.2 18.8 34.6 13.8 40.5 13.5 Z"/>
  <!-- wing -->
  <path fill="#C9C3F7" d="M20.8 36.2 C26.6 30.2 36.4 29.6 43.2 33.2 C38.2 39.8 29 41.6 20.8 36.2 Z"/>
  <!-- eye -->
  <circle cx="44.2" cy="20.4" r="2" fill="${bg}"/>
  <!-- legs -->
  <path d="M31.5 45.2 L30.4 51.2 M37.8 44.9 L38.4 51.2" stroke="#F2A33A" stroke-width="2.2" stroke-linecap="round"/>
  <!-- the letter, in its beak -->
  <g transform="rotate(-8 52 34)">
    <rect x="45.6" y="28.8" width="13.4" height="9.6" rx="1.6" fill="#F2A33A"/>
    <path d="M46.4 29.8 L52.3 34.2 L58.2 29.8" fill="none" stroke="${bg}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
  </g>
  </g>
</svg>`;

const sizes = [256, 128, 64, 32, 16];
const html = `<body style="margin:0;padding:24px;background:#F7F5F0;display:flex;gap:28px;align-items:end;font:13px sans-serif">
${sizes.map((s) => `<div style="text-align:center"><img width="${s}" height="${s}" src="data:image/svg+xml;utf8,${encodeURIComponent(MARK())}"><div>${s}px</div></div>`).join('')}
<div style="text-align:center;background:#15122B;padding:12px;border-radius:8px"><img width="64" src="data:image/svg+xml;utf8,${encodeURIComponent(MARK('#8C82F2'))}"><div style="color:#fff">dark</div></div>
</body>`;
if (process.argv[2] === 'preview') {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 760, height: 330 } });
  await p.setContent(html);
  await p.screenshot({ path: process.argv[3] });
  await b.close();
}
writeFileSync(new URL('./logo-mark.svg', import.meta.url), MARK().trim() + '\n');

// The icon files: favicon (vector), PNGs for phones, and a maskable one (full-bleed, bird smaller).
if (process.argv[2] === 'icons') {
  const out = process.argv[3];
  writeFileSync(`${out}/favicon.svg`, MARK().trim() + '\n');
  const b = await chromium.launch();
  const p = await b.newPage();
  const render = async (size, svg, file) => {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="data:image/svg+xml;utf8,${encodeURIComponent(svg)}"></body>`);
    await p.screenshot({ path: `${out}/icons/${file}`, omitBackground: true });
  };
  for (const [size, file] of [[180, 'icon-180.png'], [192, 'icon-192.png'], [512, 'icon-512.png']]) await render(size, MARK(), file);
  const maskable = MARK().replace('rx="15"', 'rx="0"').replace('scale(1.08)', 'scale(0.82)');
  await render(512, maskable, 'icon-512-maskable.png');
  await b.close();
}
