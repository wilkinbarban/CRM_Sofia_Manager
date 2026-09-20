import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  obterOuCriarCarrinhoAtivo,
  adicionarItemAoCarrinho,
  removerItemDoCarrinho,
  converterCarrinhoEmPedido,
} from '@/lib/carrinho/service'

// Mocks do Supabase
const mockSingle = vi.fn()
const mockMaybeSingle = vi.fn()
const mockSelect = vi.fn()
const mockInsert = vi.fn()
const mockUpdate = vi.fn()
const mockDelete = vi.fn()
const mockEq = vi.fn()
const mockRpc = vi.fn()

const mockSupabase: any = {
  from: vi.fn((table: string) => ({
    select: (...args: any[]) => {
      mockSelect(table, ...args)
      return {
        eq: (...eqArgs: any[]) => {
          mockEq(table, ...eqArgs)
          return {
            eq: (...secondEqArgs: any[]) => {
              mockEq(table, ...secondEqArgs)
              return {
                maybeSingle: mockMaybeSingle,
                single: mockSingle,
              }
            },
            maybeSingle: mockMaybeSingle,
            single: mockSingle,
            order: () => ({ maybeSingle: mockMaybeSingle, single: mockSingle }),
          }
        },
        maybeSingle: mockMaybeSingle,
        single: mockSingle,
      }
    },
    insert: (data: any) => {
      mockInsert(table, data)
      return {
        select: () => ({
          single: mockSingle,
          maybeSingle: mockMaybeSingle,
        }),
      }
    },
    update: (data: any) => {
      mockUpdate(table, data)
      return {
        eq: (...args: any[]) => {
          mockEq(table, ...args)
          return {
            eq: (...secondArgs: any[]) => {
              mockEq(table, ...secondArgs)
              return {
                select: () => ({ single: mockSingle, maybeSingle: mockMaybeSingle }),
              }
            },
            select: () => ({ single: mockSingle, maybeSingle: mockMaybeSingle }),
          }
        },
      }
    },
    delete: () => {
      mockDelete(table)
      return {
        eq: (...args: any[]) => {
          mockEq(table, ...args)
          return {
            eq: (...secondArgs: any[]) => {
              mockEq(table, ...secondArgs)
              return Promise.resolve({ error: null })
            },
          }
        },
      }
    },
  })),
  rpc: mockRpc,
}

describe('CarrinhoService (TDD)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('obterOuCriarCarrinhoAtivo retorna carrinho existente se já houver um aberto', async () => {
    const existingCart = {
      id: 'cart-123',
      cliente_id: 'cli-1',
      status: 'aberto',
      subtotal_centavos: 6990,
      total_centavos: 6990,
      itens_carrinho: [
        {
          id: 'item-1',
          produto_id: 'prod-1',
          quantidade: 1,
          preco_unitario_centavos: 6990,
          preco_total_centavos: 6990,
          produtos: { nome: 'Combo 1 - O Clássico', url_imagem: '/img1.png' },
        },
      ],
    }

    mockMaybeSingle.mockResolvedValueOnce({ data: existingCart, error: null })

    const result = await obterOuCriarCarrinhoAtivo('cli-1', { supabaseClient: mockSupabase })

    expect(result.success).toBe(true)
    expect(result.carrinho?.id).toBe('cart-123')
    expect(result.carrinho?.itens_carrinho).toHaveLength(1)
  })

  it('obterOuCriarCarrinhoAtivo cria novo carrinho se não houver aberto', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const newCart = {
      id: 'cart-new-1',
      cliente_id: 'cli-2',
      status: 'aberto',
      subtotal_centavos: 0,
      total_centavos: 0,
      itens_carrinho: [],
    }
    mockSingle.mockResolvedValueOnce({ data: newCart, error: null })

    const result = await obterOuCriarCarrinhoAtivo('cli-2', { canal: 'whatsapp', supabaseClient: mockSupabase })

    expect(result.success).toBe(true)
    expect(result.carrinho?.id).toBe('cart-new-1')
    expect(mockInsert).toHaveBeenCalledWith('carrinhos', expect.objectContaining({
      cliente_id: 'cli-2',
      canal: 'whatsapp',
      status: 'aberto',
    }))
  })

  it('adicionarItemAoCarrinho busca preço atual do produto no banco e adiciona item', async () => {
    // 1. Carrinho aberto existente
    mockMaybeSingle.mockResolvedValueOnce({
      data: { id: 'cart-123', cliente_id: 'cli-1', status: 'aberto' },
      error: null,
    })

    // 2. Produto no banco
    mockMaybeSingle.mockResolvedValueOnce({
      data: { id: 'prod-1', nome: 'Frango Assado', preco_centavos: 3990, ativo: true },
      error: null,
    })

    // 3. Item existente no carrinho (nenhum)
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null })

    // 4. Carrinho recarregado
    mockSingle.mockResolvedValueOnce({
      data: {
        id: 'cart-123',
        cliente_id: 'cli-1',
        status: 'aberto',
        subtotal_centavos: 7980,
        total_centavos: 7980,
        itens_carrinho: [
          {
            id: 'item-1',
            produto_id: 'prod-1',
            quantidade: 2,
            preco_unitario_centavos: 3990,
            preco_total_centavos: 7980,
            produtos: { nome: 'Frango Assado' },
          },
        ],
      },
      error: null,
    })

    const result = await adicionarItemAoCarrinho({
      clienteId: 'cli-1',
      produtoId: 'prod-1',
      quantidade: 2,
      supabaseClient: mockSupabase,
    })

    expect(result.success).toBe(true)
    expect(result.carrinho?.total_centavos).toBe(7980)
    expect(mockInsert).toHaveBeenCalledWith('itens_carrinho', expect.objectContaining({
      carrinho_id: 'cart-123',
      produto_id: 'prod-1',
      quantidade: 2,
      preco_unitario_centavos: 3990,
      preco_total_centavos: 7980,
    }))
  })

  it('removerItemDoCarrinho remove item e retorna carrinho atualizado', async () => {
    // 1. Carrinho aberto existente
    mockMaybeSingle.mockResolvedValueOnce({
      data: { id: 'cart-123', cliente_id: 'cli-1', status: 'aberto' },
      error: null,
    })

    // 2. Carrinho recarregado após exclusão
    mockSingle.mockResolvedValueOnce({
      data: {
        id: 'cart-123',
        cliente_id: 'cli-1',
        status: 'aberto',
        subtotal_centavos: 0,
        total_centavos: 0,
        itens_carrinho: [],
      },
      error: null,
    })

    const result = await removerItemDoCarrinho({
      clienteId: 'cli-1',
      produtoId: 'prod-1',
      supabaseClient: mockSupabase,
    })

    expect(result.success).toBe(true)
    expect(mockDelete).toHaveBeenCalledWith('itens_carrinho')
  })

  it('converterCarrinhoEmPedido chama RPC transacional e retorna dados do pedido', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [
        {
          pedido_id: 'ped-999',
          status_pedido: 'confirmado',
          total_centavos: 6990,
          quantidade_itens: 1,
        },
      ],
      error: null,
    })

    const result = await converterCarrinhoEmPedido({
      carrinhoId: 'cart-123',
      meioPagamento: 'pix',
      horarioRetirada: '12:15',
      supabaseClient: mockSupabase,
    })

    expect(result.success).toBe(true)
    expect(result.pedidoId).toBe('ped-999')
    expect(result.totalCentavos).toBe(6990)
    expect(mockRpc).toHaveBeenCalledWith('converter_carrinho_em_pedido', {
      p_carrinho_id: 'cart-123',
      p_meio_pagamento: 'pix',
      p_horario_retirada: '12:15',
    })
  })
})
