import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  registrarPagamento: vi.fn(),
  concluirDelivery: vi.fn(),
  falharDelivery: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: mocks.createAdminClient,
}))

import { processarPagamentoBackground } from '@/app/api/webhooks/mercadopago/route'

beforeEach(() => {
  mocks.registrarPagamento.mockResolvedValue({
    data: {
      pedido_id: 'order-refund-first',
      status_pagamento: 'reembolsado',
      idempotent: false,
    },
    error: null,
  })
  mocks.concluirDelivery.mockResolvedValue({ data: true })
  mocks.falharDelivery.mockResolvedValue({ data: true })
  mocks.createAdminClient.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
    rpc: (name: string, args: unknown) => {
      if (name === 'registrar_status_pagamento') {
        mocks.registrarPagamento(args)
        return { single: () => mocks.registrarPagamento() }
      }
      if (name === 'concluir_webhook_mercado_pago') {
        mocks.concluirDelivery(args)
        return mocks.concluirDelivery()
      }
      mocks.falharDelivery(args)
      return mocks.falharDelivery()
    },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Mercado Pago refund-first delivery', () => {
  it('records the terminal reversal and completes the delivery without retrying', async () => {
    const completed = await processarPagamentoBackground(
      'payment-refund-first',
      null,
      {
        resolvePayment: async () => ({ status: 'refunded', pedidoId: 'order-refund-first' }),
      },
      { requestId: 'delivery-refund-first', providerDeliveryId: 'delivery-refund-first' },
    )

    expect(completed).toBe(true)
    expect(mocks.registrarPagamento).toHaveBeenCalledWith({
      p_pedido_id: 'order-refund-first',
      p_novo_status: 'reembolsado',
      p_source: 'mercado_pago',
      p_external_reference: 'payment-refund-first',
      p_reason: null,
      p_provider_delivery_id: 'delivery-refund-first',
    })
    expect(mocks.concluirDelivery).toHaveBeenCalledWith({
      p_request_id: 'delivery-refund-first',
      p_payment_id: 'payment-refund-first',
    })
    expect(mocks.falharDelivery).not.toHaveBeenCalled()
  })
})
