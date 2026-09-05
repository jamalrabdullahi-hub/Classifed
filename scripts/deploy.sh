#!/usr/bin/env bash
#
# Pull, migrate, build, restart. Run after pushing to main.
#
#   bash /opt/fltcrypto/scripts/deploy.sh
#   ssh root@server 'bash /opt/fltcrypto/scripts/deploy.sh'
#
# Deliberately refuses to restart into a failed build: `next build` overwrites
# .next in place, so a build that dies halfway leaves a broken tree. Better to
# keep serving the previous version and report the failure.
#
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/fltcrypto}

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nFATAL: %s\n' "$*" >&2; exit 1; }

[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git clone — run scripts/server-setup.sh first"
[ -f "$APP_DIR/.env" ] || die "$APP_DIR/.env is missing — run scripts/server-setup.sh first"

cd "$APP_DIR"

before=$(git rev-parse --short HEAD)
log "at ${before}, fetching"
git pull --ff-only origin main
after=$(git rev-parse --short HEAD)

if [ "$before" = "$after" ]; then
  log "already up to date at ${after}"
else
  log "${before} -> ${after}"
  git --no-pager log --oneline "${before}..${after}"
fi

log "dependencies"
npm ci

log "migrations"
npx prisma migrate deploy

log "build"
npm run build

log "restart"
systemctl restart fltcrypto

log "health"
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null http://127.0.0.1:3000/login; then
    # The login page renders without touching the database. Confirm the data
    # tier separately — a 500 here is the difference between "the web server
    # started" and "the application works".
    code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/assets)
    if [ "$code" = "200" ]; then
      log "OK — serving ${after}, database reachable"
      exit 0
    fi
    die "app is up but the database is not: /api/assets returned ${code}
$(journalctl -u fltcrypto -n 30 --no-pager)"
  fi
  sleep 2
done

die "not responding after restart
$(journalctl -u fltcrypto -n 40 --no-pager)"
