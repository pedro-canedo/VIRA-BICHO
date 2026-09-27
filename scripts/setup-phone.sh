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
  # Regera também se a linha existir mas estiver vazia ou curta (ex.: uma geração que falhou antes).
  if ! grep -q "^$key=.\{16,\}" "$SECRETS"; then
    val="$(gen_secret)" || val=""
    if ! printf '%s' "$val" | grep -q '^[0-9a-f]\{64\}$'; then
      echo "Falha ao gerar $key (instale openssl ou verifique /dev/urandom); nada foi gravado." >&2
      exit 1
    fi
    # Troca a linha antiga (se houver) sem nunca imprimir o valor.
    { grep -v "^$key=" "$SECRETS" || true; printf '%s=%s\n' "$key" "$val"; } > "$SECRETS.tmp"
    mv "$SECRETS.tmp" "$SECRETS"
    chmod 600 "$SECRETS"
    unset val
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
# Só o OBS_INTERNAL_TOKEN (segredo do endpoint interno lido pelo observador). O OBS_TOKEN, senha do
# painel, fica fora do ambiente do jogo, que é o processo exposto à internet.
F="$HOME/.config/vira-bicho/secrets.env"
if [ -f "$F" ]; then
  OBS_INTERNAL_TOKEN=$(sed -n 's/^OBS_INTERNAL_TOKEN=//p' "$F" | tail -n 1)
  export OBS_INTERNAL_TOKEN
fi
unset F
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
# OBS_TOKEN e OBS_INTERNAL_TOKEN (e, se quiser, OBS_HOST=127.0.0.1 para aceitar só o túnel).
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
