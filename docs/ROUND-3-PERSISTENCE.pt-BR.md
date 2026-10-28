# Rodada 3 — gravação e troca de senha

## Problemas confirmados

- A gravação já usava temporário, flush e rename. Faltavam verificação do temporário e nomes resistentes a colisões entre processos. Erros de leitura podiam ser confundidos com arquivo ausente.
- A troca de senha alterava salt, verificador e sessão antes de terminar de salvar as contas. Alguns erros de configurações eram apenas registrados. O histórico de geração não era migrado para a nova chave.
- Uma falha ao descriptografar cookie ou senha virava campo vazio. Salvar um rótulo, mover para a lixeira ou atualizar `lastUsed` podia então perder o ciphertext original.
- O lock de contas cobria comandos IPC, mas não todo o ciclo das gravações do lançamento nativo, backup, configurações e troca de chave. O restore de backup substituía seus arquivos separadamente.
- A interface enviava senha vazia ao backend antes de rejeitá-la e podia permitir outras alterações enquanto uma troca estava em andamento.

## Alterações

- `jsonfile.rs`: criação exclusiva de temporários com PID/UUID, flush e comparação dos bytes antes de substituir o original. Leituras estritas distinguem ausência, JSON inválido e erro de I/O. Arquivos ilegíveis não são silenciosamente substituídos por listas/configurações vazias.
- `persistence.rs`: lock comum para o ciclo completo de leitura/alteração/gravação dentro do processo. Chamadas aninhadas na mesma thread são permitidas; nenhum guard atravessa `await`. Os workers continuam fora da thread da interface.
- `record_crypto.rs` e `storage.rs`: campos que não puderam ser abertos ficam vazios para exibição, acompanhados do ciphertext preservado em memória. A gravação de outros dados restaura esses bytes. Troca de chave e backup exigem descriptografia completa, inclusive senhas, lixeira e histórico.
- `key_change.rs` e `encryption.rs`: montam configurações e dados novos em memória, derivam/verificam a nova chave, verificam cada campo recriptografado e só publicam a sessão após o commit. Ler um campo não cria outra chave de dispositivo se a original estiver ausente. Parâmetros scrypt e formatos existentes foram mantidos.
- `file_transaction.rs`: registra antes/depois dos arquivos no formato em que ficam em disco, sem acrescentar senhas ou registros descriptografados ao journal. Antes da confirmação, falha/interrupção restaura o conjunto anterior; após a confirmação durável, a recuperação completa o conjunto novo. O journal é removido ao concluir. Se estiver inválido ou a recuperação falhar, o acesso é interrompido preservando os arquivos.
- `backup.rs`: exportação recusa dados ilegíveis; restore usa a mesma transação para contas, grupos e configurações, preservando a chave local. Containers antigos válidos continuam no formato versão 1. Estruturas incompletas são recusadas em vez de interpretadas como listas vazias.
- `commands.rs`, `native.rs`, `state.rs` e `lib.rs`: integram a recuperação antes das leituras de startup, serializam configurações, histórico, rekey e atualização de `lastUsed`. Configurações vindas da interface não podem substituir salt, verificador ou chave de dispositivo.
- `src/renderer.js`: senha vazia é rejeitada antes da chamada; input/botão ficam protegidos durante a troca. Falha preserva o texto e permite nova tentativa. Pular a configuração também verifica o resultado antes de abrir a interface. Renderer web sincronizado.

## Validação

- **76 testes Rust da biblioteca completa passaram**, com dados fictícios. Incluem troca de senha e leitura após recarregar os arquivos; contas na lixeira e histórico; senha antiga recusada após troca concluída; desativação da senha para proteção do dispositivo; falhas de leitura/criptografia/gravação; corrupção do temporário; interrupção em cada etapa; falha de rollback com journal preservado; serialização concorrente; compatibilidade dos backups.
- **60 testes JavaScript passaram**, incluindo senha vazia, bloqueio de solicitações repetidas, falha com possibilidade de retry, configuração inicial, autenticação e grupos da rodada anterior.
- `npm run web:build`, verificações de sintaxe JavaScript e `git diff --check` aprovados.
- `cargo check --locked --all-targets` e compilação do executável aprovados. A cópia de build GNU usa somente `rlib` para evitar o limite de exports da `cdylib` debug, mantendo o manifest do código entregue. O pacote recebeu o manifest Common Controls v6, tem subsistema GUI e inclui WebView2Loader. Integridade do ZIP aprovada; código, dados, imports e relocations foram comparados byte a byte com o binário compilado e preservados.
- O toolchain disponível é Windows GNU. A suíte Rust foi compilada com `cargo test --locked --lib --no-run`; uma cópia do runner recebeu o manifest Common Controls v6 do Tauri para resolver a falha de carregamento do ambiente. Essa cópia executou os testes com `APPDATA` isolado em `work/round3-unit-profile`; o aplicativo e suas contas reais não foram abertos.

## Como testar a build 3

1. Feche todas as versões do KNT. Extraia o ZIP inteiro numa pasta nova.
2. Copie a pasta `dados-teste` da build que você está usando para dentro da pasta da build 3. Mantenha a pasta original como estava; a nova build trabalhará na cópia pelo `TESTAR.cmd`.
3. Desbloqueie com a senha atual. Confira contas, grupos e histórico. Renomeie uma conta e reinicie para confirmar o salvamento.
4. Em Configurações, troque a senha de criptografia. Aguarde a confirmação. Feche e abra novamente pelo `TESTAR.cmd` e desbloqueie com a nova senha.
5. Confira contas ativas, lixeira, histórico e grupos. Teste uma entrada normal e um grupo pequeno para conferir os fluxos já aprovados na build anterior.
6. Se usar backups, exporte um backup de teste e restaure somente nesta cópia isolada. Confira que a senha de desbloqueio atual continua funcionando após reiniciar.

Não é necessário provocar falhas ou encerrar o processo durante a troca: esses cenários foram simulados nos testes. Não remova `storage-transaction.json` caso apareça um erro de recuperação; ele contém o estado necessário para retomar a operação.

## Limites e próxima prioridade

Não foi realizado teste visual/IPC da janela, lançamento com Roblox real, corte de energia nem saturação física de disco nesta rodada. Os testes de falha usam injeção de erro/interrupção e arquivos temporários. O lock coordena threads da mesma instância; não execute versões diferentes sobre a mesma pasta de dados simultaneamente.

Dados já perdidos antes desta correção não são recriados. Um campo cujo ciphertext exista mas não possa ser aberto será preservado; a troca de chave será recusada até resolver esse campo. O journal é recuperação de uma operação pendente, não um histórico permanente de backups.

A próxima prioridade é confirmar o ciclo de troca/reabertura nessa cópia e, em seguida, tratar o armazenamento de segredos que ainda ficam no `localStorage` (já documentado na revisão inicial). Nenhum push, deploy ou release foi realizado.
