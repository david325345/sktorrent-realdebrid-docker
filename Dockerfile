FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./
COPY lib ./lib
COPY public ./public

# Trvalé úložiště (Coolify Volume Mount → /app/data): anonymní archiv hledání v /app/data/hledani
RUN mkdir -p /app/data/hledani && chown -R node:node /app/data
VOLUME /app/data

USER node
EXPOSE 3009

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3009}/health" >/dev/null || exit 1

CMD ["node", "index.js"]
