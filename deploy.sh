#!/usr/bin/env bash
# Build smart-wallet-alerts and deploy it to the server as a systemd service.
# Usage: ./deploy.sh            (code only; server data/ and .env are kept)
#        ./deploy.sh --seed     (first deploy: also upload the local database
#                                if the server has none yet; never overwrites)
set -euo pipefail

SERVER="root@188.253.26.129"
KEY="$HOME/.ssh/searadar_deploy"
REMOTE_DIR="/opt/smart-wallet-alerts"
# One multiplexed connection for the whole deploy: the server rate-limits
# new SSH connections and resets bursts of them.
CTL="/tmp/swa-deploy-%r@%h:%p"
SSH_OPTS="-o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=20 -o ControlMaster=auto -o ControlPath=$CTL -o ControlPersist=120 -i $KEY"
SSH="ssh $SSH_OPTS $SERVER"
SEED=0
[ "${1:-}" = "--seed" ] && SEED=1

cd "$(dirname "$0")"

echo "→ Building and testing"
npm run build
npm test >/dev/null

if [ "$SEED" = 1 ]; then
  echo "→ Snapshotting local database for the seed"
  rm -f /tmp/swa-seed.sqlite
  sqlite3 data/swa.sqlite ".backup /tmp/swa-seed.sqlite"
fi

echo "→ Uploading to $SERVER:$REMOTE_DIR"
# data/ is never part of the code upload: it holds the live database.
COPYFILE_DISABLE=1 tar --no-xattrs -czf - \
  --exclude='./node_modules' --exclude='./.git' --exclude='./.DS_Store' \
  --exclude='./data' --exclude='./.vercel-out' --exclude='./fixtures' \
  . \
  | $SSH "
    set -e
    id -u smartw >/dev/null 2>&1 || useradd --system --home $REMOTE_DIR --shell /usr/sbin/nologin smartw
    mkdir -p $REMOTE_DIR/data
    cd $REMOTE_DIR
    [ -f .env ] && cp .env .env.keep || true
    tar -xzf -
    # Keep the server .env but add keys that are new in the local one.
    if [ -f .env.keep ]; then
      while IFS= read -r line; do
        case \"\$line\" in ''|\#*) continue;; esac
        key=\${line%%=*}
        grep -q \"^\$key=\" .env.keep || printf '%s\\n' \"\$line\" >> .env.keep
      done < .env
      mv .env.keep .env
    fi
    npm install --omit=dev --no-audit --no-fund --loglevel=error
    chmod 600 .env
  "

if [ "$SEED" = 1 ]; then
  if $SSH "test -f $REMOTE_DIR/data/swa.sqlite"; then
    echo "→ Seed skipped: the server already has a database"
  else
    echo "→ Seeding the server database"
    scp $SSH_OPTS /tmp/swa-seed.sqlite "$SERVER:$REMOTE_DIR/data/swa.sqlite"
  fi
  rm -f /tmp/swa-seed.sqlite
fi

$SSH "
  set -e
  chown -R smartw:smartw $REMOTE_DIR
  install -m 644 $REMOTE_DIR/deploy/smart-wallet-alerts.service /etc/systemd/system/smart-wallet-alerts.service
  systemctl daemon-reload
  systemctl enable smart-wallet-alerts >/dev/null
  systemctl restart smart-wallet-alerts
  sleep 6
  systemctl --no-pager --lines=0 status smart-wallet-alerts | head -4
  journalctl -u smart-wallet-alerts -n 6 --no-pager -o cat
  curl -s -m 5 http://127.0.0.1:5190/health; echo
"
ssh -O exit -o ControlPath=$CTL $SERVER 2>/dev/null || true
echo "✓ Deployed"
