FROM node:24-alpine

WORKDIR /app
RUN corepack enable

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY config ./config
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/fixtures/package.json packages/fixtures/package.json
# --filter invex pulls in the workspace root so tsx (root devDependency, used in CMD) is installed
RUN pnpm install --frozen-lockfile --filter invex --filter @invex/server... --filter @invex/core

COPY packages/core packages/core
COPY packages/server packages/server

ENV NODE_ENV=production
EXPOSE 8080
# Run tsx directly — via pnpm, corepack would re-fetch pnpm at runtime under non-root UID + read-only rootfs
CMD ["node_modules/.bin/tsx", "packages/server/src/main.ts"]
