FROM node:22.23.3-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY index.html vite.config.* ./
COPY src ./src
COPY public ./public
COPY shared ./shared
RUN npm run build

FROM node:22.23.3-bookworm-slim AS runtime
# glibc-based Bookworm supports the native canvas binding used by PDF rendering.
# OCR language data/cache and temporary PDF files live on the writable /tmp mount.
# DEBIAN_MIRROR keeps restricted-network builds working: IPv4 is forced because dual-stack
# hosts commonly resolve Debian's Fastly CDN to a black-holed IPv6 address and hang here.
ARG DEBIAN_MIRROR=deb.debian.org
RUN printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99force-ipv4 \
    && for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
         [ -f "$f" ] && sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" "$f" || true; \
       done \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    # Pre-create the metrics sink owned by the runtime user: a named volume mounted here
    # inherits this ownership, so metrics survive restarts without running as root.
    && mkdir -p /var/lib/daylight-metrics && chown -R node:node /var/lib/daylight-metrics
WORKDIR /app
ENV NODE_ENV=production DAYLIGHT_RUNTIME=production HOST=0.0.0.0 PORT=3000 \
    DAYLIGHT_DATA_DIR=/tmp/daylight-data TZ=Asia/Shanghai
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
USER node
EXPOSE 3000 3001
STOPSIGNAL SIGTERM
CMD ["node", "server/index.js", "--production"]
