# The stdio MCP server, with its sign-in page on 8768. See README.md,
# "Hosting one long-lived copy".
FROM docker.io/library/node:22.22.0-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    RISEUP_CONFIG_DIR=/data \
    RISEUP_LOGIN_HOST=0.0.0.0 \
    RISEUP_HEADLESS=false

WORKDIR /app
COPY package.json package-lock.json ./
# Dev dependencies too: the server runs its TypeScript through tsx. The
# sign-in runs in Playwright's Chromium, on RiseUp's own site.
RUN npm ci --include=dev \
 && npx playwright install --with-deps chromium \
 && apt-get update && apt-get install -y --no-install-recommends xvfb xauth \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

COPY src src
COPY tsconfig.json ./

# Any user works; give it a writable /data.
USER 1000:1000
EXPOSE 8768
# The sign-in browser runs with a window, on a virtual screen: Google's
# sign-in refuses headless Chromium.
ENTRYPOINT ["xvfb-run", "-a", "-s", "-screen 0 1280x1024x24", "node", "--import", "tsx", "src/main.ts"]
