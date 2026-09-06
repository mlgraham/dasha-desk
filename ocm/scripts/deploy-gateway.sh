#!/usr/bin/env bash
# Package the gateway, ship it to S3, and restart the live service.
# Restarting drops every host socket; agents reconnect with backoff by design.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-ocm}"
# Deployment identifiers live in .deploy.env (gitignored) so no account id, bucket
# name or instance id is baked into a file that will be published.
_here="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$_here/.deploy.env" ] && . "$_here/.deploy.env"
export AWS_REGION="${OCM_REGION:-us-west-2}"
BUCKET="${OCM_BUCKET:?set OCM_BUCKET in ocm/.deploy.env}"
GW_INSTANCE="${OCM_GW_INSTANCE:?set OCM_GW_INSTANCE in ocm/.deploy.env}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

node --check "$ROOT/gateway/server.mjs"
node --test "$ROOT"/tests/*.test.mjs >/dev/null || { echo "tests failed — not deploying"; exit 1; }

# The agent ships with the gateway, and a broken agent.py is invisible to the Node
# suite. A missing module-level import once shipped this way and crash-looped the
# provider: syntax was valid, and the failing constructor only runs on Apple Silicon.
if command -v uv >/dev/null 2>&1; then
  uv run --quiet --python 3.12 --with websockets python "$ROOT/tests/agent-smoke.py" \
    || { echo "agent smoke failed — not deploying"; exit 1; }
else
  echo "WARNING: uv not found, agent smoke test SKIPPED. The agent is shipping unverified." >&2
fi

tar -czf /tmp/ocm-gateway.tar.gz -C "$ROOT" gateway agent package.json
aws s3 cp /tmp/ocm-gateway.tar.gz "s3://$BUCKET/gateway/ocm-gateway.tar.gz" --only-show-errors

# Remote script kept in a file so the local shell never expands its variables.
REMOTE=$(mktemp /tmp/ocm-remote.XXXXXX.sh)
cat > "$REMOTE" <<REMOTE_EOF
set -e
aws s3 cp s3://$BUCKET/gateway/ocm-gateway.tar.gz /tmp/g.tar.gz --region us-west-2 --quiet
tar -xzf /tmp/g.tar.gz -C /opt/ocm
cd /opt/ocm && npm install --omit=dev --no-audit --no-fund --loglevel=error
# RDS CA bundle, so Postgres TLS is verified rather than merely encrypted.
if [ ! -s /etc/ocm/rds-ca.pem ]; then
  curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /etc/ocm/rds-ca.pem
  chmod 644 /etc/ocm/rds-ca.pem
fi
DB=\$(aws ssm get-parameter --name /ocm/db/url --with-decryption --query Parameter.Value --output text --region us-west-2)
grep -q '^DATABASE_URL=' /etc/ocm/gateway.env || printf 'DATABASE_URL=%s\n' "\$DB" >> /etc/ocm/gateway.env
ADM=\$(aws ssm get-parameter --name /ocm/gateway/admin_token --with-decryption --query Parameter.Value --output text --region us-west-2)
INV=\$(aws ssm get-parameter --name /ocm/gateway/invite_code --query Parameter.Value --output text --region us-west-2)
SES=\$(aws ssm get-parameter --name /ocm/gateway/session_secret --with-decryption --query Parameter.Value --output text --region us-west-2)
ADMINS=\$(aws ssm get-parameter --name /ocm/gateway/admin_emails --query Parameter.Value --output text --region us-west-2 2>/dev/null || true)
sed -i '/^OCM_INVITE_CODE=/d;/^OCM_SESSION_SECRET=/d;/^OCM_ADMIN_EMAILS=/d' /etc/ocm/gateway.env
printf 'OCM_INVITE_CODE=%s\n' "\$INV" >> /etc/ocm/gateway.env
if [ -n "\$ADMINS" ] && [ "\$ADMINS" != "None" ]; then printf 'OCM_ADMIN_EMAILS=%s\n' "\$ADMINS" >> /etc/ocm/gateway.env; fi
printf 'OCM_SESSION_SECRET=%s\n' "\$SES" >> /etc/ocm/gateway.env
grep -q '^OCM_ADMIN_TOKEN=' /etc/ocm/gateway.env || printf 'OCM_ADMIN_TOKEN=%s\n' "\$ADM" >> /etc/ocm/gateway.env
chmod 600 /etc/ocm/gateway.env
# Bootstrap credentials are retired now that account-bound ones are issued.
sed -i '/^OCM_HOST_TOKEN=/d;/^OCM_API_KEY=/d' /etc/ocm/gateway.env
systemctl restart ocm-gateway
sleep 6
systemctl is-active ocm-gateway
curl -sf http://127.0.0.1:8080/healthz
REMOTE_EOF

PJ=$(mktemp /tmp/ocm-params.XXXXXX.json)
python3 -c "
import json,sys
print(json.dumps({'commands':[open(sys.argv[1]).read()],'executionTimeout':['1800']}))
" "$REMOTE" > "$PJ"

CID=$(aws ssm send-command --instance-ids "$GW_INSTANCE" --document-name AWS-RunShellScript \
  --parameters "file://$PJ" --timeout-seconds 1800 --query "Command.CommandId" --output text)
rm -f "$REMOTE" "$PJ"

for _ in $(seq 1 120); do
  ST=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$GW_INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case "$ST" in Success|Failed|TimedOut) break;; esac
  sleep 5
done
aws ssm get-command-invocation --command-id "$CID" --instance-id "$GW_INSTANCE" --query StandardOutputContent --output text
if [ "$ST" != "Success" ]; then
  echo "--- stderr ---"
  aws ssm get-command-invocation --command-id "$CID" --instance-id "$GW_INSTANCE" --query StandardErrorContent --output text
  exit 1
fi
