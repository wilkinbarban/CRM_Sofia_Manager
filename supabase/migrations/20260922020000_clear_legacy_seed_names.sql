-- Retirada de nomes de produto e titulos de artigo que ainda carregam a marca
-- aposentada "Brasa & Sabor" e a cidade aposentada "Curitiba" nos DADOS gravados
-- por 20260816260000 e 20260828160000 em public.produtos e public.base_conhecimento.
--
-- O catalogo de combos e a base de conhecimento RAG chegam ao cliente por WhatsApp,
-- Telegram e web, e sao lidos de volta por apps/web/src/lib/cardapio/cards.ts.
-- Renomear o codigo nao alcanca estas linhas: o nome do combo e o titulo do artigo
-- ficam gravados no banco. Sem esta migracao o historico reapresentaria um nome de
-- negocio que nao existe mais, contradizendo o catalogo oficial do codigo.
--
-- Migracao apenas para frente: os arquivos historicos 20260816260000 e
-- 20260828160000 ja fazem parte do repositorio e nao podem ser editados para
-- corrigir instalacoes onde ja foram aplicados. Alterar esses arquivos nao
-- alcancaria tais instalacoes e falsificaria o historico registrado; a correcao
-- entra aqui, sobre os dados, sem transferencia de posse: nenhum
-- `alter function ... owner to supabase_admin` e adicionado, e o harness local
-- continua afirmando exatamente oito transferencias (expected_owner_transfers=8).
--
-- Escopo estrito, exatamente cinco atribuicoes: dois nomes em public.produtos.nome
-- e tres titulos em public.base_conhecimento.titulo. Fora de escopo, de proposito,
-- porque o pedido e a limpeza conservadora de nomes e titulos, nao a varredura de
-- copy de cliente: corpos de artigo (conteudo), palavras-chave (tags), descricoes de
-- produto, mensagens de public.configuracoes_sistema e o prompt mestre ficam
-- intocados; `configuracoes_sistema.chave` e chave primaria lida pelo codigo por
-- nome exato, entao renomea-la quebraria a leitura em vez de consertar um texto.
--
-- Idempotente e preservando edicao do operador por igualdade exata. Cada statement
-- compara a coluna com o valor aposentado do tipo `= '...'`, nunca com `like`,
-- `replace` ou fragmento parcial: um operador que ja renomeou o proprio item tem um
-- valor diferente, nenhuma linha casa e nada e escrito; uma reexecucao apos a
-- primeira passagem tambem nao encontra a linha e e um no-op.
--
-- Os valores de destino dos combos sao exatamente os nomes vigentes em
-- apps/web/src/lib/cardapio/cards.ts ('Combo 1 – O Clássico da Casa' e
-- 'Combo 3 – Dueto Especial (Frango & Costelinha Suína)'), e os titulos de artigo
-- mantem a mesma denominacao seguida do sufixo tecnico do artigo. O titulo do
-- artigo de retirada perde apenas a cidade, sem substituto, e continua
-- identificando o artigo.

-- 1. Nomes dos combos em public.produtos
update public.produtos
   set nome = 'Combo 1 – O Clássico da Casa'
 where nome = 'Combo 1 – O Clássico Brasa & Sabor';

update public.produtos
   set nome = 'Combo 3 – Dueto Especial (Frango & Costelinha Suína)'
 where nome = 'Combo 3 – Dueto Brasa & Sabor (Frango & Costelinha Suína)';

-- 2. Titulos dos artigos RAG
update public.base_conhecimento
   set titulo = 'Combo 1 – O Clássico da Casa: Ficha Técnica e Detalhes'
 where titulo = 'Combo 1 – O Clássico Brasa & Sabor: Ficha Técnica e Detalhes';

update public.base_conhecimento
   set titulo = 'Combo 3 – Dueto Especial (Frango & Costelinha Suína): Ficha Técnica'
 where titulo = 'Combo 3 – Dueto Brasa & Sabor (Frango & Costelinha Suína): Ficha Técnica';

-- O titulo do artigo de retirada carrega a cidade. A cidade sai inteira, sem
-- substituto, e o restante do titulo continua identificando o artigo.
update public.base_conhecimento
   set titulo = 'Janelas de Retirada (Takeaway) e Delivery Próprio'
 where titulo = 'Janelas de Retirada (Takeaway) e Delivery Próprio em Curitiba';

-- Verificacao pos-deploy (manual, nao executada por esta migracao): o resultado
-- esperado de cada consulta e zero linhas.
--
--   select count(*) from public.produtos
--    where nome = 'Combo 1 – O Clássico Brasa & Sabor'
--       or nome = 'Combo 3 – Dueto Brasa & Sabor (Frango & Costelinha Suína)';
--   select count(*) from public.base_conhecimento
--    where titulo = 'Combo 1 – O Clássico Brasa & Sabor: Ficha Técnica e Detalhes'
--       or titulo = 'Combo 3 – Dueto Brasa & Sabor (Frango & Costelinha Suína): Ficha Técnica'
--       or titulo = 'Janelas de Retirada (Takeaway) e Delivery Próprio em Curitiba';
