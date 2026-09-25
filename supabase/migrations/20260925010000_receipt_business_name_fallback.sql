-- Resolve the establishment name from persisted configuration only for new receipts.
create or replace function public.emitir_comprovante_venda(p_pedido_id uuid, p_idempotency_key uuid)
returns table(receipt_id uuid, snapshot jsonb, snapshot_hash text, idempotent boolean)
language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_order public.pedidos%rowtype; v_existing public.comprovantes_venda%rowtype; v_snapshot jsonb; v_hash text;
begin
 if p_pedido_id is null or p_idempotency_key is null then raise exception using errcode='22023',message='SALES_RECEIPT_INPUT_INVALID'; end if;
 if v_actor is null or not public.tem_funcoes(array['admin'::public.tipo_funcao,'supervisor'::public.tipo_funcao,'vendedor'::public.tipo_funcao]) then raise exception using errcode='42501',message='SALES_RECEIPT_OPERATOR_REQUIRED'; end if;
 select * into v_order from public.pedidos where id=p_pedido_id for update; if not found then raise exception using errcode='P0002',message='PEDIDO_NAO_ENCONTRADO'; end if;
 select * into v_existing from public.comprovantes_venda where pedido_id=p_pedido_id; if found then return query select v_existing.id,v_existing.snapshot,v_existing.snapshot_hash,true; return; end if;
 if v_order.status <> 'entregue' or v_order.status_pagamento <> 'aprovado' then raise exception using errcode='22023',message='RECEIPT_ISSUANCE_INELIGIVEL'; end if;
 v_snapshot:=jsonb_build_object('order',jsonb_build_object('id',v_order.id,'status',v_order.status,'delivery_type',v_order.tipo_entrega,'delivery_address',v_order.endereco_entrega,'total_products_centavos',v_order.total_produtos_centavos,'delivery_fee_centavos',v_order.taxa_entrega_centavos,'total_order_centavos',v_order.total_pedido_centavos),'customer',(select jsonb_build_object('id',c.id,'name',c.nome,'phone',c.telefone) from public.clientes c where c.id=v_order.cliente_id),'line_items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'product_id',i.produto_id,'name',p.nome,'quantity',i.quantidade,'unit_price_centavos',i.preco_unitario_centavos,'line_total_centavos',i.quantidade*i.preco_unitario_centavos) order by i.id) from public.itens_pedido i join public.produtos p on p.id=i.produto_id where i.pedido_id=v_order.id),'[]'::jsonb),'charged_amount_centavos',v_order.total_pedido_centavos,'payment',jsonb_build_object('status',v_order.status_pagamento,'method',v_order.meio_pagamento),'establishment',jsonb_build_object('name',coalesce((select nullif(btrim(valor),'') from public.configuracoes_sistema where chave='BUSINESS_NAME'),'CRM Sofia Manager')),'payment_provenance',coalesce((select jsonb_agg(jsonb_build_object('source',e.source,'external_reference',e.external_reference,'reason',e.reason,'previous_status',e.previous_status,'target_status',e.target_status,'recorded_at',e.created_at) order by e.created_at,e.id) from public.pedido_payment_events e where e.pedido_id=v_order.id),'[]'::jsonb),'issuance',jsonb_build_object('issued_by',v_actor,'issued_at',now(),'snapshot_version',1));
 v_hash:=encode(extensions.digest(v_snapshot::text,'sha256'),'hex');
 insert into public.comprovantes_venda(pedido_id,cliente_id,idempotency_key,snapshot,snapshot_hash,issued_by) values(v_order.id,v_order.cliente_id,p_idempotency_key,v_snapshot,v_hash,v_actor) returning * into v_existing;
 return query select v_existing.id,v_existing.snapshot,v_existing.snapshot_hash,false;
end $$;
revoke all on function public.emitir_comprovante_venda(uuid,uuid) from public,anon;
grant execute on function public.emitir_comprovante_venda(uuid,uuid) to authenticated;
