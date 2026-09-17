#!/bin/sh
# On the server, as root, after unpacking into /opt/bandsy:  sh /opt/bandsy/deploy/setup.sh <domain>
# Safe to re-run for updates; never overwrites the live database.
set -e
cd /opt/bandsy
command -v node >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt-get install -y nodejs; }
command -v caddy >/dev/null || apt-get install -y caddy
npm ci && npx vite build && npm prune --omit=dev
id bandsy >/dev/null 2>&1 || useradd --system --home-dir /opt/bandsy bandsy
mkdir -p data
[ -f data/bandsy.db ] || [ ! -f seed/bandsy.db ] || cp seed/bandsy.db data/bandsy.db
chown -R bandsy data
cp deploy/bandsy.service /etc/systemd/system/bandsy.service
[ -z "$1" ] || printf '%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:3001\n}\n' "$1" > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable bandsy caddy
systemctl restart bandsy caddy
echo "Bandsy is running. Add accounts with:  sh /opt/bandsy/deploy/adduser.sh <name> <password>"
