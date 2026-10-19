-- Forward-only migration updating Sofia inbound batching silence window and starvation cap.
--
-- Replaces the historical 25s silence window / 60s cap with a uniform 10s silence window
-- renewed after each admitted inbound message, bounded by a 20s hard starvation cap measured
-- from the batch's first admitted message. Applied across Telegram, WhatsApp and Web channels.

-- 1. Tighten the batch schedule bound check constraint to 20 seconds.
do $$
declare
  v_constraint text;
  v_count integer;
begin
  select pg_catalog.count(*) into v_count
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.sofia_inbound_batches'::regclass
      and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%scheduled_process_at <=%'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%first_message_at%';
  if v_count <> 1 then
    raise exception using errcode = '55000', message = 'SOFIA_BATCH_SCHEDULE_BOUND_MISMATCH';
  end if;
  select c.conname into v_constraint
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.sofia_inbound_batches'::regclass
      and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%scheduled_process_at <=%'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%first_message_at%';
  execute pg_catalog.format('alter table public.sofia_inbound_batches drop constraint %I', v_constraint);
  execute pg_catalog.format(
    'alter table public.sofia_inbound_batches add constraint %I check (scheduled_process_at <= first_message_at + interval ''20 seconds'')',
    v_constraint
  );
end
$$;

-- 2. Update enqueue_sofia_inbound_message with 10s silence window and 20s starvation cap.
create or replace function public.enqueue_sofia_inbound_message(
  p_conversa_id uuid,
  p_cliente_id uuid,
  p_canal text,
  p_delivery_key text,
  p_conteudo text,
  p_url_anexo text,
  p_received_at timestamptz default now()
) returns table(message_id uuid, batch_id uuid, duplicate boolean, scheduled_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_external_id text;
  v_message_id uuid;
  v_batch public.sofia_inbound_batches%rowtype;
  v_admitted_at timestamptz;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' or auth.uid() is not null then
    raise exception using errcode = '42501', message = 'SOFIA_BATCH_SERVICE_ROLE_REQUIRED';
  end if;
  if p_conversa_id is null or p_cliente_id is null
     or p_canal not in ('telegram', 'whatsapp', 'web')
     or nullif(btrim(p_delivery_key), '') is null or length(p_delivery_key) > 500
     or (nullif(p_conteudo, '') is null and nullif(p_url_anexo, '') is null)
     or p_received_at is null or not pg_catalog.isfinite(p_received_at) then
    raise exception using errcode = '22023', message = 'SOFIA_BATCH_ADMISSION_INVALID';
  end if;

  v_external_id := case
    when p_canal = 'web' then 'sofia-web:' || btrim(p_delivery_key)
    else 'sofia-inbound:' || p_canal || ':' || btrim(p_delivery_key)
  end;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_external_id, 91021));
  perform 1 from public.conversas c
    where c.id = p_conversa_id and c.cliente_id = p_cliente_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'SOFIA_BATCH_BINDING_INVALID';
  end if;
  perform 1 from public.conversas c
    where c.id = p_conversa_id and c.cliente_id = p_cliente_id
      and c.status = 'fechada'::public.status_conversa for update;
  if found then
    raise exception using errcode = '22023', message = 'SOFIA_BATCH_CONVERSA_FECHADA';
  end if;
  v_admitted_at := pg_catalog.clock_timestamp();

  select m.id into v_message_id from public.mensagens m where m.external_id = v_external_id;
  if found then
    select b.* into v_batch
      from public.sofia_inbound_batch_messages bm
      join public.sofia_inbound_batches b on b.id = bm.batch_id
      where bm.message_id = v_message_id;
    if not found or v_batch.conversa_id <> p_conversa_id or v_batch.cliente_id <> p_cliente_id or v_batch.canal <> p_canal then
      raise exception using errcode = '23505', message = 'SOFIA_BATCH_DELIVERY_CONFLICT';
    end if;
    if p_canal = 'web' and exists (
      select 1 from public.mensagens m
        where m.id = v_message_id
          and (m.conteudo is distinct from nullif(p_conteudo, '')
               or m.url_anexo is distinct from nullif(p_url_anexo, ''))
    ) then
      raise exception using errcode = '23505', message = 'SOFIA_BATCH_DELIVERY_CONTENT_CONFLICT';
    end if;
    return query select v_message_id, v_batch.id, true, v_batch.scheduled_process_at;
    return;
  end if;

  insert into public.mensagens(conversa_id, remetente, conteudo, url_anexo, data_criacao, external_id)
  values (p_conversa_id, 'cliente'::public.tipo_remetente, nullif(p_conteudo, ''),
          nullif(p_url_anexo, ''), p_received_at, v_external_id)
  returning id into v_message_id;

  select b.* into v_batch from public.sofia_inbound_batches b
    where b.conversa_id = p_conversa_id and b.status = 'pending' for update;
  if not found then
    insert into public.sofia_inbound_batches(
      conversa_id, cliente_id, canal, first_message_at, latest_message_at, scheduled_process_at
    ) values (
      p_conversa_id, p_cliente_id, p_canal, v_admitted_at, v_admitted_at,
      v_admitted_at + interval '10 seconds'
    ) returning * into v_batch;
  elsif v_batch.cliente_id <> p_cliente_id or v_batch.canal <> p_canal then
    raise exception using errcode = '23505', message = 'SOFIA_BATCH_BINDING_CONFLICT';
  else
    update public.sofia_inbound_batches b set
      latest_message_at = v_admitted_at,
      scheduled_process_at = least(v_admitted_at + interval '10 seconds', b.first_message_at + interval '20 seconds'),
      updated_at = v_admitted_at
    where b.id = v_batch.id returning * into v_batch;
  end if;

  insert into public.sofia_inbound_batch_messages(batch_id, message_id, message_created_at)
    values (v_batch.id, v_message_id, p_received_at);
  return query select v_message_id, v_batch.id, false, v_batch.scheduled_process_at;
end;
$$;

revoke all on function public.enqueue_sofia_inbound_message(uuid,uuid,text,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.enqueue_sofia_inbound_message(uuid,uuid,text,text,text,text,timestamptz) to service_role;

-- 3. Update attach_sofia_inbound_message with 10s silence window and 20s starvation cap.
create or replace function public.attach_sofia_inbound_message(
  p_message_id uuid,
  p_conversa_id uuid,
  p_cliente_id uuid,
  p_canal text
) returns table(batch_id uuid, duplicate boolean, scheduled_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_message public.mensagens%rowtype;
  v_batch public.sofia_inbound_batches%rowtype;
  v_existing_batch_id uuid;
  v_admitted_at timestamptz;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' or auth.uid() is not null then
    raise exception using errcode='42501',message='SOFIA_BATCH_SERVICE_ROLE_REQUIRED';
  end if;
  if p_message_id is null or p_conversa_id is null or p_cliente_id is null
     or p_canal not in ('telegram','whatsapp','web') then
    raise exception using errcode='22023',message='SOFIA_BATCH_ATTACH_INVALID';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_message_id::text,91022));
  select m.* into v_message from public.mensagens m where m.id=p_message_id for share;
  if not found or v_message.conversa_id<>p_conversa_id or v_message.remetente<>'cliente'::public.tipo_remetente
     or not exists(select 1 from public.conversas c where c.id=p_conversa_id and c.cliente_id=p_cliente_id) then
    raise exception using errcode='22023',message='SOFIA_BATCH_ATTACH_BINDING_INVALID';
  end if;
  if (p_canal='telegram' and v_message.telegram_mensagem_id is null)
     or (p_canal='whatsapp' and v_message.whatsapp_mensagem_id is null)
     or (p_canal='web' and (v_message.telegram_mensagem_id is not null or v_message.whatsapp_mensagem_id is not null)) then
    raise exception using errcode='22023',message='SOFIA_BATCH_ATTACH_CHANNEL_INVALID';
  end if;

  select bm.batch_id into v_existing_batch_id from public.sofia_inbound_batch_messages bm where bm.message_id=p_message_id;
  if found then
    select b.* into v_batch from public.sofia_inbound_batches b where b.id=v_existing_batch_id;
    if v_batch.conversa_id<>p_conversa_id or v_batch.cliente_id<>p_cliente_id or v_batch.canal<>p_canal then
      raise exception using errcode='23505',message='SOFIA_BATCH_ATTACH_CONFLICT';
    end if;
    return query select v_batch.id,true,v_batch.scheduled_process_at;
    return;
  end if;

  perform 1 from public.conversas c where c.id=p_conversa_id and c.cliente_id=p_cliente_id for update;
  v_admitted_at:=pg_catalog.clock_timestamp();
  select b.* into v_batch from public.sofia_inbound_batches b where b.conversa_id=p_conversa_id and b.status='pending' for update;
  if not found then
    insert into public.sofia_inbound_batches(conversa_id,cliente_id,canal,first_message_at,latest_message_at,scheduled_process_at)
    values(p_conversa_id,p_cliente_id,p_canal,v_admitted_at,v_admitted_at,v_admitted_at+interval '10 seconds') returning * into v_batch;
  elsif v_batch.cliente_id<>p_cliente_id or v_batch.canal<>p_canal then
    raise exception using errcode='23505',message='SOFIA_BATCH_ATTACH_CONFLICT';
  else
    update public.sofia_inbound_batches b set latest_message_at=v_admitted_at,
      scheduled_process_at=least(v_admitted_at+interval '10 seconds',b.first_message_at+interval '20 seconds'),updated_at=v_admitted_at
    where b.id=v_batch.id returning * into v_batch;
  end if;
  insert into public.sofia_inbound_batch_messages(batch_id,message_id,message_created_at)
  values(v_batch.id,p_message_id,v_message.data_criacao);
  return query select v_batch.id,false,v_batch.scheduled_process_at;
end
$$;

revoke all on function public.attach_sofia_inbound_message(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.attach_sofia_inbound_message(uuid,uuid,uuid,text) to service_role;
