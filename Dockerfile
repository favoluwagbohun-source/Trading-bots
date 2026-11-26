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
ENV SERVE_WEB_ASSETS=true

CMD ["node", "apps/api/dist/main.js"]
