# Revisão técnica — rodada 1

Data: 27/10/2026. Base: `aca8df6` (2.4.0), obtida de `Kntt9/KNT-Manager`.
Branch local: `work/reliability-round-1`. Nenhuma alteração enviada ao remoto.
Não havia `AGENTS.md` no checkout; foram consideradas as instruções fornecidas na conversa.

## Funcionamento identificado

- `src/index.html`, `renderer.js`, CSS e dicionários formam a interface JavaScript sem framework. `tauri-bridge.js` expõe `window.api`, traduzindo as ações em comandos/eventos Tauri.
- `src-tauri/src/lib.rs` inicializa estado, criptografia, plugins e helper. `commands.rs` é a fronteira de IPC; `state.rs` concentra clientes HTTP, caches, locks e mapas de processos.
- `native.rs` coordena lançamento, associação conta/PID, fechamento, sincronização e watchdog. `helper.rs` mantém um processo C# residente, com requisições identificadas no stdin/stdout; `resources/RobloxNative.cs` implementa operações Windows. Já existem serialização de lançamentos, intervalo de 2 s e limite de três relançamentos automáticos por conta em dez minutos; eles foram preservados.
- O login abre a página oficial numa Webview incognita, aguarda o usuário autenticar e captura `.ROBLOSECURITY`. O backend valida a identidade e obtém CSRF/ticket para lançar. Não existe servidor de autenticação próprio nem OAuth neste fluxo.
- `storage.rs`, `settings.rs` e `jsonfile.rs` persistem contas, grupos, configurações e histórico em `%APPDATA%\multiroblox`. Cookies/senhas de contas e histórico usam DPAPI ou AES-GCM com chave derivada por scrypt. Há leitura de formatos legados e gravação por arquivo temporário/rename.
- `backup.rs` cria backups criptografados com senha e restaura contas, grupos e configurações. A restauração substitui os dados existentes. `tracking.rs` captura imagens pelo helper e envia ao webhook Discord configurado.
- Integrações: APIs Roblox, BloxGen, Altgen, Discord, catálogo WEAO e atualizador Tauri por GitHub Releases. `web/` é uma versão de demonstração com bridge próprio e relay Node; suas operações de processo são simuladas e seus dados usam `localStorage` sem criptografia. `site/` é a landing page independente.

## Diagnóstico priorizado

“Confirmado no código” indica um caminho verificável na implementação, não que ele tenha ocorrido com suas contas. Reprodução automática é indicada separadamente.

| Prioridade | Problema confirmado e impacto | Referências | Situação nesta rodada |
| --- | --- | --- | --- |
| P1 | Restauração eliminava verifier/salt/chave locais ao substituir settings. Contas recriptografadas podiam ficar ilegíveis após reiniciar, em especial no modo com senha. | `backup.rs::do_restore`, `sanitize_restored_settings` | Corrigido; regressão criptografa um segredo e valida a leitura após simular recarga das configurações. |
| P1 | Validação tratava toda resposta negativa como cookie morto, inclusive rede, 429 e 5xx. Isso podia induzir limpeza indevida de contas e logins desnecessários. | `renderer.js::checkCookieHealth`, `recheckAllCookies`, `_flagCookieMaybeDead`; `roblox_api.rs::fetch_user_info` | Corrigido; só 401 explícito confirma rejeição da sessão. Testes de estados, simultaneidade e resposta atrasada. |
| P1 | Autenticação repetia erros permanentes, renovava CSRF depois de 429 e mantinha tickets em cache. Não havia coordenação global com validação e consultas. | `roblox_api.rs::get_auth_ticket`, `get_csrf_token`; `state.rs` | Corrigido no backend desktop Roblox; fixtures verificam interrupção e a única repetição permitida para renovar CSRF. |
| P1 | Troca de chave altera configurações antes de concluir gravações e não recriptografa o histórico do gerador; falhas podem deixar formatos/chaves inconsistentes. | `commands.rs::enc_set_key`, `encryption.rs::rotate_salt`, `storage.rs::read_genhistory` | Pendente: próxima prioridade. Confirmado pelo fluxo; falta reprodução integrada com falhas de disco. |
| P1 | Uma falha de descriptografia vira string vazia. Uma posterior edição/reordenação pode gravar essa string no lugar do ciphertext recuperável; passwords também são afetados. | `storage.rs::decrypt_account`, `save_accounts`, `decrypt_gen_entry` | Pendente: bloquear gravação destrutiva ou preservar explicitamente o ciphertext original. |
| P1 | Gravar JSON por rename evita truncamento, mas não protege a transação leitura–alteração–gravação. Operações de conta e atualização de lastUsed podem sobrescrever mudanças concorrentes. | `commands.rs::accounts_add`, `accounts_update`; `native.rs::do_launch`; `storage.rs::save_accounts` | Pendente. Caminhos concorrentes identificados; falta teste determinístico da intercalação. |
| P1 | Credenciais manuais e chaves de geradores ficam em texto simples no WebView localStorage; no demo web, cookies e senhas também. | `renderer.js::genKeysSave`, chave `mr_manual_creds`; `web/bridge.js` | Documentado; migração para armazenamento criptografado pendente. |
| P2 | Lista de servidores aceitava respostas de erro como lista vazia e podia recorrer ao acesso público após recusa autenticada. | `renderer.js::_srvFetchRaw` | Corrigido; não armazena erro como cache nem usa fallback após 401/403/429. |
| P2 | Relay Node escutava em todas as interfaces, liberava CORS `*`, não limitava corpo e deixava rejeições async fora do catch. JSON inválido podia encerrar o processo. | `web/server.mjs` | Corrigido: loopback, Host/Origin locais, 64 KiB, await dos handlers e erros 400/413. Testes HTTP locais. |
| P2 | Falta de csc era tratada como fallback em runtime, mas `include_bytes!` exige helper compilado. Falha de csc também não interrompia imediatamente o build. | `build.bat`; `native.rs::EMBEDDED_NATIVE_EXE` | Corrigido; helper C# compilado com sucesso neste ambiente. |
| P2 | Erros de leitura de arquivo, incluindo UTF-8 inválido, são tratados como arquivo ausente antes do mecanismo de proteção de corrupção. | `jsonfile.rs::read_text`, `read_array`, `read_object` | Pendente: distinguir ausência, erro de I/O e conteúdo inválido. |
| P2 | Restauração de múltiplos arquivos ainda não é uma transação: falha em grupos/settings pode deixar restauração parcial. Outros salvamentos ainda ignoram erros de settings. | `backup.rs::do_restore`; `settings.rs::save_settings`; `commands.rs::settings_save` | Parcial: restauração agora informa falha de settings; rollback global pendente. |
| P2 | Controle de requisições ainda não abrange relay web, BloxGen, Altgen e Discord. O webhook não tem timeout total e o timer pode sobrepor operações lentas. | `web/server.mjs`; `renderer.js::genBloxgen`, `captureTimedTracking`; `tracking.rs::send_to_discord_webhook` | Pendente. Não foram alterados os fluxos dos serviços externos nesta rodada. |
| P3 | Frontend de cerca de 7,6 mil linhas e módulo native de cerca de 2,7 mil linhas concentram responsabilidades; modelo de dados usa JSON dinâmico. | `src/renderer.js`; `native.rs`; `storage.rs` | Separação incremental recomendada após estabilizar persistência. Sem reescrita ampla. |
| P3 | README prometia que contas nunca saíam do dispositivo, confundia o compilador necessário e estava com versão antiga. CI existente publicava apenas a landing page. | `README.md`; `.github/workflows` | Documentação corrigida e workflow de testes Windows acrescentado. Não executado no GitHub. |

## Hipóteses que exigem medição

- Causa e frequência de bloqueios reais: não há logs redigidos, histórico dos incidentes ou medição antes/depois. O volume de requisições é uma exposição confirmada; sua relação causal com bloqueios não foi demonstrada.
- CPU/RAM altos: há polling de interface a cada 3 s sem aguardar a rodada anterior, watchdog de 1 s e leituras repetidas de settings. É preciso perfil de CPU/heap e quantidade real de contas para quantificar. Não atribuí consumo a esses pontos sem medição.
- Atualizador, login WebView, associação de PIDs, launcher personalizado, captura Discord e reconexão após crash precisam de teste integrado com o ambiente de uso. Não concluí que estejam quebrados.
- O cadastro manual preenche uma data de nascimento aleatória em `signup.rs`. O requisito desse comportamento não está documentado; sua revisão deve usar informações reais escolhidas pelo usuário, sem inventar regras de negócio.

## Controles implementados e limites

`request_policy.rs` serializa envio **e leitura do corpo** das chamadas do backend Roblox. O intervalo mínimo é 250 ms, timeout total de 10 s por requisição e limite de resposta de 8 MiB. Downloads de navegador e outras integrações usam os clientes existentes.

Um 429 pausa todo esse conjunto de chamadas, independentemente da conta. `Retry-After` aceita segundos ou data HTTP; sem cabeçalho válido, o cooldown cresce de 30 s até 960 s. A solicitação que falhou não é reenviada automaticamente. Chamadas durante a pausa recebem erro local com status e tempo restante. O estado de pausas é apenas desta execução do aplicativo.

Uma sessão rejeitada com 401 não é reenviada nesta execução; trocar o cookie permite nova autenticação. A interface também deixa de revalidar uma sessão rejeitada até ela ser substituída. Uma recusa 403 na autenticação sem renovação CSRF utilizável, ou um desafio de segurança, pausa chamadas autenticadas dessa sessão por 15 minutos. Um 403 de permissão ao consultar um recurso não suspende sozinho a sessão. O programa interrompe; não resolve nem contorna desafios. Um 403 que fornece CSRF admite uma única repetição da solicitação de ticket.

URLs recebidas pela bridge para acesso autenticado/público exigem HTTPS, host Roblox, porta 443 e ausência de usuário/senha na URL. Chamadas do backend Roblox não seguem redirecionamentos. As mensagens de transporte não incluem cookies, tokens ou conteúdo de URLs.

A documentação oficial da [Roblox sobre limites](https://create.roblox.com/docs/cloud/reference/rate-limits) orienta tratar 429, considerar `Retry-After` e usar backoff. A [referência de APIs](https://create.roblox.com/docs/cloud) distingue endpoints legados baseados em cookies e suas garantias reduzidas. Não foi confirmada uma quota universal publicada para os endpoints legados utilizados aqui: 250 ms e concorrência 1 são escolhas conservadoras do aplicativo, não cotas oficiais. Os limites dos geradores não foram verificados em documentação acessível nesta revisão. Não há promessa de eliminar bloqueios nem evidência de redução de incidentes já medida.

## Verificações

| Verificação | Resultado |
| --- | --- |
| `npm test` | 21 testes passaram: saúde de sessão, lista de servidores e relay HTTP local. |
| `npm run web:build` | Sucesso; renderer da demonstração sincronizado com o desktop. |
| `node --check` nos scripts de interface/bridge/relay/build | Sucesso. |
| Compilação C# com csc .NET Framework | Sucesso, exit code 0. O helper não foi executado. |
| `cargo check --locked --all-targets --manifest-path src-tauri/Cargo.toml` | Sucesso no aplicativo completo, incluindo assinaturas dos comandos Tauri. |
| `cargo test --no-run --locked --lib --manifest-path src-tauri/Cargo.toml` | Sucesso: executável da suíte completa compilado e linkado. |
| Execução da suíte completa Tauri | Não executou testes: o loader Windows encerrou o processo com `0xc0000139 / STATUS_ENTRYPOINT_NOT_FOUND`. O teste depende de `TaskDialogIndirect`, ausente no Common Controls carregado sem o contexto v6; o recurso/manifest do Tauri é ligado aos binários do aplicativo, não ao harness de testes GNU. Não foi validada a execução equivalente com MSVC. |
| Testes Rust do núcleo em harness isolado | 40 passaram. Os módulos reais `request_policy.rs`, `roblox_api.rs`, `crypto.rs` e `jsonfile.rs` foram incluídos por caminho; os helpers/testes de preservação de configurações do backup foram extraídos sem alteração. Somente o `AppState` foi substituído por clientes HTTP/cache de teste. Isso valida a lógica, não IPC, janelas ou processos. |
| `npm audit --json` | 0 vulnerabilidades reportadas no lockfile Node; não representa auditoria das dependências Rust. |
| `git diff --check` | Sucesso. |

Ambiente: Node 24.22.0, Rust 1.99.1 com target Windows GNU e GCC/MinGW isolados na pasta de trabalho. Nenhuma instalação global nem alteração persistente de PATH foi feita. O toolchain MSVC/Windows SDK recomendado no README não estava disponível.

Permanecem sem validação: execução do workflow no GitHub, build release/instalador, comportamento visual integrado do desktop, login/lançamento/cancelamento/associação de PIDs com contas reais, atualizador, envio a webhook, falhas reais de disco e medições de CPU/RAM. O erro do runner completo não foi tratado como aprovação dos testes que ele não chegou a executar.

Os testes HTTP usam listeners em `127.0.0.1` e sessões fictícias. Nenhuma conta real foi autenticada nem um webhook foi acionado. Dados existentes de `%APPDATA%\multiroblox` não foram abertos pelo aplicativo ou modificados para testes.

## Roteiro manual para esta rodada

1. Faça os testes de restauração numa cópia isolada dos dados. A operação de restaurar substitui contas/grupos/configurações. Para isolar o executável desta rodada, numa nova janela PowerShell, defina `$env:APPDATA = Join-Path $env:TEMP ('knt-test-' + [guid]::NewGuid())`, crie essa pasta e execute o programa a partir dessa mesma janela. Fechar a janela encerra esse override de ambiente.
2. Compile pelo `build.bat`. Crie uma conta de teste via fluxo normal, configure uma senha local, gere um backup, restaure-o, feche e reabra. A mesma senha deve desbloquear e os cookies devem continuar presentes. Repita com armazenamento por dispositivo; não teste troca de chave nesta rodada, pois ela ainda tem as limitações descritas acima.
3. Valide uma sessão legítima. Desconecte a rede e atualize: não deve aparecer como expirada só pela falha de conexão. Reconecte e valide novamente.
4. Teste uma sessão já expirada: 401 deve indicar rejeição; a rotina periódica não deve continuar revalidando esse cookie. Adicionar uma sessão nova deve permitir a validação normal.
5. Lance uma conta, depois um grupo pequeno. Confira mensagens, associação dos processos, cancelamento e encerramento. A fila de HTTP pode tornar o primeiro carregamento de muitas contas mais lento. Não provoque 429 em contas reais: os testes locais cobrem esse caso.
6. Execute `npm test` e `npm run web:serve`. Abra `http://localhost:4173`; confira a demonstração. JSON inválido e origem externa são exercitados automaticamente pelos testes, sem acessar Roblox.

Para feedback: informe versão do Windows, modo de armazenamento (senha/dispositivo), número de contas, desktop ou demo web, passos e texto exato do erro; omita cookies, senhas, tokens e URLs privadas.

## Próxima etapa recomendada

Tornar persistência e rotação de chave transacionais: preservar ciphertext quando a descriptografia falhar; incluir contas e histórico na rotação; propagar erros de settings; serializar leitura–alteração–gravação; testar falha de disco/rollback. Depois migrar segredos de localStorage e estender o agendador a cada integração com sua política documentada. Somente então medir CPU/RAM e dividir módulos por responsabilidade.

O arquivo `.github/workflows/check.yml` prepara verificações Windows para o próximo push autorizado. Ele não publica releases nem faz deploy. A automação de publicação da landing page preexistente foi preservada.
