# Rodada 6 — identidade dos jogos nos grupos

O painel lateral e o catálogo mostram o nome e a imagem oficial do jogo resolvidos pelo Place ID. O painel de detalhes volta a exibir a capa. O campo de edição mantém o destino original para não alterar os lançamentos.

Consultas públicas, sem cookies: resolução Place ID → universo, nome e ícone. Cache em memória compartilhado por Place ID, consultas em fila, deduplicação de consultas simultâneas e intervalo de cinco minutos antes de nova tentativa após falha ou imagem pendente. Sem repetição automática. Ao trocar de grupo/destino, uma resposta antiga não substitui os metadados do novo destino.

Sem dados disponíveis, permanece o Place ID e um ícone. Links de compartilhamento sem Place ID não têm resolução de capa nesta etapa. O cache é renovado ao reiniciar o app.

Validação: 84 testes JavaScript passaram (6 novos para metadados), incluindo falha de rede, cache, fila, resposta atrasada e imagem pendente. Web build e sintaxe passaram. Consulta pública real ao Place ID 106198175232796 retornou universo 10765902945, nome [UPDATE 3.5] Anime Legacy Simulator e ícone Completed. Não houve autenticação nem lançamento real do Roblox nesta rodada.

Teste: extraia o ZIP em pasta nova, copie dados-teste da versão anterior mantendo a original, abra TESTAR.cmd e selecione seu grupo. Confira nome e foto na lateral e em Grupos. Troque entre grupos com jogos diferentes e confirme que a imagem acompanha o destino. O ID continua editável no campo de destino.

Próxima prioridade: validar esta compilação no Windows com os seus grupos antes de publicar a release.

Cargo check de todos os alvos e compilação Windows passaram. Revisão no navegador confirmou o nome real e a imagem carregada (512 px) na lateral e no catálogo. O aviso conhecido de manifests duplicados do linker GNU é normalizado pelo empacotamento; o pacote valida os manifests e o subsistema GUI. Teste do executável nativo com contas reais continua pendente.
