-- Substituicao do prompt mestre aposentado de Sofia por um prompt de CRM neutro.
--
-- O valor gravado hoje em public.configuracoes_sistema pela migracao aplicada
-- 20260828160000_update_brand_and_combos_brasa_sabor descreve um negocio
-- especifico ("CASA DE ASSADOS BRASA & SABOR (UMBARÁ, CURITIBA)") com combos,
-- precos, endereco e um modelo de pre-venda que nunca existiram como operacao
-- real. Este repositorio e um CRM que sera adaptado a qualquer negocio, e todo
-- cliente, conversa, produto em estoque e pedido e dado de teste. O prompt
-- aposentado faz a Sofia afirmar um comercio fictício como se fosse real; o
-- texto abaixo diz o que e verdade — ambiente de demonstracao, dados de exemplo
-- e proibicao de inventar ramo, marca, catalogo, precos ou prazos.
--
-- Migracao apenas para frente. 20260828160000 ja esta aplicada em producao, logo
-- edita-la nao mudaria nada la e falsificaria o historico. A correcao entra aqui,
-- sobre os dados. Nenhuma transferencia de posse de funcao e adicionada.
--
-- Guarda obrigatoria, nao UPDATE incondicional. O prompt e conteudo operacional
-- editavel em runtime pelo dashboard, entao um UPDATE sem guarda destruiria em
-- silencio o que o operador tivesse gravado. A clausula `like` a seguir so casa o
-- prompt aposentado, identificado pela marca que ele cita. Se o operador ja
-- trocou o texto por outra coisa, nenhuma linha casa, nada e escrito e a
-- migracao e um no-op — inclusive em qualquer reexecucao depois desta.
--
-- O valor e gravado com dollar-quoting porque o prompt tem varias linhas, aspas
-- e `#`. O delimitador e `$$`, sem tag, e o fechamento fica encostado no fim da
-- ultima linha, de proposito, para que o valor gravado seja byte-identico a
-- constante DEFAULT_SOFIA_SYSTEM_PROMPT em
-- apps/web/src/lib/sofia/default-prompt.ts, sem newline final que uma das duas
-- copias nao teria. Dollars com tag (`$prompt$`) nao servem aqui: o validador
-- lexico de ops/supabase/migrate.sh consome o `$` de fechamento da tag como
-- parte do identificador e nunca reconhece o delimitador, tratando o corpo como
-- SQL solto. Nao ha `$` no texto abaixo, entao `$$` e seguro.
--
-- `data_atualizacao` nao e atribuida aqui: o trigger
-- tr_configuracoes_sistema_atualizar_data, criado em 20260705010000, ja a
-- atualiza em todo UPDATE. `eh_segredo` tambem fica intocado — o prompt nao e
-- credencial e nao cabe a esta migracao alterar metadado de operador.
--
-- Verificacao pos-deploy (manual, nao executada por esta migracao), esperando
-- uma linha com o novo cabecalho e nenhuma ocorrencia da marca aposentada:
--
--   select left(valor, 30) from public.configuracoes_sistema
--    where chave = 'SOFIA_SYSTEM_PROMPT';
--   select count(*) from public.configuracoes_sistema
--    where chave = 'SOFIA_SYSTEM_PROMPT' and valor like '%CASA DE ASSADOS BRASA & SABOR%';

update public.configuracoes_sistema
   set valor = $$# PROMPT MESTRE — SOFIA (CRM)

## 1. QUEM É VOCÊ
Você é a Sofia, atendente deste CRM. Este CRM é um produto que se adapta a
diferentes negócios. Hoje ainda NÃO existe um negócio real configurado: este
é um ambiente de demonstração.

## 2. REGRA DE OURO
Nunca invente nem presuma ramo de atividade, marca, endereço, catálogo,
preços ou prazos. Se perguntarem sobre o negócio, responda que este é um
ambiente de testes e que os dados são de exemplo.

## 3. DADOS DE TESTE
Tudo o que você consulta — clientes, conversas, produtos em estoque, pedidos —
é fictício e serve para validar o sistema. Nunca apresente esses dados como
reais, nem os trate como informações de um negócio em funcionamento.

## 4. SUA TAREFA
Atender cada pessoa com cordialidade e clareza, dentro das regras do sistema,
e encaminhar para um atendente humano quando não puder resolver ou quando a
pessoa pedir.

## 5. LIMITES
- Não prometa prazos, preços, descontos ou entregas que não estejam nos dados.
- Não compartilhe informações de outros clientes.
- Se não souber algo, diga com clareza e ofereça encaminhar.
- Não afirme ser de um negócio específico.$$
 where chave = 'SOFIA_SYSTEM_PROMPT'
   and valor like '%CASA DE ASSADOS BRASA & SABOR%';
