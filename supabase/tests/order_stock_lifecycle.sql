begin;
set local search_path=public,auth,extensions;
select plan(1);

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
 ('55555555-5555-4555-8555-555555555501','00000000-0000-0000-0000-000000000000','authenticated','authenticated','order-admin@example.test','',now(),'{}','{}',now(),now()),
 ('55555555-5555-4555-8555-555555555502','00000000-0000-0000-0000-000000000000','authenticated','authenticated','order-client@example.test','',now(),'{}','{}',now(),now()) on conflict(id) do nothing;
update public.perfis set ativo=true,funcao='admin' where id='55555555-5555-4555-8555-555555555501';
update public.perfis set ativo=true,funcao='cliente' where id='55555555-5555-4555-8555-555555555502';
insert into public.clientes(id,usuario_id,nome,telefone) values('55555555-5555-4555-8555-555555555510','55555555-5555-4555-8555-555555555502','Order client','5541999999901');
insert into public.produtos(id,nome,preco_centavos,quantidade_estoque,controlar_estoque,ativo) values
 ('55555555-5555-4555-8555-555555555521','Controlled A',1000,8,true,false),
 ('55555555-5555-4555-8555-555555555522','Controlled B',1000,2,true,true),
 ('55555555-5555-4555-8555-555555555523','Uncontrolled',1000,0,false,true),
 ('55555555-5555-4555-8555-555555555524','Legacy controlled',1000,4,true,false);
insert into public.pedidos(id,cliente_id,status,tipo_entrega,total_produtos_centavos,total_pedido_centavos,meio_pagamento) values
 ('55555555-5555-4555-8555-555555555531','55555555-5555-4555-8555-555555555510','novo','retirada',5000,5000,'dinheiro'),
 ('55555555-5555-4555-8555-555555555532','55555555-5555-4555-8555-555555555510','novo','retirada',9000,9000,'dinheiro'),
 ('55555555-5555-4555-8555-555555555533','55555555-5555-4555-8555-555555555510','novo','retirada',1000,1000,'dinheiro'),
 ('55555555-5555-4555-8555-555555555534','55555555-5555-4555-8555-555555555510','confirmado','retirada',2000,2000,'dinheiro'),
 ('55555555-5555-4555-8555-555555555535','55555555-5555-4555-8555-555555555510','confirmado','retirada',0,0,'dinheiro');

-- Legacy stock states are historical data. Only the canonical lifecycle
-- function owner may manufacture them; application roles must use the RPC.
set local role postgres;
update public.pedidos set estoque_estado='aplicado' where id in('55555555-5555-4555-8555-555555555534','55555555-5555-4555-8555-555555555535');
insert into public.itens_pedido(pedido_id,produto_id,preco_unitario_centavos,quantidade) values
 ('55555555-5555-4555-8555-555555555531','55555555-5555-4555-8555-555555555521',1000,2),
 ('55555555-5555-4555-8555-555555555531','55555555-5555-4555-8555-555555555521',1000,1),
 ('55555555-5555-4555-8555-555555555531','55555555-5555-4555-8555-555555555523',1000,2),
 ('55555555-5555-4555-8555-555555555532','55555555-5555-4555-8555-555555555522',1000,9),
 ('55555555-5555-4555-8555-555555555533','55555555-5555-4555-8555-555555555521',1000,1),
 ('55555555-5555-4555-8555-555555555534','55555555-5555-4555-8555-555555555524',1000,2);
insert into public.pedido_estoque_efeitos values('55555555-5555-4555-8555-555555555534','55555555-5555-4555-8555-555555555524',2,true);
insert into public.pedido_estoque_snapshots(pedido_id,efeitos) values
 ('55555555-5555-4555-8555-555555555534','[{"produto_id":"55555555-5555-4555-8555-555555555524","quantidade":2,"controlar_estoque":true}]'),
 ('55555555-5555-4555-8555-555555555535','[]');
insert into public.pedidos(id,cliente_id,status,tipo_entrega,total_produtos_centavos,total_pedido_centavos,meio_pagamento,estoque_estado) values('55555555-5555-4555-8555-555555555560','55555555-5555-4555-8555-555555555510','confirmado','retirada',1000,1000,'dinheiro','aplicado');
insert into public.pedido_estoque_efeitos values('55555555-5555-4555-8555-555555555560','55555555-5555-4555-8555-555555555524',1,true);
insert into public.pedido_estoque_snapshots values('55555555-5555-4555-8555-555555555560','[]');
reset role;

-- The ledger is intentionally private in production. This transaction-only
-- read policy lets the authenticated test actor verify function side effects
-- without weakening the deployed grants or write boundary.
grant select on public.pedido_estoque_efeitos to authenticated;
grant execute on function public.confirmar_pedido_estoque(uuid, uuid) to authenticated;
grant execute on function public.cancelar_pedido_estoque(uuid, uuid) to authenticated;
create policy test_authenticated_order_effect_reads
on public.pedido_estoque_efeitos for select to authenticated
using (true);

set local role authenticated;
select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555502',true);
do $$ begin begin perform * from public.confirmar_pedido_estoque('55555555-5555-4555-8555-555555555531','55555555-5555-4555-8555-555555555541'); raise exception 'client accepted'; exception when insufficient_privilege then null; end; end $$;
select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555501',true);
do $$ declare r record; begin
 begin insert into public.pedidos(id,cliente_id,status,tipo_entrega,total_produtos_centavos,total_pedido_centavos,meio_pagamento,estoque_confirmacao_correlation) values('55555555-5555-4555-8555-555555555538','55555555-5555-4555-8555-555555555510','novo','retirada',0,0,'dinheiro','55555555-5555-4555-8555-555555555559'); raise exception 'authenticated forged insert accepted'; exception when insufficient_privilege then null; end;
 insert into public.pedidos(id,cliente_id,status,tipo_entrega,total_produtos_centavos,total_pedido_centavos,meio_pagamento) values('55555555-5555-4555-8555-555555555539','55555555-5555-4555-8555-555555555510','novo','retirada',0,0,'dinheiro');
 begin perform * from public.cancelar_pedido_estoque('55555555-5555-4555-8555-555555555531','55555555-5555-4555-8555-555555555542'); raise exception 'early cancel accepted'; exception when check_violation then null; end;
 perform * from public.confirmar_pedido_estoque('55555555-5555-4555-8555-555555555534','55555555-5555-4555-8555-555555555547');
 if (select quantidade_estoque from public.produtos where id='55555555-5555-4555-8555-555555555524')<>4 then raise exception 'legacy replay deducted stock'; end if;
 perform * from public.cancelar_pedido_estoque('55555555-5555-4555-8555-555555555534','55555555-5555-4555-8555-555555555548');
 if (select quantidade_estoque<>6 or ativo from public.produtos where id='55555555-5555-4555-8555-555555555524') then raise exception 'legacy snapshot reversal changed wrong state'; end if;
 perform * from public.confirmar_pedido_estoque('55555555-5555-4555-8555-555555555535','55555555-5555-4555-8555-555555555557');
 perform * from public.cancelar_pedido_estoque('55555555-5555-4555-8555-555555555535','55555555-5555-4555-8555-555555555558');
 begin perform * from public.cancelar_pedido_estoque('55555555-5555-4555-8555-555555555560','55555555-5555-4555-8555-555555555561'); raise exception 'corrupt snapshot accepted'; exception when check_violation then if sqlerrm<>'EFEITOS_ESTOQUE_INDISPONIVEIS' then raise; end if; end;
 select * into r from public.confirmar_pedido_estoque('55555555-5555-4555-8555-555555555531','55555555-5555-4555-8555-555555555541');
 if r.estado<>'aplicado' or r.correlation_id<>'55555555-5555-4555-8555-555555555541' or r.actor_id<>auth.uid() then raise exception 'bad confirmation result'; end if;
 begin
  update public.pedidos set estoque_estado='pendente',estoque_confirmacao_correlation=null,estoque_cancelamento_correlation=null
  where id='55555555-5555-4555-8555-555555555531';
  raise exception 'direct lifecycle reset accepted';
 exception when insufficient_privilege then
  if sqlerrm<>'PEDIDO_ESTOQUE_LIFECYCLE_WRITE_FORBIDDEN' then raise; end if;
 end;
 update public.pedidos set mercado_pago_preferencia_id='order-stock-boundary-event' where id='55555555-5555-4555-8555-555555555531';
 if not found then raise exception 'unrelated order update denied'; end if;
 perform * from public.confirmar_pedido_estoque('55555555-5555-4555-8555-555555555531','55555555-5555-4555-8555-555555555541');
 begin perform * from public.confirmar_pedido_estoque('55555555-5555-4555-8555-555555555531','55555555-5555-4555-8555-555555555549'); raise exception 'confirmation correlation changed'; exception when unique_violation then null; end;
 if (select quantidade_estoque from public.produtos where id='55555555-5555-4555-8555-555555555521')<>5 then raise exception 'duplicate aggregation/retry failed'; end if;
 if (select count(*) from public.movimentacoes_estoque where pedido_id='55555555-5555-4555-8555-555555555531' and tipo='saida')<>1 then raise exception 'confirmation movement count'; end if;
 if (select quantidade_estoque from public.produtos where id='55555555-5555-4555-8555-555555555523')<>0 then raise exception 'uncontrolled stock changed'; end if;
 if (select ativo from public.produtos where id='55555555-5555-4555-8555-555555555521') then raise exception 'confirmation reactivated disabled product'; end if;
 if (select count(*) from public.pedido_estoque_efeitos where pedido_id='55555555-5555-4555-8555-555555555531')<>2 or not (select controlar_estoque from public.pedido_estoque_efeitos where produto_id='55555555-5555-4555-8555-555555555521') or (select controlar_estoque from public.pedido_estoque_efeitos where produto_id='55555555-5555-4555-8555-555555555523') then raise exception 'confirmation snapshot incomplete'; end if;
end $$;
reset role;
update public.itens_pedido set quantidade=7 where pedido_id='55555555-5555-4555-8555-555555555531';
update public.produtos set controlar_estoque=not controlar_estoque where id in('55555555-5555-4555-8555-555555555521','55555555-5555-4555-8555-555555555523');
set local role authenticated; select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555501',true);
do $$ declare r record; begin
 select * into r from public.cancelar_pedido_estoque('55555555-5555-4555-8555-555555555531','55555555-5555-4555-8555-555555555543');
 perform * from public.cancelar_pedido_estoque('55555555-5555-4555-8555-555555555531','55555555-5555-4555-8555-555555555543');
 begin perform * from public.cancelar_pedido_estoque('55555555-5555-4555-8555-555555555531','55555555-5555-4555-8555-555555555548'); raise exception 'cancellation correlation changed'; exception when unique_violation then null; end;
 if r.estado<>'restaurado' or (select quantidade_estoque from public.produtos where id='55555555-5555-4555-8555-555555555521')<>8 then raise exception 'cancel replay failed'; end if;
 if (select ativo from public.produtos where id='55555555-5555-4555-8555-555555555521') then raise exception 'cancellation reactivated disabled product'; end if;
 if (select quantidade_estoque from public.produtos where id='55555555-5555-4555-8555-555555555523')<>0 then raise exception 'uncontrolled snapshot restored'; end if;
 begin perform * from public.confirmar_pedido_estoque('55555555-5555-4555-8555-555555555532','55555555-5555-4555-8555-555555555544'); raise exception 'shortage accepted'; exception when check_violation then null; end;
 if (select quantidade_estoque from public.produtos where id='55555555-5555-4555-8555-555555555522')<>2 or exists(select 1 from public.movimentacoes_estoque where pedido_id='55555555-5555-4555-8555-555555555532') then raise exception 'shortage partial state'; end if;
end $$;
reset role;
update public.produtos set controlar_estoque=true where id='55555555-5555-4555-8555-555555555521';
create function pg_temp.reject_order_effect() returns trigger language plpgsql as $$ begin raise exception 'forced effect failure'; end $$;
create trigger reject_order_movement before insert on public.movimentacoes_estoque for each row execute function pg_temp.reject_order_effect();
set local role authenticated; select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555501',true);
do $$ begin begin perform * from public.confirmar_pedido_estoque('55555555-5555-4555-8555-555555555533','55555555-5555-4555-8555-555555555545'); exception when others then null; end; end $$;
reset role; drop trigger reject_order_movement on public.movimentacoes_estoque;
create trigger reject_order_audit before insert on public.logs_auditoria for each row execute function pg_temp.reject_order_effect();
set local role authenticated; select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555501',true);
do $$ begin begin perform * from public.confirmar_pedido_estoque('55555555-5555-4555-8555-555555555533','55555555-5555-4555-8555-555555555546'); exception when others then null; end;
 begin insert into public.movimentacoes_estoque(produto_id,tipo,quantidade,quantidade_anterior,quantidade_nova) values('55555555-5555-4555-8555-555555555521','saida',1,8,7); raise exception 'direct write accepted'; exception when insufficient_privilege then null; end; end $$;
do $$ begin begin insert into public.pedido_estoque_efeitos(pedido_id,produto_id,quantidade,controlar_estoque) values('55555555-5555-4555-8555-555555555531','55555555-5555-4555-8555-555555555521',99,true); raise exception 'direct ledger write accepted'; exception when insufficient_privilege then null; end; end $$;
reset role; drop trigger reject_order_audit on public.logs_auditoria;
set local role anon;
do $$ begin
 begin insert into public.pedidos(id,cliente_id,status,tipo_entrega,total_produtos_centavos,total_pedido_centavos,meio_pagamento,estoque_estado) values('55555555-5555-4555-8555-555555555540','55555555-5555-4555-8555-555555555510','novo','retirada',0,0,'dinheiro','aplicado'); raise exception 'anonymous forged insert accepted'; exception when insufficient_privilege then null; end;
 begin insert into public.pedidos(id,cliente_id,status,tipo_entrega,total_produtos_centavos,total_pedido_centavos,meio_pagamento) values('55555555-5555-4555-8555-555555555550','55555555-5555-4555-8555-555555555510','novo','retirada',0,0,'dinheiro'); raise exception 'anonymous default insert accepted'; exception when insufficient_privilege then null; end;
end $$;
do $$ begin begin insert into public.pedido_estoque_efeitos(pedido_id,produto_id,quantidade,controlar_estoque) values('55555555-5555-4555-8555-555555555531','55555555-5555-4555-8555-555555555521',99,true); raise exception 'anonymous ledger write accepted'; exception when insufficient_privilege then null; end; end $$;
do $$ declare n integer; begin
 update public.pedidos set estoque_estado='pendente' where id='55555555-5555-4555-8555-555555555531';
 get diagnostics n=row_count; if n<>0 then raise exception 'anonymous lifecycle reset accepted'; end if;
end $$;
reset role;
set local role service_role;
do $$ begin
 begin insert into public.pedidos(id,cliente_id,status,tipo_entrega,total_produtos_centavos,total_pedido_centavos,meio_pagamento,estoque_estado) values('55555555-5555-4555-8555-555555555536','55555555-5555-4555-8555-555555555510','novo','retirada',0,0,'dinheiro','aplicado'); raise exception 'service forged insert accepted'; exception when insufficient_privilege then null; end;
 insert into public.pedidos(id,cliente_id,status,tipo_entrega,total_produtos_centavos,total_pedido_centavos,meio_pagamento) values('55555555-5555-4555-8555-555555555537','55555555-5555-4555-8555-555555555510','novo','retirada',0,0,'dinheiro');
end $$;
reset role;
do $$ declare audit_count integer; begin
 if has_function_privilege('anon','public.confirmar_pedido_estoque(uuid,uuid)','execute') then raise exception 'anon execute granted'; end if;
 select count(*) into audit_count from public.logs_auditoria where acao in('confirmar_pedido_estoque','cancelar_pedido_estoque') and usuario_id='55555555-5555-4555-8555-555555555501';
 if audit_count<>4 then raise exception 'audit attribution missing: expected 4, got %', audit_count; end if;
 if (select mercado_pago_preferencia_id from public.pedidos where id='55555555-5555-4555-8555-555555555531')<>'order-stock-boundary-event' then raise exception 'unrelated order update missing'; end if;
 if (select estoque_estado from public.pedidos where id='55555555-5555-4555-8555-555555555533')<>'pendente' or (select quantidade_estoque from public.produtos where id='55555555-5555-4555-8555-555555555521')<>8 then raise exception 'effect failure did not roll back'; end if;
end $$;
select pass('order stock lifecycle is authorized, aggregated, atomic, idempotent, and auditable');
select * from finish();
rollback;
