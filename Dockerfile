FROM oven/bun:1.4.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
# tsconfig é lido pelo Bun em runtime (decorators + emitDecoratorMetadata).
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=2s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/health/live >/dev/null || exit 1
CMD ["bun", "src/main.ts"]
