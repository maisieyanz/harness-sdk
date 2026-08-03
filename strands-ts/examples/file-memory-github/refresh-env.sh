#!/usr/bin/env bash
# Refresh the short-lived AWS credentials in .env, leaving every other line untouched.
#
# Bedrock session credentials expire in about an hour; a 403 from Bedrock mid-demo means it is time to
# re-run this. Skip it entirely if your Bedrock access uses long-term keys or an assumed role.
#
# By default the credentials come from `aws configure export-credentials`. Point CREDENTIAL_COMMAND at
# something else — in .env or in your shell — if your organization issues them another way. The command
# must print JSON carrying AccessKeyId, SecretAccessKey, and SessionToken, either at the top level or
# nested under a "Credentials" key.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — fill in GITHUB_* before running the demo."
fi

# Read CREDENTIAL_COMMAND from .env so the choice persists alongside the rest of the configuration.
if [ -z "${CREDENTIAL_COMMAND:-}" ]; then
  CREDENTIAL_COMMAND=$(sed -n 's/^CREDENTIAL_COMMAND=//p' .env | tail -1)
fi
CREDENTIAL_COMMAND=${CREDENTIAL_COMMAND:-'aws configure export-credentials'}

# Tolerate a helper that wraps its JSON in other chatter.
CREDS=$(eval "$CREDENTIAL_COMMAND" 2>/dev/null | grep -o '{.*}' || true)
if [ -z "$CREDS" ]; then
  echo "No JSON credentials from: $CREDENTIAL_COMMAND" >&2
  exit 1
fi

CREDS="$CREDS" python3 - <<'PY'
import json, os, re

payload = json.loads(os.environ['CREDS'])
creds = payload.get('Credentials', payload)
values = {
    'AWS_ACCESS_KEY_ID': creds['AccessKeyId'],
    'AWS_SECRET_ACCESS_KEY': creds['SecretAccessKey'],
    'AWS_SESSION_TOKEN': creds['SessionToken'],
}

lines = open('.env').read().splitlines()
seen = set()
for index, line in enumerate(lines):
    match = re.match(r'^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)=', line)
    if match:
        key = match.group(1)
        lines[index] = f'{key}={values[key]}'
        seen.add(key)

# Append any key the file did not already carry, so a hand-trimmed .env still ends up complete.
lines += [f'{key}={value}' for key, value in values.items() if key not in seen]

open('.env', 'w').write('\n'.join(lines) + '\n')
print('Refreshed AWS credentials in .env — expire', creds.get('Expiration', 'unknown'))
PY
