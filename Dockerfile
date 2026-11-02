FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git ripgrep python3 python3-venv python3-pip \
    build-essential gosu tini unzip ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/telegram-agent-entrypoint
RUN chmod 755 /usr/local/bin/telegram-agent-entrypoint && mkdir -p /data
ENV NODE_ENV=production DATA_DIR=/data HOME=/data/home \
    VIRTUAL_ENV=/data/venv \
    PATH=/data/venv/bin:/data/home/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Root is used only for mounted-volume ownership, then entrypoint drops to node.
ENTRYPOINT ["/usr/local/bin/telegram-agent-entrypoint"]
CMD ["node", "dist/main.js"]
