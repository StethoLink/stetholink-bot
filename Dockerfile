# Production image. Runs on any Linux host with Docker and a PostgreSQL 15+ database; nothing here
# depends on a particular cloud. See docs/go-live.md.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The build needs no secret and no network: fonts and styles are in the repository.
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY package.json package-lock.json ./
# Runtime dependencies only: no compiler, test runner or linter in the image.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/apps/embedded-app/.next ./apps/embedded-app/.next
COPY --from=build /app/apps/embedded-app/next.config.mjs ./apps/embedded-app/next.config.mjs
# Migrations and the retention job travel with the image so the operator runs the matching version.
COPY supabase/migrations ./supabase/migrations
COPY scripts/retention.mjs scripts/migrate.mjs ./scripts/
RUN chown -R node:node /app/apps/embedded-app/.next
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start", "apps/embedded-app", "--hostname", "0.0.0.0"]
