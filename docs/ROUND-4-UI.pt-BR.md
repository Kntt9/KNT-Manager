# Rodada 4 — interface Grafite

A interface interna passa a compartilhar tipografia, superfícies foscas, bordas, cores semânticas e controles. A mudança mantém HTML/JavaScript/Tauri e os comandos existentes. Não houve migração de dados, troca de framework ou alteração dos parâmetros de criptografia nesta rodada.

## Alterações e motivos

- `src/graphite.css`: camada visual comum para as 12 abas, cartões, listas, configurações, menus, notificações, tela de desbloqueio e diálogos internos. Remove desfoque do fundo dos diálogos, reduz animações e respeita a preferência de movimento reduzido. Mantém os temas existentes, alto contraste e os três modos de contas.
- `src/index.html` e `src/renderer.js`: lista de contas com estado e destino; botão de adicionar sempre acessível; painel lateral para selecionar e operar um grupo em janelas a partir de 1450 px. Em janelas menores as mesmas ações continuam na aba Grupos. Os botões reutilizam o lançamento/distribuição já existentes.
- O estado “Em fila” corresponde a um membro ainda pendente numa operação de grupo. Contas já tentadas ou canceladas saem da fila; processos confirmados aparecem como em execução. A apresentação não dispara consultas ou tentativas de autenticação adicionais.
- `src/ui-shell.js`: coordena abertura, fechamento e sobreposição de diálogos. O foco fica no diálogo e volta ao controle de origem; o conteúdo de fundo fica inerte. Importação de grupo e renomeação de perfil usam um formulário com a mesma aparência, substituindo `prompt()`.
- A troca de senha ganhou diálogo próprio com confirmação da nova senha. Divergências são recusadas antes do IPC; campos e cancelamento ficam protegidos durante a gravação. O procedimento transacional da rodada 3 continua no backend.
- Fontes Inter e Material Icons Round ficam em `src/assets/fonts/`, com licenças incluídas. A interface não depende do download dessas fontes ao abrir. `web/build-web.mjs` copia os mesmos estilos, scripts e fontes para a demonstração.
- Corrigida a aplicação imediata do tema: antes o código reaplicava o tema anterior antes de salvar a seleção. Também foram corrigidos nomes de padrões de fundo, título de FPS com `{v}` literal e alguns rótulos de edição/servidores.
- Corrigido o diálogo de grupo em janelas pequenas: cabeçalho e rodapé permanecem disponíveis, com rolagem no conteúdo. Menus fechados, tooltips ocultos e páginas inativas deixam de expor controles invisíveis na navegação.
- O editor mantém Ctrl+S, e Escape considera somente o diálogo superior. Fechar o login por Escape também cancela o fluxo de login. Atalhos do conteúdo de fundo ficam bloqueados enquanto um diálogo está aberto.
- `web/bridge.js`: adicionadas as assinaturas de eventos de visibilidade/Home que faltavam na demonstração e interrompiam sua inicialização. Isso não altera os eventos nativos do Tauri.

## Verificações desta rodada

- **69 testes JavaScript aprovados**, sem falhas. Incluem os fluxos anteriores de sessão, servidores, grupos, cancelamento, senha, desbloqueio e relay local; três testes de estados, confirmação de senha divergente, dois testes de seleção de tema e três testes de atalhos/diálogos.
- `npm run web:build`, verificações de sintaxe JavaScript e `git diff --check` aprovados.
- `cargo check --locked --offline --all-targets` aprovado e aplicativo Windows compilado com sucesso. A cópia de build GNU usa somente `rlib`, como no pacote anterior, sem alterar o manifest do repositório.
- Pacote Windows com subsistema GUI, WebView2Loader e licenças das fontes. Os manifests duplicados do linker GNU são normalizados para Common Controls v6; código, dados, imports e relocations são preservados e comparados byte a byte com o executável compilado. ZIP e SHA-256 verificados.
- Revisão no navegador com dados fictícios: navegação pelas 12 abas; conta/edição, iniciar, criar grupo, importação, renomeação e senha; Tab/Shift+Tab, restauração de foco, fundo inerte e temas claro/Grafite/alto contraste. Verificados 800×680, 1280×840 e 1600×900. Na janela mínima o diálogo de grupo mantém o rodapé dentro do viewport e os botões de contas permanecem disponíveis.
- A revisão visual usa a demonstração estática local. Não houve uso de cookies reais, alteração das suas senhas, envio de capturas ao Discord, download de executores ou lançamento do Roblox nessa revisão.
- Os **76 testes Rust passaram na rodada 3**. O código Rust permanece idêntico nesta rodada; essa suíte não foi executada novamente. A compilação e a checagem de todos os targets foram repetidas.

## Como testar a build 4

1. Feche as versões anteriores e extraia o ZIP inteiro numa pasta nova.
2. Para usar uma cópia dos seus dados, copie a pasta inteira `dados-teste` da build que você está usando para a pasta desta build. Mantenha a pasta original. Esse passo vale para o perfil isolado das builds anteriores; abrir diretamente o EXE usa o APPDATA normal.
3. Abra `TESTAR.cmd`, desbloqueie com a senha atual e confira contas, grupos, lixeira e histórico.
4. Se houver um tema anterior salvo, selecione **Configurações → Temas → Grafite** para reproduzir as imagens da nova interface.
5. Passe pelas abas. Em Contas alterne lista, grade e compacto; abra edição, servidores e iniciar. Cancele os diálogos e confira a volta ao botão de origem. Redimensione a janela.
6. Em Grupos abra Novo grupo/Editar e confira membros e ordem; teste uma conta e depois um grupo pequeno. Confira destino, resultados e cancelamento, incluindo a distribuição em servidores distintos.
7. O painel de grupo na aba Contas aparece com a janela ampla, a partir de 1450 px. Ele usa o mesmo grupo e as mesmas ações da aba Grupos.
8. Troca de senha e backup são opcionais neste teste de aparência. Caso os teste, faça isso no perfil copiado e confira os dados e o desbloqueio após reiniciar.

## Limites e próxima prioridade

O teste com o executável Tauri, WebView2, DPI/escala do Windows e contas reais continua com o usuário. O navegador não valida IPC nativo, processos reais, login Roblox nem a disponibilidade atual dos servidores. Não foi medido ganho de desempenho nesta rodada. Diálogos de arquivos do Windows e páginas externas de autenticação mantêm o visual dos seus próprios sistemas.

Próxima prioridade: validar esta build com uma conta e um grupo pequeno, corrigir eventuais problemas de escala/navegação e depois retomar a transferência dos segredos de gerador que ainda usam `localStorage` para armazenamento protegido. Não houve push, deploy ou publicação de release.
