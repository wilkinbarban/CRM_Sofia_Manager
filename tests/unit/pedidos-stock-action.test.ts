import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))

function client(error: unknown = null) {
  const rpc = vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: error ? null : { estado: 'aplicado' }, error }) })
  const profiles = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { funcao: 'admin', ativo: true }, error: null }) }
  return { value: { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'actor' } }, error: null }) }, from: vi.fn(() => profiles), rpc }, rpc }
}

describe('order stock actions', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('sends only trusted order and correlation payloads to lifecycle RPCs', async () => {
    const c = client(); mocks.createClient.mockResolvedValue(c.value)
    const { confirmarPedidoOperador, cancelarPedido } = await import('@/app/actions/pedidos')
    await confirmarPedidoOperador('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')
    await cancelarPedido('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333')
    expect(c.rpc.mock.calls).toEqual([
      ['transicionar_pedido', { p_pedido_id: '11111111-1111-4111-8111-111111111111', p_novo_status: 'confirmado', p_idempotency_key: '22222222-2222-4222-8222-222222222222', p_reason: null }],
      ['transicionar_pedido', { p_pedido_id: '11111111-1111-4111-8111-111111111111', p_novo_status: 'cancelado', p_idempotency_key: '33333333-3333-4333-8333-333333333333', p_reason: null }],
    ])
  })

  it('maps stable lifecycle failures and contains no direct stock loop', async () => {
    const c = client({ code: '23514', message: 'ESTOQUE_INSUFICIENTE' }); mocks.createClient.mockResolvedValue(c.value)
    const { confirmarPedidoOperador } = await import('@/app/actions/pedidos')
    expect(await confirmarPedidoOperador('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')).toEqual({ success: false, error: 'ESTOQUE_INSUFICIENTE' })
    const conflict = client({ code: '23505', message: 'IDEMPOTENCY_CONFLICT' }); mocks.createClient.mockResolvedValue(conflict.value)
    expect(await confirmarPedidoOperador('11111111-1111-4111-8111-111111111111')).toEqual({ success: false, error: 'CONFLITO_IDEMPOTENCIA' })
    const legacy = client({ code: '23514', message: 'EFEITOS_ESTOQUE_INDISPONIVEIS' }); mocks.createClient.mockResolvedValue(legacy.value)
    expect(await confirmarPedidoOperador('11111111-1111-4111-8111-111111111111')).toEqual({ success: false, error: 'EFEITOS_ESTOQUE_INDISPONIVEIS' })
    const source = readFileSync('apps/web/src/app/actions/pedidos.ts', 'utf8')
    expect(source).not.toMatch(/from\('produtos'\)[\s\S]{0,500}update\(/)
    expect(source).not.toMatch(/from\('movimentacoes_estoque'\)[\s\S]{0,300}insert\(/)
  })

  it('locks items before snapshotting exact effects and preserves product activation', () => {
    const sql = readFileSync('supabase/migrations/20260716212059_order_stock_lifecycle.sql', 'utf8')

    expect(sql).toContain('create table public.pedido_estoque_efeitos')
    expect(sql).toContain('create table public.pedido_estoque_snapshots')
    expect(sql.indexOf('from public.itens_pedido where pedido_id=p_pedido_id order by produto_id,id for update')).toBeGreaterThan(sql.indexOf('from public.pedidos where id=p_pedido_id for update'))
    expect(sql).toMatch(/from public\.itens_pedido[\s\S]*order by produto_id,id for update;[\s\S]*insert into public\.pedido_estoque_efeitos/)
    expect(sql.slice(sql.indexOf('select count(*) into expected'))).not.toContain('from public.itens_pedido')
    const productLock = sql.indexOf('order by p.id for update of p')
    expect(productLock).toBeGreaterThan(sql.indexOf('order by produto_id,id for update'))
    expect(productLock).toBeLessThan(sql.lastIndexOf('insert into public.pedido_estoque_efeitos'))
    expect(sql).toMatch(/insert into public\.pedido_estoque_snapshots[\s\S]*jsonb_agg/)
    expect(sql).toContain('order by p.id for update of p')
    expect(sql).not.toMatch(/update public\.produtos set[\s\S]{0,300}\bativo\s*=/)
    expect(sql).toContain("message='EFEITOS_ESTOQUE_INDISPONIVEIS'")
    expect(sql).toContain('revoke all on table public.pedido_estoque_efeitos from public,anon,authenticated,service_role')
  })

  it('backfills an exact legacy snapshot including valid zero-item orders and verifies it before replay', () => {
    const sql = readFileSync('supabase/migrations/20260716212059_order_stock_lifecycle.sql', 'utf8')

    expect(sql).toMatch(/insert into public\.pedido_estoque_snapshots[\s\S]*where p\.status='confirmado'/)
    expect(sql).toContain("coalesce(jsonb_agg")
    expect(sql).toContain("'[]'::jsonb")
    expect(sql).toMatch(/select s\.efeitos into snapshot[\s\S]*snapshot is distinct from actual/)
  })

  it('requires an ownership-bound lifecycle write boundary without revoking unrelated order updates', () => {
    const sql = readFileSync('supabase/migrations/20260718195305_order_stock_lifecycle_write_boundary.sql', 'utf8')

    expect(sql).toMatch(/create function public\.enforce_order_stock_lifecycle_write_boundary\(\)[\s\S]*security invoker/)
    expect(sql).toMatch(/current_user::pg_catalog\.regrole[\s\S]*proowner/)
    expect(sql).toContain("message = 'PEDIDO_ESTOQUE_LIFECYCLE_WRITE_FORBIDDEN'")
    expect(sql).toMatch(/tg_op = 'INSERT'[\s\S]*new\.estoque_estado <> 'pendente'/i)
    expect(sql).toMatch(/before insert or update\s+on public\.pedidos/)
    expect(sql).not.toMatch(/revoke update on (table )?public\.pedidos/i)
  })
})
