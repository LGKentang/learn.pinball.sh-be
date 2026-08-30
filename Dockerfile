FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
# Migrations are TypeScript now, so there is nothing to copy alongside dist/.
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

ENV HOST=0.0.0.0
ENV PORT=8787
# Only used when PINBALL_STORAGE=local; with s3 nothing is written to this volume.
ENV PINBALL_UPLOADS=/app/data/uploads

EXPOSE 8787
VOLUME ["/app/data"]

# Migrations run at boot, guarded by a Postgres advisory lock so several replicas
# starting at once is safe.
CMD ["node", "dist/server.js"]
