# Rodada 2 — entradas no jogo, grupos e desbloqueio

## Causas confirmadas

- O HTTP 415 da captura foi uma regressão introduzida na rodada 1: o POST de ticket perdeu `Content-Type: application/json`, `Accept` e o corpo vazio explicitamente delimitado. A fixture anterior verificava só a resposta e não detectava o formato incorreto do request.
- `enc_unlock` calculava scrypt para validar a senha, descartava a chave e a primeira leitura/salvamento a calculava novamente. O comando e as operações de contas eram síncronos no IPC, bloqueando a thread da janela durante criptografia e disco. A build debug também executava as primitivas sem otimização.
- Distribuição reutilizava destinos, não verificava corretamente respostas de erro e repetia tentativas após falhas de autenticação. A validação de destinos podia buscar até vinte páginas e ainda declarar incorretamente que um servidor ausente na amostra estava morto.

## O que foi corrigido

### Entrada e autenticação

`roblox_api.rs::empty_auth_post` centraliza os cabeçalhos dos POSTs de CSRF/ticket. O corpo permanece vazio, compatível com o código original. Não se envia CSRF ao endpoint logout, evitando transformar a consulta do token em logout autenticado. Permanecem a única renovação CSRF permitida, as pausas de 429 e a interrupção em desafios. Erros 400/415 indicam formato do aplicativo, sem culpar a conta.

Lançamento individual, pasta, seleção, grupo, servidor específico, link privado e watchdog convergem em `native::do_launch`, portanto recebem a correção comum. As fixtures agora inspecionam método, path, headers, comprimento e corpo e respondem 415 ao contrato incorreto.

### Distribuição

O botão distribuir usa servidores públicos distintos, com população informada pela API de pelo menos **uma pessoa** e pelo menos **uma vaga**. Ordena pela menor população, depois ping e ID. Servidores vazios, cheios, inválidos, duplicados, reservados por outro lote ou conhecidos como ocupados por contas gerenciadas são excluídos.

Cada conta recebe um destino explícito `placeId:jobId`, sem reutilizar um servidor. Se houver menos destinos adequados que contas, os excedentes permanecem sem iniciar e o resultado é informado como parcial. Há uma tentativa por conta; falha isolada não muda o destino nem pula as contas seguintes. Rate limit ou cancelamento interrompe o lote. A proteção contra cliques duplicados independe do DOM e vale entre lote e modal individual.

O lançamento normal do grupo seleciona um destino comum com espaço para todos; links privados e destinos explícitos são preservados. A validação de um jobId consulta só uma amostra: pode confirmar falta de vagas, mas não considera a ausência na amostra como prova de servidor encerrado. Erros da listagem não viram entrada genérica no jogo.

### Interface e tempo de desbloqueio

`enc_unlock` passa a usar `spawn_blocking`; a chave validada fica em cache para ler as contas sem outro scrypt. Os oito comandos de contas também usam workers e um lock para serializar seu ciclo leitura/alteração/gravação. Isso cobre esses comandos, não todas as operações de native/backup/troca de chave.

Repetir Enter/clicar durante desbloqueio não cria cálculos paralelos. Falha de worker não é exibida como senha incorreta. A build de desenvolvimento otimiza scrypt, salsa20, sha2 e pbkdf2, mantendo **N=65536, r=8, p=1**, salt e formato existentes. O executável Windows usa o subsistema gráfico também nesta build de teste.

## Validação

- `npm test`: **56 passaram**, incluindo 32 cenários novos de grupos/servidores e três de desbloqueio.
- Harness Rust do núcleo: **51 passaram**, incluindo requisições de autenticação, chave verificada reutilizável e workers fora da thread chamadora, serialização, erro original e panic. Não substitui teste de janelas/IPC em uso real.
- Benchmark local com senha e salt fictícios, mesmos parâmetros: derivação **128 ms**; verificação com retorno da chave **129 ms**. Medição do cálculo, não do desbloqueio completo no computador do usuário.
- Sonda real **sem cookies**, sem conta e sem repetição: POST logout e ticket responderam **401**, não 415. Isso confirma o formato aceito e a ausência de autenticação; não confirma lançamento real.
- Consulta pública real sem cookies respondeu **200**, com lista e paginação. A seleção em si foi validada com fixtures, sem lançar contas.
- `cargo check --locked --all-targets`: aprovado no aplicativo completo.
- Executável da rodada 2 compilado com sucesso. O ambiente usa GNU: para evitar o limite de exports da `cdylib` debug, a cópia temporária de build usou somente `rlib`, sem alterar o manifest do código entregue. O pacote inclui WebView2Loader, usa subsistema GUI e recebeu o manifest Common Controls v6 do Tauri após o aviso de manifests duplicados do linker. Leitura dos recursos, imports e integridade do ZIP aprovadas; as seções de código, dados e relocations foram comparadas com o binário original e preservadas.
- A suite unitária completa vinculada ao Tauri não foi executada com sucesso neste ambiente: o runner GNU anteriormente falhou no carregamento com `0xc0000139` (entrypoint ausente de Common Controls). Os 51 testes citados são do harness isolado, e não de toda a aplicação. Não foi realizada validação visual/IPC da interface nem lançamento real com Roblox.
- `node --check` e `git diff --check`: aprovados. Renderer web sincronizado pelo build.

Nenhum cookie, senha, token real ou dado salvo da instalação do usuário foi lido para esses testes. Não houve push, deploy nem publicação de release.

## Como testar a nova build

1. Feche a build antiga e extraia o novo pacote inteiro numa pasta separada. Use `TESTAR.cmd` para manter os dados em `dados-teste/multiroblox`.
2. Desbloqueie e adicione uma conta de teste. A janela deve continuar respondendo durante essas operações.
3. Teste entrada normal e depois um grupo pequeno pelo botão normal.
4. No distribuir, use duas ou três contas e confira os destinos distintos. A API deve informar ao menos uma pessoa em cada destino antes da entrada. Se faltarem destinos, confira a mensagem parcial.
5. Teste Cancelar grupo durante a busca, durante um lançamento e no intervalo entre contas. Não provoque 429 deliberadamente: ele já é coberto pelos testes locais.
6. Envie o modo utilizado e o erro exato se houver falha. Não envie cookies, senhas ou tokens.

## Limitações restantes

A ocupação pode mudar entre consulta e entrada. A presença de contas iniciadas fora do gerenciador ou sem destino conhecido não pode ser excluída com confiança. Não foi executado login ou lançamento com contas reais nesta revisão; a confirmação integrada depende do teste de uso. A fila de requisições preserva suas pausas e não contorna recusas do serviço.

Os riscos já documentados de rotação de chave, preservação de ciphertext em falhas de descriptografia e transações envolvendo arquivos/backup continuam pendentes. Esta rodada não promete ganho de loot nem eliminação de bloqueios de contas.
