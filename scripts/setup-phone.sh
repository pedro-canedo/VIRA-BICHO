#!/usr/bin/env bash
# Prepara o celular (Termux) para rodar o VIRA-BICHO como serviço runit. Roda uma vez.
# Tudo via SSH: arquivos criados assim mantêm o rótulo SELinux correto do Termux.
set -euo pipefail
HOST="${PHONE_HOST:-192.168.3.22}"
PORT="${PHONE_PORT:-8022}"

ssh -p "$PORT" "$HOST" 'bash -s' <<'REMOTE'
set -e
command -v rsync >/dev/null || pkg install -y rsync
mkdir -p "$HOME/apps/vira-bicho"
SV="$PREFIX/var/service/vira-bicho"
mkdir -p "$SV/log"
cat > "$SV/run" <<'RUN'
#!/data/data/com.termux/files/usr/bin/sh
cd "$HOME/apps/vira-bicho"
export PORT=3000 NODE_ENV=production
exec node server.mjs 2>&1
RUN
chmod +x "$SV/run"
ln -sf "$PREFIX/share/termux-services/svlogger" "$SV/log/run"
# Fica parado até o primeiro deploy (o deploy remove este arquivo).
[ -f "$HOME/apps/vira-bicho/server.mjs" ] || touch "$SV/down"
echo "Serviço pronto em $SV"
REMOTE
