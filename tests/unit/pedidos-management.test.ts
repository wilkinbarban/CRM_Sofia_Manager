import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  actionListarPedidos,
  actionAtualizarStatusPedido,
  actionAtualizarStatusPagamento,
  actionObterResumoReceitaRealizada,
} from '@/app/actions/pedidos'
import {
  projetarElegibilidadeReceita,
  resumirReceitaRealizada,
} from '@/lib/orders/revenueEligibility'
import { createClient } from '@/lib/supabase/server'

// Mock Supabase Server Client
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

describe('Gestão de Pedidos - Server Actions (TDD)', () => {
  const mockUser = { id: 'user-op-1', email: 'atendente@crmsofiamanager.com.br' }
  const mockPerfil = { id: 'user-op-1', funcao: 'vendedor', ativo: true }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejeita listagem de pedidos se o operador não estiver autenticado', async () => {
    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: new Error('Não autenticado') }),
      },
    }
    vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

    const res = await actionListarPedidos()
    expect(res.success).toBe(false)
    expect(res.error).toBe('ACESSO_NEGADO_NAO_AUTENTICADO')
  })

  it('lista pedidos com sucesso para operador autorizado', async () => {
    const mockPedidosData = [
      {
        id: 'ped-1',
        status: 'confirmado',
        tipo_entrega: 'retirada',
        total_pedido_centavos: 6990,
        status_pagamento: 'aprovado',
        meio_pagamento: 'pix',
        data_criacao: '2026-08-17T12:00:00Z',
        cliente_id: 'cli-1',
        clientes: { id: 'cli-1', nome: 'Carlos Silva', telefone: '5541999998888' },
        itens: [
          {
            id: 'item-1',
            quantidade: 1,
            preco_unitario_centavos: 6990,
            preco_total_centavos: 6990,
            produtos: { id: 'prod-1', nome: 'Combo 1 - Clássico' },
          },
        ],
      },
    ]

    const mockQueryBuilder: any = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: mockPedidosData, error: null }),
    }

    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'perfis') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: mockPerfil, error: null }),
              }),
            }),
          }
        }
        if (table === 'pedidos') {
          return mockQueryBuilder
        }
        return {}
      }),
    }

    vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

    const res = await actionListarPedidos({ status: 'confirmado' })
    expect(res.success).toBe(true)
    expect(res.data).toHaveLength(1)
    expect(res.data?.[0].id).toBe('ped-1')
  })

  it('atualiza o status do pedido sem alterar o estado do pagamento', async () => {
    const directStatusUpdate = vi.fn()
    const rpc = vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: {
          pedido_id: 'ped-1',
          status: 'entregue',
          valid_next_actions: [],
          idempotent: false,
        },
        error: null,
      }),
    })
    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'perfis') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: mockPerfil, error: null }),
              }),
            }),
          }
        }
        if (table === 'pedidos') {
          return {
            update: directStatusUpdate,
          }
        }
        return {}
      }),
      rpc,
    }

    vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

    const res = await actionAtualizarStatusPedido({
      pedidoId: 'ped-1',
      novoStatus: 'entregue',
    })

    expect(res.success).toBe(true)
    expect((res.data as any)?.status).toBe('entregue')
    expect(rpc).toHaveBeenCalledWith('transicionar_pedido', {
      p_pedido_id: 'ped-1',
      p_novo_status: 'entregue',
      p_idempotency_key: expect.any(String),
      p_reason: null,
    })
    expect(directStatusUpdate).not.toHaveBeenCalled()
  })

  it('cancela o pedido restaurando o estoque via RPC', async () => {
    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'perfis') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: mockPerfil, error: null }),
              }),
            }),
          }
        }
        return {}
      }),
      rpc: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { status: 'cancelado' }, error: null }),
      }),
    }

    vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

    const res = await actionAtualizarStatusPedido({
      pedidoId: 'ped-1',
      novoStatus: 'cancelado',
    })

    expect(res.success).toBe(true)
    expect(mockSupabase.rpc).toHaveBeenCalledWith('transicionar_pedido', {
      p_pedido_id: 'ped-1',
      p_novo_status: 'cancelado',
      p_idempotency_key: expect.any(String),
      p_reason: null,
    })
  })

  it('maps an invalid lifecycle transition to a stable continuation', async () => {
    const rpc = vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { code: '23514', message: 'TRANSICAO_PEDIDO_INVALIDA' },
      }),
    })
    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
      from: vi.fn().mockImplementation((table: string) => table === 'perfis' ? {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: mockPerfil, error: null }),
          }),
        }),
      } : {}),
      rpc,
    }
    vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

    await expect(actionAtualizarStatusPedido({
      pedidoId: 'ped-1',
      novoStatus: 'novo',
    })).resolves.toEqual({
      success: false,
      error: 'TRANSICAO_PEDIDO_INVALIDA',
      continuation: 'RECARREGAR_ACOES_VALIDAS',
    })
  })

  it('atualiza o status de pagamento para aprovado', async () => {
    const rpc = vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: { pedido_id: 'ped-1', status_pagamento: 'aprovado', idempotent: false },
        error: null,
      }),
    })
    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'perfis') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: mockPerfil, error: null }),
              }),
            }),
          }
        }
        return {}
      }),
      rpc,
    }

    vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

    const res = await actionAtualizarStatusPagamento({
      pedidoId: 'ped-1',
      statusPagamento: 'aprovado',
      reason: 'PIX confirmado no caixa',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    })

    expect(res.success).toBe(true)
    expect((res.data as any)?.status_pagamento).toBe('aprovado')
    expect(rpc).toHaveBeenCalledWith('registrar_status_pagamento', {
      p_pedido_id: 'ped-1',
      p_novo_status: 'aprovado',
      p_source: 'manual',
      p_external_reference: null,
      p_reason: 'PIX confirmado no caixa',
      p_idempotency_key: '11111111-1111-4111-8111-111111111111',
    })
  })

  it('requires a manual approval reason before it reaches the payment authority', async () => {
    const rpc = vi.fn()
    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'perfis') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: mockPerfil, error: null }),
              }),
            }),
          }
        }
        return {}
      }),
      rpc,
    }
    vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

    const res = await actionAtualizarStatusPagamento({
      pedidoId: 'ped-1',
      statusPagamento: 'aprovado',
      reason: '   ',
    })

    expect(res).toEqual({
      success: false,
      error: 'MOTIVO_APROVACAO_MANUAL_OBRIGATORIO',
      continuation: 'INFORMAR_MOTIVO_APROVACAO_MANUAL',
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('classifica receita realizada e elegibilidade somente quando o pedido está entregue e aprovado', () => {
    expect(projetarElegibilidadeReceita({
      id: 'ped-entregue-pago',
      status: 'entregue',
      status_pagamento: 'aprovado',
      total_pedido_centavos: 6990,
    })).toEqual({
      receita_realizada_centavos: 6990,
      elegivel_para_comprovante: true,
      continuacao: null,
    })
  })

  it.each([
    ['confirmado', 'aprovado', 'MARCAR_PEDIDO_COMO_ENTREGUE'],
    ['entregue', 'pendente', 'APROVAR_PAGAMENTO'],
    ['cancelado', 'aprovado', 'PEDIDO_NAO_ELEGIVEL_PARA_COMPROVANTE'],
  ] as const)(
    'mantém pedido %s/%s inelegível com orientação estável',
    (status, statusPagamento, continuacao) => {
      expect(projetarElegibilidadeReceita({
        id: 'ped-inelegivel',
        status,
        status_pagamento: statusPagamento,
        total_pedido_centavos: 6990,
      })).toEqual({
        receita_realizada_centavos: 0,
        elegivel_para_comprovante: false,
        continuacao,
      })
    },
  )

  it('resume somente métricas agregadas de receita realizada sem dados do cliente', () => {
    expect(resumirReceitaRealizada([
      { id: 'ped-1', status: 'entregue', status_pagamento: 'aprovado', total_pedido_centavos: 6990 },
      { id: 'ped-2', status: 'entregue', status_pagamento: 'pendente', total_pedido_centavos: 5000 },
      { id: 'ped-3', status: 'confirmado', status_pagamento: 'aprovado', total_pedido_centavos: 2500 },
    ])).toEqual({
      pedidos_realizados: 1,
      receita_realizada_centavos: 6990,
      pedidos_inelegiveis_para_comprovante: 2,
    })
  })

  it('expõe o resumo de receita realizada sem dados pessoais do pedido', async () => {
    const pedidosQuery: any = {
      select: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          { id: 'ped-1', status: 'entregue', status_pagamento: 'aprovado', total_pedido_centavos: 6990 },
          { id: 'ped-2', status: 'entregue', status_pagamento: 'pendente', total_pedido_centavos: 5000 },
        ],
        error: null,
      }),
    }
    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'perfis') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: mockPerfil, error: null }),
              }),
            }),
          }
        }
        if (table === 'pedidos') return pedidosQuery
        return {}
      }),
    }
    vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

    await expect(actionObterResumoReceitaRealizada()).resolves.toEqual({
      success: true,
      data: {
        pedidos_realizados: 1,
        receita_realizada_centavos: 6990,
        pedidos_inelegiveis_para_comprovante: 1,
      },
    })
    expect(pedidosQuery.select).toHaveBeenCalledWith('id, status, status_pagamento, total_pedido_centavos')
  })
})

describe('emissão de comprovante de venda', () => {
  const mockUser = { id: 'user-op-1', email: 'atendente@crmsofiamanager.com.br' }
  const mockPerfil = { id: 'user-op-1', funcao: 'vendedor', ativo: true }

  it('emite e reemite o mesmo snapshot pelo RPC autoritativo', async () => {
    const rpc = vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: {
          receipt_id: 'receipt-1',
          snapshot: { charged_amount_centavos: 6990 },
          snapshot_hash: 'a'.repeat(64),
          idempotent: true,
        },
        error: null,
      }),
    })
    const mockSupabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }) },
      from: vi.fn().mockImplementation((table: string) => table === 'perfis' ? {
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: mockPerfil, error: null }) }) }),
      } : {}),
      rpc,
    }
    vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

    const { actionEmitirComprovanteVenda } = await import('@/app/actions/pedidos')
    const result = await actionEmitirComprovanteVenda({ pedidoId: 'ped-1', idempotencyKey: '3b42cc50-ddb8-46d8-9fab-0d0db3e5b48c' })

    expect(result).toEqual(expect.objectContaining({ success: true, idempotent: true, snapshot_hash: 'a'.repeat(64) }))
    expect(rpc).toHaveBeenCalledWith('emitir_comprovante_venda', {
      p_pedido_id: 'ped-1',
      p_idempotency_key: '3b42cc50-ddb8-46d8-9fab-0d0db3e5b48c',
    })
  })

  it('returns the payment continuation when receipt issuance is ineligible', async () => {
    const rpc = vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: null, error: { message: 'RECEIPT_ISSUANCE_INELIGIVEL' } }) })
    const mockSupabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }) },
      from: vi.fn().mockImplementation((table: string) => table === 'perfis' ? {
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: mockPerfil, error: null }) }) }),
      } : {}),
      rpc,
    }
    vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

    const { actionEmitirComprovanteVenda } = await import('@/app/actions/pedidos')
    const result = await actionEmitirComprovanteVenda({ pedidoId: 'ped-1', idempotencyKey: '3b42cc50-ddb8-46d8-9fab-0d0db3e5b48c' })

    expect(result).toEqual({ success: false, error: 'PEDIDO_NAO_ELEGIVEL_PARA_COMPROVANTE', continuation: 'MARCAR_PEDIDO_COMO_ENTREGUE_OU_APROVAR_PAGAMENTO' })
  })
})
