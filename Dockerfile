FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN AXIOM_API_AUTH_REQUIRED=false npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl \
  && install -d -m 0755 /usr/share/postgresql-common/pgdg \
  && curl --fail --silent --show-error --location \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    --output /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install --yes --no-install-recommends postgresql-client-16 \
  && apt-get purge --yes --auto-remove curl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 axiom \
  && useradd --system --uid 10001 --gid axiom --home-dir /app axiom
COPY --from=builder --chown=axiom:axiom /app/node_modules ./node_modules
COPY --from=builder --chown=axiom:axiom /app/.next ./.next
COPY --from=builder --chown=axiom:axiom /app/public ./public
COPY --from=builder --chown=axiom:axiom /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=axiom:axiom /app/next.config.mjs /app/drizzle.config.ts ./
COPY --from=builder --chown=axiom:axiom /app/config ./config
COPY --from=builder --chown=axiom:axiom /app/drizzle ./drizzle
COPY --from=builder --chown=axiom:axiom /app/lib ./lib
COPY --from=builder --chown=axiom:axiom /app/scripts ./scripts
COPY --from=builder --chown=axiom:axiom /app/worker ./worker
COPY --chown=axiom:axiom deploy/container-entrypoint.sh /usr/local/bin/axiom-entrypoint
RUN chmod 0555 /usr/local/bin/axiom-entrypoint
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/axiom-entrypoint"]
CMD ["web"]
