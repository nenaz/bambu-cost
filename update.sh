#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
git pull origin master --ff-only
npm install --no-audit --no-fund
sudo systemctl restart bambu-cost
sleep 3
systemctl is-active bambu-cost
journalctl -u bambu-cost -n 10 --no-pager