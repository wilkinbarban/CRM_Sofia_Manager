-- The Google Calendar integration no longer exists in the application, so nothing
-- reads or writes pedidos.google_event_id any more. Dropping the column is delicate
-- for one reason: the payment authority returns the field as part of its returns
-- table shape, and PostgreSQL cannot change a function return type through
-- create or replace. The authority is therefore dropped and recreated without the
-- field, with both grants restored, and only then is the column dropped. The body is
-- copied verbatim from 20260824163000_mercado_pago_refund_first_terminality.sql
-- except that the retired field disappears from the return shape and from every
-- return query select, so the refund-first terminality and idempotency contract of
-- the payment authority is unchanged.

drop function if exists public.registrar_status_pagamento(
  uuid, public.status_pagamento, text, text, text, uuid
);

drop function if exists public.registrar_status_pagamento(
  uuid, public.status_pagamento, text, text, text, uuid, text
);

create or replace function public.registrar_status_pagamento(
  p_pedido_id uuid, p_novo_status public.status_pagamento, p_source text,
  p_external_reference text default null, p_reason text default null,
  p_idempotency_key uuid default null, p_provider_delivery_id text default null
) returns table(pedido_id uuid,status_pagamento public.status_pagamento,idempotent boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_order public.pedidos%rowtype;
  v_delivery public.pedido_payment_events%rowtype;
  v_approval public.pedido_payment_events%rowtype;
  v_reversal public.pedido_payment_events%rowtype;
  v_reason text := nullif(btrim(p_reason), '');
  v_external_reference text := nullif(btrim(p_external_reference), '');
  v_provider_delivery_id text := nullif(btrim(p_provider_delivery_id), '');
begin
  if p_pedido_id is null or p_novo_status is null or p_source not in ('manual', 'mercado_pago') then
    raise exception using errcode='22023', message='DADOS_PAGAMENTO_INVALIDOS';
  end if;
  if p_source = 'mercado_pago' then
    if coalesce(auth.jwt()->>'role', '') <> 'service_role' or v_actor is not null then
      raise exception using errcode='42501', message='MERCADO_PAGO_SERVICE_ROLE_REQUIRED';
    end if;
    if v_external_reference is null then
      raise exception using errcode='22023', message='MERCADO_PAGO_DELIVERY_ID_REQUIRED';
    end if;
    if v_provider_delivery_id is null then
      v_provider_delivery_id := v_external_reference;
    end if;
    if v_reason is not null then
      raise exception using errcode='22023', message='MERCADO_PAGO_REASON_FORBIDDEN';
    end if;
  else
    if v_actor is null or not public.tem_funcoes(array['admin'::public.tipo_funcao,'supervisor'::public.tipo_funcao,'vendedor'::public.tipo_funcao]) then
      raise exception using errcode='42501', message='USUARIO_NAO_AUTORIZADO';
    end if;
    if v_reason is null then
      raise exception using errcode='22023', message='MANUAL_PAYMENT_REASON_REQUIRED';
    end if;
    if p_idempotency_key is null then
      raise exception using errcode='22023', message='MANUAL_PAYMENT_IDEMPOTENCY_KEY_REQUIRED';
    end if;
    if v_external_reference is not null or v_provider_delivery_id is not null then
      raise exception using errcode='22023', message='MANUAL_PAYMENT_EXTERNAL_REFERENCE_FORBIDDEN';
    end if;
  end if;

  select * into v_order from public.pedidos where id=p_pedido_id for update;
  if not found then raise exception using errcode='P0002', message='PEDIDO_NAO_ENCONTRADO'; end if;

  if p_source = 'manual' then
    select e.* into v_delivery from public.pedido_payment_events e
      where e.source='manual' and e.pedido_id=p_pedido_id and e.idempotency_key=p_idempotency_key;
    if found then
      if v_delivery.target_status <> p_novo_status or v_delivery.reason is distinct from v_reason or v_delivery.actor_id is distinct from v_actor then
        raise exception using errcode='23505', message='MANUAL_PAYMENT_IDEMPOTENCY_CONFLICT';
      end if;
      return query select v_order.id, v_delivery.result_status, true;
      return;
    end if;
  else
    select e.* into v_delivery from public.pedido_payment_events e
      where e.source='mercado_pago' and e.provider_delivery_id=v_provider_delivery_id;
    if found then
      if v_delivery.pedido_id <> p_pedido_id
        or v_delivery.external_reference <> v_external_reference
        or v_delivery.target_status <> p_novo_status then
        raise exception using errcode='23505', message='MERCADO_PAGO_DELIVERY_CONFLICT';
      end if;
      return query select v_order.id, v_delivery.result_status, true;
      return;
    end if;

    if exists (
      select 1 from public.pedido_payment_events e
      where e.source = 'mercado_pago'
        and e.external_reference = v_external_reference
        and e.pedido_id <> p_pedido_id
    ) or exists (
      select 1 from public.pedidos p
      where p.mercado_pago_pagamento_id = v_external_reference
        and p.id <> p_pedido_id
    ) then
      raise exception using errcode = '23505', message = 'MERCADO_PAGO_EXTERNAL_REFERENCE_CONFLICT';
    end if;

    select e.* into v_approval from public.pedido_payment_events e
      where e.source='mercado_pago' and e.pedido_id=p_pedido_id
        and e.external_reference=v_external_reference
        and e.target_status='aprovado'::public.status_pagamento
      order by e.created_at, e.id limit 1;
    select e.* into v_reversal from public.pedido_payment_events e
      where e.source='mercado_pago' and e.pedido_id=p_pedido_id
        and e.external_reference=v_external_reference
        and e.target_status='reembolsado'::public.status_pagamento
      order by e.created_at, e.id limit 1;

    if p_novo_status='reembolsado'::public.status_pagamento then
      if v_reversal.id is null then
        update public.pedidos
          set status_pagamento='reembolsado', data_atualizacao=now()
          where id=p_pedido_id;
        insert into public.pedido_payment_events(
          pedido_id,source,actor_id,external_reference,provider_delivery_id,
          idempotency_key,reason,previous_status,target_status,result_status,observation_provenance
        ) values (
          p_pedido_id,'mercado_pago',null,v_external_reference,v_provider_delivery_id,
          null,null,v_order.status_pagamento,'reembolsado'::public.status_pagamento,
          'reembolsado'::public.status_pagamento,
          case when v_approval.id is null
            then 'provider_terminal_without_local_approval'
            else 'provider_reversal_after_local_approval'
          end
        );
        return query select v_order.id, 'reembolsado'::public.status_pagamento, false;
        return;
      end if;

      insert into public.pedido_payment_events(
        pedido_id,source,actor_id,external_reference,provider_delivery_id,
        idempotency_key,reason,previous_status,target_status,result_status,observation_provenance
      ) values (
        p_pedido_id,'mercado_pago',null,v_external_reference,v_provider_delivery_id,
        null,null,v_order.status_pagamento,'reembolsado'::public.status_pagamento,
        'reembolsado'::public.status_pagamento,'provider_reversal_duplicate_observation'
      );
      return query select v_order.id, 'reembolsado'::public.status_pagamento, false;
      return;
    end if;

    if p_novo_status='aprovado'::public.status_pagamento and v_reversal.id is not null then
      insert into public.pedido_payment_events(
        pedido_id,source,actor_id,external_reference,provider_delivery_id,
        idempotency_key,reason,previous_status,target_status,result_status,observation_provenance
      ) values (
        p_pedido_id,'mercado_pago',null,v_external_reference,v_provider_delivery_id,
        null,null,v_order.status_pagamento,'aprovado'::public.status_pagamento,
        'reembolsado'::public.status_pagamento,'provider_approval_observed_after_reversal'
      );
      return query select v_order.id, 'reembolsado'::public.status_pagamento, false;
      return;
    end if;

    if v_approval.id is not null then
      insert into public.pedido_payment_events(
        pedido_id,source,actor_id,external_reference,provider_delivery_id,
        idempotency_key,reason,previous_status,target_status,result_status
      ) values (
        p_pedido_id,'mercado_pago',null,v_external_reference,v_provider_delivery_id,
        null,null,v_order.status_pagamento,p_novo_status,v_order.status_pagamento
      );
      return query select v_order.id, v_order.status_pagamento, false;
      return;
    end if;
  end if;

  update public.pedidos set
    status_pagamento=p_novo_status,
    mercado_pago_pagamento_id=case when p_source='mercado_pago' then v_external_reference else mercado_pago_pagamento_id end,
    data_atualizacao=now()
    where id=p_pedido_id;
  insert into public.pedido_payment_events(
    pedido_id,source,actor_id,external_reference,provider_delivery_id,
    idempotency_key,reason,previous_status,target_status,result_status
  ) values (
    p_pedido_id,p_source,v_actor,v_external_reference,v_provider_delivery_id,
    p_idempotency_key,v_reason,v_order.status_pagamento,p_novo_status,p_novo_status
  );
  return query select v_order.id,p_novo_status,false;
end $$;

revoke all on function public.registrar_status_pagamento(
  uuid,public.status_pagamento,text,text,text,uuid,text
) from public, anon;
grant execute on function public.registrar_status_pagamento(
  uuid,public.status_pagamento,text,text,text,uuid,text
) to authenticated, service_role;

alter table public.pedidos drop column if exists google_event_id;
