# Rodada 5 — composição e navegação do aplicativo

Esta rodada reorganiza as telas e os formulários. A estrutura aparece em qualquer tema; não exige selecionar Grafite. Os comandos de autenticação, escolha de servidores, criptografia e persistência continuam no backend existente.

## O que muda no uso

- **Contas:** tabela contínua com seleção por linha, conta, grupo, status, destino e ações. Categorias passam a ser um filtro da tabela; grade/compacto continuam disponíveis. A categoria selecionada ainda pode ser iniciada pelo botão correspondente. Filtros de todas/em jogo/paradas/em fila ficam visíveis, com contagens que usam o estado real da sessão. Ao mudar de estado, a conta sai dos filtros que deixaram de corresponder.
- **Ações em lote:** ficam numa barra dentro da tela de contas. Iniciar e criar grupo têm acesso direto; ações secundárias ficam em Mais ações. Selecionar todas respeita o filtro atual e preserva seleções fora dele.
- **Ações de uma conta:** Iniciar fica na linha. Editar, servidores, copiar dados, abrir no navegador e mover para a lixeira ficam no menu. O caminho de iniciar pelo menu agora prepara o mesmo diálogo do botão principal, corrigindo a possibilidade de reaproveitar uma prévia antiga.
- **Grupos:** catálogo à esquerda e detalhes do grupo selecionado à direita. Membros, destino, iniciar, distribuir, servidores e ações adicionais continuam disponíveis. Selecionar outro grupo troca o painel sem iniciar contas. O painel de grupo na tela de contas aparece a partir de 1160 px; em janelas menores as ações seguem na tela Grupos.
- **Distribuição:** formulário mostra grupo, membros aguardando e a regra de servidores diferentes com outro jogador. Não inventa servidores, vagas ou ocupação. A consulta e a distribuição existentes só começam ao confirmar; contas sem destino disponível continuam sem ser iniciadas.
- **Navegação:** sete entradas principais. Painel, Jogos, Gerador, Tracking, Exploits e Créditos ficam acessíveis na área Ferramentas. As funcionalidades existentes não foram removidas.
- **Configurações:** categorias laterais e conteúdo separado. Criptografia mantém o indicador do modo de proteção; criar/restaurar backup ocupam duas áreas próprias. Mixer reúne descrição, controle e valor na mesma linha. Gerador e Tracking usam áreas separadas para seus fluxos; logs têm cabeçalho de colunas e busca acessível por botão.
- **Formulários:** adicionar conta mostra os dois métodos como opções separadas; iniciar mostra conta e destino em áreas distintas; grupo separa identificação/opções de membros/ordem. Edição separa perfil/organização de jogo/acesso. Os diálogos compartilham cabeçalho, corpo e rodapé, mantendo os IDs, eventos, foco e proteção de operações pendentes.

## Arquivos principais

- `src/index.html`: nova navegação, área Ferramentas, tabela e controles de contas, composição do lançamento e formulário de distribuição.
- `src/workspace-ui.js`: apresentação da tabela, seleção, filtros, catálogo de grupos e composição dos controles já existentes. Atualiza informações locais sem consultar serviços para desenhar a tela.
- `src/workspace.css`: geometria e adaptação das áreas; as cores continuam no sistema de temas.
- `src/renderer.js`: integra as novas áreas e preserva os comandos existentes; mantém acesso a servidores e lixeira pelo menu.
- `src/ui-shell.js`: integra a composição dos diálogos e evita focar controles em menus ocultos.
- `src/i18n/*.js`, `web/build-web.mjs` e arquivos espelhados em `web/`: textos e demonstração sincronizados.
- `tests/workspace-ui.test.mjs`: nove verificações de seleção, grupos, filtros, encaminhamento das ações, prévia sem lançamento antecipado e escape de texto.

## Verificações

- **78 testes JavaScript aprovados**, sem falhas. Incluem os fluxos anteriores e os nove testes desta rodada.
- `npm run web:build`, sintaxe JavaScript e `git diff --check` aprovados.
- `cargo check --locked --offline --all-targets` e compilação Windows aprovados. A cópia temporária de build GNU usa `rlib`, como nas builds anteriores; o manifest do repositório permanece preservado.
- Pacote com subsistema GUI, WebView2Loader, licenças e SHA-256. Manifests do linker GNU normalizados para Common Controls v6; código, dados, imports e relocations comparados com o executável compilado. ZIP verificado.
- Demonstração local com contas fictícias: seleção por linha, seleção múltipla, menu de conta, importação de grupo, troca entre dois grupos e seus membros, métodos de adicionar, lançamento simulado e atualização automática dos filtros. O lançamento simulado saiu de Paradas e apareceu em Em jogo. Não foi aberto um cliente Roblox real nessa verificação.
- Navegação conferida nas telas principais e nos seis recursos da área Ferramentas. Conferidos tamanho mínimo de 800×680, tamanho padrão de 1280×840 e capturas em 1280×720. Na janela mínima os botões da tabela cabem na tela e o rodapé do formulário de grupo fica dentro do viewport.
- Código Rust não alterado nesta rodada. A suíte de 76 testes Rust passou na rodada 3; não foi executada novamente. Checagem e compilação foram repetidas.

## Como testar a build 5

1. Feche o KNT anterior e extraia o ZIP inteiro em uma pasta nova.
2. Se usa o perfil isolado das builds anteriores, copie a pasta inteira `dados-teste` para a pasta desta build. Preserve a original. Abra `TESTAR.cmd`; abrir diretamente o EXE usa o APPDATA normal do Windows.
3. Desbloqueie com a senha atual. A nova organização já deve aparecer, mesmo mantendo seu tema anterior.
4. Teste busca, filtros, categoria, seleção e o menu da linha. Abra edição, servidores e iniciar; confira conta/destino antes de iniciar.
5. Abra Grupos e selecione grupos diferentes. Confira membros e destino. Teste uma conta e depois um grupo pequeno; confira distribuição e cancelamento.
6. Passe por Configurações e Ferramentas. Confira que seus ajustes permanecem. Teste redimensionamento, grade/compacto e teclado.

## Limites e próxima prioridade

A demonstração não valida IPC Tauri, login real, disponibilidade de servidores nem DPI/escala do Windows. O teste desses pontos fica para a build nativa. Não foi medido ganho de desempenho nem alterado o armazenamento de segredos nesta rodada. Janelas de arquivos do Windows e autenticação externa mantêm a interface do sistema ou serviço.

Próxima prioridade: recolher feedback da disposição e dos caminhos de uso nesta build, corrigir regressões de escala/fluxo e retomar a proteção dos segredos de gerador ainda mantidos em `localStorage`. Nenhum push, deploy ou release foi realizado.
