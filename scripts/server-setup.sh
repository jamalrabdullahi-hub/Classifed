#!/usr/bin/env bash
#
# One-time server bootstrap for Ubuntu. Installs PostgreSQL natively (no
# Docker), creates the role and database, writes .env, installs the systemd
# unit, and brings the app up.
#
# Safe to re-run. In particular it will NOT regenerate APP_SECRET or the
# database password once they exist — regenerating those while the database
# already holds the old password is precisely how a working box breaks.
#
#   sudo bash scripts/server-setup.sh
#
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/fltcrypto}
PG_VERSION=${PG_VERSION:-17}
NODE_MAJOR=${NODE_MAJOR:-22}
DB_NAME=fltcrypto
DB_USER=fltcrypto

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nFATAL: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git clone — clone the repo there first"

cd "$APP_DIR"

# --- packages --------------------------------------------------------------

log "installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release openssl >/dev/null

if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  log "installing Node ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
log "node $(node -v), npm $(npm -v)"

if ! command -v psql >/dev/null; then
  log "installing PostgreSQL ${PG_VERSION} from PGDG"
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  apt-get install -y -qq "postgresql-${PG_VERSION}" >/dev/null
fi

systemctl enable --now postgresql
# Ubuntu assigns a free port per cluster, so a pre-existing cluster pushes ours
# off 5432. Never assume the port — ask.
PG_PORT=$(pg_lsclusters -h | awk -v v="$PG_VERSION" '$1==v {print $3; exit}')
[ -n "$PG_PORT" ] || die "no PostgreSQL ${PG_VERSION} cluster found"
log "postgres ${PG_VERSION} listening on port ${PG_PORT}"

# --- swap ------------------------------------------------------------------
# `next build` is the memory peak. On a 4GB box it is routinely OOM-killed.

if [ ! -f /swapfile ] && [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 8000 ]; then
  log "adding 4G swap"
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- database --------------------------------------------------------------

psql_su() { sudo -u postgres psql -p "$PG_PORT" -tAc "$1"; }

if [ "$(psql_su "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'")" = "1" ]; then
  log "role ${DB_USER} already exists"
  ROLE_EXISTED=yes
else
  DB_PASS=$(openssl rand -hex 24)
  log "creating role ${DB_USER}"
  sudo -u postgres psql -p "$PG_PORT" -q \
    -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}'"
  ROLE_EXISTED=no
fi

if [ "$(psql_su "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")" = "1" ]; then
  log "database ${DB_NAME} already exists"
else
  log "creating database ${DB_NAME}"
  sudo -u postgres createdb -p "$PG_PORT" -O "${DB_USER}" "${DB_NAME}"
fi

# --- .env ------------------------------------------------------------------

if [ -f .env ]; then
  log ".env exists — leaving APP_SECRET and DATABASE_URL untouched"
  if [ "$ROLE_EXISTED" = "no" ]; then
    # New role, existing .env: the password in .env is stale by definition.
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:${PG_PORT}/${DB_NAME}|" .env
    log "updated DATABASE_URL for the newly created role"
  fi
else
  log "writing .env"
  cp .env.example .env
  sed -i "s|^APP_SECRET=.*|APP_SECRET=$(openssl rand -base64 48)|" .env
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:${PG_PORT}/${DB_NAME}|" .env
fi
chmod 600 .env

# Fail loudly now rather than with an opaque P1001 later.
log "verifying database connectivity"
DB_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
PGPASSWORD=$(echo "$DB_URL" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|') \
  psql -h localhost -p "$PG_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT 1' >/dev/null \
  || die "cannot connect with the credentials in .env — check DATABASE_URL"
log "database reachable"

# --- application -----------------------------------------------------------

log "installing dependencies"
npm ci

log "running migrations"
npx prisma migrate deploy

USER_COUNT=$(PGPASSWORD=$(echo "$DB_URL" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|') \
  psql -h localhost -p "$PG_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
  'SELECT count(*) FROM users' 2>/dev/null || echo 0)
if [ "$USER_COUNT" = "0" ]; then
  log "seeding (database is empty)"
  npm run db:seed
else
  log "skipping seed (${USER_COUNT} users already present)"
fi

log "building"
npm run build

# --- service ---------------------------------------------------------------

log "installing systemd unit"
install -m 644 deploy/fltcrypto.service /etc/systemd/system/fltcrypto.service
systemctl daemon-reload
systemctl enable --now fltcrypto
systemctl restart fltcrypto

log "waiting for the app"
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null http://127.0.0.1:3000/login; then
    log "UP — http://127.0.0.1:3000"
    printf '\nAdmin login: admin@example.com / Password123!\n'
    printf 'Deploy updates with: bash %s/scripts/deploy.sh\n\n' "$APP_DIR"
    exit 0
  fi
  sleep 2
done

die "app did not come up. Logs:
$(journalctl -u fltcrypto -n 40 --no-pager)"
