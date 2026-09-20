-- Forward-only correction to the Web atomic admission, still inert behind the explicit Web
-- producer gate (`SOFIA_INBOUND_BATCH_WEB_ENQUEUE_ENABLED`).
--
-- The client-generated Web idempotency key is now bound to the content it admitted. A replay
-- with the same key and the same text/attachment keeps returning the original message, batch
-- and deadline, but a key reused with edited content fails closed with a typed error instead
-- of silently returning the stale row, which discarded the customer's edited text.
--
-- The comparison is scoped to the Web channel. Telegram and WhatsApp/Evolution keep their
-- existing replay contract, where a repeated delivery key with different content is still an
-- idempotent replay. Only the function body changes; signature, ownership and ACLs stay.

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
  -- O caminho de navegador que este RPC substitui era filtrado por RLS, que proibia inserir
  -- em conversa fechada (`conversas.status <> 'fechada'`); o service_role nao passa por RLS,
  -- entao a recusa precisa ser explicita aqui. `fechada` e o unico estado terminal do enum
  -- `public.status_conversa`, e a checagem corre sob a mesma trava `for update` que fixa a
  -- conversa, de modo que o encerramento concorrente nao pode escapar entre a recusa e o
  -- insert. A recusa vem antes da repeticao de chave: uma conversa encerrada nao admite.
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
    -- A chave Web é gerada pelo cliente e pertence a um conteúdo específico. Reutilizá-la com
    -- outro texto ou anexo não pode devolver a mensagem antiga em silêncio: seria descartar a
    -- edição do cliente. O conflito é o mesmo da chave já vinculada a outro lote (23505),
    -- porque a violação é da identidade de entrega, não do formato do argumento.
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
      v_admitted_at + interval '25 seconds'
    ) returning * into v_batch;
  elsif v_batch.cliente_id <> p_cliente_id or v_batch.canal <> p_canal then
    raise exception using errcode = '23505', message = 'SOFIA_BATCH_BINDING_CONFLICT';
  else
    update public.sofia_inbound_batches b set
      latest_message_at = v_admitted_at,
      scheduled_process_at = least(v_admitted_at + interval '25 seconds', b.first_message_at + interval '60 seconds'),
      updated_at = v_admitted_at
    where b.id = v_batch.id returning * into v_batch;
  end if;

  insert into public.sofia_inbound_batch_messages(batch_id, message_id, message_created_at)
    values (v_batch.id, v_message_id, p_received_at);
  return query select v_message_id, v_batch.id, false, v_batch.scheduled_process_at;
end;
$$;
