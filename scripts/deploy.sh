#!/usr/bin/env bash
# Build no PC, envia só o JS pronto para o celular e reinicia os serviços (jogo e observador).
# O build não roda no celular: lá o Node reporta a plataforma "android", sem binários nativos do Vite/esbuild.
set -euo pipefail
HOST="${PHONE_HOST:-192.168.3.22}"
PORT="${PHONE_PORT:-8022}"
cd "$(dirname "$0")/.."

npm run typecheck
npm test
npm run build

# Jogo: dist/ sem os arquivos do observador.
rsync -az --delete --exclude 'obs.mjs' --exclude 'obs.mjs.map' --exclude 'obs-public/' \
  -e "ssh -p $PORT" dist/ "$HOST:apps/vira-bicho/"
# Observador: sem --delete na raiz, para não tocar em apps/vira-bicho-obs/data.
ssh -p "$PORT" "$HOST" 'mkdir -p "$HOME/apps/vira-bicho-obs/data"'
rsync -az -e "ssh -p $PORT" dist/obs.mjs dist/obs.mjs.map "$HOST:apps/vira-bicho-obs/"
rsync -az --delete -e "ssh -p $PORT" dist/obs-public/ "$HOST:apps/vira-bicho-obs/obs-public/"

ssh -p "$PORT" "$HOST" 'bash -s' <<'REMOTE'
set -e
for s in vira-bicho vira-bicho-obs; do
  SV="$PREFIX/var/service/$s"
  if [ ! -d "$SV" ]; then
    echo "Serviço $s não existe: rode scripts/setup-phone.sh" >&2
    continue
  fi
  rm -f "$SV/down"
  sv restart "$SV"
done
REMOTE

wait_for() {
  local name="$1" url="$2" log="$3"
  for _ in $(seq 1 15); do
    if curl -fsS "$url"; then
      echo
      echo "$name ok: $url"
      return 0
    fi
    sleep 1
  done
  echo "$name não respondeu em $url" >&2
  ssh -p "$PORT" "$HOST" "tail -20 \"\$PREFIX/var/log/sv/$log/current\"" >&2 || true
  return 1
}

wait_for "Jogo" "http://$HOST:3000/health" vira-bicho
wait_for "Observador" "http://$HOST:3001/healthz" vira-bicho-obs
echo "Deploy ok: jogo em http://$HOST:3000 · painel em http://$HOST:3001"
