-- Fatos por cliente da Sofia (memoria_cliente): schema, invariantes e conjunto de indices.
-- O preludio guardado segue supabase/tests/admin_user_dual_deletion.sql: o harness local
-- descartavel ja aplicou a cadeia completa, enquanto o runner self-hosted clona um banco que
-- ainda pode nao conter esta migracao. O harness tambem afirma a contagem exata de
-- `alter function ... owner to supabase_admin`; este slice nao adiciona nenhuma.
create extension if not exists pgtap;
create extension if not exists dblink;
select not to_regclass('public.fatos_cliente') is not null as apply_fatos_cliente_schema \gset
\if :apply_fatos_cliente_schema
\ir ../migrations/20260918010000_fatos_cliente_schema.sql
\endif
select not to_regprocedure('public.registrar_fato_cliente(uuid,text,text,text,text,uuid,numeric,boolean)') is not null as apply_fatos_cliente_rpcs \gset
\if :apply_fatos_cliente_rpcs
\ir ../migrations/20260918020000_fatos_cliente_rpcs.sql
\endif
-- O guarda procura os code points de U+2028/U+2029 no texto da constraint: quando eles ja
-- estao declarados (cadeia completa aplicada pelo harness local) nada e reaplicado.
select position('\u2028' in (select pg_catalog.pg_get_constraintdef(c.oid) from pg_catalog.pg_constraint c where c.conrelid='public.fatos_cliente'::regclass and c.conname='ck_fatos_cliente_valor_controle')) = 0 as apply_fatos_cliente_separadores \gset
\if :apply_fatos_cliente_separadores
\ir ../migrations/20260920010000_fatos_cliente_valor_separadores.sql
\endif
begin;
select plan(227);
set role postgres;

insert into public.clientes(id,nome,telefone) values
 ('f1000000-0000-4000-8000-000000000001','Memoria A','5541997000001'),
 ('f1000000-0000-4000-8000-000000000002','Memoria B','5541997000002');
insert into public.conversas(id,cliente_id) values
 ('f2000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001'),
 ('f2000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000002');

-- Relacao, colunas, nulabilidade e chaves estrangeiras.
select has_table('public','fatos_cliente','public.fatos_cliente exists as the typed customer fact store');
select has_column('public','fatos_cliente','id','fatos_cliente exposes id');
select has_column('public','fatos_cliente','cliente_id','fatos_cliente exposes cliente_id');
select has_column('public','fatos_cliente','tipo','fatos_cliente exposes tipo');
select has_column('public','fatos_cliente','chave','fatos_cliente exposes chave');
select has_column('public','fatos_cliente','valor','fatos_cliente exposes valor');
select has_column('public','fatos_cliente','origem','fatos_cliente exposes origem');
select has_column('public','fatos_cliente','origem_conversa_id','fatos_cliente exposes origem_conversa_id');
select has_column('public','fatos_cliente','confianca','fatos_cliente exposes confianca');
select has_column('public','fatos_cliente','estado','fatos_cliente exposes estado');
select has_column('public','fatos_cliente','revisado_por','fatos_cliente exposes revisado_por');
select has_column('public','fatos_cliente','revisado_em','fatos_cliente exposes revisado_em');
select has_column('public','fatos_cliente','substitui_id','fatos_cliente exposes substitui_id');
select has_column('public','fatos_cliente','criado_em','fatos_cliente exposes criado_em');
select has_column('public','fatos_cliente','atualizado_em','fatos_cliente exposes atualizado_em');
select col_is_pk('public','fatos_cliente','id','id is the identity primary key');
select col_type_is('public','fatos_cliente','confianca','numeric(3,2)','confidence keeps the designed scale');
select col_type_is('public','fatos_cliente','origem_conversa_id','uuid','provenance points at a conversation uuid');
select is(
 (select array_agg(a.attname::text order by a.attname) from pg_catalog.pg_attribute a
   where a.attrelid='public.fatos_cliente'::regclass and a.attnum>0 and not a.attisdropped and not a.attnotnull),
 array['confianca','origem_conversa_id','revisado_em','revisado_por','substitui_id']::text[],
 'exactly the five designed columns are nullable');
select ok(exists (select 1 from pg_catalog.pg_constraint c where c.conrelid='public.fatos_cliente'::regclass and c.contype='f' and c.confrelid='public.clientes'::regclass and c.confdeltype='c'),'cliente_id cascades with the customer row so the total purge stays complete');
select ok(exists (select 1 from pg_catalog.pg_constraint c where c.conrelid='public.fatos_cliente'::regclass and c.contype='f' and c.confrelid='public.conversas'::regclass and c.confdeltype='n'),'losing a conversation nulls the provenance pointer instead of the durable fact');
select ok(exists (select 1 from pg_catalog.pg_constraint c where c.conrelid='public.fatos_cliente'::regclass and c.contype='f' and c.confrelid='public.fatos_cliente'::regclass and c.confdeltype='n'),'the self reference degrades to a null history link rather than a cascade');
select is((select count(*)::integer from pg_catalog.pg_constraint c where c.conrelid='public.fatos_cliente'::regclass and c.contype='f'),3,'the table declares exactly three foreign keys, so revisado_por carries none');

-- Constraints nomeadas: a definicao exata e os dois comentarios centrais.
select is(
 (select array_agg(c.conname::text order by c.conname) from pg_catalog.pg_constraint c where c.conrelid='public.fatos_cliente'::regclass and c.contype='c'),
 array['ck_fatos_cliente_aprovacao','ck_fatos_cliente_chave','ck_fatos_cliente_confianca','ck_fatos_cliente_estado','ck_fatos_cliente_origem','ck_fatos_cliente_revisao','ck_fatos_cliente_tipo','ck_fatos_cliente_valor_controle','ck_fatos_cliente_valor_invisivel','ck_fatos_cliente_valor_nao_vazio','ck_fatos_cliente_valor_tamanho']::text[],
 'the eleven check constraints are exactly the designed ones');
select pg_catalog.pg_get_constraintdef(c.oid) as aprovacao_def from pg_catalog.pg_constraint c where c.conrelid='public.fatos_cliente'::regclass and c.conname='ck_fatos_cliente_aprovacao' \gset
select ok(position('0.85' in :'aprovacao_def') > 0,'the 0.85 threshold is a literal inside ck_fatos_cliente_aprovacao, so lowering it needs a migration');
select ok(position('restricao_alimentar' in :'aprovacao_def') > 0,'restricao_alimentar is excluded from auto-approval inside the constraint');
select ok(position('importado' in :'aprovacao_def') = 0,'importado is not part of the trusted set of ck_fatos_cliente_aprovacao');
select ok(position('cliente' in :'aprovacao_def') > 0 and position('operador' in :'aprovacao_def') > 0,'the trusted origins are exactly cliente and operador');
select ok(pg_catalog.obj_description('public.fatos_cliente'::regclass) is not null,'the table documents itself in pt-BR');
select is((select count(*)::integer from pg_catalog.pg_description d where d.objoid='public.fatos_cliente'::regclass and d.classoid='pg_catalog.pg_class'::regclass and d.objsubid>0),5,'the five documented columns carry pt-BR comments');
select is((select count(*)::integer from pg_catalog.pg_description d join pg_catalog.pg_constraint c on c.oid=d.objoid where c.conrelid='public.fatos_cliente'::regclass and d.classoid='pg_catalog.pg_constraint'::regclass),2,'the two central constraints carry pt-BR comments');

-- Contrato de forma: enums, chave e valor.
select lives_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,origem_conversa_id,confianca,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','ponto_da_carne','ao ponto para bem passado','ia','f2000000-0000-4000-8000-000000000001',0.90,'pendente')$$,'a well formed inferred fact is stored with its provenance and confidence');
select lives_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','endereco',repeat('a',64),repeat('b',500),'cliente','pendente')$$,'the 64 character key and 500 character value boundaries are accepted');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','cor','cor','azul','cliente','pendente')$$,'23514',null,'a tipo outside the five permitted values is rejected');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','voz','forte','voz','pendente')$$,'23514',null,'an origem outside the four permitted values is rejected');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','estado_invalido','x','cliente','arquivado')$$,'23514',null,'an estado outside the four permitted values is rejected');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','ChaveMaiuscula','x','cliente','pendente')$$,'23514',null,'a key with uppercase characters violates the key regex');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia',repeat('a',65),'x','cliente','pendente')$$,'23514',null,'a 65 character key violates the key regex');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','valor_vazio','','cliente','pendente')$$,'23514',null,'an empty value is rejected');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','valor_longo',repeat('b',501),'cliente','pendente')$$,'23514',null,'a 501 character value is rejected');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','valor_espaco',' ao ponto','cliente','pendente')$$,'23514',null,'a value with leading whitespace is rejected instead of trimmed on write');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','valor_quebra','ao ponto'||chr(10)||'sem cebola','cliente','pendente')$$,'23514',null,'a newline inside a value is rejected because the prompt block is line oriented');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','valor_controle','ao ponto'||chr(7),'cliente','pendente')$$,'23514',null,'a C0 control character inside a value is rejected');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','valor_invisivel','ao ponto'||chr(8203),'cliente','pendente')$$,'23514',null,'a zero width character inside a value is rejected');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','valor_bidi','ao ponto'||chr(8236),'cliente','pendente')$$,'23514',null,'a bidirectional override inside a value is rejected');
-- U+2028/U+2029 sao categoria `separator`, nao `control`: `[[:cntrl:]]` nao os alcanca, e
-- nenhum dos dois pode abrir uma linha nova no bloco do prompt.
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','valor_separador_linha','ao ponto'||chr(8232)||'sem cebola','cliente','pendente')$$,'23514',null,'a Unicode LINE SEPARATOR (U+2028) inside a value is rejected by the explicit separator class');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','valor_separador_paragrafo','ao ponto'||chr(8233)||'sem cebola','cliente','pendente')$$,'23514',null,'a Unicode PARAGRAPH SEPARATOR (U+2029) inside a value is rejected by the explicit separator class');

-- Matriz de aprovacao: o limite 0.85 vive na constraint, importado nao e confiavel e
-- restricao_alimentar nunca se auto-aprova.
select lives_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,confianca,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','auto_aprovado','bem passado','ia',0.85,'aprovado')$$,'an inferred fact at exactly the 0.85 bound is stored approved with no reviewer');
select ok((select f.estado='aprovado' and f.revisado_por is null from public.fatos_cliente f where f.chave='auto_aprovado'),'the auto-approved row carries no reviewer, so the audit predicate derives it');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,confianca,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','abaixo_limite','mal passado','ia',0.84,'aprovado')$$,'23514',null,'a below-threshold inference cannot be stored approved');
select lives_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,confianca,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','abaixo_limite','mal passado','ia',0.84,'pendente')$$,'the same below-threshold inference is accepted as pending');
select ok((select f.estado='pendente' from public.fatos_cliente f where f.chave='abaixo_limite'),'the below-threshold inference is stored pending');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,confianca,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','sem_limite','no meio','ia',0.50,'aprovado')$$,'23514',null,'a raw 0.50 approval is rejected by the database with no caller-side check');
select lives_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,confianca,estado) values('f1000000-0000-4000-8000-000000000001','restricao_alimentar','alergia_max','castanha','ia',1.00,'pendente')$$,'a maximum-confidence allergy inference is stored pending');
select ok((select f.estado='pendente' from public.fatos_cliente f where f.chave='alergia_max'),'restricao_alimentar is never auto-approved at any confidence');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,confianca,estado) values('f1000000-0000-4000-8000-000000000001','restricao_alimentar','alergia_forcada','castanha','ia',1.00,'aprovado')$$,'23514',null,'even a direct write cannot auto-approve restricao_alimentar');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','importado_sem_revisor','antigo','importado','aprovado')$$,'23514',null,'importado with estado aprovado and no reviewer is rejected');
select lives_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado,revisado_por,revisado_em) values('f1000000-0000-4000-8000-000000000001','preferencia','importado_revisado','antigo','importado','aprovado','f3000000-0000-4000-8000-000000000001',now())$$,'an imported fact reaches approved only through a recorded reviewer');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,confianca,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','operador_confianca','x','operador',0.90,'pendente')$$,'23514',null,'an operator fact cannot carry a confidence');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,confianca,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','cliente_confianca','x','cliente',0.50,'pendente')$$,'23514',null,'a customer statement cannot carry a confidence');
select lives_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,confianca,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','confianca_alta','ao ponto','ia',0.90,'aprovado')$$,'an inferred fact may carry a confidence and auto-approve above the bound');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,confianca,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','confianca_fora','x','ia',1.20,'pendente')$$,'23514',null,'a confidence outside 0..1 is rejected');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,confianca,estado,revisado_por) values('f1000000-0000-4000-8000-000000000001','preferencia','revisor_sem_data','x','ia',0.50,'pendente','f3000000-0000-4000-8000-000000000001')$$,'23514',null,'a reviewer without a review time is rejected');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,confianca,estado,revisado_em) values('f1000000-0000-4000-8000-000000000001','preferencia','data_sem_revisor','x','ia',0.50,'pendente',now())$$,'23514',null,'a review time without a reviewer is rejected');
select lives_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,confianca,estado,revisado_por,revisado_em) values('f1000000-0000-4000-8000-000000000001','preferencia','revisado_pelo_operador','restricao de sal','ia',0.50,'aprovado','f3000000-0000-4000-8000-000000000001',now())$$,'a sub-threshold inference becomes approved only with a recorded reviewer');
select lives_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','endereco','origem_cliente','Rua das Flores, 123','cliente','aprovado')$$,'a trusted human origin approves without a reviewer');
select is(
 (select array_agg(f.chave::text order by f.chave) from public.fatos_cliente f where f.origem='ia' and f.revisado_por is null and f.estado='aprovado'),
 array['auto_aprovado','confianca_alta']::text[],
 'the audit predicate selects exactly the auto-approved facts and excludes the operator-approved inference');
select is(
 (select array_agg(f.chave::text order by f.chave) from public.fatos_cliente f where f.estado='aprovado' and not (f.origem='ia' and f.revisado_por is null)),
 array['importado_revisado','origem_cliente','revisado_pelo_operador']::text[],
 'every other approved fact is explainable as a trusted human origin or a recorded reviewer');

-- RLS e privilegios: a tabela so e alcancavel pelas funcoes.
select ok((select c.relrowsecurity from pg_catalog.pg_class c where c.oid='public.fatos_cliente'::regclass),'row level security is enabled on the fact table');
select ok(not (select c.relforcerowsecurity from pg_catalog.pg_class c where c.oid='public.fatos_cliente'::regclass),'row level security is not forced, so the security definer functions keep seeing rows');
select is((select count(*)::integer from pg_catalog.pg_policy p where p.polrelid='public.fatos_cliente'::regclass),0,'no RLS policy exists; the function surface is the only access path');
select table_privs_are('public','fatos_cliente','anon',array[]::text[],'anon holds no privilege on the fact table');
select table_privs_are('public','fatos_cliente','authenticated',array[]::text[],'authenticated holds no privilege on the fact table');
select table_privs_are('public','fatos_cliente','service_role',array[]::text[],'service_role holds no privilege on the fact table');
select ok(not exists (select 1 from pg_catalog.pg_class c cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a where c.oid='public.fatos_cliente'::regclass and a.grantee=0),'PUBLIC holds no privilege on the fact table');

-- Indices: conjunto exato, predicados parciais e reuso da chave. A migracao nao adiciona
-- `alter function ... owner to supabase_admin`; a contagem exata de transferencias e afirmada
-- pelo proprio harness (scripts/run-local-sofia-sql-tests.sh, expected_owner_transfers=8).
select is(
 (select array_agg(c.relname::text order by c.relname) from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid=i.indexrelid where i.indrelid='public.fatos_cliente'::regclass),
 array['fatos_cliente_auto_aprovados','fatos_cliente_origem_conversa','fatos_cliente_pkey','fatos_cliente_prompt','fatos_cliente_revisao','fatos_cliente_substitui','uq_fatos_cliente_vigente']::text[],
 'the fact table carries exactly the designed index set');
select ok(pg_catalog.pg_get_indexdef(to_regclass('public.uq_fatos_cliente_vigente')) like 'CREATE UNIQUE INDEX%' and pg_catalog.pg_get_indexdef(to_regclass('public.uq_fatos_cliente_vigente')) like '%(cliente_id, tipo, chave)%' and pg_catalog.pg_get_indexdef(to_regclass('public.uq_fatos_cliente_vigente')) like '%pendente%' and pg_catalog.pg_get_indexdef(to_regclass('public.uq_fatos_cliente_vigente')) like '%aprovado%','uq_fatos_cliente_vigente is the partial unique one-live-fact-per-key index');
select ok(pg_catalog.pg_get_indexdef(to_regclass('public.fatos_cliente_prompt')) like '%(cliente_id, tipo, chave)%' and pg_catalog.pg_get_indexdef(to_regclass('public.fatos_cliente_prompt')) like '%estado = ''aprovado''%' and pg_catalog.pg_get_indexdef(to_regclass('public.fatos_cliente_prompt')) like '%tipo <> ''observacao''%','the prompt index is limited to approved non-observacao facts');
select ok(pg_catalog.pg_get_indexdef(to_regclass('public.fatos_cliente_revisao')) like '%(cliente_id, estado, atualizado_em DESC)%','the review index serves the operator order by estado, atualizado_em desc');
select ok(pg_catalog.pg_get_indexdef(to_regclass('public.fatos_cliente_auto_aprovados')) like '%(criado_em DESC)%' and pg_catalog.pg_get_indexdef(to_regclass('public.fatos_cliente_auto_aprovados')) like '%origem = ''ia''%' and pg_catalog.pg_get_indexdef(to_regclass('public.fatos_cliente_auto_aprovados')) like '%revisado_por IS NULL%' and pg_catalog.pg_get_indexdef(to_regclass('public.fatos_cliente_auto_aprovados')) like '%estado = ''aprovado''%','the audit index makes the auto-approval predicate visible at the schema level');
select ok(pg_catalog.pg_get_indexdef(to_regclass('public.fatos_cliente_origem_conversa')) like '%(origem_conversa_id)%' and pg_catalog.pg_get_indexdef(to_regclass('public.fatos_cliente_origem_conversa')) like '%IS NOT NULL%','the provenance foreign key action has a partial index of its own');
select ok(pg_catalog.pg_get_indexdef(to_regclass('public.fatos_cliente_substitui')) like '%(substitui_id)%' and pg_catalog.pg_get_indexdef(to_regclass('public.fatos_cliente_substitui')) like '%IS NOT NULL%','the supersession self reference has a partial index of its own');
select throws_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','endereco','origem_cliente','Rua Nova, 45','operador','pendente')$$,'23505',null,'a second live row for the key is rejected by uq_fatos_cliente_vigente even for a raw insert');
select lives_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','formato_pedido','historico_limpo','sem cebola','operador','rejeitado')$$,'a rejected fact is retained as history');
select lives_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','formato_pedido','historico_limpo','com cebola','operador','pendente')$$,'a rejected row does not block a new live fact for the key');
select is((select count(*)::integer from public.fatos_cliente f where f.chave='historico_limpo' and f.estado in ('pendente','aprovado')),1,'exactly one live row remains for the key after a rejection');
select lives_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','substituido_historico','antigo','operador','substituido')$$,'a superseded fact is retained as history');
select lives_ok($$insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,estado) values('f1000000-0000-4000-8000-000000000001','preferencia','substituido_historico','novo','operador','aprovado')$$,'a superseded row does not block a new live fact for the key');
select is((select count(*)::integer from public.fatos_cliente f where f.chave='substituido_historico' and f.estado in ('pendente','aprovado')),1,'exactly one live row remains for the key after a supersession');

-- Slice 2, task 6 (RED): funcoes de backend. A autoridade e conferida antes da forma e a forma
-- antes da existencia, para que um chamador nao autorizado nao use codigos de erro como oraculo.
insert into public.clientes(id,nome,telefone) values ('f1000000-0000-4000-8000-000000000003','Memoria C','5541997000003');
insert into public.conversas(id,cliente_id) values ('f2000000-0000-4000-8000-000000000003','f1000000-0000-4000-8000-000000000003');
select set_config('request.jwt.claim','{"role":"anon"}',false);
select throws_ok($$select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','preferencia','autoridade','x','ia',null,0.90,false)$$,'42501','SOFIA_FATO_SERVICE_ROLE_REQUIRED','authority is checked before argument shape for the writer');
select set_config('request.jwt.claim','{"role":"service_role"}',false);
select throws_ok($$select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','cor','entrada','x','ia',null,0.90,false)$$,'22023','SOFIA_FATO_ENTRADA_INVALIDA','a tipo outside the five values is invalid input');
select throws_ok($$select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','preferencia','entrada','x','voz',null,null,false)$$,'22023','SOFIA_FATO_ENTRADA_INVALIDA','an origem outside the four values is invalid input');
select throws_ok($$select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','preferencia','entrada',null,'ia',null,0.90,false)$$,'22023','SOFIA_FATO_ENTRADA_INVALIDA','a missing required value is invalid input');
select throws_ok($$select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','preferencia','Entrada','x','ia',null,0.90,false)$$,'22023','SOFIA_FATO_ENTRADA_INVALIDA','a key outside the regex is invalid input');
select throws_ok($$select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','preferencia','entrada','ao ponto'||chr(10)||'sem cebola','ia',null,0.90,false)$$,'22023','SOFIA_FATO_ENTRADA_INVALIDA','a newline inside a value is invalid input before the constraint is reached');
select throws_ok($$select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','preferencia','entrada','x','cliente',null,0.90,false)$$,'22023','SOFIA_FATO_CONFIANCA_INVALIDA','a non-inferred origin cannot carry a confidence');
select throws_ok($$select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','preferencia','entrada','x','ia',null,null,false)$$,'22023','SOFIA_FATO_CONFIANCA_INVALIDA','an inference without a confidence is invalid input');
select throws_ok($$select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','preferencia','entrada','x','ia',null,1.20,false)$$,'22023','SOFIA_FATO_CONFIANCA_INVALIDA','an inference outside the 0..1 confidence window is invalid input');
select throws_ok($$select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','preferencia','entrada','x','ia','f2000000-0000-4000-8000-000000000002',0.90,false)$$,'22023','SOFIA_FATO_CONVERSA_INVALIDA','a provenance conversation of another customer is invalid input');
select throws_ok($$select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-0000000000ff','preferencia','entrada','x','ia',null,0.90,false)$$,'P0002','SOFIA_FATO_CLIENTE_NAO_ENCONTRADO','an unknown customer is reported only after authority and shape');

-- Derivacao de estado e leitura do prompt: somente aprovado e nunca observacao.
select is((select estado from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000003','preferencia','prompt_limite','ao ponto','ia','f2000000-0000-4000-8000-000000000003',0.90,false)),'aprovado','a high-confidence inference with a provenance conversation lands approved');
select is((select estado from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000003','preferencia','prompt_pendente','bem passado','ia',null,0.50,false)),'pendente','a below-threshold inference lands pending');
select is((select estado from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000003','observacao','prompt_interno','cliente prefere retirada','operador',null,null,false)),'aprovado','a trusted operator note is approved');
select is((select array_agg(f.tipo||'/'||f.chave order by f.tipo,f.chave) from public.buscar_fatos_para_prompt('f1000000-0000-4000-8000-000000000003',20) f),array['preferencia/prompt_limite']::text[],'the prompt surface returns only approved non-observacao facts');
select is((select count(*)::integer from public.buscar_fatos_para_prompt('f1000000-0000-4000-8000-000000000003',1)),1,'the prompt surface honours the caller limit inside the 1..20 window');
select is((select count(*)::integer from public.buscar_fatos_para_prompt('f1000000-0000-4000-8000-0000000000ff',20)),0,'an unknown customer returns an empty set rather than P0002');
select throws_ok($$select * from public.buscar_fatos_para_prompt('f1000000-0000-4000-8000-000000000003',0)$$,'22023','SOFIA_FATO_ENTRADA_INVALIDA','a zero limit is invalid input');
select throws_ok($$select * from public.buscar_fatos_para_prompt('f1000000-0000-4000-8000-000000000003',21)$$,'22023','SOFIA_FATO_ENTRADA_INVALIDA','a limit above the surface cap is invalid input');
select set_config('request.jwt.claim','{"role":"anon"}',true);
select throws_ok($$select * from public.buscar_fatos_para_prompt('f1000000-0000-4000-8000-000000000003',20)$$,'42501','SOFIA_FATO_SERVICE_ROLE_REQUIRED','the prompt read requires the backend service role');
select set_config('request.jwt.claim','{"role":"service_role"}',true);

-- ACLs e definidor de seguranca: EXECUTE apenas para service_role nas duas funcoes.
select function_privs_are('public','registrar_fato_cliente',array['uuid','text','text','text','text','uuid','numeric','boolean'],'service_role',array['EXECUTE'],'the writer is executable by the backend service role');
select function_privs_are('public','registrar_fato_cliente',array['uuid','text','text','text','text','uuid','numeric','boolean'],'authenticated',array[]::text[],'the writer is not executable by an authenticated user');
select function_privs_are('public','registrar_fato_cliente',array['uuid','text','text','text','text','uuid','numeric','boolean'],'anon',array[]::text[],'the writer is not executable by anon');
select ok(not exists (select 1 from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a where p.oid='public.registrar_fato_cliente(uuid,text,text,text,text,uuid,numeric,boolean)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'),'PUBLIC cannot execute the writer');
select function_privs_are('public','buscar_fatos_para_prompt',array['uuid','integer'],'service_role',array['EXECUTE'],'the prompt read is executable by the backend service role');
select function_privs_are('public','buscar_fatos_para_prompt',array['uuid','integer'],'authenticated',array[]::text[],'the prompt read is not executable by an authenticated user');
select function_privs_are('public','buscar_fatos_para_prompt',array['uuid','integer'],'anon',array[]::text[],'the prompt read is not executable by anon');
select ok(not exists (select 1 from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a where p.oid='public.buscar_fatos_para_prompt(uuid,integer)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'),'PUBLIC cannot execute the prompt read');
select ok((select p.prosecdef and (select count(*) = 1 and bool_and(config in ('search_path=', 'search_path=""')) from pg_catalog.unnest(coalesce(p.proconfig, array[]::text[])) as config where config like 'search_path=%') from pg_catalog.pg_proc p where p.oid = 'public.registrar_fato_cliente(uuid,text,text,text,text,uuid,numeric,boolean)'::regprocedure),'the writer is security definer with a safe empty search path');
select ok((select p.prosecdef and (select count(*) = 1 and bool_and(config in ('search_path=', 'search_path=""')) from pg_catalog.unnest(coalesce(p.proconfig, array[]::text[])) as config where config like 'search_path=%') from pg_catalog.pg_proc p where p.oid = 'public.buscar_fatos_para_prompt(uuid,integer)'::regprocedure),'the prompt read is security definer with a safe empty search path');

-- Slice 2, task 8: precedencia de proveniencia cliente > operador > importado > ia. Uma correcao
-- do cliente materializa a mesma forma que `corrigir_meu_fato_cliente` grava: origem=cliente e
-- estado=aprovado no fato vigente.
select is((select estado from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','endereco','precedencia_cliente','Rua das Flores, 123','cliente',null,null,false)),'aprovado','a customer correction lives as an approved origem=cliente row');
create temporary table precedencia_antes as select f.id, f.valor, f.origem, f.estado, f.atualizado_em from public.fatos_cliente f where f.chave='precedencia_cliente';
create temporary table precedencia_ia as select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','endereco','precedencia_cliente','Rua das Pedras, 999','ia',null,0.99,false);
select is((select substituido_id from precedencia_ia),null::uuid,'a strictly lower-ranked candidate returns substituido_id null');
select is((select count(*)::integer from public.fatos_cliente f where f.chave='precedencia_cliente'),1,'a strictly lower-ranked candidate creates no successor row');
select is((select f.valor||'|'||f.origem||'|'||f.estado from public.fatos_cliente f where f.chave='precedencia_cliente'),(select p.valor||'|'||p.origem||'|'||p.estado from precedencia_antes p),'the live row is byte-identical after the discarded inference');
select ok((select f.atualizado_em = p.atualizado_em from public.fatos_cliente f, precedencia_antes p where f.chave='precedencia_cliente'),'the discarded inference does not even touch atualizado_em');
select is((select fato_id from precedencia_ia),(select p.id from precedencia_antes p),'the returned fact is the surviving customer fact, so a later ia candidate cannot overwrite the correction');

-- Repeticao identica de mesmo rank: no-op idempotente.
create temporary table repetido_primeiro as select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','preferencia','repetido','ao ponto','ia',null,0.95,false);
create temporary table repetido_segundo as select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','preferencia','repetido','ao ponto','ia',null,0.95,false);
select is((select fato_id from repetido_segundo),(select fato_id from repetido_primeiro),'a repeated identical inference returns the existing live row');
select is((select substituido_id from repetido_segundo),null::uuid,'the repeated inference supersedes nothing');
select is((select count(*)::integer from public.fatos_cliente f where f.chave='repetido'),1,'the repeated extraction never produces a second live fact');
select is((select estado from repetido_segundo),'aprovado','the idempotent replay preserves the stored state');

-- Mesmo rank com valor diferente: substituicao com elo de historico.
create temporary table sucessao_antes as select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','formato_pedido','sucessao','sem cebola','operador',null,null,false);
create temporary table sucessao_depois as select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','formato_pedido','sucessao','com cebola','operador',null,null,false);
select is((select substituido_id from sucessao_depois),(select fato_id from sucessao_antes),'a same-rank candidate with a different value supersedes its predecessor');
select is((select f.estado from public.fatos_cliente f where f.id=(select fato_id from sucessao_antes)),'substituido','the predecessor transitions to substituido instead of being deleted');
select is((select count(*)::integer from public.fatos_cliente f where f.chave='sucessao' and f.estado in ('pendente','aprovado')),1,'exactly one live row remains for the key after a supersession');
select is((select f.substitui_id from public.fatos_cliente f where f.id=(select fato_id from sucessao_depois)),(select fato_id from sucessao_antes),'the successor links its predecessor through substitui_id');

-- Corrida da mesma chave: o perdedor espera o pg_advisory_xact_lock e substitui, sem 23505.
select dblink_connect('fatos_owner', :'runtime_dblink_conninfo');
select dblink_connect('fatos_contender', :'runtime_dblink_conninfo');
select dblink_exec('fatos_owner', $$set request.jwt.claim = '{"role":"service_role"}'$$);
select dblink_exec('fatos_contender', $$set request.jwt.claim = '{"role":"service_role"}'$$);
-- A suite roda em uma unica transacao nao confirmada, que as sessoes dblink nao enxergam: o
-- cliente da corrida e criado pela propria conexao, em autocommit, para que ambos o vejam.
select dblink_exec('fatos_owner', $$insert into public.clientes(id,nome,telefone) values ('f1000000-0000-4000-8000-000000000004','Corrida Concorrente','5541997000004')$$);
select dblink_exec('fatos_owner', $$begin$$);
select dblink_exec('fatos_owner', $$do $remote$ begin perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('f1000000-0000-4000-8000-000000000004|preferencia|corrida_concorrente', 91423)); end $remote$ $$);
select dblink_send_query('fatos_contender', $$select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000004','preferencia','corrida_concorrente','versao do concorrente','operador',null,null,false)$$);
select is(dblink_is_busy('fatos_contender'),1,'the competing same-key writer waits on the advisory key lock');
select dblink_exec('fatos_owner', $$do $remote$ begin perform public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000004','preferencia','corrida_concorrente','versao do dono','operador',null,null,false); end $remote$ $$);
select dblink_exec('fatos_owner', $$commit$$);
create temporary table corrida as select * from dblink_get_result('fatos_contender') as result(fato_id uuid, estado text, substituido_id uuid);
select dblink_disconnect('fatos_owner');
select dblink_disconnect('fatos_contender');
select ok((select substituido_id is not null from corrida),'the same-key race resolves as a supersession instead of a 23505');
select is((select count(*)::integer from public.fatos_cliente f where f.chave='corrida_concorrente' and f.estado in ('pendente','aprovado')),1,'one live row survives the same-key race');
select is((select count(*)::integer from public.fatos_cliente f where f.chave='corrida_concorrente' and f.estado='substituido'),1,'the race leaves exactly one superseded predecessor');
select ok(not ('fatos_owner' = any(coalesce(dblink_get_connections(), array[]::text[])) or 'fatos_contender' = any(coalesce(dblink_get_connections(), array[]::text[]))),'both concurrent writers finish cleanly and their connections are closed');

-- Slice 2, task 9: durabilidade da recusa. A recusa bruta abaixo e a mesma transicao que
-- `revisar_fato_cliente` fara no slice 3 (rejeitar nao apaga e libera a chave).
select is((select estado from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','formato_pedido','recusa_ia','sem cebola','operador',null,null,false)),'aprovado','the refused claim starts as a live approved fact for the setup');
update public.fatos_cliente set estado='rejeitado', atualizado_em=pg_catalog.now() where chave='recusa_ia';
create temporary table recusa_antes as select f.id, f.atualizado_em from public.fatos_cliente f where f.chave='recusa_ia';
create temporary table recusa_depois as select * from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','formato_pedido','recusa_ia','sem cebola','ia',null,1.00,false);
select is((select estado from recusa_depois),'pendente','a re-inferred value identical to a refused claim lands pending, never approved');
select is((select substituido_id from recusa_depois),null::uuid,'the re-inferred candidate supersedes nothing');
select ok((select f.estado='rejeitado' and f.atualizado_em=(select a.atualizado_em from recusa_antes a) from public.fatos_cliente f where f.id=(select a.id from recusa_antes a)),'the refused row stays rejected and is not touched');
select is((select count(*)::integer from public.fatos_cliente f where f.chave='recusa_ia' and f.estado='substituido'),0,'the refusal is never superseded by re-inference');
select is((select count(*)::integer from public.fatos_cliente f where f.chave='recusa_ia' and f.estado in ('pendente','aprovado')),1,'exactly one live row exists after the re-inference');

-- Slice 2, task 10 (REFACTOR): nenhuma funcao aceita estado de aprovacao solicitado e a tabela
-- continua inalcancavel fora da superficie de funcoes.
select is((select estado from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000001','preferencia','forcar_pendente','ao ponto','operador',null,null,true)),'pendente','p_forcar_pendente makes approval harder even for a trusted origin');
select ok(position('p_estado' in pg_catalog.pg_get_functiondef('public.registrar_fato_cliente(uuid,text,text,text,text,uuid,numeric,boolean)'::regprocedure)) = 0,'no function accepts a requested approval state');
set local role authenticated;
select throws_ok($$select * from public.fatos_cliente$$,'42501',null,'direct table access stays denied for authenticated');
reset role;
set local role service_role;
select throws_ok($$select * from public.fatos_cliente$$,'42501',null,'direct table access stays denied for service_role as well');
reset role;

-- Slice 3, task 11 (RED): superficie de operador e de proprietario. O operador entra por
-- public.tem_funcoes; o proprietario e resolvido por clientes.usuario_id = auth.uid().
insert into auth.users(id,instance_id,aud,role,email,created_at,updated_at) values
 ('f3000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','memoria-operador@test',now(),now()),
 ('f3000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','memoria-proprietario-a@test',now(),now()),
 ('f3000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','memoria-proprietario-b@test',now(),now()),
 ('f3000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','memoria-sem-perfil@test',now(),now())
on conflict(id) do nothing;
insert into public.perfis(id,nome,funcao,ativo) values
 ('f3000000-0000-4000-8000-000000000001','Memoria Operador','vendedor',true),
 ('f3000000-0000-4000-8000-000000000002','Memoria Proprietario A','cliente',true),
 ('f3000000-0000-4000-8000-000000000003','Memoria Proprietario B','cliente',true),
 ('f3000000-0000-4000-8000-000000000004','Memoria Sem Perfil','cliente',true)
on conflict(id) do update set nome=excluded.nome, funcao=excluded.funcao, ativo=excluded.ativo;
insert into public.clientes(id,usuario_id,nome,telefone) values
 ('f1000000-0000-4000-8000-000000000005','f3000000-0000-4000-8000-000000000002','Memoria Proprietario A','5541997000005'),
 ('f1000000-0000-4000-8000-000000000006','f3000000-0000-4000-8000-000000000003','Memoria Proprietario B','5541997000006'),
 ('f1000000-0000-4000-8000-000000000007',null,'Memoria Listagem','5541997000007');
insert into public.conversas(id,cliente_id) values
 ('f2000000-0000-4000-8000-000000000005','f1000000-0000-4000-8000-000000000005');
insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,origem_conversa_id,confianca,estado,revisado_por,revisado_em) values
 ('f1000000-0000-4000-8000-000000000005','endereco','endereco_principal','Rua Antiga, 10','ia','f2000000-0000-4000-8000-000000000005',0.90,'aprovado',null,null),
 ('f1000000-0000-4000-8000-000000000005','preferencia','ponto_carne','bem passado','ia',null,0.50,'aprovado','f3000000-0000-4000-8000-000000000001',now()),
 ('f1000000-0000-4000-8000-000000000005','observacao','nota_interna','cliente pede retirada','operador',null,null,'aprovado',null,null),
 ('f1000000-0000-4000-8000-000000000005','formato_pedido','cebola','sem cebola','operador','f2000000-0000-4000-8000-000000000005',null,'aprovado',null,null),
 ('f1000000-0000-4000-8000-000000000005','preferencia','novo_pendente','mal passado','ia',null,0.60,'pendente',null,null),
 ('f1000000-0000-4000-8000-000000000005','preferencia','revisar_aprovar','ao ponto','ia',null,0.70,'pendente',null,null),
 ('f1000000-0000-4000-8000-000000000005','preferencia','revisar_rejeitar','mal passado','ia',null,0.60,'pendente',null,null),
 ('f1000000-0000-4000-8000-000000000005','preferencia','revisar_corrigir','no meio','ia',null,0.70,'pendente',null,null),
 ('f1000000-0000-4000-8000-000000000005','formato_pedido','revisar_terminal','suspenso','operador',null,null,'rejeitado',null,null),
 ('f1000000-0000-4000-8000-000000000005','formato_pedido','revisar_subs','antigo','operador',null,null,'substituido',null,null),
 ('f1000000-0000-4000-8000-000000000005','formato_pedido','revisar_recusa','sem cebola','operador','f2000000-0000-4000-8000-000000000005',null,'aprovado',null,null),
 ('f1000000-0000-4000-8000-000000000006','preferencia','bebida','sem acucar','operador',null,null,'aprovado',null,null);
insert into public.fatos_cliente(cliente_id,tipo,chave,valor,origem,confianca,estado,atualizado_em) values
 ('f1000000-0000-4000-8000-000000000007','preferencia','lista_aprovado_novo','ao ponto','ia',0.90,'aprovado',now()),
 ('f1000000-0000-4000-8000-000000000007','preferencia','lista_aprovado_antigo','ao ponto','operador',null,'aprovado',now()-interval '1 hour'),
 ('f1000000-0000-4000-8000-000000000007','preferencia','lista_pendente','mal passado','ia',0.40,'pendente',now()),
 ('f1000000-0000-4000-8000-000000000007','formato_pedido','lista_rejeitado','sem cebola','operador',null,'rejeitado',now()),
 ('f1000000-0000-4000-8000-000000000007','formato_pedido','lista_substituido','com cebola','operador',null,'substituido',now());
select f.id as f1_id from public.fatos_cliente f where f.chave='endereco_principal' \gset
select f.id as f2_id, f.revisado_por as f2_revisor, f.revisado_em as f2_revisado_em from public.fatos_cliente f where f.chave='ponto_carne' \gset
select f.id as f3_id from public.fatos_cliente f where f.chave='nota_interna' \gset
select f.id as f4_id from public.fatos_cliente f where f.chave='cebola' \gset
select f.id as f5_id from public.fatos_cliente f where f.chave='novo_pendente' \gset
select f.id as g1_id from public.fatos_cliente f where f.chave='bebida' \gset
select f.id as r1_id from public.fatos_cliente f where f.chave='revisar_aprovar' \gset
select f.id as r2_id from public.fatos_cliente f where f.chave='revisar_rejeitar' \gset
select f.id as r3_id from public.fatos_cliente f where f.chave='revisar_corrigir' \gset
select f.id as r4_id from public.fatos_cliente f where f.chave='revisar_terminal' \gset
select f.id as r5_id from public.fatos_cliente f where f.chave='revisar_subs' \gset
select f.id as r6_id from public.fatos_cliente f where f.chave='revisar_recusa' \gset

-- Gate de operador e fila de revisao: todos os estados, com proveniencia e ordem estavel.
set local role authenticated;
select set_config('request.jwt.claim.sub','f3000000-0000-4000-8000-000000000004',true);
select throws_ok($$select * from public.listar_fatos_cliente('f1000000-0000-4000-8000-000000000007',null,200)$$,'42501','SOFIA_FATO_OPERADOR_REQUERIDO','a plain client cannot list another customer facts');
select throws_ok(format($$select * from public.revisar_fato_cliente(%L,'aprovar')$$,:'r1_id'),'42501','SOFIA_FATO_OPERADOR_REQUERIDO','a plain client cannot review a fact');
select set_config('request.jwt.claim.sub','',true);
select throws_ok($$select * from public.listar_fatos_cliente('f1000000-0000-4000-8000-000000000007',null,200)$$,'42501','SOFIA_FATO_OPERADOR_REQUERIDO','an anonymous caller cannot list facts');
select set_config('request.jwt.claim.sub','f3000000-0000-4000-8000-000000000001',true);
select throws_ok($$select * from public.listar_fatos_cliente('f1000000-0000-4000-8000-000000000007',null,0)$$,'22023','SOFIA_FATO_ENTRADA_INVALIDA','a zero operator limit is invalid input');
select throws_ok($$select * from public.listar_fatos_cliente('f1000000-0000-4000-8000-000000000007',null,501)$$,'22023','SOFIA_FATO_ENTRADA_INVALIDA','a limit above the operator cap is invalid input');
select throws_ok($$select * from public.listar_fatos_cliente('f1000000-0000-4000-8000-000000000007',array['arquivado'],200)$$,'22023','SOFIA_FATO_ENTRADA_INVALIDA','an unknown state filter is invalid input instead of an empty list');
select throws_ok($$select * from public.listar_fatos_cliente(null,null,200)$$,'22023','SOFIA_FATO_ENTRADA_INVALIDA','a null customer is invalid input');
select throws_ok($$select * from public.listar_fatos_cliente('f1000000-0000-4000-8000-0000000000ff',null,200)$$,'P0002','SOFIA_FATO_CLIENTE_NAO_ENCONTRADO','an unknown customer is reported instead of looking empty');
select is(
 (select array_agg(t.chave||'/'||t.origem order by t.ordinality) from public.listar_fatos_cliente('f1000000-0000-4000-8000-000000000007',null,500) with ordinality as t),
 array['lista_aprovado_novo/ia','lista_aprovado_antigo/operador','lista_pendente/ia','lista_rejeitado/operador','lista_substituido/operador']::text[],
 'the operator sees all four states with provenance, ordered by estado then atualizado_em desc');
select is((select count(*)::integer from public.listar_fatos_cliente('f1000000-0000-4000-8000-000000000007',null,1)),1,'the operator limit is honoured inside 1..500');
select is(
 (select array_agg(t.chave order by t.ordinality) from public.listar_fatos_cliente('f1000000-0000-4000-8000-000000000007',array['aprovado'],500) with ordinality as t),
 array['lista_aprovado_novo','lista_aprovado_antigo']::text[],
 'the state filter returns only the requested states');
reset role;

-- Leitura do proprietario: resolucao por clientes.usuario_id, projecao estreita e sem observacao.
set local role authenticated;
select set_config('request.jwt.claim.sub','',true);
select throws_ok($$select * from public.meus_fatos_cliente(200)$$,'42501','SOFIA_FATO_NAO_AUTENTICADO','an anonymous caller cannot read the owner surface');
select set_config('request.jwt.claim.sub','f3000000-0000-4000-8000-000000000004',true);
select throws_ok($$select * from public.meus_fatos_cliente(200)$$,'P0002','SOFIA_FATO_CLIENTE_NAO_ENCONTRADO','an authenticated user without a customer profile has no facts');
select throws_ok($$select * from public.meus_fatos_cliente(0)$$,'22023','SOFIA_FATO_ENTRADA_INVALIDA','an owner limit below one is invalid input');
select set_config('request.jwt.claim.sub','f3000000-0000-4000-8000-000000000002',true);
select is(
 (select array_agg(t.tipo||'/'||t.chave||'/'||t.origem order by t.ordinality) from public.meus_fatos_cliente(200) with ordinality as t),
 array['endereco/endereco_principal/ia','formato_pedido/cebola/operador','formato_pedido/revisar_recusa/operador','preferencia/ponto_carne/ia']::text[],
 'the owner reads exactly their own approved non-observacao facts');
select ok(not exists (select 1 from public.meus_fatos_cliente(200) t where t.chave='nota_interna'),'the internal observacao never reaches the customer');
select pg_catalog.pg_get_function_result('public.meus_fatos_cliente(integer)'::regprocedure) as meu_result \gset
select ok(position('confianca' in :'meu_result') = 0 and position('revisado_por' in :'meu_result') = 0 and position('revisado_em' in :'meu_result') = 0 and position('substitui_id' in :'meu_result') = 0 and position('origem_conversa_id' in :'meu_result') = 0 and position('fato_id' in :'meu_result') > 0,'the owner projection omits the internal review chain and keeps the claim identity');
select set_config('request.jwt.claim.sub','f3000000-0000-4000-8000-000000000003',true);
select is(
 (select array_agg(t.chave order by t.ordinality) from public.meus_fatos_cliente(200) with ordinality as t),
 array['bebida']::text[],
 'one customer never reads another customer facts');
reset role;

-- Decisao do operador: aprovar, rejeitar e corrigir, com historico terminal e revisor registrado.
-- As chamadas rodam como `authenticated`; a inspecao direta da tabela roda depois do `reset role`,
-- porque `authenticated` nao tem privilegio de tabela (design 9.1).
set local role authenticated;
select set_config('request.jwt.claim.sub','f3000000-0000-4000-8000-000000000001',true);
select (select estado from public.revisar_fato_cliente(:'r1_id'::uuid,'aprovar')) as r1_estado \gset
select (select estado from public.revisar_fato_cliente(:'r2_id'::uuid,'rejeitar')) as r2_estado \gset
select (select estado from public.revisar_fato_cliente(:'r3_id'::uuid,'corrigir','ao ponto para bem passado')) as r3_estado \gset
select (select estado from public.revisar_fato_cliente(:'r6_id'::uuid,'rejeitar')) as r6_estado \gset
select throws_ok(format($$select * from public.revisar_fato_cliente(%L,'corrigir')$$,:'r1_id'),'22023','SOFIA_FATO_ENTRADA_INVALIDA','correcting without a value is invalid input');
select throws_ok(format($$select * from public.revisar_fato_cliente(%L,'aprovar','valor indevido')$$,:'r1_id'),'22023','SOFIA_FATO_ENTRADA_INVALIDA','approving with a value is invalid input');
select throws_ok(format($$select * from public.revisar_fato_cliente(%L,'arquivar')$$,:'r1_id'),'22023','SOFIA_FATO_ENTRADA_INVALIDA','an unknown decision is invalid input');
select throws_ok(format($$select * from public.revisar_fato_cliente(%L,'corrigir',' espaco')$$,:'r1_id'),'22023','SOFIA_FATO_ENTRADA_INVALIDA','an untrimmed corrected value is invalid input');
select throws_ok(format($$select * from public.revisar_fato_cliente(%L,'corrigir','ao ponto'||chr(8232)||'sem cebola')$$,:'r3_id'),'22023','SOFIA_FATO_ENTRADA_INVALIDA','a corrected value with U+2028 is refused as typed invalid input, not as a constraint violation');
select throws_ok(format($$select * from public.revisar_fato_cliente(%L,'aprovar')$$,:'r4_id'),'22023','SOFIA_FATO_NAO_REVISAVEL','a rejected fact is terminal history');
select throws_ok(format($$select * from public.revisar_fato_cliente(%L,'rejeitar')$$,:'r5_id'),'22023','SOFIA_FATO_NAO_REVISAVEL','a superseded fact is terminal history');
select throws_ok(format($$select * from public.revisar_fato_cliente(%L,'aprovar')$$,'f1000000-0000-4000-8000-0000000000ff'),'P0002','SOFIA_FATO_NAO_ENCONTRADO','an unknown fact is not found for review');
reset role;
select is(:'r1_estado'::text,'aprovado','approving a pending inference returns the approved state');
select ok((select f.estado='aprovado' and f.revisado_por='f3000000-0000-4000-8000-000000000001' and f.revisado_em is not null and f.confianca=0.70 from public.fatos_cliente f where f.id=:'r1_id'::uuid),'approval records the reviewer and the time and keeps the inference confidence');
select is(:'r2_estado'::text,'rejeitado','rejecting a pending inference returns the rejected state');
select ok((select f.estado='rejeitado' and f.confianca=0.60 and f.revisado_por='f3000000-0000-4000-8000-000000000001' from public.fatos_cliente f where f.id=:'r2_id'::uuid),'rejection is retained and keeps the inference confidence');
select is(:'r3_estado'::text,'aprovado','correcting a pending inference approves the corrected value');
select ok((select f.origem='ia' and f.valor='ao ponto para bem passado' and f.confianca is null and f.revisado_por='f3000000-0000-4000-8000-000000000001' from public.fatos_cliente f where f.id=:'r3_id'::uuid),'correction clears the confidence and records the reviewer while keeping the origin');
select is(:'r6_estado'::text,'rejeitado','a refusal through the review function lands rejected');
select ok((select f.origem='operador' and f.confianca is null and f.origem_conversa_id='f2000000-0000-4000-8000-000000000005' from public.fatos_cliente f where f.id=:'r6_id'::uuid),'the reviewed refusal produces the same row shape the writer-level refusal assertions expect');
select is((select count(*)::integer from public.fatos_cliente f where f.chave='revisar_recusa' and f.estado='substituido'),0,'the reviewed refusal supersedes nothing');
select is((select count(*)::integer from public.fatos_cliente f where f.chave='revisar_recusa' and f.estado='rejeitado'),1,'the reviewed refusal retains exactly one rejected row');
select is((select count(*)::integer from public.fatos_cliente f where f.valor like '%'||chr(8232)||'%' or f.valor like '%'||chr(8233)||'%'),0,'no stored fact value carries a Unicode line or paragraph separator');

-- Retificacao LGPD: atualizacao no lugar, sem substituicao, e recusas de posse e de observacao.
set local role authenticated;
select set_config('request.jwt.claim.sub','',true);
select throws_ok(format($$select * from public.corrigir_meu_fato_cliente(%L,'x')$$,:'f1_id'),'42501','SOFIA_FATO_NAO_AUTENTICADO','an anonymous caller cannot correct a fact');
select set_config('request.jwt.claim.sub','f3000000-0000-4000-8000-000000000002',true);
select throws_ok(format($$select * from public.corrigir_meu_fato_cliente(%L,' ')$$,:'f1_id'),'22023','SOFIA_FATO_ENTRADA_INVALIDA','an untrimmed correction is invalid input');
select throws_ok(format($$select * from public.corrigir_meu_fato_cliente(%L,'Rua Nova'||chr(8233)||', 20')$$,:'f1_id'),'22023','SOFIA_FATO_ENTRADA_INVALIDA','an owner correction with U+2029 is refused as typed invalid input');
select (select f.valor||'|'||f.estado||'|'||f.origem from public.corrigir_meu_fato_cliente(:'f1_id'::uuid,'Rua Nova, 20') f) as correcao_a \gset
select (select f.valor from public.corrigir_meu_fato_cliente(:'f2_id'::uuid,'bem passado mesmo') f) as correcao_b \gset
select throws_ok(format($$select * from public.corrigir_meu_fato_cliente(%L,'x')$$,:'f3_id'),'42501','SOFIA_FATO_NAO_EXPOSTO','an internal observacao is never exposed to correction');
select throws_ok(format($$select * from public.corrigir_meu_fato_cliente(%L,'x')$$,:'f5_id'),'P0002','SOFIA_FATO_NAO_ENCONTRADO','a pending fact does not exist for the customer surface');
select throws_ok(format($$select * from public.corrigir_meu_fato_cliente(%L,'x')$$,'f1000000-0000-4000-8000-0000000000ff'),'P0002','SOFIA_FATO_NAO_ENCONTRADO','an unknown fact is not found for correction');
select throws_ok(format($$select * from public.corrigir_meu_fato_cliente(%L,'x')$$,:'g1_id'),'42501','SOFIA_FATO_NAO_AUTORIZADO','another customer fact is refused for correction');
reset role;
select is(:'correcao_a'::text,'Rua Nova, 20|aprovado|cliente','correction updates the live fact in place with the customer as the strongest provenance');
select ok((select f.confianca is null and f.origem_conversa_id is null from public.fatos_cliente f where f.id=:'f1_id'::uuid),'correction clears the model confidence and the conversation provenance');
select is((select count(*)::integer from public.fatos_cliente f where f.id=:'f1_id'::uuid and f.estado in ('pendente','aprovado')),1,'correction leaves exactly one live fact for the key');
select is(:'correcao_b'::text,'bem passado mesmo','a correction of a reviewed fact returns the new value');
select ok((select f.revisado_por=:'f2_revisor'::uuid and f.revisado_em=:'f2_revisado_em'::timestamptz from public.fatos_cliente f where f.id=:'f2_id'::uuid),'correction preserves the previous review history');
select ok((select f.valor='sem acucar' and f.estado='aprovado' and f.origem='operador' from public.fatos_cliente f where f.id=:'g1_id'::uuid),'the refused cross-customer fact is unchanged');
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claim','{"role":"service_role"}',false);
select is((select substituido_id from public.registrar_fato_cliente('f1000000-0000-4000-8000-000000000005','endereco','endereco_principal','Rua Errada, 99','ia',null,0.99,false)),null::uuid,'a later inference cannot supersede a customer correction');
select ok((select f.valor='Rua Nova, 20' and f.origem='cliente' and f.estado='aprovado' from public.fatos_cliente f where f.id=:'f1_id'::uuid),'the corrected value remains the live fact after later inference');

-- Recusa do proprietario: rejeita sem apagar e sem reescrever a proveniencia.
set local role authenticated;
select set_config('request.jwt.claim.sub','',true);
select throws_ok(format($$select * from public.recusar_meu_fato_cliente(%L)$$,:'f4_id'),'42501','SOFIA_FATO_NAO_AUTENTICADO','an anonymous caller cannot refuse a fact');
select set_config('request.jwt.claim.sub','f3000000-0000-4000-8000-000000000002',true);
select (select estado from public.recusar_meu_fato_cliente(:'f4_id'::uuid)) as recusa_a \gset
select throws_ok(format($$select * from public.recusar_meu_fato_cliente(%L)$$,:'f3_id'),'42501','SOFIA_FATO_NAO_EXPOSTO','recusal of an internal observacao is never exposed');
select throws_ok(format($$select * from public.recusar_meu_fato_cliente(%L)$$,:'f5_id'),'P0002','SOFIA_FATO_NAO_ENCONTRADO','a pending own fact is not found for refusal');
select throws_ok(format($$select * from public.recusar_meu_fato_cliente(%L)$$,'f1000000-0000-4000-8000-0000000000ff'),'P0002','SOFIA_FATO_NAO_ENCONTRADO','an unknown fact is not found for refusal');
select throws_ok(format($$select * from public.recusar_meu_fato_cliente(%L)$$,:'g1_id'),'42501','SOFIA_FATO_NAO_AUTORIZADO','another customer fact cannot be refused');
reset role;
select is(:'recusa_a'::text,'rejeitado','a customer refusal marks the fact rejected');
select ok((select f.origem='operador' and f.confianca is null and f.origem_conversa_id='f2000000-0000-4000-8000-000000000005' from public.fatos_cliente f where f.id=:'f4_id'::uuid),'refusal leaves origem, confianca and origem_conversa_id unchanged');
select is((select count(*)::integer from public.fatos_cliente f where f.id=:'f4_id'::uuid),1,'the refused row is retained instead of deleted');
select ok((select f.estado='aprovado' from public.fatos_cliente f where f.id=:'g1_id'::uuid),'the cross-customer refusal leaves the other customer fact unchanged');

-- Slice 3, task 13 (TRIANGULATE): matriz de ACL, definidor de seguranca e trava compartilhada.
select function_privs_are('public','listar_fatos_cliente',array['uuid','text[]','integer'],'authenticated',array['EXECUTE'],'the operator list is executable by authenticated');
select function_privs_are('public','listar_fatos_cliente',array['uuid','text[]','integer'],'service_role',array[]::text[],'the operator list is not executable by service_role');
select function_privs_are('public','listar_fatos_cliente',array['uuid','text[]','integer'],'anon',array[]::text[],'the operator list is not executable by anon');
select function_privs_are('public','revisar_fato_cliente',array['uuid','text','text'],'authenticated',array['EXECUTE'],'the operator review is executable by authenticated');
select function_privs_are('public','revisar_fato_cliente',array['uuid','text','text'],'service_role',array[]::text[],'the operator review is not executable by service_role');
select function_privs_are('public','revisar_fato_cliente',array['uuid','text','text'],'anon',array[]::text[],'the operator review is not executable by anon');
select function_privs_are('public','meus_fatos_cliente',array['integer'],'authenticated',array['EXECUTE'],'the owner read is executable by authenticated');
select function_privs_are('public','meus_fatos_cliente',array['integer'],'service_role',array[]::text[],'the owner read is not executable by service_role');
select function_privs_are('public','meus_fatos_cliente',array['integer'],'anon',array[]::text[],'the owner read is not executable by anon');
select function_privs_are('public','corrigir_meu_fato_cliente',array['uuid','text'],'authenticated',array['EXECUTE'],'the owner correction is executable by authenticated');
select function_privs_are('public','corrigir_meu_fato_cliente',array['uuid','text'],'service_role',array[]::text[],'the owner correction is not executable by service_role');
select function_privs_are('public','corrigir_meu_fato_cliente',array['uuid','text'],'anon',array[]::text[],'the owner correction is not executable by anon');
select function_privs_are('public','recusar_meu_fato_cliente',array['uuid'],'authenticated',array['EXECUTE'],'the owner refusal is executable by authenticated');
select function_privs_are('public','recusar_meu_fato_cliente',array['uuid'],'service_role',array[]::text[],'the owner refusal is not executable by service_role');
select function_privs_are('public','recusar_meu_fato_cliente',array['uuid'],'anon',array[]::text[],'the owner refusal is not executable by anon');
select ok(not exists (
 select 1 from pg_catalog.pg_proc p
  cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
  where p.oid in ('public.listar_fatos_cliente(uuid,text[],integer)'::regprocedure,
                  'public.revisar_fato_cliente(uuid,text,text)'::regprocedure,
                  'public.meus_fatos_cliente(integer)'::regprocedure,
                  'public.corrigir_meu_fato_cliente(uuid,text)'::regprocedure,
                  'public.recusar_meu_fato_cliente(uuid)'::regprocedure)
    and a.grantee=0 and a.privilege_type='EXECUTE'),'PUBLIC cannot execute any of the five operator or owner functions');
select ok(not exists (
 select 1 from pg_catalog.pg_proc p where p.oid in ('public.listar_fatos_cliente(uuid,text[],integer)'::regprocedure,'public.revisar_fato_cliente(uuid,text,text)'::regprocedure,'public.meus_fatos_cliente(integer)'::regprocedure,'public.corrigir_meu_fato_cliente(uuid,text)'::regprocedure,'public.recusar_meu_fato_cliente(uuid)'::regprocedure)
   and (not p.prosecdef or not exists (select 1 from pg_catalog.unnest(coalesce(p.proconfig,array[]::text[])) c where c in ('search_path=','search_path=""')))),'the five new functions are security definer with an empty search path');
select ok(position('pg_catalog.hashtextextended(' in pg_catalog.pg_get_functiondef('public.revisar_fato_cliente(uuid,text,text)'::regprocedure)) > 0 and position(', 91423)' in pg_catalog.pg_get_functiondef('public.revisar_fato_cliente(uuid,text,text)'::regprocedure)) > 0 and position('pg_catalog.hashtextextended(' in pg_catalog.pg_get_functiondef('public.registrar_fato_cliente(uuid,text,text,text,text,uuid,numeric,boolean)'::regprocedure)) > 0,'review and write share the same advisory key lock expression');

select * from finish();
rollback;
