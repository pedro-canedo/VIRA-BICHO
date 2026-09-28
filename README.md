# BATLLE-BICHO

Battle royale de monstrinhos para o navegador. Todo mundo começa **chocando de um ovo**. Você nasce um bebê de nível 1, **vira o que você come**, compra habilidades para montar a sua build (Guerreiro, Mago ou Caçador) e, se perder uma batalha, **o vencedor rouba a sua evolução**. No fim, só as 2 maiores Forças disputam o Duelo Final, e sai o ranking completo da partida.

Partidas de 5, 10 ou 30 minutos, com 8 a 16 jogadores (bots completam a arena). O controle é só com mouse ou toque.

**Jogar:** https://batllebicho.caixazen.online

## Como funciona

**Modos** (escolhidos no menu; a sala privada usa o modo de quem a cria):

| Modo | Duração | Arena | Vagas de habilidade | Maestrias | Troféus |
|---|---|---|---|---|---|
| ⚡ Rápido | 5 min | 48/64 tiles | 4 | não | até 3 |
| ⚔️ Clássico | 10 min | ×1,25 | 6 | sim | até 5 |
| 🧠 Avançado | 30 min | ×1,5 | 8 | sim | até 8 |

No Avançado a Essência rende 45%, então a build se completa perto do fim, e não nos primeiros minutos.

**Fases** (os tempos abaixo são do Rápido; os outros modos esticam as mesmas fases):

| Rápido | Clássico | Avançado | Fase | O que acontece |
|---|---|---|---|---|
| 0:00–2:00 | 0:00–3:30 | 0:00–9:00 | Coleta | Só bichos selvagens. Coma para evoluir e juntar Essência. |
| 2:00–4:00 | 3:30–8:00 | 9:00–23:00 | Caçada | Dá para desafiar outros jogadores, e a zona começa a fechar. |
| 4:00–5:00 | 8:00–10:00 | 23:00–30:00 | Final | Os selvagens somem, e cada derrota custa 2 estágios. |
| 5:00 | 10:00 | 30:00 | Duelo Final | Só as **2 maiores Forças** seguem, com HP cheio, no centro da arena. Os demais assistem. Não há limite de turnos: a partir do 5º, a "fúria da arena" tira 10% de HP dos dois a cada turno. Quem vencer leva a partida. |

**Nascimento e evolução:**
- A partida começa com todo mundo dentro do ovo (2,5 s chocando). Do ovo sai um bebê de nível 1 (Bolinha, Faísca, Pingo, Semente…), que evolui para Filhote, Adulto e Forma final.
- O tipo depende do que você come:
  - **Tipos puros:** 🔥 Brasa, 🌊 Maré e 🌿 Broto.
  - **Híbridos:** Vapor, Cinza e Mangue.
  - **Quimera:** rara, surge quando os três tipos estão equilibrados.
- O corpo é sempre uma bolinha 16×16 que ganha peças (chamas, nadadeiras, folhas) desenhadas proceduralmente. O bestiário tem 32 formas.

**Batalha:**
- Os dois escolhem ao mesmo tempo, em segredo:
  - ⚔️ Ataque vence ⚡ Carga;
  - 🛡️ Defesa vence ⚔️ Ataque;
  - ⚡ Carga vence 🛡️ Defesa e dobra o próximo golpe.
- O 4º botão, **Especial**, só funciona para quem comprou um (veja abaixo).
- O triângulo de tipos multiplica o dano: Brasa > Broto > Maré > Brasa.
- São no máximo 4 turnos, dentro de uma bolha visível no mapa. Quem está do lado de fora pode esperar para atacar o vencedor enfraquecido.

**Morte e renascimento:**
- Quem perde entrega um estágio ao vencedor, que também absorve metade dos pontos de tipo do perdedor.
- Um bebê que perde para outro jogador (ou que zera o HP na zona) **morre e renasce de um ovo**, quantas vezes precisar. A cada morte, perde metade da Essência e dos pontos de tipo e volta ao nível 1. As habilidades compradas e os troféus ficam.
- Depois de renascer vem a **Fome**: 5 s de proteção e XP em dobro por 30 s.
- Ninguém sai da partida antes do Duelo Final: todos disputam a Força até o fim.

**Essência e loja:**
- Comer bichos, pegar frutas raras, vencer jogadores e derrubar a Coroa dão **Essência**.
- A loja (botão **Loja** ou tecla `L`) funciona a qualquer hora fora de batalha, e a partida continua enquanto você compra.
- São 3 linhas com 5 habilidades cada: 3 passivas, 1 Especial e 1 maestria (nível 3, só no Clássico e no Avançado). Os custos são 9, 18 e 30 de Essência.
- A classe surge do que você compra. Com 2 e com 4 habilidades da mesma linha você ganha um título e um bônus:

| Linha | Habilidades | 2 da linha | 4 da linha |
|---|---|---|---|
| 🗡️ Guerreiro | Couro Grosso (+20% HP), Golpe Pesado (Ataque +40%), Contra-ataque, **Golpe Brutal**, *Sede de Batalha* (cura ao vencer turno) | Aprendiz de Guerreiro: +10% de dano | Campeão: +10% de HP e +10% de dano |
| 🔮 Mago | Foco Elemental (vantagem de tipo ×1,75), Canalizar (Carga causa dano cheio), Escudo Arcano, **Explosão Arcana**, *Tempestade* (2 Especiais por batalha) | Aprendiz de Mago: Carregado ×2,25 | Arquimago: começa toda batalha Carregado |
| 🏹 Caçador | Passos Leves (+15% de velocidade), Faro (+1 de Essência por bicho), Esquiva, **Armadilha**, *Rastro* (+1 de XP por bicho) | Rastreador: +10% de velocidade | Predador: vencer um jogador rouba 2 de Essência |

**Especiais:** cada bicho carrega no máximo 1, com 1 uso por batalha (2 com Tempestade), e comprar outro troca o anterior sem ocupar vaga. Eles entram no triângulo:
- 💥 **Golpe Brutal** vence Ataque e Carga (×1,6) e perde para Defesa.
- 🔮 **Explosão Arcana** vence Defesa e Carga (×1,4) e perde para Ataque.
- 🪤 **Armadilha** vence Ataque e Defesa (×1,4) e perde para Carga.
- Dois Especiais se chocam e os dois levam dano.

**Força e ranking:**
- A **Força** soma estágio, troféus, habilidades (pelo custo), Essência guardada e vida.
- Ela ordena o placar, define a Coroa e escolhe os 2 finalistas do Duelo.
- Na tela final sai o **ranking completo**: todos os jogadores, com colocação, forma, Força, build, título e mortes. Os dois finalistas aparecem marcados.

**Mecânicas extras:**
- **Coroa:** a maior Força (a partir do nível 2) fica marcada no mapa e vale XP e Essência extras para quem a derrubar.
- **Troféus:** vitórias na forma final dão +10% de dano cada, até o teto do modo.
- **Fruta rara:** aparece no coração de cada bioma e dá pontos de tipo e Essência.

**Efeitos visuais ("Grimório de Pixels"):** cada elemento tem física própria (Brasa sobe, Maré cai e espirala, Broto flutua). Há feitiços no golpe, impacto com hitstop, círculo de runas na evolução, orbe da evolução roubada, eliminação em pixels, zona como barreira mágica, luz do Duelo Final, auras e ambiente vivo nos biomas. No painel de batalha, as cartas viram na revelação e há HP fantasma e selos de eficácia. Tudo em pixel art, sem blur, com orçamento de partículas e qualidade automática pelo FPS (ou escolhida no menu). Respeita `prefers-reduced-motion`. Para ver todos os efeitos em sequência, abra `/?fxdemo` (ou `/?fxdemo=eclosao`, `renascer`, `especiais`, `compra`, `bebes` para uma cena só). As telas da interface abrem sem servidor com `/?uidemo=<tela>` (`menu`, `lobby`, `hud`, `shop`, `battle`, `spectate`, `death`, `end`, `bestiary` e `help`; parâmetros `gm`, `ess` e `sk`).

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

Todos os números do jogo ficam em [`shared/src/balance.ts`](shared/src/balance.ts). Os modos estão em [`shared/src/modes.ts`](shared/src/modes.ts), e as habilidades, os títulos e a Força em [`shared/src/skills.ts`](shared/src/skills.ts). O desenho completo das builds está em [`docs/builds.md`](docs/builds.md).

## Desenvolvimento

```bash
npm install
npm run dev        # servidor (tsx watch, :3000) + Vite (:5173, com proxy do WebSocket)
npm test           # testes unitários + partidas simuladas
npm run typecheck
npm run sim -- 30 16 classico   # balanceamento: 30 partidas com 16 bots no modo Clássico (rapido | classico | avancado)
npm run build      # dist/public (cliente) + dist/server.mjs (servidor) + dist/obs.mjs e dist/obs-public (observador)
npm start          # roda o build em :3000
npm run dev:obs    # painel de observabilidade em :3001 com um jogo falso simulado
```

## Segurança e limites

O servidor não tem contas, então se protege sozinho na borda. Todos os limites ficam em [`server/src/security.ts`](server/src/security.ts) (objeto `SECURITY`), e os testes de ataque ficam em `tests/`.

- **IP real:** só vale o `CF-Connecting-IP`, e apenas quando a conexão vem de loopback (o cloudflared no próprio celular). `X-Forwarded-For` nunca é lido. IPv6 é agrupado por /64, com um segundo teto por /48 (conexões, handshakes e salas) contra quem gira de /64 dentro do mesmo bloco.
- **HTTP:** só GET/HEAD, estáticos servidos da memória (sem fallback de SPA), 60 requisições com recarga de 20/s por IP, timeouts contra slowloris e cabeçalhos de segurança (a CSP completa está em Report-Only).
- **WebSocket:** checagem de Origin, até 500 conexões no total, 16 por IP e 48 por /48 IPv6, taxa de handshakes (40 de uma vez, depois 1 a cada 2 s), hello em até 10 s, 60 s fora de sala para quem nunca entrou numa (5 min para quem já jogou nessa conexão), 2 min parado e vivo numa partida (um bot assume), mensagens de até 512 bytes, 20 mensagens com recarga de 10/s, pings do cliente limitados (5 com recarga de 1/s, sem pong automático), e fechamento por abuso com `terminate()` 1 s depois se o outro lado não responder ao close.
- **Lobby:** até 10 salas (8 privadas); por IP, no máximo 2 salas ao mesmo tempo (3 na partida rápida, por causa de CGNAT) e 4 por /48 IPv6; taxa de criação por IP (4 de uma vez, depois 1 a cada 150 s), cobrada só de salas que começam (entrar e sair do lobby devolve a ficha); códigos errados: 10/min por IP e 300/min no servidor inteiro. Entrar numa sala existente não tem limite por IP, então amigos no mesmo Wi-Fi jogam juntos.
- **Memória:** com o heap acima de 200 MB (o processo roda com `--max-old-space-size=256`), novos handshakes recebem 503 até o heap cair abaixo de 180 MB. A guarda olha o heap e não o RSS, porque o V8 não devolve o RSS depois de um pico.
- **/health:** pelo túnel responde só `{"ok":true}`. Pela LAN mostra os números, nunca os códigos das salas.

Variáveis de ambiente:

| Variável | Para quê |
|---|---|
| `PORT` | Porta (padrão 3000). |
| `HOST` | Interface de escuta. Sem valor, escuta em todas (LAN + túnel), como antes. |
| `PUBLIC_DIR` | Pasta do build do cliente (padrão `public` ao lado do `server.mjs`). |
| `ALLOWED_ORIGINS` | Origins extras aceitos no WebSocket, separados por vírgula. Os domínios públicos do jogo já vêm incluídos. `localhost` e IPs privados são aceitos fora do túnel. |
| `VB_TRUSTED_IPS` | IPs isentos dos limites por IP, separados por vírgula (ex.: a máquina do teste de carga na LAN, ou o IP público de uma escola/LAN party em que mais de 16 pessoas jogam atrás do mesmo NAT). |
| `OBS_INTERNAL_TOKEN` | Segredo do endpoint interno do observador (ver Observabilidade). Sem ele, ou com menos de 16 caracteres, o endpoint não sobe e o jogo roda igual. Depois de lido, o valor sai do `process.env` (não passa para processos filhos). |
| `OBS_INTERNAL_PORT` | Porta do endpoint interno, sempre em `127.0.0.1` (padrão 3002). |
| `VB_VERSION` | Versão reportada ao observador. Sem valor, vale a gravada no build (`package.json` + commit). |

Códigos de fechamento do WebSocket: 1008 (abuso ou mensagens inválidas), 1009 (mensagem grande), 1011 (erro interno), 1012 (reinício), 4001 (sem hello), 4002 (ocioso fora de sala), 4003 (parado na partida) e 4029 (conexões demais da mesma rede).

### Túnel e regras na Cloudflare

- A ingress do cloudflared **tem de apontar para `http://localhost:3000`**. Se apontar para o IP da LAN (`http://192.168.3.22:3000`), o servidor deixa de confiar no `CF-Connecting-IP` e todo o público vira uma chave só (16 conexões e 2 salas para o mundo inteiro). O servidor avisa no log com `cf_header_from_lan` quando isso acontece.
- As regras de borda valem para **os dois hosts**, `virabicho.caixazen.online` e `batllebicho.caixazen.online` (o Origin dos dois é aceito). Em cada regra, use `http.host in {"virabicho.caixazen.online" "batllebicho.caixazen.online"}`.
- Rate limiting sugerido: `/ws` com no máximo ~30 handshakes por IP a cada 10 s, e o site com ~200 requisições por IP a cada 10 s. Os limites do servidor continuam valendo como segunda camada; o teto global de 500 conexões é o último recurso contra ataque distribuído.

## Deploy (celular com Termux)

O servidor roda num Motorola One Hyper reaproveitado (Termux + runit), exposto pela Cloudflare Tunnel em `batllebicho.caixazen.online` → `http://localhost:3000`. A Cloudflare atende nas portas 443 (HTTPS/WSS) e repassa pelo túnel.

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
| 2 s | `GET http://127.0.0.1:3002/internal/stats?since=<seq>` no jogo (cabeçalho `x-obs-token`). Jogadores, salas, processo (RSS, CPU, lag do event loop, tick), contadores e eventos novos. Conexão recusada, ou duas consultas seguidas sem resposta em 1,5 s = jogo **fora do ar**; `startedAt` diferente = **reinício**. |
| 5 s | Amostra das séries (online, jogando, na sala, salas ativas, conexões, RSS/CPU/lag/tick do jogo, carga, RAM livre, temperatura, bateria) em buffers circulares de 24 h. |
| 5 s | Celular: `/proc/loadavg`, `/proc/meminfo`, `/proc/uptime`, `/sys/class/thermal/thermal_zone*/temp`, `/sys/class/power_supply/battery/*` e disco (`statfs`). O que o Android não deixar ler aparece como “—”. |
| 30 s | `sv status` dos serviços em `$PREFIX/var/service/*`. |
| 60 s | `GET PUBLIC_URL` (padrão `https://batllebicho.caixazen.online/health`): prova de que o túnel da Cloudflare está de pé, com a latência. Também roda na hora em que o jogo cai ou volta. |
| 60 s | Grava `series.bin` e `state.json` na pasta de dados (restaurados ao iniciar). |

Os eventos vão para `events-AAAA-MM-DD.ndjson` (um arquivo por dia, apagados depois de 7 dias, com teto de 20 MB por dia: passando disso, o resto do dia fica só no feed em memória). Ao iniciar, o observador lê só o fim desses arquivos, então um dia com muitos eventos não estoura a memória. As gravações de `series.bin`, `state.json` e `sessions.json` são atômicas e com `fsync`, para aguentar o celular desligar de repente. O contrato completo está em [`shared/src/obs.ts`](shared/src/obs.ts).

**Lado do jogo** ([`server/src/metrics.ts`](server/src/metrics.ts) e [`server/src/internal.ts`](server/src/internal.ts)): o jogo abre um segundo servidor HTTP, **só em `127.0.0.1:3002`** (`OBS_INTERNAL_PORT`), separado da porta 3000. Por isso o túnel, que aponta para `localhost:3000`, nunca chega a ele. O servidor só sobe com um `OBS_INTERNAL_TOKEN` de pelo menos 16 caracteres, e o token é conferido em tempo constante (sem ele: 401). Requisições com `CF-Connecting-IP`, `CF-Ray` ou `X-Forwarded-For` recebem 403, mesmo com o token. O servidor aceita só GET, tem timeouts curtos e um teto de 16 conexões e 20 requisições de uma vez (recarga de 5/s). O token é conferido antes do limite, e as requisições sem o token certo gastam um balde separado: um app qualquer do celular que martele a porta sem o token leva 429, mas não tira os dados do observador. Se a porta estiver ocupada, o jogo sobe do mesmo jeito, registra `obs_internal_listen_error` (uma linha, depois só a cada 10 falhas) e tenta de novo a cada 30 s; quando consegue, registra `obs_internal_listening`.
- **Contadores** cumulativos desde o início do processo. Uma partida em que todos os humanos saem no meio termina com `match_end` sem vencedor (`winner` e `form` nulos), então `matchesEnded` alcança `matchesStarted`. Os de segurança (`rateLimited`, `rejectedConnections`, `originRejected`) vêm do `SecurityLog`. `errors` soma exceções em timers, no tratamento de mensagens e no tick das salas.
- **Eventos** num buffer circular de 2000, com `seq` crescente. Os de segurança passam pelo mesmo throttle do log (1 por tipo e IP por minuto) e por um teto global (30 de uma vez, depois 1 a cada 2 s). Os de erro têm um teto parecido. Os contadores contam tudo. O `ipHash` é o mesmo `tag` do log: um hash com salt que muda a cada processo, nunca o IP.
- **Salas:** `bots` = jogadores que não são de humanos ainda na sala (bots desde o início e humanos que saíram), então `humans + bots` é sempre o total da partida, inclusive na tela de fim.
- **Jogadores:** `online` = humanos conectados em salas = `lobby` + `playing` (vivos na partida) + `spectating` (eliminados assistindo, ou na tela de fim). O país vem do `CF-IPCountry` só quando a conexão chega pelo túnel (loopback com `CF-Connecting-IP`). Direto ou pela LAN, o país é `XX`. O dispositivo sai do User-Agent.
- **Processo:** `tickMs` mede cada `lobby.tick` numa janela dos últimos 30 s. O lag do event loop vem do `monitorEventLoopDelay` com resolução de 50 ms (janela de cerca de 10 s, já descontada a resolução do timer). Ele só liga na primeira leitura autenticada: sem observador, ou com a porta interna ocupada, não custa nada. A CPU é medida entre duas coletas. No tick, o custo extra são duas leituras de relógio e uma escrita num `Float64Array` (~0,1 µs). Os ganchos da partida só rodam em entrada, início e fim, batalha e eliminação.
- Os logs do jogo nunca levam IP cru, token nem código de sala. O endpoint interno mostra os códigos, porque é local e autenticado.

```bash
# No celular, lendo o que o observador lê:
(. ~/.config/vira-bicho/secrets.env; curl -s -H "x-obs-token: $OBS_INTERNAL_TOKEN" 'http://127.0.0.1:3002/internal/stats?since=0')
```

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
# No próprio celular (o token não sai do aparelho):
(. ~/.config/vira-bicho/secrets.env; curl -H "Authorization: Bearer $OBS_TOKEN" http://127.0.0.1:3001/metrics)
```

**Acesso:** o jeito recomendado de abrir o painel é pelo túnel (HTTPS), de preferência atrás do Cloudflare Access. Pela rede local (`http://192.168.3.22:3001`) tudo trafega **em HTTP puro**: o token digitado, o cookie (que nesse caso fica sem `Secure`) e o Bearer passam em claro pelo Wi-Fi. Só use isso numa rede de confiança. Para o observador aceitar só conexões locais (o túnel), acrescente `OBS_HOST=127.0.0.1` ao `secrets.env`. O `deploy.sh` checa o `/healthz` de dentro do celular via SSH, então funciona nos dois modos.

**Segurança**
- O login troca o token por um cookie de sessão assinado com HMAC (HttpOnly, SameSite=Strict), válido por 7 dias. Atrás de HTTPS o cookie se chama `__Host-vbobs` e ganha `Secure`: o prefixo impede que outro subdomínio de `caixazen.online` plante um cookie com o mesmo nome.
- As sessões podem ser revogadas. **sair** invalida aquele cookie no servidor, inclusive cópias dele, e **sair de todos os aparelhos** (no rodapé) invalida todas as sessões. Streams SSE abertos dessas sessões são fechados na hora. Revogações ficam em `data/sessions.json`. Trocar o `OBS_TOKEN` também invalida tudo.
- O limite é de 5 falhas por minuto por cliente, e só as falhas contam: login certo e Bearer certo não gastam tentativas. Endereços IPv6 contam por /64, e há um teto global de 30 falhas por minuto somando todo mundo. Atrás do túnel, o IP real vem do `CF-Connecting-IP`, aceito só quando a conexão chega pelo loopback. Processos no próprio celular (loopback sem cabeçalhos de proxy) com o Bearer certo passam mesmo com o bloqueio ativo, porque eles já conseguem ler o `secrets.env`.
- Login e logout conferem `Sec-Fetch-Site`/`Origin` contra CSRF. CSP sem script nem estilo inline, `X-Frame-Options: DENY`, `nosniff` e `Referrer-Policy: same-origin`. Não é `no-referrer` porque, com ela, o navegador manda `Origin: null` no POST do formulário. Para outros sites nada é enviado. O painel não usa CDN, e apelidos e nomes de sala entram no DOM só como texto.

**Segredos:** o `setup-phone.sh` cria `~/.config/vira-bicho/secrets.env` (modo 600) com `OBS_TOKEN` (senha do painel) e `OBS_INTERNAL_TOKEN` (segredo compartilhado com o jogo) aleatórios, sem imprimir os valores. Se uma linha existir mas estiver vazia ou curta, o valor é gerado de novo. O observador carrega o arquivo inteiro. O jogo, que é o processo exposto à internet, recebe só o `OBS_INTERNAL_TOKEN`. Para ver o token no celular, use `grep OBS_TOKEN ~/.config/vira-bicho/secrets.env`.

**Variáveis:** `OBS_PORT` (3001), `OBS_HOST` (0.0.0.0), `OBS_TOKEN`, `OBS_INTERNAL_TOKEN`, `GAME_INTERNAL_URL` (`http://127.0.0.1:3002`), `PUBLIC_URL`, `OBS_DATA_DIR`, `OBS_PUBLIC_DIR` e `OBS_MAX_DAY_MB` (20).

**Consumo:** a meta era menos de 30 MB de RSS, mas o RSS não é a medida certa aqui. No PC (x86_64), o `obs.mjs` com as flags do serviço fica em cerca de 65 MB de RSS, e uns 45 MB disso são páginas do binário do Node, compartilhadas com o processo do jogo. O custo real é o **PSS** (`/proc/self/smaps_rollup`), em torno de 22 MB, ou a memória privada (RssAnon), em torno de 19 MB. A CPU fica em cerca de 0,1% de um núcleo. O cartão “Observador” do painel e o `/metrics` (`vb_obs_pss_megabytes`) mostram esses números. Ainda falta medir no celular (ARM). Um cliente SSE que para de ler não acumula dados: os ticks são coalescidos e o cliente é desconectado depois de 60 s travado.

Para abrir o painel pela internet, adicione um hostname no túnel da Cloudflare apontando para `http://localhost:3001`.
