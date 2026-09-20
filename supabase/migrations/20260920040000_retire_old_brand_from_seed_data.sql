-- Retirada da marca aposentada, do nome do bairro e da cidade dos DADOS de demonstracao
-- gravados por 20260816260000 e 20260828160000 em public.produtos,
-- public.base_conhecimento e public.configuracoes_sistema.
--
-- O catalogo de combos e a base de conhecimento RAG chegam ao cliente por
-- WhatsApp, Telegram e web, e sao lidos de volta por
-- apps/web/src/lib/cardapio/cards.ts. Renomear o codigo nao alcanca estas linhas:
-- o nome do combo, o titulo e o corpo do artigo e as palavras-chave ficam gravados
-- no banco. Sem esta migracao uma semente ou um reset local reintroduziria
-- "Casa de Assados Brasa & Sabor", "Umbará" e "Curitiba" em texto que o cliente ve,
-- contradizendo
-- o prompt mestre substituido por 20260920030000, que afirma que este e um ambiente
-- de demonstracao com dados de teste.
--
-- Migracao apenas para frente: 20260816260000 e 20260828160000 ja estao aplicadas
-- em producao, entao edita-las nao mudaria nada la e falsificaria o historico. A
-- correcao entra aqui, sobre os dados, sem transferencia de posse: nenhum
-- `alter function ... owner to supabase_admin` e adicionado, e o harness local
-- continua afirmando exatamente oito transferencias (expected_owner_transfers=8).
--
-- Idempotente por construcao. Nomes de combo e titulos de artigo usam igualdade
-- exata contra o valor aposentado, de modo que um operador que ja renomeou o
-- proprio item nao e sobrescrito, e uma reexecucao nao encontra a linha e nao
-- escreve nada. Corpos de artigo e palavras-chave usam
-- `replace`/`array_replace`/`array_remove` guardados por `like`/`any`, que e um
-- no-op depois da primeira passagem.
--
-- Cada `replace` cobre o fragmento INTEIRO, nunca apenas a cauda. Isso e
-- obrigatorio no texto que chega ao cliente: o corpo do artigo de retirada ja
-- traz "em um raio de ate 5 km" imediatamente antes de "no Umbará, Ganchinho,
-- Sítio Cercado e Pinheirinho", entao trocar so a cauda gerava a copy duplicada
-- "em um raio de ate 5 km em um raio de ate 5 km" (defeito encontrado na
-- verificacao independente da issue #197). O par substituto inclui a expressao
-- que ja existia, o fragmento de origem desaparece por completo e uma segunda
-- passagem nao altera mais nada.
--
-- Fora de escopo, de proposito: `public.produtos.descricao` nunca citou a marca;
-- `public.configuracoes_sistema.chave` e chave primaria lida pelo codigo por nome
-- exato, entao renomea-la quebraria a leitura em vez de consertar um texto; e o
-- padrao `'Asados'` do campo `establishment` de public.emitir_comprovante_venda
-- (definida em 20260820160000, substituida em 20260824160000) NAO e tocado aqui —
-- exige `create or replace` de uma funcao de autoridade de seguranca e pertence a
-- uma mudanca propria. Enquanto ele existir, um comprovante emitido pelo banco
-- ainda imprime a marca aposentada; o fallback de `apps/web/src/app/api/receipts/`
-- so cobre o caminho sem comprovante persistido. Tambem fora de escopo: as
-- restricoes e rotinas de normalizacao de telefone de DDD 41 (20260703210000 e
-- 20260816140001) citam "Curitiba" como dominio funcional, nao como copy de
-- cliente, e permanecem intactas.

-- 1. Nomes dos combos em public.produtos
update public.produtos
   set nome = 'Combo 1 – O Clássico'
 where nome = 'Combo 1 – O Clássico Brasa & Sabor';

update public.produtos
   set nome = 'Combo 3 – Dueto (Frango & Costelinha Suína)'
 where nome = 'Combo 3 – Dueto Brasa & Sabor (Frango & Costelinha Suína)';

-- 2. Titulos dos artigos RAG
update public.base_conhecimento
   set titulo = 'Combo 1 – O Clássico: Ficha Técnica e Detalhes'
 where titulo = 'Combo 1 – O Clássico Brasa & Sabor: Ficha Técnica e Detalhes';

update public.base_conhecimento
   set titulo = 'Combo 3 – Dueto (Frango & Costelinha Suína): Ficha Técnica'
 where titulo = 'Combo 3 – Dueto Brasa & Sabor (Frango & Costelinha Suína): Ficha Técnica';

-- O titulo do artigo de retirada carrega a cidade. A cidade sai inteira, sem
-- substituto, e o restante do titulo continua identificando o artigo.
update public.base_conhecimento
   set titulo = 'Janelas de Retirada (Takeaway) e Delivery Próprio'
 where titulo = 'Janelas de Retirada (Takeaway) e Delivery Próprio em Curitiba';

-- 3. Corpo dos artigos RAG: a marca sai do texto, o conteudo operacional fica
update public.base_conhecimento
   set conteudo = replace(conteudo, 'O Clássico Brasa & Sabor', 'O Clássico')
 where conteudo like '%O Clássico Brasa & Sabor%';

update public.base_conhecimento
   set conteudo = replace(conteudo, 'Dueto Brasa & Sabor', 'Dueto')
 where conteudo like '%Dueto Brasa & Sabor%';

-- Identidade do negocio e bairro no artigo de retirada. Duas variantes sao
-- tratadas porque 20260816260000 gravou "Casa de Assados Sofia" e 20260828160000
-- reescreveu a mesma linha como "Casa de Assados Brasa & Sabor". O enquadramento
-- de ambiente de demonstracao entra no lugar da identidade e mantem a frase
-- gramatical ("... demonstração opera com o modelo ..."). O ultimo par cobre o
-- fragmento inteiro do raio de entrega, incluindo o "em um raio de até 5 km" que
-- ja existe no texto, para nao duplicar a expressao.
update public.base_conhecimento
   set conteudo = replace(
         replace(
           replace(
             replace(conteudo,
               'A Casa de Assados Brasa & Sabor opera', 'Este ambiente de demonstração opera'),
             'A Casa de Assados Sofia opera', 'Este ambiente de demonstração opera'),
           'no balcão no Umbará', 'no balcão de retirada'),
         'em um raio de até 5 km no Umbará, Ganchinho, Sítio Cercado e Pinheirinho', 'em um raio de até 5 km')
 where conteudo like '%Casa de Assados%';

-- Cidade no corpo do Combo 4 (Kit Churrasco Família). O fragmento inteiro entra
-- no par substituto: "de Curitiba" e a cauda da frase, e trocar apenas a cidade
-- deixaria a preposicao orfa.
update public.base_conhecimento
   set conteudo = replace(conteudo, 'com o melhor custo-benefício de Curitiba', 'com o melhor custo-benefício')
 where conteudo like '%custo-benefício de Curitiba%';

-- 4. Palavras-chave dos artigos que carregavam a marca, o bairro ou a cidade
update public.base_conhecimento
   set tags = array_replace(tags, 'clássico brasa e sabor', 'clássico')
 where 'clássico brasa e sabor' = any(tags);

update public.base_conhecimento
   set tags = array_replace(tags, 'dueto brasa & sabor', 'dueto')
 where 'dueto brasa & sabor' = any(tags);

update public.base_conhecimento
   set tags = array_replace(tags, 'umbara', 'demonstracao')
 where 'umbara' = any(tags);

-- A cidade e palavra-chave de localizacao aposentada: sai da lista em vez de ser
-- renomeada, porque nenhuma outra tag carrega o mesmo sentido.
update public.base_conhecimento
   set tags = array_remove(tags, 'curitiba')
 where 'curitiba' = any(tags);

-- 5. Mensagem automatica fora de horario (20260708000000), texto que o cliente le
update public.configuracoes_sistema
   set valor = replace(valor, 'Equipe Asados', 'Equipe de Atendimento')
 where valor like '%Equipe Asados%';

-- A mesma mensagem ainda promete "o melhor churrasco de Curitiba": a cidade sai
-- dentro do fragmento inteiro da frase, para nao deixar preposicao orfa.
update public.configuracoes_sistema
   set valor = replace(valor, 'o melhor churrasco de Curitiba!', 'o melhor churrasco!')
 where valor like '%o melhor churrasco de Curitiba!%';

-- Verificacao pos-deploy (manual, nao executada por esta migracao): o resultado
-- esperado de cada consulta e zero linhas.
--
--   select count(*) from public.produtos
--    where nome like '%Brasa & Sabor%' or nome like '%Assados%';
--   select count(*) from public.base_conhecimento
--    where titulo like '%Brasa & Sabor%' or titulo like '%Assados%'
--       or conteudo like '%Brasa & Sabor%' or conteudo like '%Assados%'
--       or conteudo like '%Umbar%' or conteudo like '%Curitiba%'
--       or titulo like '%Curitiba%';
--   select count(*) from public.base_conhecimento
--    where tags && array['clássico brasa e sabor', 'dueto brasa & sabor', 'umbara', 'curitiba'];
--   select count(*) from public.base_conhecimento
--    where conteudo like '%em um raio de até 5 km em um raio de até 5 km%';
--   select count(*) from public.configuracoes_sistema
--    where valor like '%Assados%' or valor like '%Asados%' or valor like '%Curitiba%';
