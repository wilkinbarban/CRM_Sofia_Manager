create extension if not exists pgtap;
\ir ../migrations/20260913010000_sofia_timing_and_pacing_correction.sql
\ir ../migrations/20260914010000_sofia_web_atomic_admission.sql
\ir ../migrations/20260919010000_web_admission_idempotency_content.sql
\ir ../migrations/20261018010000_sofia_silence_window_10s_cap_20s.sql

begin;
select plan(8);

-- 1. Constraint check: sofia_inbound_batches bounds scheduled_process_at to first_message_at + 20s
select ok(
  exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid = 'public.sofia_inbound_batches'::regclass
      and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%scheduled_process_at <= (first_message_at + ''00:00:20''::interval)%'
  ),
  'sofia_inbound_batches enforces 20s starvation cap constraint'
);

-- 2. Function definitions contain 10s sliding interval and 20s cap
select ok(
  position('10 seconds' in pg_catalog.pg_get_functiondef('public.enqueue_sofia_inbound_message(uuid,uuid,text,text,text,text,timestamptz)'::regprocedure)) > 0,
  'enqueue_sofia_inbound_message sets 10s initial schedule'
);

select ok(
  position('20 seconds' in pg_catalog.pg_get_functiondef('public.enqueue_sofia_inbound_message(uuid,uuid,text,text,text,text,timestamptz)'::regprocedure)) > 0,
  'renewed admission caps schedule at 20s from first message'
);

select ok(
  position('10 seconds' in pg_catalog.pg_get_functiondef('public.attach_sofia_inbound_message(uuid,uuid,uuid,text)'::regprocedure)) > 0,
  'attach_sofia_inbound_message sets 10s initial schedule'
);

select ok(
  position('20 seconds' in pg_catalog.pg_get_functiondef('public.attach_sofia_inbound_message(uuid,uuid,uuid,text)'::regprocedure)) > 0,
  'attach_sofia_inbound_message caps renewed schedule at 20s'
);

-- 3. Execution verification under service_role
insert into public.clientes(id, nome, telefone) values
  ('c1000000-0000-4000-8000-000000000099', 'Timing Test Client', '5541999990099');
insert into public.conversas(id, cliente_id) values
  ('c2000000-0000-4000-8000-000000000099', 'c1000000-0000-4000-8000-000000000099');

create temporary table test_admissions(
  msg_id uuid,
  batch_id uuid,
  dup boolean,
  sched timestamptz
);

grant select, insert on test_admissions to service_role;
set local role service_role;
select set_config('request.jwt.claim', '{"role":"service_role"}', true);

-- First inbound message
insert into test_admissions
select * from public.enqueue_sofia_inbound_message(
  'c2000000-0000-4000-8000-000000000099',
  'c1000000-0000-4000-8000-000000000099',
  'web',
  'timing-key-1',
  'Hello timing 1',
  null
);

reset role;

select ok(
  (select sched - b.first_message_at between interval '9.8 seconds' and interval '10.2 seconds'
   from test_admissions t
   join public.sofia_inbound_batches b on b.id = t.batch_id),
  'first message sets schedule approximately 10s from first_message_at'
);

-- Second inbound message within window
set local role service_role;
select set_config('request.jwt.claim', '{"role":"service_role"}', true);

insert into test_admissions
select * from public.enqueue_sofia_inbound_message(
  'c2000000-0000-4000-8000-000000000099',
  'c1000000-0000-4000-8000-000000000099',
  'web',
  'timing-key-2',
  'Hello timing 2',
  null
);

reset role;

select ok(
  (select count(*) = 2 and count(distinct batch_id) = 1 from test_admissions),
  'consecutive messages are grouped into the same batch'
);

select ok(
  (select b.scheduled_process_at <= b.first_message_at + interval '20 seconds'
   from public.sofia_inbound_batches b
   where b.conversa_id = 'c2000000-0000-4000-8000-000000000099'),
  'batch scheduled_process_at strictly satisfies 20s starvation ceiling'
);

select * from finish();
rollback;
