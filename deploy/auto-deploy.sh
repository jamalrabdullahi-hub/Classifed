#!/usr/bin/env bash
#
# Deploy whatever is on origin/main, if it isn't already deployed.
#
# Run on a timer. The check is deliberately cheap — `git fetch` and a hash
# comparison — so this can run every couple of minutes without doing any work
# on the overwhelming majority of ticks.
#
# Why polling rather than a webhook: a webhook needs a public endpoint, a
# shared secret, and a listener to keep alive. This needs none of those, and
# the cost of being up to two minutes late is nil.
#
# A failed deploy does not stop the timer, but it does stop *this* run before
# anything restarts — update.sh already guarantees that. The next tick will
# retry the same commit, and will keep failing visibly in the journal until
# somebody fixes it, which is the correct behaviour: a broken build should not
# quietly stay unnoticed, and it should also never take the site down.
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/flt-exchange}
APP_USER=${APP_USER:-flt}

if [[ $EUID -ne 0 ]]; then
  echo "Run as root — this restarts systemd services." >&2
  exit 1
fi

cd "$APP_DIR"

sudo -u "$APP_USER" git fetch --quiet origin main

local_head=$(sudo -u "$APP_USER" git rev-parse HEAD)
remote_head=$(sudo -u "$APP_USER" git rev-parse origin/main)

if [[ "$local_head" == "$remote_head" ]]; then
  echo "Already on ${local_head:0:7}; nothing to deploy."
  exit 0
fi

echo "Deploying ${local_head:0:7} -> ${remote_head:0:7}"
exec bash "$APP_DIR/deploy/update.sh"
