# Open Coding Partner dashboard.
# The process listens on all container interfaces only because OCP_DOCKER_BIND=bridge
# is set. Compose publishes that port on 127.0.0.1. Do not publish 0.0.0.0.

FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm exec tsc -b

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    OCP_DATA_DIR=/data \
    OCP_DOCKER_BIND=bridge \
    OCP_WORKSPACE=/workspace
RUN mkdir -p /data /workspace
COPY --from=build /src /app
EXPOSE 4317
VOLUME ["/data", "/workspace"]
CMD ["node", "packages/cli/dist/main.js", "app", "--host", "0.0.0.0", "--port", "4317"]
