-- Retirada do dominio aposentado `casadeasados.duckdns.org` dos DADOS gravados por
-- 20260828160000_update_brand_and_combos_brasa_sabor em public.base_conhecimento,
-- public.produtos e public.configuracoes_sistema.
--
-- O dominio aposentado nao existe mais em DNS e nao sera recriado: a unica origem suportada
-- passa a ser `https://crmsofiamanager.duckdns.org`. Renomear o codigo nao alcanca estas
-- linhas, porque a URL absoluta fica gravada no proprio texto da linha: os artigos RAG da base
-- de conhecimento carregam linhas no formato `Foto: <origem>/cardapio/<arquivo>.png`, a
-- superficie de escrita de produto aceita URL completa em public.produtos.url_imagem*, e
-- public.configuracoes_sistema.valor guarda conteudo operacional editavel em runtime. Sem esta
-- migracao o rebuild/redeploy continuaria citando e servindo midia de um host que nao resolve,
-- e a verificacao pos-deploy encontraria o dominio antigo dentro dos dados.
--
-- Migracao apenas para frente: 20260828160000 ja esta aplicada em producao, entao edita-la nao
-- muda nada la e falsificaria o historico. A correcao entra aqui, sobre os dados, sem
-- transferencia de posse: nenhum `alter function ... owner to supabase_admin` e adicionado, e o
-- harness local afirma exatamente oito transferencias (expected_owner_transfers=8).
--
-- Idempotente por construcao: cada statement substitui o token de dominio
-- `casadeasados.duckdns.org` (forma que abrange a ocorrencia com esquema, `https://<host>`, e
-- qualquer ocorrencia nua, como `PROXY_DOMAIN=<host>`) e e guardado por `like '%casadeasados%'`
-- na propria coluna, de modo que uma reexecucao nao encontra linhas e nao escreve nada.
--
-- Fora de escopo, de proposito: `base_conhecimento.busca_vector` e coluna gerada a partir de
-- titulo/conteudo e nunca e atribuida; `base_conhecimento.tags` guarda palavras-chave e nenhum
-- valor gravado pelas sementes carrega URL; `configuracoes_sistema.chave` e chave primaria
-- identificadora lida pelo codigo por nome exato, entao renomea-la quebraria a leitura da
-- configuracao em vez de consertar um link.

-- 1. Artigos RAG: corpo do artigo e titulo
update public.base_conhecimento
   set conteudo = replace(conteudo, 'casadeasados.duckdns.org', 'crmsofiamanager.duckdns.org')
 where conteudo like '%casadeasados%';

update public.base_conhecimento
   set titulo = replace(titulo, 'casadeasados.duckdns.org', 'crmsofiamanager.duckdns.org')
 where titulo like '%casadeasados%';

-- 2. Produtos: descricao e nome (colunas tocadas pela migracao de marca) mais as quatro
-- colunas de imagem, que aceitam URL absoluta pela superficie de escrita de produto
update public.produtos
   set descricao = replace(descricao, 'casadeasados.duckdns.org', 'crmsofiamanager.duckdns.org')
 where descricao like '%casadeasados%';

update public.produtos
   set nome = replace(nome, 'casadeasados.duckdns.org', 'crmsofiamanager.duckdns.org')
 where nome like '%casadeasados%';

update public.produtos
   set url_imagem = replace(url_imagem, 'casadeasados.duckdns.org', 'crmsofiamanager.duckdns.org')
 where url_imagem like '%casadeasados%';

update public.produtos
   set url_imagem_thumb = replace(url_imagem_thumb, 'casadeasados.duckdns.org', 'crmsofiamanager.duckdns.org')
 where url_imagem_thumb like '%casadeasados%';

update public.produtos
   set url_imagem_2 = replace(url_imagem_2, 'casadeasados.duckdns.org', 'crmsofiamanager.duckdns.org')
 where url_imagem_2 like '%casadeasados%';

update public.produtos
   set url_imagem_2_thumb = replace(url_imagem_2_thumb, 'casadeasados.duckdns.org', 'crmsofiamanager.duckdns.org')
 where url_imagem_2_thumb like '%casadeasados%';

-- 3. Configuracoes operacionais editaveis em runtime (`valor`), incluindo prompt e links
-- citados pelo atendimento
update public.configuracoes_sistema
   set valor = replace(valor, 'casadeasados.duckdns.org', 'crmsofiamanager.duckdns.org')
 where valor like '%casadeasados%';

-- Verificacao pos-deploy (manual, nao executada por esta migracao): o resultado esperado de
-- cada consulta e zero linhas.
--
--   select count(*) from public.base_conhecimento
--    where conteudo like '%casadeasados%' or titulo like '%casadeasados%';
--   select count(*) from public.produtos
--    where nome like '%casadeasados%' or descricao like '%casadeasados%'
--       or url_imagem like '%casadeasados%' or url_imagem_thumb like '%casadeasados%'
--       or url_imagem_2 like '%casadeasados%' or url_imagem_2_thumb like '%casadeasados%';
--   select count(*) from public.configuracoes_sistema where valor like '%casadeasados%';
