import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.createAdminClient }))
vi.mock('@/lib/orders/orderNotifications', () => ({ notificarClienteAtualizacaoPedido: mocks.notify }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import {
  actionAtualizarStatusPagamento,
  actionAtualizarStatusPedido,
  confirmarPedidoOperador,
} from '@/app/actions/pedidos'

const orderId = '11111111-1111-4111-8111-111111111111'

function operatorClient() {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'operator-id' } }, error: null }) },
    from: vi.fn((table: string) => {
      if (table === 'perfis') return {
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { funcao: 'admin', ativo: true }, error: null }),
      }
      return {
        update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { id: orderId }, error: null }),
      }
    }),
    rpc: vi.fn((rpc: string) => {
      if (rpc === 'assert_order_payment_available') return { data: null, error: null }
      return { single: vi.fn().mockResolvedValue({ data: { id: orderId }, error: null }) }
    }),
  }
}

describe('canonical notification outbox bridge', () => {
  beforeEach(() => vi.clearAllMocks())

  it('leaves lifecycle and payment delivery to canonical RPC outbox events', async () => {
    const client = operatorClient()
    mocks.createClient.mockResolvedValue(client)

    await expect(confirmarPedidoOperador(orderId)).resolves.toMatchObject({ success: true })
    await expect(actionAtualizarStatusPedido({ pedidoId: orderId, novoStatus: 'entregue' })).resolves.toMatchObject({ success: true })
    await expect(actionAtualizarStatusPagamento({ pedidoId: orderId, statusPagamento: 'aprovado', reason: 'PIX confirmado' })).resolves.toMatchObject({ success: true })

    expect(client.rpc).toHaveBeenCalledWith('transicionar_pedido', expect.any(Object))
    expect(client.rpc).toHaveBeenCalledWith('registrar_status_pagamento', expect.any(Object))
    expect(mocks.notify).not.toHaveBeenCalled()
  })
})
