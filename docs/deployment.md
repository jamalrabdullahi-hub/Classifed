# Deployment

Target: a single Linux host running Node, PostgreSQL, and nginx as a TLS
terminator. Three services — the consumer app, the admin app, and the worker.

## Why this shape

The two applications deploy separately because they have different audiences
and different risk. Putting the admin panel on its own hostname is what makes it
possible to restrict it at the network layer without touching application code,
and that restriction is the single highest-value control on the deployment: the
panel can suspend accounts and disable trading, and it has no legitimate user on
the open internet.

## Host setup

```bash
sudo adduser --system --group --home /opt/flt-exchange flt
sudo apt install -y postgresql nginx
```

Node 20.11 or later, and pnpm 12.

## Database

```bash
sudo -u postgres createuser flt --pwprompt
sudo -u postgres createdb flt_exchange --owner flt
```

The application user needs no superuser rights. Migrations run as the same
user, so it needs `CREATE` on its own database and nothing more.

## Application

```bash
sudo -u flt git clone <repo> /opt/flt-exchange
cd /opt/flt-exchange
sudo -u flt pnpm install --frozen-lockfile
sudo -u flt cp .env.example .env      # then fill it in
sudo -u flt pnpm db:deploy            # migrate, never `migrate dev`
sudo -u flt pnpm db:seed              # first deploy only
sudo -u flt pnpm build
```

`.env` must be readable only by the `flt` user:

```bash
sudo chmod 600 /opt/flt-exchange/.env
sudo chown flt:flt /opt/flt-exchange/.env
```

### Secrets

Generate real ones. The environment schema refuses to start in production with
placeholder values, mock providers, or a `console` mail adapter.

```bash
openssl rand -base64 48   # APP_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY
```

`ENCRYPTION_KEY` protects MFA secrets at rest. Losing it means every user has to
re-enrol their second factor; rotating it without re-encrypting means the same.
Back it up separately from the database — storing them together defeats the
point of encrypting at rest.

## Services

```bash
sudo cp deploy/flt-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now flt-web flt-admin flt-worker
```

The units run with `ProtectSystem=strict` and no write access outside their own
cache directories. The worker handles `SIGTERM` and finishes its in-flight pass,
so `TimeoutStopSec` is set generously rather than killing a transaction
mid-transition.

```bash
journalctl -u flt-worker -f
```

## Reverse proxy

`deploy/nginx.conf` is a starting point. Two things in it are load-bearing:

**`X-Forwarded-For` must be set by the proxy, not passed through.** The
application reads the client IP from that header and keys rate limits on it. If
nginx forwards a client-supplied value, every IP-based limit — including the
login brute-force limit — can be evaded by sending the header.

**The admin `allow`/`deny` block.** Commented out in the sample because the
right range is site-specific. Uncomment it.

## Verifying a deployment

```bash
pnpm verify:tokens     # every seeded token matches the chain
curl -sS https://app.fltexchange.example/api/tokens | head
```

Then sign in to the admin panel and open **System health**. It checks the
database, the DEX router and the market data provider live on page load rather
than reporting a cached status, and it flags the worker as degraded if expired
quotes are going unswept — which is the clearest signal the worker is not
running.

## Backups

`pg_dump` on a schedule, stored off-host. The database holds the audit trail and
the compliance record; it does not hold customer assets, because FLT never has
them. That materially changes what a restore has to achieve: a lost database is
a lost record, not lost money, and balances re-read from the chain on the next
page load.

## Upgrades

```bash
sudo -u flt git pull
sudo -u flt pnpm install --frozen-lockfile
sudo -u flt pnpm db:deploy
sudo -u flt pnpm build
sudo systemctl restart flt-web flt-admin flt-worker
```

Migrations are applied before the restart so the new schema is in place when the
new code starts. Migrations in this project are additive; a destructive one
would need a maintenance window and is not something to run behind a `git pull`.

## What is deliberately absent

No key management, no custody infrastructure, no signing service, no hot wallet.
There is nothing to secure in that category because the system has no keys —
which is the whole point of the architecture. See `docs/adr/0001`.
