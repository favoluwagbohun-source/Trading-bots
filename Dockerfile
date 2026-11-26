FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig*.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci && npm run build

EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
ENV SERVE_WEB_ASSETS=true
ENV WATCHLIST_SYMBOLS="BTCUSDT,ETHUSDT,SOLUSDT"
ENV SCAN_INTERVAL_MS="30000"
ENV PAPER_FEE_RATE_PER_SIDE="0.001"
ENV PAPER_SLIPPAGE_RATE_PER_SIDE="0.001"
ENV HEARTBEAT_ENABLED="true"

CMD ["node", "apps/worker/dist/render-entrypoint.js"]
