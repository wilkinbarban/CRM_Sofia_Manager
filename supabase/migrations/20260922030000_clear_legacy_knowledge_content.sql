-- Retirada da marca aposentada ("Brasa & Sabor", "Casa de Assados Sofia") e da
-- exaltacao geografica ("Curitiba") dos CORPOS de artigo gravados por
-- 20260816260000_seed_combos_e_base_conhecimento_oficial e
-- 20260828160000_update_brand_and_combos_brasa_sabor em public.base_conhecimento.
--
-- A base de conhecimento RAG chega ao cliente por WhatsApp, Telegram e web. Renomear
-- o codigo nao alcanca estas linhas: o corpo do artigo fica gravado no banco e o RAG
-- o devolve ao atendimento. Os titulos ja foram corrigidos por
-- 20260922020000_clear_legacy_seed_names; sem esta migracao os corpos continuariam
-- apresentando um nome de negocio que nao existe mais, contradizendo o catalogo e o
-- perfil de negocio vigentes.
--
-- Migracao apenas para frente: os arquivos historicos 20260816260000 e 20260828160000
-- ja fazem parte do repositorio e nao podem ser editados para corrigir instalacoes onde
-- ja foram aplicados. Edita-los nao alcancaria tais instalacoes e falsificaria o
-- historico registrado; a correcao entra aqui, sobre os dados, sem transferencia de
-- posse: nenhum `alter function ... owner to supabase_admin` e adicionado, e o harness
-- local continua afirmando exatamente oito transferencias (expected_owner_transfers=8).
--
-- Escopo estrito, exatamente quatro atribuicoes em public.base_conhecimento.conteudo:
-- os artigos dos Combos 1, 3 e 4 e o artigo de Janelas de Retirada. Fora de escopo, de
-- proposito: titulos (ja limpos por 20260922020000), tags, ativo, descricoes de
-- produto, public.produtos, public.configuracoes_sistema e o prompt mestre permanecem
-- intocados. Nao ha substituicao por texto de demonstracao ou de teste.
--
-- Origem exata de cada corpo: os artigos dos Combos 1, 3 e Janelas de Retirada vem do
-- UPDATE de 20260828160000; o artigo do Combo 4 vem do INSERT original de
-- 20260816260000, porque 20260828160000 nunca tocou esse corpo. A migracao posterior
-- 20260920020000 substitui apenas o dominio `casadeasados.duckdns.org`; nenhum destes
-- corpos contem dominio, entao 20260920020000 nao cria variante de conteudo para eles.
--
-- Idempotente e preservando edicao do operador por igualdade exata do corpo inteiro.
-- Cada statement compara `conteudo` com o valor aposentado por `= '...'`, nunca com
-- `like`, `ilike`, `replace` ou fragmento parcial: um operador que ja editou o proprio
-- artigo tem um corpo diferente, nenhuma linha casa e nada e escrito; uma reexecucao
-- apos a primeira passagem tambem nao encontra a linha e e um no-op.
--
-- O que permanece: fatos de produto, precos, composicao, rendimento, janelas de
-- retirada, raio de entrega (5 km) e o fluxo de agendamento por WhatsApp. Saem o nome
-- de negocio aposentado, a exaltacao geografica e os bairros nomeados do artigo de
-- retirada: bairros fixos descrevem uma localizacao que o BusinessProfile configuravel
-- nao garante. O corpo do Combo 4 mantem a familia do nome vigente
-- ("Kit Churrasco Família") e perde somente a cidade. O corpo do artigo de retirada
-- perde o nome de negocio no inicio e os bairros nomeados, preservando o ponto de
-- retirada generico, o raio de 5 km e todo o restante. O trecho inteiro do raio e
-- reescrito de uma vez, para nao duplicar "5 km".

-- 1. Combo 1: o nome de negocio aposentado sai do qualificador do combo.
update public.base_conhecimento
   set conteudo = 'O Combo 1 (O Clássico da Casa) custa R$ 69,90 e serve de 3 a 4 pessoas com muita fartura. É composto por 1 Frango recheado inteiro (~1,4kg assado) com pele dourada e crocante, recheio generoso de farofa temperada da casa aparente na cavidade, acompanhado por uma tigela de maionese caseira tradicional de batata com cenoura (300g) e cumbuca rústica de farofa artesanal crocante com bacon (250g). Nosso frango é marinado por 12 horas em infusão de ervas frescas e assado em máquina giratória a gás com fogo calibrado, garantindo suculência interna incomparável e pele bem douradinha.'
 where conteudo = 'O Combo 1 (O Clássico Brasa & Sabor) custa R$ 69,90 e serve de 3 a 4 pessoas com muita fartura. É composto por 1 Frango recheado inteiro (~1,4kg assado) com pele dourada e crocante, recheio generoso de farofa temperada da casa aparente na cavidade, acompanhado por uma tigela de maionese caseira tradicional de batata com cenoura (300g) e cumbuca rústica de farofa artesanal crocante com bacon (250g). Nosso frango é marinado por 12 horas em infusão de ervas frescas e assado em máquina giratória a gás com fogo calibrado, garantindo suculência interna incomparável e pele bem douradinha.';

-- 2. Combo 3: mesmo tratamento no qualificador do dueto.
update public.base_conhecimento
   set conteudo = 'O Combo 3 (Dueto Especial) custa R$ 94,90 e serve 3 a 4 pessoas. É a combinação perfeita de duas carnes consagradas: exatamente meio frango assado dourado crocante com ervas frescas + 500g de costelinha suína macia marinada em ervas finas e glaceada lentamente na brasa. Acompanha batatas rústicas douradas ao alecrim (300g) e farofa artesanal crocante da casa (200g). É ideal para famílias que apreciam variedade de sabores no mesmo almoço.'
 where conteudo = 'O Combo 3 (Dueto Brasa & Sabor) custa R$ 94,90 e serve 3 a 4 pessoas. É a combinação perfeita de duas carnes consagradas: exatamente meio frango assado dourado crocante com ervas frescas + 500g de costelinha suína macia marinada em ervas finas e glaceada lentamente na brasa. Acompanha batatas rústicas douradas ao alecrim (300g) e farofa artesanal crocante da casa (200g). É ideal para famílias que apreciam variedade de sabores no mesmo almoço.';

-- 3. Combo 4: sai apenas a exaltacao geografica no fecho, sem tocar nos fatos.
update public.base_conhecimento
   set conteudo = 'O Combo 4 (Kit Churrasco Família) custa R$ 169,90 e serve com fartura de 5 a 6 pessoas. É um grande banquete de domingo que reúne todos os sucessos da nossa brasa: 1 frango recheado inteiro dourado + 700g de costela bovina assada no bafo + 4 linguiças toscanas artesanais grelhadas + 4 fatias de pão de alho tostadas na brasa, acompanhados de uma tigela grande de maionese caseira tradicional (500g) e farofa grande artesanal com bacon (400g). Perfeito para celebrações em família com o melhor custo-benefício.'
 where conteudo = 'O Combo 4 (Kit Churrasco Família) custa R$ 169,90 e serve com fartura de 5 a 6 pessoas. É um grande banquete de domingo que reúne todos os sucessos da nossa brasa: 1 frango recheado inteiro dourado + 700g de costela bovina assada no bafo + 4 linguiças toscanas artesanais grelhadas + 4 fatias de pão de alho tostadas na brasa, acompanhados de uma tigela grande de maionese caseira tradicional (500g) e farofa grande artesanal com bacon (400g). Perfeito para celebrações em família com o melhor custo-benefício de Curitiba.';

-- 4. Janelas de Retirada: saem o nome de negocio no inicio e os bairros nomeados;
-- o ponto de retirada generico, o raio de 5 km e o fluxo de agendamento permanecem.
update public.base_conhecimento
   set conteudo = 'A casa opera com o modelo inovador de Pré-Venda com Janelas de Retirada de 15 minutos (ex.: 11h30, 11h45, 12h00, 12h15, 12h30, 12h45, 13h00, 13h15, 13h30). Ao agendar pelo WhatsApp, seu pedido fica reservado e sai da estufa quente direto para sua mão no balcão de retirada em menos de 90 segundos, sem filas! Também realizamos Delivery próprio com caixas térmicas vedadas em um raio de até 5 km, chegando quentinho a mais de 65°C.'
 where conteudo = 'A Casa de Assados Brasa & Sabor opera com o modelo inovador de Pré-Venda com Janelas de Retirada de 15 minutos (ex.: 11h30, 11h45, 12h00, 12h15, 12h30, 12h45, 13h00, 13h15, 13h30). Ao agendar pelo WhatsApp, seu pedido fica reservado e sai da estufa quente direto para sua mão no balcão no Umbará em menos de 90 segundos, sem filas! Também realizamos Delivery próprio com caixas térmicas vedadas em um raio de até 5 km no Umbará, Ganchinho, Sítio Cercado e Pinheirinho, chegando quentinho a mais de 65°C.';

-- Verificacao pos-deploy (manual, nao executada por esta migracao): o resultado
-- esperado de cada consulta e zero linhas.
--
--   select count(*) from public.base_conhecimento
--    where conteudo like '%Brasa & Sabor%'
--       or conteudo like '%Casa de Assados Sofia%'
--       or conteudo like '%custo-benefício de Curitiba%'
--       or conteudo like '%Umbará, Ganchinho%';
--
-- Os titulos ja limpam no codigo e permanecem fora do escopo desta migracao.
