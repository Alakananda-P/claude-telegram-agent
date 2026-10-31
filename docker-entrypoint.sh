#!/bin/sh
set -eu
umask 077

# Fixed, explicitly scoped mount. Never chown recursively or follow symlinks.
if [ "${DATA_DIR:-/data}" != /data ]; then
  echo 'Container DATA_DIR must be /data.' >&2
  exit 1
fi
for target in /data /data/home /data/claude /data/bot /data/workspaces /data/venv /data/memory; do
  if [ -L "$target" ]; then
    echo 'Refusing symlink at a runtime data directory.' >&2
    exit 1
  fi
  mkdir -p "$target"
  if [ "$(id -u)" = 0 ]; then
    chown node:node "$target"
    chmod 700 "$target"
  fi
done
if [ "$(id -u)" = 0 ]; then
  if [ ! -x /data/venv/bin/python ]; then
    gosu node python3 -m venv /data/venv
  fi
  exec gosu node "$@"
fi
if [ ! -x /data/venv/bin/python ]; then
  python3 -m venv /data/venv
fi
exec "$@"
