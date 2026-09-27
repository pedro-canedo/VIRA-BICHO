# BATLLE-BICHO

Battle royale de monstrinhos para o navegador. Você nasce como um ovo, **vira o que você come** e, se perder uma batalha, **o vencedor rouba a sua evolução**.

Partidas de ~5 minutos, 8 a 16 jogadores (bots completam a arena), controle só com mouse ou toque.

**Jogar:** https://batllebicho.caixazen.online

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
scripts/  build do servidor, simulação de balanceamento, setup e deploy no celular
```

Todos os números do jogo ficam em [`shared/src/balance.ts`](shared/src/balance.ts).

## Desenvolvimento

```bash
npm install
npm run dev        # servidor (tsx watch, :3000) + Vite (:5173, com proxy do WebSocket)
npm test           # testes unitários + partidas simuladas
npm run typecheck
npm run sim -- 30 16   # estatísticas de balanceamento: 30 partidas com 16 bots
npm run build      # dist/public (cliente) + dist/server.mjs (servidor num arquivo só)
npm start          # roda o build em :3000
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

Códigos de fechamento do WebSocket: 1008 (abuso ou mensagens inválidas), 1009 (mensagem grande), 1011 (erro interno), 1012 (reinício), 4001 (sem hello), 4002 (ocioso fora de sala), 4003 (parado na partida) e 4029 (conexões demais da mesma rede).

### Túnel e regras na Cloudflare

- A ingress do cloudflared **tem de apontar para `http://localhost:3000`**. Se apontar para o IP da LAN (`http://192.168.3.22:3000`), o servidor deixa de confiar no `CF-Connecting-IP` e todo o público vira uma chave só (16 conexões e 2 salas para o mundo inteiro). O servidor avisa no log com `cf_header_from_lan` quando isso acontece.
- As regras de borda valem para **os dois hosts**, `virabicho.caixazen.online` e `batllebicho.caixazen.online` (o Origin dos dois é aceito). Em cada regra, use `http.host in {"virabicho.caixazen.online" "batllebicho.caixazen.online"}`.
- Rate limiting sugerido: `/ws` com no máximo ~30 handshakes por IP a cada 10 s, e o site com ~200 requisições por IP a cada 10 s. Os limites do servidor continuam valendo como segunda camada; o teto global de 500 conexões é o último recurso contra ataque distribuído.

## Deploy (celular com Termux)

O servidor roda num Motorola One Hyper reaproveitado (Termux + runit), exposto pela Cloudflare Tunnel em `batllebicho.caixazen.online` → `http://localhost:3000`. A Cloudflare atende nas portas 443 (HTTPS/WSS) e repassa pelo túnel.

```bash
bash scripts/setup-phone.sh   # uma vez: rsync + serviço runit "vira-bicho"
npm run deploy                # typecheck, testes, build no PC, rsync e restart
```

O build é feito no PC: no Termux o Node reporta a plataforma `android`, para a qual o Vite e o esbuild não têm binários nativos. O celular recebe só JavaScript pronto, sem nenhuma dependência para instalar.

Os endereços podem ser trocados com `PHONE_HOST` e `PHONE_PORT` (padrão `192.168.3.22:8022`).
