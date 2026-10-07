#!/bin/sh
# Writes /config.js from environment variables when the container starts,
# so ONE image can be promoted unchanged from dev -> staging -> prod.
set -eu
cat > /usr/share/nginx/html/config.js <<EOF
window.__CONFIG__ = {
  apiBaseUrl: "${API_BASE_URL:-/api}",
  appEnv: "${APP_ENV:-local}"
};
EOF
echo "runtime config written: APP_ENV=${APP_ENV:-local} API_BASE_URL=${API_BASE_URL:-/api}"
