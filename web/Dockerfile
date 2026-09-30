# The web client and /register/ portal: built with Node, served by nginx, which also passes /api/ and
# /twilio/ to the api container. The optional VITE_BRAND_* build arguments rename or recolour it.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG VITE_BRAND_NAME VITE_MAIL_DOMAIN VITE_BRAND_COLOR VITE_BRAND_COLOR_DARK VITE_BRAND_LOGO VITE_LEGACY_DOMAINS
RUN npm run build

FROM nginx:1.27-alpine
# The api the pages talk to (host:port).
ENV API_UPSTREAM=api:3000
COPY docker-nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /srv/web
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1/index.html >/dev/null || exit 1
