# Relatório — BATLLE-BICHO (atualizado em 28/09/2026)

## No ar

| O quê | Onde |
|---|---|
| Jogo | https://batllebicho.caixazen.online (http:// redireciona para https) |
| Jogo pela rede de casa | http://192.168.3.22:3000 |
| Painel de observabilidade | http://192.168.3.22:3001 (rede de casa) |
| Código | https://github.com/pedro-canedo/VIRA-BICHO (branch `main`) |

Tudo roda no Motorola One Hyper (Termux + runit). O PC pode ficar desligado: ele só é necessário para publicar versões novas (`npm run deploy`).

### Token do painel

Rode no terminal (no Claude Code, com `!` na frente):

```
ssh -p 8022 192.168.3.22 'sed -n "s/^OBS_TOKEN=//p" ~/.config/vira-bicho/secrets.env'
```

A sessão do painel dura 7 dias. Para acessar de fora de casa, crie no túnel uma rota como `status.caixazen.online` → `http://localhost:3001`. Proteja essa rota com o **Cloudflare Access** (login pelo seu e-mail, gratuito).

## Rodada de 28/09/2026: eclosão, builds, renascimento e modos

1. **Nascer do ovo:** o ovo deixou de ser um estágio. Todos começam chocando (2,5 s, com rachaduras e casca voando) e saem como um bebê de nível 1, com nome próprio por forma (Bolinha, Faísca, Pingo, Semente, Bafinho, Brasinha, Poçinha, Grudinho). Depois vêm Filhote, Adulto e Forma final. O bestiário passou a 32 formas.
2. **Loja de habilidades:** a Essência vem de bichos, frutas, vitórias, abates e da Coroa. Há 3 linhas (🗡️ Guerreiro, 🔮 Mago e 🏹 Caçador), cada uma com:
   - 3 passivas;
   - 1 Especial;
   - 1 maestria (só no Clássico e no Avançado).

   A classe surge do que você compra. Com 2 e 4 habilidades da mesma linha vêm os títulos e os bônus (Campeão, Arquimago, Predador…). O Especial é o 4º botão da batalha e entra no triângulo: Golpe Brutal, Explosão Arcana e Armadilha vencem duas ações cada e perdem para uma.
3. **Renascimento infinito:** o bebê que morre renasce de um ovo quantas vezes precisar. Cada morte custa metade da Essência e dos pontos de tipo e zera o XP; as habilidades e os troféus ficam. Ninguém sai da partida antes do Duelo Final.
4. **Duelo Final e ranking:** no fim de cada modo, só as **2 maiores Forças** (estágio, troféus, build, Essência e vida) vão para o duelo. A tela final traz o **ranking completo** com todos os jogadores.
5. **Modos:**
   - ⚡ Rápido: 5 min;
   - ⚔️ Clássico: 10 min, arena ×1,25, 6 vagas e maestrias;
   - 🧠 Avançado: 30 min, arena ×1,5 e 8 vagas; a Essência rende 45% para a build se completar perto do fim.

   Cada modo tem a sua fila na partida rápida, e a sala privada usa o modo de quem a criou.
6. **Visual:** eclosão, renascimento, efeitos dos 3 Especiais, efeito de compra e selo da build no mapa. A loja se adapta ao celular (abas por linha).

Testes: **348**. As simulações deram taxas de vitória por linha entre 27% e 38% nos 3 modos (a meta era nenhuma passar de 45%), e os finalistas foram sempre as 2 maiores Forças em 500 partidas. O fluxo completo (menu → eclosão → comer bichos → loja → compra → batalha com o 4º botão) passou no Chrome do PC e no Chrome Android com toque.

**Decisões tomadas por mim:**
- O renascimento vale nos 3 modos.
- Quem renasce ganha a Fome: 5 s de proteção e XP em dobro por 30 s.
- A Coroa passou a ir para a maior Força (a partir do nível 2).
- O multiplicador de Essência do Avançado ficou em 0,45.
- O teto de troféus depende do modo: 3, 5 ou 8.

**Para testar no seu iPhone:** o WebKit de teste deste PC (Playwright no Fedora) trava em batalhas, mas trava do mesmo jeito com a versão anterior do jogo, então é um problema do ambiente de teste e não do jogo. Mesmo assim, vale jogar uma partida no Safari de verdade.

## Rodada de 27/09/2026

1. **Duelo Final:** aos 5:00, ou quando sobram só 2 jogadores, os 2 mais evoluídos lutam com HP cheio no centro da arena. A partir do 5º turno, a "fúria da arena" tira HP dos dois a cada turno, garantindo um vencedor. Quem ficou de fora assiste. Em 60 partidas simuladas, os finalistas foram sempre os 2 mais evoluídos e as partidas duraram ~5:20.
2. **Nome:** BATLLE-BICHO na interface. Repositório, pastas e serviços continuam `vira-bicho`.
3. **Segurança** (auditada por 3 lentes e atacada de verdade):
   - Havia 5 formas de derrubar o servidor com uma única requisição (por exemplo, `GET /%FF`), e a produção de fato caía. Todas foram corrigidas.
   - Limites por conexão, IP e rede (sem bloquear amigos no mesmo Wi-Fi) e validação estrita das mensagens.
   - Origens autorizadas (batllebicho e virabicho), cabeçalhos de segurança e `/health` público sem códigos de salas privadas.
   - Processo com teto de memória e log rotativo.
4. **Observabilidade** (serviço `vira-bicho-obs`, porta 3001):
   - Painel ao vivo com jogadores online, salas, partidas, eventos, países e dispositivos, saúde do processo e do celular, checagem do domínio público e um painel de segurança.
   - Histórico de 24 h, eventos guardados por 7 dias e `/metrics` no formato Prometheus.
   - O jogo expõe as métricas só em `127.0.0.1:3002`, com token.
5. **Toque no iPhone:** o Phaser ficava com o "dedo preso" quando um botão da sala de espera era redesenhado durante o toque, e ignorava todos os toques seguintes da partida. Corrigido e validado no motor do Safari e no Chrome Android com toques reais.
6. **Efeitos de magia ("Grimório de Pixels"):** 42 efeitos em 3 frentes (servidor, mundo e interface).
   - No mapa: feitiços por elemento, impacto com hitstop, runas de evolução, orbe da evolução roubada, eliminação em pixels, zona como barreira mágica, luz do Duelo Final, auras e ambiente vivo.
   - No painel: cartas na revelação, HP fantasma e selos de eficácia.
   - Qualidade automática pelo FPS (ou escolhida no menu) e respeito a `prefers-reduced-motion`. Para ver todos os efeitos em sequência, abra `/?fxdemo`.

Testes: **301**, incluindo partidas inteiras simuladas e ataques reais. A verificação final passou em Chrome (desktop e celular), WebKit (iPhone) e contra a produção.

### Decisões tomadas por mim nessa rodada (você liberou)

- A Morte súbita foi substituída pelo Duelo Final. Antes do duelo, a fase Final tem "derrota dobrada" (cada derrota custa 2 estágios) e não tem selvagens.
- O limite de criação de salas ficou em 8 por IP, com recarga de 1 por minuto (Wi-Fi compartilhado e CGNAT).
- A CSP de conteúdo ficou em modo "Report-Only", para não quebrar os efeitos. As proteções contra frames e objetos estão ativas.
- O painel escuta em toda a rede local (HTTP sem criptografia dentro de casa). Para aceitar só o túnel, acrescente `OBS_HOST=127.0.0.1` ao `secrets.env`.

## Pendências (não urgentes, dependem do painel da Cloudflare)

- **virabicho.caixazen.online** tem a rota no túnel, mas não tem DNS. Crie um CNAME `virabicho` → `0f427765-7bd2-4582-b25c-ecba4f251449.cfargotunnel.com` (com proxy), ou apague a rota se não for usar.
- Opcional: ativar "Sempre usar HTTPS" na Cloudflare. O servidor já redireciona sozinho, então isso é só um reforço.
- Opcional: uma regra de rate limit no plano gratuito (por IP, 60 requisições em 10 s, exceto `/assets/`).

## Pontos conhecidos de baixa prioridade

- Com dois bichos colados na vertical, a barra de HP de um pode encostar no sprite do outro.
- No Safari aparece no console um aviso da CSP Report-Only (sem `report-to`). Não afeta o jogo.
- Os efeitos do último tick de uma partida podem não chegar (a tela final entra por cima).
- Cinco IPs diferentes conseguem ocupar as 10 arenas ao mesmo tempo (limite de capacidade do celular).
- No Avançado a Quimera vence com frequência. O motivo é a distribuição das formas, não as builds; vale observar em partidas reais.
- Nas capturas de tela feitas por este PC os emojis aparecem como quadrados. É uma limitação do Chromium de teste: nos celulares e navegadores normais eles aparecem.

## Como continuar

```bash
cd ~/Downloads/VIRA-BICHO
npm install
npm run dev            # jogo local em :5173 (/?uidemo=shop e /?fxdemo=eclosao mostram telas e efeitos sem jogar)
npm test               # 348 testes
npm run sim -- 30 16 avancado   # balanceamento (rapido | classico | avancado)
npm run deploy         # publica no celular (PC e celular na mesma rede)
```

A conversa pode ser retomada com `claude --resume`.
