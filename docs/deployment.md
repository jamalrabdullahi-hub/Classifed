# Deployment

Ubuntu server, PostgreSQL installed natively, app run by systemd. **No Docker
on the server** — Docker is used for local development only, where a disposable
database is convenient.

## First time

```bash
apt update && apt install -y git
git clone git@github.com:jamalrabdullahi-hub/Classifed.git /opt/fltcrypto
cd /opt/fltcrypto
bash scripts/server-setup.sh
```

The script installs Node and PostgreSQL, creates the role and database, writes
`.env`, runs migrations, seeds if the database is empty, builds, and installs
and starts the systemd unit. It prints the admin login when it finishes.

It is safe to re-run. It will **not** regenerate `APP_SECRET` or the database
password once they exist — rotating the password in `.env` while the database
still holds the old one is the single most common way to break a working box,
and re-running the bootstrap must never do it silently.

## Updating

After pushing to `main`:

```bash
ssh root@<server> 'bash /opt/fltcrypto/scripts/deploy.sh'
```

Pull, `npm ci`, `prisma migrate deploy`, build, restart, health-check. It will
not restart into a failed build, and it checks the *database* as well as the
web tier before reporting success — `/login` renders without touching Postgres,
so a green login page proves very little on its own.

## Migrating off the Docker setup

If the server was previously set up with `docker compose`:

```bash
cd /opt/fltcrypto
docker compose down -v          # discards the containerised database
apt remove -y docker.io docker-compose-v2 || true
rm -f docker-compose.override.yml
rm -f .env                      # so setup writes a correct DATABASE_URL
bash scripts/server-setup.sh
```

Removing `.env` is what repoints `DATABASE_URL` from the container's port to the
native cluster's. Only do this on a staging box with no data worth keeping — on
anything real, dump first:

```bash
docker compose exec -T postgres pg_dump -U fltcrypto fltcrypto > /root/pre-migration.sql
```

## Ports and exposure

The app listens on `127.0.0.1:3000` behind whatever fronts it. PostgreSQL
listens on localhost only, which is the Ubuntu package default — do not change
it. Nothing needs to reach the database from outside the box.

Publishing the app directly on port 3000 means plaintext HTTP over the public
internet: session cookies unprotected in transit, and the origin IP exposed. Put
something in front of it before anyone real uses it. A Cloudflare Tunnel needs
no inbound ports open at all:

```bash
cloudflared tunnel create fltcrypto
cloudflared tunnel route dns fltcrypto app.example.com
cloudflared tunnel --url http://127.0.0.1:3000 run fltcrypto
cloudflared service install     # once it works
```

Then close everything except SSH:

```bash
ufw allow 22/tcp && ufw --force enable
```

Do the SSH rule first. Locking yourself out of a Hetzner box means a rescue
console.

## Staging, not production

The app refuses to start with `NODE_ENV=production` while any provider is still
`mock` (`src/server/env.ts`), and all six currently are. So the server runs with
`NODE_ENV=development`, which also means session cookies are not `Secure`-flagged.

Treat this box as a demo environment until real providers are wired in. It must
not hold customer data or real funds in this state.

## Diagnosing

```bash
systemctl status fltcrypto
journalctl -u fltcrypto -n 50 --no-pager
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/assets
sudo -u postgres psql -c '\l'
pg_lsclusters
```

| Symptom | Cause |
|---|---|
| `P1001` can't reach database | PostgreSQL down, or `DATABASE_URL` names the wrong port. Check `pg_lsclusters` — a pre-existing cluster pushes a new one off 5432. |
| `P1000` authentication failed | `.env` password and the role's password disagree. `ALTER USER fltcrypto WITH PASSWORD '...'` to match `.env`. |
| `P2021` table does not exist | Migrations never ran. `npx prisma migrate deploy`. |
| `/login` 200 but `/api/assets` 500 | Web tier up, data tier broken. One of the three above. |
| Build killed with no error | Out of memory. The setup script adds 4G of swap; confirm with `free -h`. |

## Making an administrator

Register through the UI, then:

```bash
cd /opt/fltcrypto
sudo -u postgres psql -d fltcrypto -c "UPDATE users SET role='ADMIN' WHERE email='you@example.com';"
```

## Backups

Nothing here is backed up yet. Before this box holds anything that matters:

```bash
sudo -u postgres pg_dump fltcrypto | gzip > /root/fltcrypto-$(date +%F).sql.gz
```

Put it on a schedule and copy it off the machine. A backup that lives only on
the server it protects is not a backup.
