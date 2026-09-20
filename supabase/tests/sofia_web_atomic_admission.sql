create extension if not exists pgtap;
\ir ../migrations/20260913010000_sofia_timing_and_pacing_correction.sql
\ir ../migrations/20260914010000_sofia_web_atomic_admission.sql
\ir ../migrations/20260919010000_web_admission_idempotency_content.sql
begin;
select plan(28);

select ok(exists (select 1 from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) privilege where p.oid = 'public.enqueue_sofia_inbound_message(uuid,uuid,text,text,text,text,timestamptz)'::regprocedure and privilege.grantee = pg_catalog.to_regrole('service_role')::oid and privilege.privilege_type = 'EXECUTE'),'service role has direct Web admission EXECUTE');
select ok(not exists (select 1 from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) privilege where p.oid = 'public.enqueue_sofia_inbound_message(uuid,uuid,text,text,text,text,timestamptz)'::regprocedure and privilege.grantee in (pg_catalog.to_regrole('anon')::oid, pg_catalog.to_regrole('authenticated')::oid) and privilege.privilege_type = 'EXECUTE'),'anon and authenticated have no direct Web admission EXECUTE');
select ok(not exists (select 1 from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) privilege where p.oid = 'public.enqueue_sofia_inbound_message(uuid,uuid,text,text,text,text,timestamptz)'::regprocedure and privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'),'PUBLIC cannot admit Web messages');
select ok((select p.prosecdef and (select count(*) = 1 and bool_and(config in ('search_path=', 'search_path=""')) from pg_catalog.unnest(coalesce(p.proconfig, array[]::text[])) as config where config like 'search_path=%') from pg_catalog.pg_proc p where p.oid = 'public.enqueue_sofia_inbound_message(uuid,uuid,text,text,text,text,timestamptz)'::regprocedure),'Web admission remains security definer with a safe empty search path');
select ok(position('''web''' in pg_catalog.pg_get_functiondef('public.enqueue_sofia_inbound_message(uuid,uuid,text,text,text,text,timestamptz)'::regprocedure)) > 0,'the canonical admission RPC accepts the Web channel');
select ok(position('sofia-web:' in pg_catalog.pg_get_functiondef('public.enqueue_sofia_inbound_message(uuid,uuid,text,text,text,text,timestamptz)'::regprocedure)) > 0,'the Web idempotency key uses a Web-specific external-id namespace');
select ok(position('''sofia-inbound:''' in pg_catalog.pg_get_functiondef('public.enqueue_sofia_inbound_message(uuid,uuid,text,text,text,text,timestamptz)'::regprocedure)) > 0,'Telegram and WhatsApp keep their existing external-id namespace');

insert into public.clientes(id,nome,telefone) values
 ('c1000000-0000-4000-8000-000000000001','Atomic Web','5541991111301'),
 ('c1000000-0000-4000-8000-000000000002','Other','5541991111302'),
 ('c1000000-0000-4000-8000-000000000003','Mixed','5541991111303');
insert into public.conversas(id,cliente_id) values
 ('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001'),
 ('c2000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000002'),
 ('c2000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000003');
create temporary table admissao(label text,message_id uuid,batch_id uuid,duplicate boolean,scheduled_at timestamptz);
grant select,insert on admissao to service_role;
set local role service_role;
select set_config('request.jwt.claim','{"role":"service_role"}',true);
insert into admissao select 'first',* from public.enqueue_sofia_inbound_message('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','web','web-key-1','primeiro',null);
insert into admissao select 'retry',* from public.enqueue_sofia_inbound_message('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','web','web-key-1','primeiro',null);
insert into admissao select 'attachment',* from public.enqueue_sofia_inbound_message('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','web','web-key-2',null,'cliente/comprovante.pdf');
insert into admissao select 'telegram',* from public.enqueue_sofia_inbound_message('c2000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000003','telegram','tg-key-1','telegram',null);
reset role;
select is((select count(*)::integer from public.mensagens where conversa_id='c2000000-0000-4000-8000-000000000001'),2,'Web admission inserts the canonical message in the same transaction as its batch membership');
select is((select array_agg(m.external_id order by m.external_id) from public.mensagens m where m.conversa_id='c2000000-0000-4000-8000-000000000001'),array['sofia-web:web-key-1','sofia-web:web-key-2']::text[],'the client idempotency key is stored in the Web external-id namespace');
select is((select array_agg(m.remetente::text order by m.external_id) from public.mensagens m where m.conversa_id='c2000000-0000-4000-8000-000000000001'),array['cliente','cliente']::text[],'admitted Web messages remain canonical customer messages');
select is((select m.conteudo from public.mensagens m where m.external_id='sofia-web:web-key-2'),null,'an attachment-only Web message stores no text');
select is((select m.url_anexo from public.mensagens m where m.external_id='sofia-web:web-key-2'),'cliente/comprovante.pdf','an attachment-only Web message keeps its canonical attachment metadata');
select is((select count(*)::integer from public.sofia_inbound_batches where conversa_id='c2000000-0000-4000-8000-000000000001'),1,'Web admissions share one pending conversation batch');
select is((select b.canal from public.sofia_inbound_batches b where b.conversa_id='c2000000-0000-4000-8000-000000000001'),'web','the admitted batch belongs to the Web channel');
select is((select count(*)::integer from public.sofia_inbound_batch_messages bm join public.sofia_inbound_batches b on b.id=bm.batch_id where b.conversa_id='c2000000-0000-4000-8000-000000000001'),2,'replaying a key creates no extra batch membership');
select ok((select first.message_id = retry.message_id and first.batch_id = retry.batch_id and first.scheduled_at = retry.scheduled_at and retry.duplicate and not first.duplicate from admissao first, admissao retry where first.label='first' and retry.label='retry'),'a replayed Web key returns the original message, batch and unchanged deadline');
select is((select m.conteudo from public.mensagens m where m.external_id='sofia-web:web-key-1'),'primeiro','a replayed Web key never rewrites the stored message');
select ok((select abs(extract(epoch from b.scheduled_process_at - b.latest_message_at) - 25) < 0.1 from public.sofia_inbound_batches b where b.conversa_id='c2000000-0000-4000-8000-000000000001'),'Web admission renews the twenty-five second silence window');
select ok((select b.scheduled_process_at <= b.first_message_at + interval '60 seconds' from public.sofia_inbound_batches b where b.conversa_id='c2000000-0000-4000-8000-000000000001'),'Web admission respects the sixty-second starvation cap');
set local role service_role;
select set_config('request.jwt.claim','{"role":"service_role"}',true);
select throws_ok($$select * from public.enqueue_sofia_inbound_message('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','web','web-key-1','editado',null)$$,'23505','SOFIA_BATCH_DELIVERY_CONTENT_CONFLICT','a reused Web key with edited content fails closed instead of returning the stale message');
select throws_ok($$select * from public.enqueue_sofia_inbound_message('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','web','web-key-2',null,'cliente/outro.pdf')$$,'23505','SOFIA_BATCH_DELIVERY_CONTENT_CONFLICT','a reused Web key with a different attachment fails closed');
select lives_ok($$select * from public.enqueue_sofia_inbound_message('c2000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000003','telegram','tg-key-1','telegram editado',null)$$,'a non-Web channel still tolerates a repeated key with different content');
select throws_ok($$select * from public.enqueue_sofia_inbound_message('c2000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000003','web','web-conflict','conflito',null)$$,'23505','SOFIA_BATCH_BINDING_CONFLICT','a Web admission cannot join a pending batch of another channel');
select throws_ok($$select * from public.enqueue_sofia_inbound_message('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','web','web-empty',null,null)$$,'22023','SOFIA_BATCH_ADMISSION_INVALID','a Web admission without text or attachment fails closed');
select throws_ok($$select * from public.enqueue_sofia_inbound_message('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','web','   ','texto',null)$$,'22023','SOFIA_BATCH_ADMISSION_INVALID','a blank Web idempotency key fails closed');
select throws_ok($$select * from public.enqueue_sofia_inbound_message('c2000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000001','web','web-binding','texto',null)$$,'22023','SOFIA_BATCH_BINDING_INVALID','a Web admission validates customer ownership of the conversation');
select set_config('request.jwt.claim','{"role":"authenticated"}',true);
select throws_ok($$select * from public.enqueue_sofia_inbound_message('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','web','web-auth','texto',null)$$,'42501','SOFIA_BATCH_SERVICE_ROLE_REQUIRED','authority is checked before Web input details');
reset role;
select is((select count(*)::integer from public.mensagens where conversa_id='c2000000-0000-4000-8000-000000000001'),2,'a rejected content mismatch leaves exactly the originally admitted rows');
select * from finish();
rollback;
