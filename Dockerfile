# Yamlet: a local-first API client served in your browser.
#   docker run -d --name yamlet -p 127.0.0.1:7878:7878 -v "$PWD:/workspace" -v yamlet-data:/data ghcr.io/piyushdoorwar/yamlet
# Keep the named /data volume when recreating the container: it holds the extension pairing.
# then open http://localhost:7878

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
ARG APP_VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/piyushdoorwar/yamlet" \
      org.opencontainers.image.title="Yamlet" \
      org.opencontainers.image.description="Local-first API client for Git-friendly YAML collections, in your browser" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7878 \
    APP_VERSION=${APP_VERSION} \
    YAMLET_IN_CONTAINER=1 \
    YAMLET_WORKSPACE=/workspace \
    YAMLET_BROWSE_ROOT=/workspace
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /workspace /data && chown node:node /workspace /data

# Non-root. The node user is uid 1000, which owns the mounted folder on most
# Linux desktops; otherwise pass --user "$(id -u):$(id -g)".
USER node
VOLUME ["/workspace"]
VOLUME ["/data"]
EXPOSE 7878
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:7878/api/health >/dev/null || exit 1
CMD ["node", "dist/server/src/index.js"]
