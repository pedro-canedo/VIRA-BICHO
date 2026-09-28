# Design: nascimento, builds, renascimento e modos

Decisões do usuário (27/09/2026):
- O jogo não começa com ovo jogável: o bicho **nasce do ovo** (animação curta) como bebê Nível 1 e evolui até o Nível 4.
- A classe **surge das compras** (Guerreiro, Mago, Caçador), com títulos e bônus de conjunto.
- Na batalha: **passivas + 1 Especial** (4º botão, uma vez por batalha).
- **Ninguém é eliminado**: quem morre renasce do ovo quantas vezes precisar, perdendo parte do que juntou. Na última onda, os **2 mais fortes** vão ao Duelo Final e o **ranking completo** é montado.
- Modos: **Rápido (5 min)**, **Clássico (10 min)** e **Avançado (30 min)**.

## Contrato (já implementado em `shared/src`)

- `modes.ts`: `GameMode`, `MODES` (fases, escala do mapa, vagas de habilidade, maestria, teto de troféus).
- `skills.ts`: catálogo `SKILLS` (15 habilidades), `LINE_INFO`, `SPECIAL_INFO`, `modsOf` (passivas + conjuntos), `specialOf`, `titleOf`, `canBuy`, `withSkill`, `powerOf` (Força).
- `battle.ts`: `resolveTurn` com Especiais (`moveOf`, `beatsAction`) e passivas de batalha (Esquiva, Escudo Arcano, Sede de Batalha, Foco Elemental, Canalizar, Contra-ataque, Golpe Pesado, bônus de dano e de Carregado). Estado por batalha no `Combatant` (`specialLeft`, `shieldUsed`, `dodgeUsed`, `charged`).
- `balance.ts`: `essence` (ganhos) e `respawn` (chocar 2,5 s, mantém 50% da Essência e dos pontos).
- `protocol.ts`: `hello.gm`, `buy`, `act 'especial'`, `EntSnap.hx/ln/tl`, `SelfSnap.essence/skills/power/deaths/hatchMs`, `LeaderRow.pw/ln/tl`, `FighterInfo.skills/special/specialLeft`, `b_reveal.move*/heal*/dodge*/shield*/spLeft*`, `lobby.gm`, `start.gm`, `death`, `end.ranking` (`RankRow`), FxEvent `h.sp`, `r` (nasceu/renasceu) e `k` (compra).

## Regras de jogo

**Nascimento.** No início da partida todos ficam `respawn.hatchMs` chocando: não andam, não miram e não podem ser alvo (`EntSnap.hx`). O servidor emite FxEvent `r` para cada um. O estágio 0 passa a ser o bebê (Nível 1), não um ovo.

**Essência.** Começa com `essence.start`. Ganha comendo selvagem (`wild` + `mods.wildEssence`), pegando fruta rara (`fruit`), vencendo jogador (`pvpWin`; `crown` extra se ele tinha a Coroa; `kill` extra se ele morreu; `mods.stealEssence` do Predador tirado do perdedor).

**Loja.** `buy` só fora de batalha e enquanto vivo; valida com `canBuy(skills, essence, id, mode)`; aplica `withSkill` (um Especial novo substitui o antigo). A vida máxima muda com `hpMult` (preservar a fração de HP). Emite FxEvent `k`. Bots também compram.

**Build no mundo.** HP máximo = `BALANCE.hp[stage] × mods.hpMult`. Passo no mapa = `BALANCE.stepMs / mods.speedMult`. Comer selvagem: cura `healOnWildPct × wildHealMult`, XP `1 + wildXp` (dobrado pela Fome). Faro revela frutas no minimapa (cliente).

**Build na batalha.** Cada lado do `Battle` guarda `specialLeft` (= `mods.specialUses` se tiver Especial), `shieldUsed`, `dodgeUsed` e `charged` (começa `true` com Arquimago). `act 'especial'` sem Especial disponível vira Defesa (`moveOf`). Cura (`heal*`) aplicada depois do dano, até o máximo. Bots usam o Especial às vezes (≈35% por turno enquanto houver uso).

**Morte e renascimento.** Onde antes havia eliminação (perder no Nível 1, zona no Nível 1): o jogador morre, emite FxEvent `x` e a mensagem `death`, perde `1 - essenceKeep` da Essência e `1 - pointsKeep` dos pontos de tipo, zera XP, mantém habilidades e troféus, e renasce como bebê num tile caminhável dentro da zona a pelo menos `respawn.minDist` de outros jogadores, chocando de novo (FxEvent `r`). `stats.deaths++`. Só o corte do Duelo Final tira alguém da partida (mensagem `elim` com reason `duelo`).

**Força e Duelo Final.** `powerOf` decide o placar (`lb` ordenado por `pw`) e os finalistas. Aos `MODES[gm].phases.finalEnd`, os 2 com mais Força duelam (regras atuais do duelo). Os demais assistem.

**Ranking.** No fim: 1º e 2º pelo resultado do duelo, os outros pela Força no início do duelo (desempate: menos mortes, depois mais vitórias). A mensagem `end` leva o ranking completo com a build de cada um.

**Modos.** Fases, escala do mapa (`mapScale` sobre 48/64 tiles), vagas, maestria e teto de troféus vêm de `MODES`. A partida rápida tem uma fila por modo; salas privadas escolhem o modo ao criar.

## Interface

- Menu: escolha do modo (3 cartões) para jogar e para criar sala. A sala de espera mostra o modo.
- HUD: Essência ✨, botão da loja (com aviso quando dá para comprar algo), título da build, Força, mortes; relógio das fases pelo modo.
- Loja: 3 colunas (linhas), cartões com ícone, nome, descrição, custo e tier; estados comprado/sem Essência/sem vaga/maestria bloqueada; bônus de conjunto e título; aviso de troca de Especial. Fecha sozinha quando começa uma batalha.
- Batalha: 4º botão Especial (ícone e nome da build, usos restantes, "vence X e Y"). A revelação mostra o Especial; esquiva, escudo e cura aparecem. Títulos e passivas do oponente ficam visíveis.
- Morte: aviso "Você morreu, renascendo…", com o que foi perdido.
- Fim: ranking completo (posição, bicho, nome, título, Força, mortes) e a sua build.
- Bestiário: bebês (estágio 0) de cada forma.
- Como jogar: novas regras.

## Mundo (Phaser)

- `creature.ts`: estágio 0 desenhado como bebê (corpo menor, olhos grandes, cor do elemento dominante); função separada para o ovo da eclosão.
- Eclosão: ovo treme e racha (≈2 s), estoura em partículas e revela o bebê (FxEvent `r` e `EntSnap.hx`).
- Distintivo da linha do título ao lado do nome (ícone, com destaque para o mestre).
- Especiais: golpe gigante (Brutal), orbe e raio arcano roxo (Arcana), rede e espinhos (Armadilha) no FxEvent `h` com `sp`.
- Compra: brilho na cor da linha (FxEvent `k`).

## Ajustes feitos no balanceamento

Estes números saíram das simulações (`npm run sim -- N P modo`). Todos ficam em `shared/src/balance.ts`, `modes.ts` e `skills.ts`.

**Economia**
- **Essência:** começa com 3. Rende 2 por selvagem, 4 por fruta, 5 por vitória contra jogador, +5 por derrubar a Coroa e 3 por abate.
- **Custos:** 9 / 18 / 30 por nível; o Faro custa 14.
- **Multiplicador do Avançado:** `essenceMult` = 0,45, com a fração guardada por jogador (`Player.essenceFrac`). Sem ele a build completava por volta dos 9 minutos. Com ele, em 60 partidas de 16 bots:
  - 3,6 habilidades no fim da Coleta;
  - 6,8 no fim da Caçada;
  - 7,1 no Duelo (os finalistas, 8,0).

**Habilidades**
- Couro Grosso dá +20% de HP e Golpe Pesado +40% de dano.
- Aprendiz de Guerreiro dá +10% de dano.
- Sede de Batalha cura 8% por turno vencido.
- Passos Leves dá +15% de velocidade e Rastreador +10%.
- O Predador rouba 2 de Essência.
- Armadilha causa ×1,4.

**Força**
- As habilidades contam pelo custo, e a Essência guardada conta ×0,5.
- A Coroa vai para a maior Força a partir do nível 2, com 10 pontos de histerese para não ficar trocando de dono.

**Renascimento**
- Quem renasce sai do ovo com a Fome: 5 s de proteção e XP em dobro por 30 s.
- A quantidade de selvagens não cresce com o tamanho da arena.
- Um clique dado durante a eclosão fica guardado e é executado quando o bicho sai do ovo.

**Taxa de vitória por linha (build dominante do campeão)**

| Modo | Guerreiro | Mago | Caçador |
|---|---|---|---|
| Rápido | 34% | 30% | 37% |
| Clássico | 31% | 34% | 36% |
| Avançado | 38% | 35% | 27% |

A meta é nenhuma linha passar de 45%. Os finalistas foram sempre as 2 maiores Forças (500 partidas).

**Em observação:** a Quimera vence com frequência no Avançado. O motivo é a distribuição das formas, não as builds.
