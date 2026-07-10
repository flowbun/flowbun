#!/usr/bin/env bash
set -euo pipefail

# One-time login for flowbun's embedded Claude Code agent (see
# packages/coordinator/src/agent/). Runs `claude setup-token` *inside* the
# running container to mint a long-lived OAuth token tied to your Claude
# subscription (Pro/Max/Team/Enterprise) — this needs a real browser to
# complete, so it can't be scripted end-to-end. `setup-token` doesn't write
# a credentials file in this non-interactive container context; it prints
# the token once for you to store yourself. This script gets you to that
# point and tells you what to do with it.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE_SERVICE="flowbun"
CLAUDE_BIN="./packages/coordinator/node_modules/.bin/claude"
ENV_FILE=".env"

if ! docker compose ps --status running --services 2>/dev/null | grep -qx "$COMPOSE_SERVICE"; then
  echo "The '$COMPOSE_SERVICE' service isn't running yet — starting it with 'docker compose up -d'..."
  docker compose up -d
fi

echo "Starting the Claude login flow inside the container."
echo "This will print a URL — open it in a browser and follow the prompts."
echo "It ends by printing a long-lived OAuth token. Copy it when it appears."
echo "(Ctrl-C to abort.)"
echo

docker compose exec "$COMPOSE_SERVICE" "$CLAUDE_BIN" setup-token

echo
echo "Add the token you just copied to $ENV_FILE as:"
echo "  CLAUDE_CODE_OAUTH_TOKEN=<paste the token here>"
echo
echo "docker-compose.yml already loads $ENV_FILE (env_file), so the running"
echo "container just needs a restart to pick it up:"
echo "  docker compose up -d"
echo
echo "It's never committed to data/'s own git history (data/.gitignore excludes"
echo "agent/), and $ENV_FILE itself is git-ignored at the repo root."
