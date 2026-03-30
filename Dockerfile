FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    python3-minimal \
    ca-certificates \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY fixtures ./fixtures
COPY README.md TASKER.md ./
COPY tasker ./tasker

COPY docker/entrypoint.sh /usr/local/bin/gettransfer-entrypoint.sh
RUN chmod +x /usr/local/bin/gettransfer-entrypoint.sh

RUN mkdir -p /data/capture

WORKDIR /data

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/gettransfer-entrypoint.sh"]
CMD ["dashboard"]
