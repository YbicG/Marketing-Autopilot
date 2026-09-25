# Worker + migrate image: Debian (glibc) because Playwright Chromium and Remotion need it.
FROM node:24-bookworm-slim
# postgresql-client-18 from the PGDG repo so pg_dump/pg_restore match the postgres:18 server (bookworm ships 15).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-color-emoji postgresql-client-18 \
  && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# Chromium and its system libraries, in a shared path the non-root user can read.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm --filter @mkt/worker exec playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*
# Remotion's Chrome Headless Shell (same system libraries), baked in so renders never download.
RUN pnpm --filter @mkt/worker ensure-browser
RUN groupadd --system --gid 1001 mkt && useradd --system --uid 1001 --gid mkt --create-home mkt \
  && mkdir -p /data && chown -R mkt:mkt /data
USER mkt
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@mkt/worker", "start"]
