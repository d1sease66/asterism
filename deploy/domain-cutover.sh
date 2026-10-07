#!/bin/sh
# Moves the site to solquorum.xyz once its DNS points at this server.
# Runs from /etc/cron.d/quorum-domain every 5 minutes and removes that entry
# when done: certificate, HTTPS config, solasterism.xyz → 301, SITE_URL.
set -eu
D=solquorum.xyz
IP=188.253.26.129
APP=/opt/smart-wallet-alerts
LOG=/var/log/quorum-domain.log

apex=$(dig +short "$D" A @1.1.1.1 | tail -n1)
www=$(dig +short "www.$D" A @1.1.1.1 | tail -n1)
[ "$apex" = "$IP" ] || exit 0
names="-d $D"
[ "$www" = "$IP" ] && names="$names -d www.$D"

{
  echo "$(date -u +%FT%TZ) DNS ok ($apex / ${www:-no www}), issuing certificate"
  certbot certonly --webroot -w /var/www/html $names --non-interactive --agree-tos --keep-until-expiring
  cp "$APP/deploy/nginx-domain.conf" "/etc/nginx/sites-available/$D"
  cp "$APP/deploy/nginx-legacy-domain.conf" /etc/nginx/sites-available/solasterism.xyz
  ln -sf "/etc/nginx/sites-available/$D" "/etc/nginx/sites-enabled/$D"
  nginx -t && systemctl reload nginx
  if grep -q '^SITE_URL=' "$APP/.env"; then
    sed -i "s#^SITE_URL=.*#SITE_URL=https://$D#" "$APP/.env"
  else
    echo "SITE_URL=https://$D" >> "$APP/.env"
  fi
  systemctl restart smart-wallet-alerts
  rm -f /etc/cron.d/quorum-domain
  echo "$(date -u +%FT%TZ) done"
} >> "$LOG" 2>&1
