FROM docker.io/oven/bun:1

WORKDIR /app

# git-snapshot.ts shells out to `git` to auto-commit data/blocks and
# data/wiring on every write (see coordinator's git-snapshot.ts) — the base
# image has no git binary, so without this the coordinator degrades
# silently to "snapshotting disabled" in every deployed container.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better layer caching across data/source edits).
COPY package.json bun.lock ./
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/coordinator/package.json packages/coordinator/package.json
COPY packages/flow-host/package.json packages/flow-host/package.json
COPY packages/editor/package.json packages/editor/package.json
RUN bun install --frozen-lockfile

# Now the rest of the source. data/ is deliberately NOT baked into the image
# (see .dockerignore) — it's bind-mounted at `docker run` time, same as the
# design doc's "plaintext on disk, bind-mounted into the container" intent,
# so wiring/blocks stay editable and persistent across image rebuilds.
COPY . .

# Coordinator's websocket control API and the editor's HTTP/dev server.
EXPOSE 8787 4200

# Safe-by-default: real HA writes require an explicit override, never baked
# into the image. HASS_BASE_URL/HASS_TOKEN are supplied at `docker run` time
# via --env-file, never copied into a layer.
ENV FLOWBUN_DRY_RUN=true
ENV FLOWBUN_DATA_DIR=/app/data
ENV FLOWBUN_WS_PORT=8787
ENV FLOWBUN_EDITOR_PORT=4200

ENTRYPOINT ["bun", "run", "docker-entrypoint.ts"]
