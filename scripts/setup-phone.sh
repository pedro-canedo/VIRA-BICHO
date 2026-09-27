#!/usr/bin/env bash
# Prepara o celular (Termux) para rodar o VIRA-BICHO e o observador como serviços runit.
# Pode rodar de novo sem problema: recria os scripts "run" e só gera segredos que ainda não existem.
# Tudo via SSH: arquivos criados assim mantêm o rótulo SELinux correto do Termux.
set -euo pipefail
HOST="${PHONE_HOST:-192.168.3.22}"
PORT="${PHONE_PORT:-8022}"

ssh -p "$PORT" "$HOST" 'bash -s' <<'REMOTE'
set -e
command -v rsync >/dev/null || pkg install -y rsync

# ---------- segredos (nunca impressos) ----------
CONF="$HOME/.config/vira-bicho"
SECRETS="$CONF/secrets.env"
mkdir -p "$CONF"
chmod 700 "$CONF"
umask 077
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}
[ -f "$SECRETS" ] || : > "$SECRETS"
chmod 600 "$SECRETS"
for key in OBS_TOKEN OBS_INTERNAL_TOKEN; do
  if ! grep -q "^$key=" "$SECRETS"; then
    printf '%s=%s\n' "$key" "$(gen_secret)" >> "$SECRETS"
    echo "Gerado $key em $SECRETS"
  fi
done
umask 022

# ---------- jogo ----------
mkdir -p "$HOME/apps/vira-bicho"
SV="$PREFIX/var/service/vira-bicho"
mkdir -p "$SV/log"
cat > "$SV/run" <<'RUN'
#!/data/data/com.termux/files/usr/bin/sh
cd "$HOME/apps/vira-bicho"
# OBS_INTERNAL_TOKEN: segredo do endpoint interno lido pelo observador.
if [ -f "$HOME/.config/vira-bicho/secrets.env" ]; then
  set -a
  . "$HOME/.config/vira-bicho/secrets.env"
  set +a
fi
export PORT=3000 NODE_ENV=production
exec node server.mjs 2>&1
RUN
chmod +x "$SV/run"
ln -sf "$PREFIX/share/termux-services/svlogger" "$SV/log/run"
# Fica parado até o primeiro deploy (o deploy remove este arquivo).
[ -f "$HOME/apps/vira-bicho/server.mjs" ] || touch "$SV/down"
echo "Serviço pronto em $SV"

# ---------- observador ----------
mkdir -p "$HOME/apps/vira-bicho-obs/data"
chmod 700 "$HOME/apps/vira-bicho-obs/data"
SVO="$PREFIX/var/service/vira-bicho-obs"
mkdir -p "$SVO/log"
cat > "$SVO/run" <<'RUN'
#!/data/data/com.termux/files/usr/bin/sh
cd "$HOME/apps/vira-bicho-obs"
set -a
. "$HOME/.config/vira-bicho/secrets.env"
set +a
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PATH="$PREFIX/bin:$PATH"
export OBS_PORT=3001 OBS_DATA_DIR="$HOME/apps/vira-bicho-obs/data" NODE_ENV=production
# Heap pequeno: o observador guarda as séries fora do heap (TypedArrays) e usa poucos MB.
exec node --max-old-space-size=48 --max-semi-space-size=1 obs.mjs 2>&1
RUN
chmod +x "$SVO/run"
ln -sf "$PREFIX/share/termux-services/svlogger" "$SVO/log/run"
[ -f "$HOME/apps/vira-bicho-obs/obs.mjs" ] || touch "$SVO/down"
echo "Serviço pronto em $SVO"
REMOTE
