FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# The lockfile pins every package version: npm ci installs exactly those, or fails.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
RUN mkdir -p /data/avatars && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.js"]
