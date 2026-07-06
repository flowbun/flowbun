#!/usr/bin/env bash
# S6 spike driver: runs fs.watch and mtime-polling tests against a bind-mounted
# directory inside a Podman container, driving host-side file operations while
# the container watches, and capturing container logs for later inspection.
set -uo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SPIKE_DIR"

WATCH_DIR="$SPIKE_DIR/watched-dir"
SCRIPTS_DIR="$SPIKE_DIR/scripts"
IMAGE="docker.io/oven/bun:latest"
DURATION_MS=8000
RUNTIME="${RUNTIME:-podman}" # override with RUNTIME=docker for comparison

reset_watch_dir() {
  rm -rf "$WATCH_DIR"
  mkdir -p "$WATCH_DIR"
  echo "hello from host, starter file 1" > "$WATCH_DIR/file1.txt"
  echo "hello from host, starter file 2" > "$WATCH_DIR/file2.txt"
}

run_test() {
  local script_name="$1"
  local label="$2"
  local container_name="s6-${label}-$$"

  echo "=================================================="
  echo "=== Running $label test ($script_name) via $RUNTIME ==="
  echo "=================================================="
  reset_watch_dir

  "$RUNTIME" run -d \
    --name "$container_name" \
    -v "$WATCH_DIR:/data:Z" \
    -v "$SCRIPTS_DIR:/scripts:Z,ro" \
    -e WATCH_DURATION_MS="$DURATION_MS" \
    "$IMAGE" bun run "/scripts/$script_name" >/dev/null

  echo "[driver] container '$container_name' started, waiting 1.5s for watcher init..."
  sleep 1.5

  echo "[driver] host op: create newfile.txt"
  echo "created by host at $(date -Iseconds)" > "$WATCH_DIR/newfile.txt"
  sleep 0.3

  echo "[driver] host op: modify file1.txt (append)"
  echo "appended by host at $(date -Iseconds)" >> "$WATCH_DIR/file1.txt"
  sleep 0.3

  echo "[driver] host op: rename file2.txt -> file2-renamed.txt"
  mv "$WATCH_DIR/file2.txt" "$WATCH_DIR/file2-renamed.txt"
  sleep 0.3

  echo "[driver] host op: delete newfile.txt"
  rm "$WATCH_DIR/newfile.txt"

  echo "[driver] waiting ~3s for events to propagate..."
  sleep 3

  echo "[driver] checking reverse direction (container -> host write visibility)..."
  if [ -f "$WATCH_DIR/container-wrote-this.txt" ]; then
    echo "[driver] REVERSE CHECK OK: $(cat "$WATCH_DIR/container-wrote-this.txt")"
  else
    echo "[driver] REVERSE CHECK: container-wrote-this.txt NOT YET visible on host"
  fi

  echo "[driver] waiting for container to finish (duration=${DURATION_MS}ms)..."
  "$RUNTIME" wait "$container_name" >/dev/null 2>&1

  echo "--- container stdout logs for $label ---"
  "$RUNTIME" logs "$container_name" 2>&1
  echo "--- end container logs ---"

  "$RUNTIME" rm "$container_name" >/dev/null 2>&1

  echo "--- on-disk log file for $label (watched-dir) ---"
  if [ -f "$WATCH_DIR/fswatch-log.txt" ]; then
    cat "$WATCH_DIR/fswatch-log.txt"
  fi
  if [ -f "$WATCH_DIR/poll-log.txt" ]; then
    cat "$WATCH_DIR/poll-log.txt"
  fi
  echo "--- end on-disk log ---"
  echo
}

run_test "watcher.ts" "fswatch"
run_test "poll-watcher.ts" "poll"

echo "Done."
