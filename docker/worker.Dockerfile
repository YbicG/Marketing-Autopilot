# Worker + migrate image: Debian (glibc) because Playwright Chromium and Remotion need it.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# Chromium and its system libraries, in a shared path the non-root user can read.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm --filter @mkt/worker exec playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 1001 mkt && useradd --system --uid 1001 --gid mkt --create-home mkt \
  && mkdir -p /data && chown -R mkt:mkt /data
USER mkt
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@mkt/worker", "start"]
