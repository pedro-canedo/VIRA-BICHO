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
# Teto de heap: o Node cai e o runit reinicia antes que o lmkd do Android mate o Termux inteiro.
exec node --max-old-space-size=256 server.mjs 2>&1
RUN
chmod +x "$SV/run"
ln -sf "$PREFIX/share/termux-services/svlogger" "$SV/log/run"
# Rotação do log (svlogd): 5 arquivos de até 5 MB, para um flood de log não apagar o histórico.
LOGDIR="$PREFIX/var/log/sv/vira-bicho"
mkdir -p "$LOGDIR"
printf 's5000000\nn5\n' > "$LOGDIR/config"
# Fica parado até o primeiro deploy (o deploy remove este arquivo).
[ -f "$HOME/apps/vira-bicho/server.mjs" ] || touch "$SV/down"
echo "Serviço pronto em $SV"
REMOTE
