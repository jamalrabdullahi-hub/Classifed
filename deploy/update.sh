#!/usr/bin/env bash
#
# One deploy pass: pull, install, generate, build, migrate, restart.
#
# Written because the sequence was being run by hand from a chat window, a
# step at a time, and the failure mode was always the same — a step quietly
# skipped, then an hour spent wondering why a new page or a new script was
# "missing" when it had simply never been deployed.
#
# Two rules this enforces that were easy to forget by hand:
#
#   1. Every repo command runs as `flt`, never root. Running pnpm as root in
#      /opt/flt-exchange leaves root-owned files in node_modules and the git
#      objects directory, and the next deploy fails with a permission error
#      that looks nothing like its cause.
#
#   2. Prisma sees the environment. The CLI looks for .env next to
#      schema.prisma, not at the repo root where FLT's actually lives, so
#      migrations are run with the root .env sourced explicitly.
#
# Run as root (it restarts services):
#   bash deploy/update.sh
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/flt-exchange}
APP_USER=${APP_USER:-flt}
SERVICES=${SERVICES:-"flt-web flt-admin flt-worker"}

if [[ $EUID -ne 0 ]]; then
  echo "Run as root — this restarts systemd services." >&2
  exit 1
fi

as_app() { sudo -u "$APP_USER" "$@"; }

# Sourced for the Prisma CLI, which cannot find the repo-root .env on its own.
as_app_with_env() {
  sudo -u "$APP_USER" bash -c "set -a; source '$APP_DIR/.env'; set +a; cd '$APP_DIR' && $*"
}

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

cd "$APP_DIR"

step "Pulling"
as_app git pull origin main

step "Installing dependencies"
as_app pnpm install --frozen-lockfile

step "Generating the Prisma client"
as_app pnpm --filter @flt/db exec prisma generate

step "Building"
as_app pnpm build

step "Applying migrations"
# A migration that failed on an earlier run blocks every later one until it is
# resolved. Say so plainly rather than letting the operator read a stack trace:
# the fix is `prisma migrate resolve`, and which flag depends on whether the
# failed migration left anything behind.
if ! as_app_with_env "pnpm --filter @flt/db exec prisma migrate deploy"; then
  cat >&2 <<'MSG'

Migrations failed.

If the error mentions a migration that "failed to apply" on a previous run,
Prisma will refuse everything after it until that record is cleared:

  sudo -u flt bash -c 'set -a; source /opt/flt-exchange/.env; set +a; \
    cd /opt/flt-exchange && pnpm --filter @flt/db exec prisma migrate resolve \
    --rolled-back <migration_name>'

Use --rolled-back when the failed migration ran in a transaction and left
nothing behind (the usual case). Use --applied only when you have checked the
schema and its changes are genuinely already present.

Nothing has been restarted; the running services are still on the old build.
MSG
  exit 1
fi

# Keep the installed units in step with the repo. Without this, a change to
# the auto-deploy unit can only be picked up by hand -- and if that change is
# the fix for a broken auto-deploy, it can never be picked up at all.
if systemctl list-unit-files flt-autodeploy.timer >/dev/null 2>&1   && [[ -f /etc/systemd/system/flt-autodeploy.timer ]]; then
  if ! cmp -s "$APP_DIR/deploy/flt-autodeploy.service" /etc/systemd/system/flt-autodeploy.service     || ! cmp -s "$APP_DIR/deploy/flt-autodeploy.timer" /etc/systemd/system/flt-autodeploy.timer; then
    step "Refreshing the auto-deploy units"
    install -m 0644 "$APP_DIR/deploy/flt-autodeploy.service" /etc/systemd/system/
    install -m 0644 "$APP_DIR/deploy/flt-autodeploy.timer" /etc/systemd/system/
    systemctl daemon-reload
    systemctl restart flt-autodeploy.timer
  fi
fi

step "Restarting"
# shellcheck disable=SC2086
systemctl restart $SERVICES

step "Done"
printf 'Deployed %s\n' "$(as_app git rev-parse --short HEAD)"
# shellcheck disable=SC2086
systemctl --no-pager --lines=0 status $SERVICES | grep -E 'flt-|Active:' || true
