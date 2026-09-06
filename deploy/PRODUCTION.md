# Production deployment

What is actually live, as of 2026-09-06. No secrets here — those live only in
`/opt/flt-exchange/.env` on the server and in whichever secrets manager you
choose later.

## Topology

- **Server**: Hetzner VPS, Ubuntu 22.04, `204.168.254.41`. 2 vCPU / 3.7 GiB RAM
  / 38 GiB disk, plus a 4 GiB swapfile added for headroom during `pnpm build`
  (two Next.js production builds concurrently on 3.7 GiB is tight without it).
- **DNS / edge**: Cloudflare, proxied (orange-clouded), for `ftlexchange.com`.
  - `app.ftlexchange.com` → the consumer app (`:3000`)
  - `admin.ftlexchange.com` → the admin panel (`:3001`)
  - SSL/TLS mode: **Full (strict)**. The origin presents a Cloudflare Origin
    Certificate (`/etc/ssl/cloudflare/ftlexchange-origin.pem` +
    `ftlexchange-origin.key`, both SANs, 15-year validity, issued
    2026-09-06) — this cert is trusted by Cloudflare only, not publicly, which
    is correct for an origin Cloudflare always sits in front of. It is **not**
    a Let's Encrypt cert, so certbot renewal does not apply to it; if it is
    ever regenerated in the Cloudflare dashboard, replace both files on the
    server and reload nginx.
- **Reverse proxy**: nginx, config at `deploy/ftlexchange.com.nginx.conf`
  (installed as `/etc/nginx/sites-available/ftlexchange.conf`, symlinked into
  `sites-enabled`), plus `deploy/cloudflare-realip.conf` (installed as
  `/etc/nginx/conf.d/cloudflare-realip.conf`) so `$remote_addr` — and
  therefore both nginx's `limit_req` zones and the application's own
  rate-limit buckets — resolve to the real visitor IP rather than
  Cloudflare's edge IP. `deploy/proxy_params_flt` is installed as
  `/etc/nginx/proxy_params_flt`.
- **Apps**: `web`, `admin`, and the `worker`, each a systemd unit
  (`deploy/flt-{web,admin,worker}.service`) running as the unprivileged `flt`
  system user out of `/opt/flt-exchange`, reading `/opt/flt-exchange/.env`.
- **Database**: PostgreSQL 14 (Ubuntu's default `apt` package), local to the
  server. Role and database are both named `flt_exchange`.
- **Firewall**: `ufw` — only 22, 80, 443 open. `fail2ban` running against SSH.
- **Deploy access**: a repo-scoped, read-only GitHub Deploy Key lives at
  `/root/.ssh/flt_deploy_key` (and a copy at `/home/flt/.ssh/flt_deploy_key`
  so the `flt` user can pull without root). It can only read this repository —
  rotate it from the repo's Settings → Deploy keys if it is ever suspected
  compromised.

## What's real vs. what's a placeholder

Configured with live production credentials, provided directly by you:

- `DEX_ROUTER=zeroex` with a real 0x API key
- `BASE_RPC_URL` on a keyed Alchemy endpoint (with the public Base RPC as
  `BASE_RPC_FALLBACK_URL`)
- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` — a real Reown project ID
- `MARKET_DATA_PROVIDER=coingecko`, `PRICE_HISTORY_PROVIDER=geckoterminal` —
  both on the free keyless tier, so subject to that tier's rate limits

**Not yet configured — a real gap, not a cosmetic one:**

- **Email**: `MAIL_PROVIDER=console`. Verification and password-reset emails
  are logged, not delivered. `packages/config/src/env.ts` treats this as a
  loud runtime warning rather than a startup refusal — deliberately, since
  unlike the other production guards in that function it doesn't fabricate
  data, it just fails to send mail — but it means **no one can complete
  signup or reset a password against this deployment today.** Set
  `MAIL_PROVIDER=resend` and `RESEND_API_KEY` to close this.
- **`FLT_FEE_RECIPIENT_ADDRESS`** is blank, so the platform currently takes a
  0 bps fee on every trade.
- **Admin panel network restriction**: the `allow`/`deny` block in
  `ftlexchange.com.nginx.conf` for `admin.ftlexchange.com` is commented out.
  The panel is reachable from the open internet behind only its own
  login + MFA. This is called out in the original plan as "the single
  highest-value control on the whole deployment" and should be turned on —
  either an IP allow-list or Cloudflare Access — before real users exist.

## Redeploying

```bash
ssh root@204.168.254.41
cd /opt/flt-exchange
sudo -u flt git pull origin main
sudo -u flt pnpm install --frozen-lockfile
sudo -u flt pnpm --filter @flt/db exec prisma generate
sudo -u flt pnpm build
sudo -u flt pnpm --filter @flt/db exec prisma migrate deploy   # only if schema changed
systemctl restart flt-web flt-admin flt-worker
```

No CI/CD is wired up yet — this is a manual pull-and-rebuild, which is fine at
this stage but is the next real gap once deploys become routine.
