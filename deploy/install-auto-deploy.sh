#!/usr/bin/env bash
#
# Turn on automatic deploys. Run once, as root:
#
#   bash /opt/flt-exchange/deploy/install-auto-deploy.sh
#
# After this, every push to origin/main is live within about two minutes with
# no further action. Watch it with:
#
#   journalctl -u flt-autodeploy -f
#
# Turn it off with:
#
#   systemctl disable --now flt-autodeploy.timer
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/flt-exchange}

if [[ $EUID -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

install -m 0644 "$APP_DIR/deploy/flt-autodeploy.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/deploy/flt-autodeploy.timer" /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now flt-autodeploy.timer

echo
echo "Automatic deploys are on. Next run:"
systemctl list-timers flt-autodeploy.timer --no-pager
