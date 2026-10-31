#!/bin/sh
set -e

# Generate the template secret locally; never ship a shared signing secret.
/usr/local/searxng/searx-pyenv/bin/python - <<'PY_SECRET'
import json
import os
from pathlib import Path
import secrets
settings = Path('/etc/searxng/settings.yml')
text = settings.read_text()
marker = '"__GENERATE_ON_FIRST_START__"'
if marker in text:
    secret = os.environ.get('SEARXNG_SECRET') or secrets.token_hex(32)
    settings.write_text(text.replace(marker, json.dumps(secret)))
PY_SECRET

echo "Starting SearXNG..."

sudo -H -u searxng bash -c "cd /usr/local/searxng/searxng-src && export SEARXNG_SETTINGS_PATH='/etc/searxng/settings.yml' && export FLASK_APP=searx/webapp.py && /usr/local/searxng/searx-pyenv/bin/python -m flask run --host=0.0.0.0 --port=8080" &
SEARXNG_PID=$!

echo "Waiting for SearXNG to be ready..."
sleep 5

COUNTER=0
MAX_TRIES=30
until curl -s http://localhost:8080 > /dev/null 2>&1; do
  COUNTER=$((COUNTER+1))
  if [ $COUNTER -ge $MAX_TRIES ]; then
    echo "Warning: SearXNG health check timeout, but continuing..."
    break
  fi
  sleep 1
done

if curl -s http://localhost:8080 > /dev/null 2>&1; then
  echo "SearXNG started successfully (PID: $SEARXNG_PID)"
else
  echo "SearXNG may not be fully ready, but continuing (PID: $SEARXNG_PID)"
fi

cd /home/vane
echo "Starting Vane..."

exec node server.js