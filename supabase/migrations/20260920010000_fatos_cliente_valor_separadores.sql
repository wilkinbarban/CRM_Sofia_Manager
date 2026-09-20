-- Fechamento do buraco dos separadores de linha Unicode (U+2028 LINE SEPARATOR e U+2029
-- PARAGRAPH SEPARATOR) no contrato de `valor` dos fatos do cliente (design 6.1).
--
-- O bloco do prompt e orientado a linhas: um separador dentro de `valor` abre uma linha
-- nova no prompt de sistema, o primitivo exato que a defesa de `[[:cntrl:]]` tenta barrar.
-- A classe POSIX nao alcanca U+2028/U+2029 porque os dois sao da categoria Unicode
-- `separator` (Zl e Zp), nao de `control` (Cc). Por isso a classe e explicita no texto da
-- constraint: `\u2028`/`\u2029` sao escapes ARE resolvidos pelo motor de regex do Postgres,
-- nao pelo literal de string, entao a constraint declara literalmente os code points que
-- recusa, sem depender de uma classe "equivalente" que nao cobre separadores.
--
-- Migracao apenas para frente: 20260918010000 (tabela) e 20260918020000 (funcoes) ja estao
-- aplicadas, entao a alteracao das constraints e das duas funcoes de escrita de valor entra
-- aqui. Sem `alter function ... owner to supabase_admin`: o harness local afirma exatamente
-- oito transferencias de posse e esta migracao nao muda essa constante.

alter table public.fatos_cliente
  drop constraint ck_fatos_cliente_valor_controle,
  add constraint ck_fatos_cliente_valor_controle check (valor !~ '[[:cntrl:]\u2028\u2029]');

alter table public.fatos_cliente
  drop constraint ck_fatos_cliente_valor_invisivel,
  add constraint ck_fatos_cliente_valor_invisivel
    check (valor !~ '[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]');

-- `revisar_fato_cliente` e `corrigir_meu_fato_cliente` repetem a validacao do `valor`: sem
-- esta recriacao o mesmo texto sairia como 23514 da constraint em vez do 22023 tipado que a
-- superficie promete. As funcoes vao inteiras porque `create or replace function` exige o
-- corpo completo; fora da validacao do valor, a unica diferenca para 20260918020000 e a
-- propria palavra-chave `or replace`.

create or replace function public.revisar_fato_cliente(
  p_fato_id uuid,
  p_decisao text,
  p_valor text default null
) returns table(fato_id uuid, estado text, valor text, origem text)
language plpgsql security definer set search_path = '' as $$
declare
  v_cliente_id uuid;
  v_tipo text;
  v_chave text;
  v_fato public.fatos_cliente%rowtype;
begin
  if not public.tem_funcoes(array[
    'admin'::public.tipo_funcao,
    'supervisor'::public.tipo_funcao,
    'vendedor'::public.tipo_funcao
  ]) then
    raise exception using errcode = '42501', message = 'SOFIA_FATO_OPERADOR_REQUERIDO';
  end if;
  if p_fato_id is null
     or p_decisao is null or p_decisao not in ('aprovar','rejeitar','corrigir')
     or (p_decisao = 'corrigir' and (p_valor is null or p_valor = ''
         or p_valor <> pg_catalog.btrim(p_valor) or char_length(p_valor) > 500
         or p_valor ~ '[[:cntrl:]\u2028\u2029]'
         or p_valor ~ '[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]'))
     or (p_decisao <> 'corrigir' and p_valor is not null) then
    raise exception using errcode = '22023', message = 'SOFIA_FATO_ENTRADA_INVALIDA';
  end if;
  select f.cliente_id, f.tipo, f.chave into v_cliente_id, v_tipo, v_chave
    from public.fatos_cliente f where f.id = p_fato_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'SOFIA_FATO_NAO_ENCONTRADO';
  end if;
  -- Mesma trava por chave do escritor: a revisao nunca corre solta contra uma inferencia.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_cliente_id::text || '|' || v_tipo || '|' || v_chave, 91423));
  select f.* into v_fato from public.fatos_cliente f where f.id = p_fato_id for update;
  -- Rejeitado e substituido sao historico terminal: reaprovar exigiria colidir com a chave.
  if v_fato.estado in ('rejeitado','substituido') then
    raise exception using errcode = '22023', message = 'SOFIA_FATO_NAO_REVISAVEL';
  end if;
  -- `corrigir` limpa a confianca porque o valor armazenado deixou de ser a inferencia do modelo;
  -- aprovar e rejeitar a preservam. A origem nunca muda, e o revisor e sempre registrado.
  update public.fatos_cliente f
     set estado = case p_decisao when 'rejeitar' then 'rejeitado' else 'aprovado' end,
         valor = case when p_decisao = 'corrigir' then p_valor else f.valor end,
         confianca = case when p_decisao = 'corrigir' then null else f.confianca end,
         revisado_por = auth.uid(),
         revisado_em = pg_catalog.now(),
         atualizado_em = pg_catalog.now()
   where f.id = p_fato_id;
  return query select f.id, f.estado, f.valor, f.origem
    from public.fatos_cliente f where f.id = p_fato_id;
end
$$;

create or replace function public.corrigir_meu_fato_cliente(p_fato_id uuid, p_valor text)
returns table(fato_id uuid, valor text, estado text, origem text)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_cliente_id uuid;
  v_fato public.fatos_cliente%rowtype;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception using errcode = '42501', message = 'SOFIA_FATO_NAO_AUTENTICADO';
  end if;
  if p_fato_id is null or p_valor is null or p_valor = ''
     or p_valor <> pg_catalog.btrim(p_valor) or char_length(p_valor) > 500
     or p_valor ~ '[[:cntrl:]\u2028\u2029]'
     or p_valor ~ '[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]' then
    raise exception using errcode = '22023', message = 'SOFIA_FATO_ENTRADA_INVALIDA';
  end if;
  select c.id into v_cliente_id from public.clientes c where c.usuario_id = v_uid;
  if not found then
    raise exception using errcode = 'P0002', message = 'SOFIA_FATO_NAO_ENCONTRADO';
  end if;
  select f.* into v_fato from public.fatos_cliente f where f.id = p_fato_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'SOFIA_FATO_NAO_ENCONTRADO';
  end if;
  if v_fato.cliente_id <> v_cliente_id then
    raise exception using errcode = '42501', message = 'SOFIA_FATO_NAO_AUTORIZADO';
  end if;
  if v_fato.tipo = 'observacao' then
    raise exception using errcode = '42501', message = 'SOFIA_FATO_NAO_EXPOSTO';
  end if;
  -- A superficie do cliente so mostra fatos aprovados; um pendente e `nao encontrado` para ele.
  if v_fato.estado <> 'aprovado' then
    raise exception using errcode = 'P0002', message = 'SOFIA_FATO_NAO_ENCONTRADO';
  end if;
  -- Retificacao LGPD no lugar, nunca substituicao: preserva a identidade do fato e deixa um unico
  -- fato vigente para a chave. `revisado_por`/`revisado_em` permanecem como historico da revisao.
  update public.fatos_cliente f
     set valor = p_valor, origem = 'cliente', estado = 'aprovado', confianca = null,
         origem_conversa_id = null, atualizado_em = pg_catalog.now()
   where f.id = p_fato_id;
  return query select f.id, f.valor, f.estado, f.origem
    from public.fatos_cliente f where f.id = p_fato_id;
end
$$;
