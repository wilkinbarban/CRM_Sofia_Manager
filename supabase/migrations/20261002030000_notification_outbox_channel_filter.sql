create function public.claim_notification_outbox_for_channels(
  p_channels text[],
  p_lease_seconds integer default 60
)
returns table(
  id bigint,
  aggregate_type text,
  aggregate_id uuid,
  event_type text,
  event_id uuid,
  customer_id uuid,
  conversation_id uuid,
  channel text,
  payload jsonb,
  delivery_key text,
  attempt integer,
  lease_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.notification_outbox%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' or auth.uid() is not null then
    raise exception using
      errcode = '42501',
      message = 'NOTIFICATION_OUTBOX_SERVICE_ROLE_REQUIRED';
  end if;

  if p_lease_seconds is null or p_lease_seconds not between 10 and 300 then
    raise exception using
      errcode = '22023',
      message = 'NOTIFICATION_OUTBOX_LEASE_INVALID';
  end if;

  if p_channels is null or coalesce(cardinality(p_channels), 0) = 0 then
    return;
  end if;

  if exists (
    select 1
    from unnest(p_channels) as ch(channel_name)
    where ch.channel_name is null
       or ch.channel_name not in ('web', 'whatsapp', 'telegram')
  ) then
    raise exception using
      errcode = '22023',
      message = 'NOTIFICATION_OUTBOX_CHANNELS_INVALID';
  end if;

  select *
  into v
  from public.notification_outbox
  where notification_outbox.status in ('pending', 'claimed')
    and notification_outbox.channel = any(p_channels)
    and notification_outbox.next_attempt_at <= now()
    and (
      notification_outbox.status = 'pending'
      or notification_outbox.claimed_until <= now()
    )
  order by
    notification_outbox.next_attempt_at,
    notification_outbox.id
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  if v.status = 'claimed' and v.attempts >= v.max_attempts then
    update public.notification_outbox
    set status = 'dead_letter',
        lease_token = null,
        claimed_until = null,
        dead_lettered_at = now(),
        updated_at = now()
    where notification_outbox.id = v.id;
    return;
  end if;

  update public.notification_outbox
  set status = 'claimed',
      attempts = notification_outbox.attempts + 1,
      lease_token = gen_random_uuid(),
      claimed_until = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where notification_outbox.id = v.id
  returning notification_outbox.* into v;

  return query
  select
    v.id,
    v.aggregate_type,
    v.aggregate_id,
    v.event_type,
    v.event_id,
    v.customer_id,
    v.conversation_id,
    v.channel,
    v.payload,
    v.delivery_key,
    v.attempts,
    v.lease_token;
end;
$$;

revoke all on function public.claim_notification_outbox_for_channels(text[], integer) from public, anon, authenticated;
grant execute on function public.claim_notification_outbox_for_channels(text[], integer) to service_role;
