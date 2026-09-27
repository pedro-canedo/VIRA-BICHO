# VIRA-BICHO

Battle royale de monstrinhos para o navegador. Você nasce como um ovo, **vira o que você come** e, se perder uma batalha, **o vencedor rouba a sua evolução**.

Partidas de ~5 minutos, 8 a 16 jogadores (bots completam a arena), controle só com mouse ou toque.

**Jogar:** https://virabicho.caixazen.online

## Como funciona

**Partida**

| Tempo | Fase | O que acontece |
|---|---|---|
| 0:00–2:00 | Coleta | Só bichos selvagens. Coma para evoluir. |
| 2:00–4:00 | Caçada | Dá para desafiar outros jogadores. A zona começa a fechar. |
| 4:00–5:00 | Final | Os selvagens somem e cada derrota custa 2 estágios. |
| 5:00+ | Morte súbita | A zona fecha até sumir. |

**Evolução:** Ovo → Filhote → Adulto → Forma final. O tipo depende do que você comeu:
- **Tipos puros:** 🔥 Brasa, 🌊 Maré, 🌿 Broto.
- **Híbridos:** Vapor, Cinza e Mangue.
- **Quimera:** rara, quando os três tipos estão equilibrados.

O corpo é sempre a mesma bolinha 16×16, que ganha peças (chamas, nadadeiras, folhas) desenhadas proceduralmente. São 24 formas no bestiário.

**Batalha:**
- Os dois escolhem ao mesmo tempo, em segredo: ⚔️ Ataque vence ⚡ Carga, 🛡️ Defesa vence ⚔️ Ataque, ⚡ Carga vence 🛡️ Defesa (e dobra o próximo golpe).
- O triângulo de tipos multiplica o dano: Brasa > Broto > Maré > Brasa.
- São no máximo 4 turnos, dentro de uma bolha visível no mapa. Quem está do lado de fora pode esperar para atacar o vencedor enfraquecido.

**O twist:**
- Quem perde entrega um estágio ao vencedor, e o vencedor também absorve metade dos pontos de tipo do perdedor.
- Só é eliminado quem perde ainda sendo ovo.

**Mecânicas extras:**
- **Coroa:** o líder fica marcado no mapa e vale XP extra para quem o derrubar.
- **Fome:** quem perde ganha 5 s de proteção e XP em dobro.
- **Troféus:** vitórias na forma final dão +10% de dano cada.
- **Fruta rara:** aparece no coração de cada bioma.

## Arquitetura

```
shared/   regras puras e determinísticas: tipos, balanceamento, batalha, evolução,
          gerador de mapa com semente, A*, protocolo das mensagens
server/   Node + ws. O servidor é a autoridade: movimento no grid, batalhas,
          zona, bots e salas. Tick de 10 Hz, snapshots só do que está no raio de visão
client/   Vite + Phaser 4 para o mundo; interface em HTML/CSS (menu, HUD, batalha, fim)
tests/    Vitest: regras, mapa, A* e partidas simuladas inteiras só com bots
observer/ vira-bicho-obs: serviço separado de observabilidade (coleta, séries, painel web)
scripts/  build do servidor e do observador, simulação de balanceamento, setup e deploy no celular
```

Todos os números do jogo ficam em [`shared/src/balance.ts`](shared/src/balance.ts).

## Desenvolvimento

```bash
npm install
npm run dev        # servidor (tsx watch, :3000) + Vite (:5173, com proxy do WebSocket)
npm test           # testes unitários + partidas simuladas
npm run typecheck
npm run sim -- 30 16   # estatísticas de balanceamento: 30 partidas com 16 bots
npm run build      # dist/public (cliente) + dist/server.mjs (servidor) + dist/obs.mjs e dist/obs-public (observador)
npm start          # roda o build em :3000
npm run dev:obs    # painel de observabilidade em :3001 com um jogo falso simulado
```

## Deploy (celular com Termux)

O servidor roda num Motorola One Hyper reaproveitado (Termux + runit), exposto pela Cloudflare Tunnel em `virabicho.caixazen.online` → `http://localhost:3000`. A Cloudflare atende nas portas 443 (HTTPS/WSS) e repassa pelo túnel.

```bash
bash scripts/setup-phone.sh   # uma vez: rsync + serviço runit "vira-bicho"
npm run deploy                # typecheck, testes, build no PC, rsync e restart dos dois serviços
```

O build é feito no PC: no Termux o Node reporta a plataforma `android`, para a qual o Vite e o esbuild não têm binários nativos. O celular recebe só JavaScript pronto, sem nenhuma dependência para instalar.

Os endereços podem ser trocados com `PHONE_HOST` e `PHONE_PORT` (padrão `192.168.3.22:8022`).

## Observabilidade

O **vira-bicho-obs** é um serviço separado (runit `vira-bicho-obs`, porta `3001`) que acompanha o jogo e o celular e serve um painel ao vivo protegido por login. Fica em `~/apps/vira-bicho-obs` (`obs.mjs` + `obs-public/`), com os dados em `~/apps/vira-bicho-obs/data`.

**O que coleta**

| A cada | O quê |
|---|---|
| 2 s | `GET http://127.0.0.1:3002/internal/stats?since=<seq>` no jogo (cabeçalho `x-obs-token`). Jogadores, salas, processo (RSS, CPU, lag do event loop, tick), contadores e eventos novos. Sem resposta em 1,5 s = jogo **fora do ar**; `startedAt` diferente = **reinício**. |
| 5 s | Amostra das séries (online, jogando, na sala, salas ativas, conexões, RSS/CPU/lag/tick do jogo, carga, RAM livre, temperatura, bateria) em buffers circulares de 24 h. |
| 5 s | Celular: `/proc/loadavg`, `/proc/meminfo`, `/proc/uptime`, `/sys/class/thermal/thermal_zone*/temp`, `/sys/class/power_supply/battery/*` e disco (`statfs`). O que o Android não deixar ler aparece como “—”. |
| 30 s | `sv status` dos serviços em `$PREFIX/var/service/*`. |
| 60 s | `GET PUBLIC_URL` (padrão `https://batllebicho.caixazen.online/health`): prova de que o túnel da Cloudflare está de pé, com a latência. |
| 60 s | Grava `series.bin` e `state.json` na pasta de dados (restaurados ao iniciar). |

Os eventos vão para `events-AAAA-MM-DD.ndjson` (um arquivo por dia, apagados depois de 7 dias). O contrato completo está em [`shared/src/obs.ts`](shared/src/obs.ts).

**Painel e APIs**

| Rota | Acesso | Conteúdo |
|---|---|---|
| `/healthz` | livre | `{"ok":true,"game":"up"}` (ou `"down"`) para monitores externos |
| `/login` | livre | formulário do token (`OBS_TOKEN`) |
| `/` | sessão | painel ao vivo |
| `/api/stream` | sessão ou Bearer | SSE com o resumo e os eventos novos a cada 2 s |
| `/api/summary` | sessão ou Bearer | estado atual (jogo, túnel, serviços, celular, hoje) |
| `/api/series?range=1h\|6h\|24h` | sessão ou Bearer | séries reduzidas a ≤ 480 pontos (`&fields=online,playing` opcional) |
| `/api/events?limit=N&type=join,security` | sessão ou Bearer | feed de eventos (`&day=AAAA-MM-DD` lê o arquivo do dia) |
| `/metrics` | sessão ou Bearer | formato de texto do Prometheus |

```bash
curl -H "Authorization: Bearer $OBS_TOKEN" http://192.168.3.22:3001/metrics
```

**Segurança**
- O login troca o token por um cookie de sessão assinado com HMAC (HttpOnly, SameSite=Strict, Secure atrás de HTTPS), válido por 7 dias. Trocar o `OBS_TOKEN` invalida todas as sessões.
- São 5 tentativas por minuto por IP (Bearer errado também conta). Atrás do túnel, o IP real vem do `CF-Connecting-IP`, aceito só quando a conexão chega pelo loopback.
- CSP sem script nem estilo inline, `X-Frame-Options: DENY`, `nosniff` e `Referrer-Policy: no-referrer`. O painel não usa CDN, e apelidos e nomes de sala entram no DOM só como texto.

**Segredos:** o `setup-phone.sh` cria `~/.config/vira-bicho/secrets.env` (modo 600) com `OBS_TOKEN` (senha do painel) e `OBS_INTERNAL_TOKEN` (segredo compartilhado com o jogo) aleatórios, sem imprimir os valores. Os dois serviços carregam esse arquivo. Para ver o token no celular, use `grep OBS_TOKEN ~/.config/vira-bicho/secrets.env`.

**Variáveis:** `OBS_PORT` (3001), `OBS_HOST` (0.0.0.0), `OBS_TOKEN`, `OBS_INTERNAL_TOKEN`, `GAME_INTERNAL_URL` (`http://127.0.0.1:3002`), `PUBLIC_URL`, `OBS_DATA_DIR` e `OBS_PUBLIC_DIR`.

**Consumo:** no PC (x86_64), o `obs.mjs` usa cerca de 20 MB de memória privada (RssAnon) e 0,3% de um núcleo. O RSS total fica em torno de 65 MB, mas quase 48 MB disso são páginas do binário do Node, compartilhadas com o processo do jogo. O próprio painel mostra esse consumo no cartão “Observador”.

Para abrir o painel pela internet, adicione um hostname no túnel da Cloudflare apontando para `http://localhost:3001`.
