FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && cp src/db/schema.sql dist/db/schema.sql

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

ENV HOST=0.0.0.0
ENV PORT=8787
ENV PINBALL_DB=/app/data/pinball.db
ENV PINBALL_UPLOADS=/app/data/uploads

EXPOSE 8787
VOLUME ["/app/data"]

CMD ["node", "dist/server.js"]
