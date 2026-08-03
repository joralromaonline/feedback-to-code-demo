FROM node:24-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /app
ENV CI=true

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/sdk/package.json packages/sdk/package.json
COPY demo-app/package.json demo-app/package.json
RUN pnpm install --frozen-lockfile

COPY . .

FROM base AS runtime
ENV NODE_ENV=development
EXPOSE 3000 3001
CMD ["pnpm", "dev"]

FROM base AS verify
RUN pnpm typecheck && pnpm test
CMD ["pnpm", "test:e2e"]
