#!/usr/bin/env bash
# A non-zero exit makes bb delete the new worktree, so failures only warn.

if ! command -v bun >/dev/null 2>&1; then
  echo "bb-env-setup: bun not found on PATH, skipped dependency install"
  exit 0
fi

for pkg in plugins/*/package.json; do
  [ -f "$pkg" ] || continue
  dir=$(dirname "$pkg")
  echo "bb-env-setup: bun install in $dir"
  if ! (cd "$dir" && bun install --frozen-lockfile); then
    echo "bb-env-setup: WARNING bun install failed in $dir, run it by hand"
  fi
done

exit 0
