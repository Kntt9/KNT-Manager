# KNT Manager 2.5.0

## Novidades
- Layout reorganizado: tabela de contas, navegação por grupos e painel lateral com ações rápidas.
- Nome e imagem do jogo nos grupos a partir do Place ID, com cache e fila de consultas.
- Estética consistente entre páginas, configurações e janelas de diálogo; fontes incluídas no pacote.
- Status de espera e acompanhamento dos lançamentos em grupo.

## Correções e confiabilidade
- Correção do erro HTTP 415 na obtenção do ticket de entrada.
- Operações de contas e criptografia retiradas da thread da interface para reduzir travamentos ao desbloquear e adicionar contas.
- Distribuição entre servidores públicos distintos, com pelo menos outro jogador e tratamento de cancelamento.
- Controles de concorrência, limites de tentativas e tratamento de falhas nas requisições.
- Gravação de dados com validação, arquivos temporários e recuperação de transações interrompidas.
- Melhorias de teclado, foco e confirmação nos diálogos.

## Download para Windows
1. Baixe **[KNT-Manager-v2.5.0.exe](https://github.com/Kntt9/KNT-Manager/releases/download/v2.5.0/KNT-Manager-v2.5.0.exe)**.
2. Abra o executável normalmente. O carregador WebView2 e o runtime C estão incorporados; não é necessário baixar DLLs separadas.
3. Se o Windows informar que falta o WebView2 Runtime, instale o **[WebView2 Runtime — download oficial da Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download-section)** (Evergreen Bootstrapper) e abra o aplicativo novamente.

O aplicativo usa o perfil normal do Windows. Se você usava uma versão de teste com a pasta dados-teste, suas contas continuam naquele perfil separado; mantenha essa pasta e faça a migração por backup/restauração antes de abandoná-la.

**Source code (zip)** e **Source code (tar.gz)** contêm apenas o código-fonte, para quem deseja compilar ou modificar o projeto. Não são instaladores.

Os hashes dos downloads estão em **SHA256.txt**, e as licenças estão em **LICENCAS.txt**. Nenhuma conta ou credencial é distribuída.

## Validação e limites
- 84 testes JavaScript aprovados, incluindo fila/cache de metadados e fluxos de lançamento.
- Verificação dos alvos Rust e compilação Windows concluídas.
- 76 testes Rust aprovados na rodada de persistência; as rodadas seguintes alteraram a interface.
- Nome e imagem reais de Anime Legacy Simulator conferidos na prévia; testes visuais usam contas fictícias.
- A build anterior foi testada e aprovada pelo mantenedor. O ajuste de versão desta release não muda os fluxos.
- Sem conexão ou metadados disponíveis, o app mantém o Place ID e um ícone. Links de compartilhamento sem Place ID não resolvem capa nesta versão.
- O binário Windows é uma compilação otimizada (release/MSVC), sem assinatura digital. Os controles de requisição não garantem ausência de bloqueios pelo Roblox.

Código e relatórios técnicos completos estão disponíveis no repositório.
