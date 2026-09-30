import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// In production nginx serves the built files and proxies /api/ to the api. `npm run dev` does the same
// against a local api (API_TARGET, default http://127.0.0.1:3000).
const target = process.env.API_TARGET || 'http://127.0.0.1:3000'

// White-label: the page title, theme colour and the installable-app manifest follow the VITE_BRAND_* settings
// (see src/brand.ts and .env.example). The manifest lets phones "Add to Home screen" and open it like an app.
function brandPlugin(mode: string): Plugin {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...loadEnv(mode, '..', 'VITE_') }
  const name = env.VITE_BRAND_NAME || 'PhoneMail'
  const color = env.VITE_BRAND_COLOR || '#4B3FB0'
  const domain = env.VITE_MAIL_DOMAIN || 'phonemail.net'
  return {
    name: 'brand',
    transformIndexHtml: (html) =>
      html.replaceAll('__BRAND_NAME__', name).replaceAll('__BRAND_COLOR__', color).replaceAll('__MAIL_DOMAIN__', domain),
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify({
          name,
          short_name: name,
          description: `Email where your phone number is your address (@${domain}).`,
          start_url: '/',
          scope: '/',
          display: 'standalone',
          background_color: '#F7F5F0',
          theme_color: color,
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
          ],
        }, null, 2),
      })
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), brandPlugin(mode)],
  envDir: '..', // the project's .env (next to docker-compose.yml) holds the VITE_BRAND_* settings too
  server: {
    proxy: {
      // Our api serves /api/... itself (no prefix to strip); /api/events is a live stream.
      '/api': { target, changeOrigin: true },
    },
  },
}))
