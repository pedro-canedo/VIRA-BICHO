#!/usr/bin/env bash
# Build no PC, envia só o JS pronto para o celular e reinicia o serviço.
# O build não roda no celular: lá o Node reporta a plataforma "android", sem binários nativos do Vite/esbuild.
set -euo pipefail
HOST="${PHONE_HOST:-192.168.3.22}"
PORT="${PHONE_PORT:-8022}"
cd "$(dirname "$0")/.."

npm run typecheck
npm test
npm run build
rsync -az --delete -e "ssh -p $PORT" dist/ "$HOST:apps/vira-bicho/"
ssh -p "$PORT" "$HOST" 'rm -f "$PREFIX/var/service/vira-bicho/down"; sv restart "$PREFIX/var/service/vira-bicho"'
for _ in $(seq 1 15); do
  if curl -fsS "http://$HOST:3000/health"; then
    echo
    echo "Deploy ok: http://$HOST:3000"
    exit 0
  fi
  sleep 1
done
echo "O servidor não respondeu em http://$HOST:3000/health" >&2
ssh -p "$PORT" "$HOST" 'tail -20 "$PREFIX/var/log/sv/vira-bicho/current"' >&2 || true
exit 1
