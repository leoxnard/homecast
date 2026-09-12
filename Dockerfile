# syntax=docker/dockerfile:1

# --- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so the dependency layer survives source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# --- runtime ----------------------------------------------------------------
# Node >= 22.18 strips TypeScript types natively, so the server needs no build
# step and the runtime image installs nothing at all.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0

COPY --from=build /app/dist ./dist
COPY server ./server

# Drop privileges: the image ships with an unprivileged `node` user.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.ts"]
