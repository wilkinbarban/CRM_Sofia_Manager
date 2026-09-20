import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  getUser: vi.fn(),
  obterConfiguracaoSistema: vi.fn(),
  enviarMensagemWhatsapp: vi.fn(),
  enviarMensagemTelegram: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: mocks.createAdminClient,
}))

vi.mock('@/lib/config/sistema', () => ({
  obterConfiguracaoSistema: mocks.obterConfiguracaoSistema,
}))

vi.mock('@/lib/whatsapp/send', () => ({
  enviarMensagemWhatsapp: mocks.enviarMensagemWhatsapp,
}))

vi.mock('@/lib/telegram/send', () => ({
  enviarMensagemTelegram: mocks.enviarMensagemTelegram,
}))

import {
  gerarCobrancaPixPedido,
  enviarCobrancaPixAoCliente,
  enviarComprovantePagamentoCliente,
} from '@/app/actions/pedidos'

describe('PIX Payment & Customer Receipt Actions', () => {
  beforeEach(() => {
    vi.resetAllMocks()

    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'operador-123' } },
      error: null,
    })

    const supabaseMock = {
      auth: { getUser: mocks.getUser },
      from: vi.fn((table: string) => {
        if (table === 'perfis') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { funcao: 'admin', ativo: true },
                  error: null,
                }),
                maybeSingle: async () => ({
                  data: { funcao: 'admin', ativo: true },
                  error: null,
                }),
              }),
            }),
          }
        }
        if (table === 'pedidos') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: 'pedido-pix-test-1234',
                    status: 'novo',
                    status_pagamento: 'pendente',
                    total_produtos_centavos: 12000,
                    total_pedido_centavos: 12000,
                    cliente_id: 'cliente-123',
                    conversa_id: 'conversa-123',
                    clientes: {
                      id: 'cliente-123',
                      usuario_id: 'user-cliente-123',
                      nome: 'João Silva',
                      telefone: '5541999998888',
                      telegram_chat_id: '12345678',
                    },
                  },
                  error: null,
                }),
              }),
            }),
          }
        }
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
        }
      }),
    }

    const supabaseAdminMock = {
      from: vi.fn(() => ({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                maybeSingle: async () => ({ data: { id: 'conversa-123' }, error: null }),
              }),
            }),
            single: async () => ({
              data: {
                id: 'pedido-pix-test-1234',
                conversa_id: 'conversa-123',
                cliente_id: 'cliente-123',
                clientes: {
                  id: 'cliente-123',
                  nome: 'João Silva',
                  telefone: '5541999998888',
                  telegram_chat_id: '12345678',
                },
              },
              error: null,
            }),
          }),
        }),
      })),
      rpc: vi.fn().mockReturnValue({
        single: async () => ({ data: true, error: null }),
      }),
    }

    mocks.createClient.mockResolvedValue(supabaseMock)
    mocks.createAdminClient.mockReturnValue(supabaseAdminMock)
    mocks.obterConfiguracaoSistema.mockResolvedValue(null)
    mocks.enviarMensagemWhatsapp.mockResolvedValue({ sucesso: true })
    mocks.enviarMensagemTelegram.mockResolvedValue({ sucesso: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gerarCobrancaPixPedido generates mock PIX payload in development/mock mode', async () => {
    const res = await gerarCobrancaPixPedido('pedido-pix-test-1234')

    expect(res.success).toBe(true)
    if (res.success && res.pix) {
      expect(res.pix.qrCodeCopiaCola).toContain('00020126580014br.gov.bcb.pix')
      expect(res.pix.qrCodeBase64).toBeDefined()
      expect(res.pix.valorCentavos).toBe(12000)
    }
  })

  it('enviarCobrancaPixAoCliente dispatches formatted message to chat, whatsapp and telegram', async () => {
    const res = await enviarCobrancaPixAoCliente('pedido-pix-test-1234', {
      qrCodeCopiaCola: '00020126580014br.gov.bcb.pixMOCK',
      valorCentavos: 12000,
    })

    expect(res.success).toBe(true)
    expect(mocks.enviarMensagemWhatsapp).toHaveBeenCalledWith(
      'conversa-123',
      expect.objectContaining({
        texto: expect.stringContaining('00020126580014br.gov.bcb.pixMOCK'),
        remetente: 'operador',
      })
    )
    expect(mocks.enviarMensagemTelegram).toHaveBeenCalledWith(
      'conversa-123',
      expect.objectContaining({
        texto: expect.stringContaining('00020126580014br.gov.bcb.pixMOCK'),
        remetente: 'operador',
      })
    )
  })

  it('enviarComprovantePagamentoCliente rejects a proof without durable order authority', async () => {
    const res = await enviarComprovantePagamentoCliente('pedido-pix-test-1234', {
      texto: 'Comprovante Nubank transferido às 14:30',
      urlComprovante: 'https://storage.crmsofiamanager.duckdns.org/comprovante.jpg',
    })

    expect(res).toEqual({ success: false, error: 'COMPROVANTE_INDISPONIVEL' })
  })
})
