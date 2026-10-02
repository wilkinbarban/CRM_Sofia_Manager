create extension if not exists pgtap;
begin;
select plan(40);

-- 1. Function execution permissions
select function_privs_are(
  'public',
  'claim_notification_outbox_for_channels',
  array['text[]', 'integer'],
  'service_role',
  array['EXECUTE'],
  'service_role may execute channel-scoped claim'
);

select function_privs_are(
  'public',
  'claim_notification_outbox_for_channels',
  array['text[]', 'integer'],
  'authenticated',
  array[]::text[],
  'authenticated cannot execute channel-scoped claim'
);

select function_privs_are(
  'public',
  'claim_notification_outbox_for_channels',
  array['text[]', 'integer'],
  'anon',
  array[]::text[],
  'anon cannot execute channel-scoped claim'
);

select function_privs_are(
  'public',
  'claim_notification_outbox',
  array['integer'],
  'service_role',
  array['EXECUTE'],
  'historical claim RPC service_role grant unchanged'
);

-- 2. Table ACL and permission security: direct table access denied to service_role
select table_privs_are(
  'public',
  'notification_outbox',
  'service_role',
  array[]::text[],
  'service_role has no direct table grants on notification_outbox'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$select * from public.notification_outbox limit 1$$,
  '42501',
  null,
  'direct table select by service_role is rejected'
);

select throws_ok(
  $$update public.notification_outbox set status = 'pending' where id = 1$$,
  '42501',
  null,
  'direct table update by service_role is rejected'
);

-- 3. Caller authentication and identity boundary on channel claim RPC
reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok(
  $$select * from public.claim_notification_outbox_for_channels(array['web'], 60)$$,
  '42501',
  'NOTIFICATION_OUTBOX_SERVICE_ROLE_REQUIRED',
  'anonymous caller is rejected'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role","sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}', true);
select throws_ok(
  $$select * from public.claim_notification_outbox_for_channels(array['web'], 60)$$,
  '42501',
  'NOTIFICATION_OUTBOX_SERVICE_ROLE_REQUIRED',
  'caller with auth.uid is rejected'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}', true);
select throws_ok(
  $$select * from public.claim_notification_outbox_for_channels(array['web'], 60)$$,
  '42501',
  null,
  'authenticated caller cannot execute channel-scoped claim'
);

-- 4. Parameter validation (lease boundaries, lease NULL, and channel names)
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$select * from public.claim_notification_outbox_for_channels(array['web'], 9)$$,
  '22023',
  'NOTIFICATION_OUTBOX_LEASE_INVALID',
  'lease under 10 seconds is rejected'
);

select throws_ok(
  $$select * from public.claim_notification_outbox_for_channels(array['web'], 301)$$,
  '22023',
  'NOTIFICATION_OUTBOX_LEASE_INVALID',
  'lease over 300 seconds is rejected'
);

select throws_ok(
  $$select * from public.claim_notification_outbox_for_channels(array['web'], null)$$,
  '22023',
  'NOTIFICATION_OUTBOX_LEASE_INVALID',
  'null lease seconds is rejected'
);

select throws_ok(
  $$select * from public.claim_notification_outbox_for_channels(array['email'], 60)$$,
  '22023',
  'NOTIFICATION_OUTBOX_CHANNELS_INVALID',
  'unknown channel element is rejected'
);

select throws_ok(
  $$select * from public.claim_notification_outbox_for_channels(array['web', null], 60)$$,
  '22023',
  'NOTIFICATION_OUTBOX_CHANNELS_INVALID',
  'null channel element is rejected'
);

select throws_ok(
  $$select * from public.claim_notification_outbox_for_channels(array[''], 60)$$,
  '22023',
  'NOTIFICATION_OUTBOX_CHANNELS_INVALID',
  'empty channel string is rejected'
);

-- 5. Seed initial fixtures across three channels via service_role RPC
do $$
begin
  perform public.enqueue_notification_outbox(
    'order',
    '11111111-1111-4111-8111-111111111111',
    'order_created',
    '22222222-2222-4222-8222-222222222222',
    null,
    null,
    'web',
    '{"message_key":"order_created"}'
  );
  perform public.enqueue_notification_outbox(
    'order',
    '11111111-1111-4111-8111-111111111111',
    'order_created',
    '33333333-3333-4333-8333-333333333333',
    null,
    null,
    'whatsapp',
    '{"message_key":"order_created"}'
  );
  perform public.enqueue_notification_outbox(
    'order',
    '11111111-1111-4111-8111-111111111111',
    'order_created',
    '44444444-4444-4444-8444-444444444444',
    null,
    null,
    'telegram',
    '{"message_key":"order_created"}'
  );
end;
$$;

-- 6. Null and empty channel array handling
select is(
  (select count(*)::integer from public.claim_notification_outbox_for_channels(null, 60)),
  0,
  'null channels argument returns no claims'
);

select is(
  (select count(*)::integer from public.claim_notification_outbox_for_channels(array[]::text[], 60)),
  0,
  'empty channels array returns no claims'
);

-- Inspect table state as test owner
reset role;
select is(
  (select count(*)::integer from public.notification_outbox where status = 'pending' and attempts = 0),
  3,
  'all rows remain pending with 0 attempts after null/empty claims'
);

-- 7. Scoped channel claiming and preserved closed backlog
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  c record;
begin
  select * into c from public.claim_notification_outbox_for_channels(array['web'], 60);
  perform set_config('test.claim_web_id', c.id::text, false);
  perform set_config('test.claim_web_token', c.lease_token::text, false);
  perform set_config('test.claim_web_attempt', c.attempt::text, false);
  perform set_config('test.claim_web_channel', c.channel, false);
end;
$$;

select is(
  current_setting('test.claim_web_channel'),
  'web',
  'claim with array[web] claims exactly the web row'
);

select is(
  (select count(*)::integer from public.claim_notification_outbox_for_channels(array['web'], 60)),
  0,
  'second claim with array[web] returns no rows'
);

-- Inspect closed channels backlog as test owner
reset role;
select is(
  (select count(*)::integer from public.notification_outbox where channel in ('whatsapp', 'telegram') and status = 'pending' and attempts = 0),
  2,
  'whatsapp and telegram rows remain untouched in pending with zero attempts'
);

select is(
  (select count(*)::integer from public.notification_outbox where channel = 'whatsapp' and status = 'pending' and attempts = 0),
  1,
  'closed whatsapp channel backlog is preserved'
);

select is(
  (select count(*)::integer from public.notification_outbox where channel = 'telegram' and status = 'pending' and attempts = 0),
  1,
  'closed telegram channel backlog is preserved'
);

-- Claim telegram row
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  c record;
begin
  select * into c from public.claim_notification_outbox_for_channels(array['telegram'], 60);
  perform set_config('test.claim_tg_channel', c.channel, false);
end;
$$;

select is(
  current_setting('test.claim_tg_channel'),
  'telegram',
  'claim with array[telegram] claims telegram row'
);

reset role;
select is(
  (select count(*)::integer from public.notification_outbox where channel = 'whatsapp' and status = 'pending' and attempts = 0),
  1,
  'whatsapp row still remains pending with zero attempts'
);

-- Claim with multiple channels (web already claimed, claims whatsapp)
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  c record;
begin
  select * into c from public.claim_notification_outbox_for_channels(array['web', 'whatsapp'], 60);
  perform set_config('test.claim_wa_channel', c.channel, false);
end;
$$;

select is(
  current_setting('test.claim_wa_channel'),
  'whatsapp',
  'claim with array[web, whatsapp] claims whatsapp row'
);

-- 8. Fenced completion verification
select ok(
  public.complete_notification_outbox(
    current_setting('test.claim_web_id')::bigint,
    'success',
    null,
    current_setting('test.claim_web_token')::uuid,
    current_setting('test.claim_web_attempt')::integer
  ),
  'fenced completion succeeds with matching token and attempt'
);

reset role;
select is(
  (select status from public.notification_outbox where id = current_setting('test.claim_web_id')::bigint),
  'completed',
  'completed row status is completed'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  not public.complete_notification_outbox(
    current_setting('test.claim_web_id')::bigint,
    'success',
    null,
    gen_random_uuid(),
    current_setting('test.claim_web_attempt')::integer
  ),
  'stale token cannot complete an already transitioned row'
);

-- 9. Expired lease with available attempts reclaims/scoped rows
do $$
declare
  v_reclaim_web_id bigint;
  v_reclaim_wa_id bigint;
begin
  v_reclaim_web_id := public.enqueue_notification_outbox(
    'order',
    '11111111-1111-4111-8111-111111111111',
    'order_created',
    '66666666-6666-4666-8666-666666666666',
    null,
    null,
    'web',
    '{"message_key":"order_created"}'
  );
  v_reclaim_wa_id := public.enqueue_notification_outbox(
    'order',
    '11111111-1111-4111-8111-111111111111',
    'order_created',
    '77777777-7777-4777-8777-777777777777',
    null,
    null,
    'whatsapp',
    '{"message_key":"order_created"}'
  );
  perform set_config('test.reclaim_web_id', v_reclaim_web_id::text, false);
  perform set_config('test.reclaim_wa_id', v_reclaim_wa_id::text, false);
end;
$$;

-- Prepare expired claimed state with available attempts (attempts=1, max_attempts=5) as test owner
reset role;
update public.notification_outbox
set status = 'claimed',
    attempts = 1,
    max_attempts = 5,
    lease_token = '11111111-2222-4333-8444-555555555555'::uuid,
    claimed_until = now() - interval '10 seconds',
    next_attempt_at = now() - interval '10 seconds'
where id in (
  current_setting('test.reclaim_web_id')::bigint,
  current_setting('test.reclaim_wa_id')::bigint
);

-- Claim with array['web'] only: should reclaim web row, increment attempts, rotate token, and leave whatsapp untouched
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  c record;
begin
  select * into c from public.claim_notification_outbox_for_channels(array['web'], 60);
  perform set_config('test.reclaimed_web_id', c.id::text, false);
  perform set_config('test.reclaimed_web_token', c.lease_token::text, false);
  perform set_config('test.reclaimed_web_attempt', c.attempt::text, false);
  perform set_config('test.reclaimed_web_channel', c.channel, false);
end;
$$;

select is(
  current_setting('test.reclaimed_web_id')::bigint,
  current_setting('test.reclaim_web_id')::bigint,
  'expired lease with available attempts is reclaimed for scoped web channel'
);

select is(
  current_setting('test.reclaimed_web_attempt')::integer,
  2,
  'reclaimed row increments attempt count to 2'
);

select isnt(
  current_setting('test.reclaimed_web_token'),
  '11111111-2222-4333-8444-555555555555',
  'reclaimed row acquires a newly generated lease token'
);

-- Verify expired whatsapp row remains untouched in its existing state
reset role;
select is(
  (select attempts from public.notification_outbox where id = current_setting('test.reclaim_wa_id')::bigint),
  1,
  'expired whatsapp row remains untouched when claiming only web channel'
);

select is(
  (select lease_token::text from public.notification_outbox where id = current_setting('test.reclaim_wa_id')::bigint),
  '11111111-2222-4333-8444-555555555555',
  'expired whatsapp row lease token remains unchanged by web channel claim'
);

-- Claim whatsapp row to verify subsequent reclaim of other scoped channel
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  c record;
begin
  select * into c from public.claim_notification_outbox_for_channels(array['whatsapp'], 60);
  perform set_config('test.reclaimed_wa_id', c.id::text, false);
  perform set_config('test.reclaimed_wa_attempt', c.attempt::text, false);
end;
$$;

select is(
  current_setting('test.reclaimed_wa_id')::bigint,
  current_setting('test.reclaim_wa_id')::bigint,
  'expired whatsapp row is reclaimed when whatsapp channel is queried'
);

select is(
  current_setting('test.reclaimed_wa_attempt')::integer,
  2,
  'reclaimed whatsapp row increments attempt count to 2'
);

-- 10. Dead letter on expired lease reaching max attempts
do $$
declare
  v_id bigint;
begin
  v_id := public.enqueue_notification_outbox(
    'order',
    '11111111-1111-4111-8111-111111111111',
    'order_created',
    '55555555-5555-4555-8555-555555555555',
    null,
    null,
    'web',
    '{"message_key":"order_created"}'
  );
  perform set_config('test.dead_letter_id', v_id::text, false);
end;
$$;

reset role;
update public.notification_outbox
set status = 'claimed',
    attempts = 3,
    max_attempts = 3,
    lease_token = gen_random_uuid(),
    claimed_until = now() - interval '10 seconds',
    next_attempt_at = now() - interval '10 seconds'
where id = current_setting('test.dead_letter_id')::bigint;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select count(*)::integer from public.claim_notification_outbox_for_channels(array['web'], 60)),
  0,
  'claim encounters expired lease at max attempts, dead letters it, and returns no row'
);

reset role;
select is(
  (select status from public.notification_outbox where id = current_setting('test.dead_letter_id')::bigint),
  'dead_letter',
  'exhausted expired job transitions to dead_letter'
);

select ok(
  (select lease_token is null and claimed_until is null from public.notification_outbox where id = current_setting('test.dead_letter_id')::bigint),
  'dead-lettered row clears lease_token and claimed_until'
);

select * from finish();
rollback;
