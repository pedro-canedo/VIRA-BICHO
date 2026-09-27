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

## Deploy (celular com Termux)

O servidor roda num Motorola One Hyper reaproveitado (Termux + runit), exposto pela Cloudflare Tunnel em `batllebicho.caixazen.online` → `http://localhost:3000`. A Cloudflare atende nas portas 443 (HTTPS/WSS) e repassa pelo túnel.

```bash
bash scripts/setup-phone.sh   # uma vez: rsync + serviço runit "vira-bicho"
npm run deploy                # typecheck, testes, build no PC, rsync e restart
```

O build é feito no PC: no Termux o Node reporta a plataforma `android`, para a qual o Vite e o esbuild não têm binários nativos. O celular recebe só JavaScript pronto, sem nenhuma dependência para instalar.

Os endereços podem ser trocados com `PHONE_HOST` e `PHONE_PORT` (padrão `192.168.3.22:8022`).
