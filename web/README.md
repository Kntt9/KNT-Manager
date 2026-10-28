# KNT Manager — versão Web

O app desktop Tauri (Rust) portado para o navegador. A mesma interface, com os
dados salvos no próprio navegador (`localStorage`) e tudo que exige acesso ao
sistema operacional simulado ou adaptado.

## Como rodar

**Opção 1 — só abrir (modo demo):** dê dois cliques em `web/index.html` ou
abra em qualquer hospedagem estática. Funciona tudo, mas:
- Charts mostra um catálogo de jogos embutido (com ícones de placeholder);
- a validação de cookie não consulta a Roblox (aceita o formato e marca a conta);
- BloxGen funciona (o site dele libera CORS); Altgen e "Follow user" não.

**Opção 2 — completo (recomendado):** rode o servidor local, que faz o relay
das APIs da Roblox (elas bloqueiam CORS no navegador):

```bash
node web/server.mjs        # → http://localhost:4173
# ou
npm run web:serve
```

Com o servidor rodando: Charts ao vivo, validação real de `.ROBLOSECURITY`,
Altgen, "Follow user" e nomes de jogos reais. O relay escuta apenas em
`127.0.0.1`, aceita os hosts `localhost` e `127.0.0.1` na porta escolhida,
rejeita origens externas e limita corpos de requisição a 64 KiB.

Se você alterar algo em `src/` (o app Tauri) e quiser re-sincronizar o site:

```bash
npm run web:build          # copia src/ → web/ e aplica as adaptações de navegador
```

## O que funciona / o que é simulado

| Recurso | No navegador |
| --- | --- |
| Contas, categorias, grupos, lixeira, histórico do generator | ✅ real (localStorage) |
| Adicionar conta por cookie | ✅ real (com servidor) / aceita formato (offline) |
| Launch / Kill Roblox, volume, FPS cap, RAM trim, anti-AFK | 🎭 simulado (navegador não acessa o SO) |
| Charts (jogos em alta) | ✅ real (com servidor) / catálogo embutido (offline) |
| Tracking → Discord webhook | ✅ real (captura simulada desenhada em canvas e enviada) |
| Backup / restauração | ✅ real (baixa um arquivo `.kntweb.json`; restaurar re-lê o arquivo) |
| Login via navegador embutido (Chrome) | ❌ use "Paste Cookie" |
| Gerar conta manual (signup) | ⚠️ abre a página da Roblox; complete e cole o cookie |

Os dados, incluindo cookies e senhas, ficam em texto simples no `localStorage`
do navegador. Limpar os dados do site apaga as contas. Na validação real,
o cookie passa pelo relay local e é enviado à Roblox. Integrações opcionais
(geradores e webhook do Discord) também fazem requisições externas.
O modo offline pode aceitar o formato de um cookie sem verificar a identidade;
isso não equivale a uma sessão autenticada. A fila de requisições do desktop
ainda não foi portada para este relay.
