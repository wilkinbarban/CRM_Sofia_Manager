import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executarToolSofia, type SofiaToolContext } from '@/lib/ai/tools'
import * as carrinhoService from '@/lib/carrinho/service'

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn(),
  })),
}))

vi.mock('@/lib/carrinho/service', () => ({
  adicionarItemAoCarrinho: vi.fn(),
  obterOuCriarCarrinhoAtivo: vi.fn(),
  removerItemDoCarrinho: vi.fn(),
  limparCarrinho: vi.fn(),
  converterCarrinhoEmPedido: vi.fn(),
}))

describe('Sofia AI Cart Tools (TDD)', () => {
  const mockContext: SofiaToolContext = {
    clienteId: 'cli-1',
    telefone: '5541999998888',
    canal: 'whatsapp',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('tool: adicionar_ao_carrinho adiciona produto e retorna resumo', async () => {
    vi.mocked(carrinhoService.adicionarItemAoCarrinho).mockResolvedValueOnce({
      success: true,
      carrinho: {
        id: 'cart-1',
        cliente_id: 'cli-1',
        canal: 'whatsapp',
        status: 'aberto',
        subtotal_centavos: 6990,
        desconto_centavos: 0,
        taxa_entrega_centavos: 0,
        total_centavos: 6990,
        tipo_entrega: 'retirada',
        itens_carrinho: [
          {
            id: 'item-1',
            carrinho_id: 'cart-1',
            produto_id: 'prod-combo-1',
            quantidade: 1,
            preco_unitario_centavos: 6990,
            preco_total_centavos: 6990,
            produtos: { nome: 'Combo 1 - O Clássico' },
          },
        ],
      },
    })

    const resultado = await executarToolSofia(
      'adicionar_ao_carrinho',
      { produtoId: 'prod-combo-1', quantidade: 1 },
      mockContext
    )

    expect(resultado.success).toBe(true)
    expect(resultado.mensagem).toContain('Combo 1 - O Clássico')
    expect(resultado.mensagem).toContain('69,90')
    expect(carrinhoService.adicionarItemAoCarrinho).toHaveBeenCalledWith(
      expect.objectContaining({
        clienteId: 'cli-1',
        produtoId: 'prod-combo-1',
        quantidade: 1,
      })
    )
  })

  it('tool: ver_carrinho retorna itens e subtotal atual', async () => {
    vi.mocked(carrinhoService.obterOuCriarCarrinhoAtivo).mockResolvedValueOnce({
      success: true,
      carrinho: {
        id: 'cart-1',
        cliente_id: 'cli-1',
        canal: 'whatsapp',
        status: 'aberto',
        subtotal_centavos: 11990,
        desconto_centavos: 0,
        taxa_entrega_centavos: 0,
        total_centavos: 11990,
        tipo_entrega: 'retirada',
        itens_carrinho: [
          {
            id: 'item-2',
            carrinho_id: 'cart-1',
            produto_id: 'prod-combo-2',
            quantidade: 1,
            preco_unitario_centavos: 11990,
            preco_total_centavos: 11990,
            produtos: { nome: 'Combo 2 - Costela Suprema' },
          },
        ],
      },
    })

    const resultado = await executarToolSofia('ver_carrinho', {}, mockContext)

    expect(resultado.success).toBe(true)
    expect(resultado.mensagem).toContain('Combo 2 - Costela Suprema')
    expect(resultado.mensagem).toContain('119,90')
  })

  it('tool: limpar_carrinho esvazia o carrinho ativo', async () => {
    vi.mocked(carrinhoService.limparCarrinho).mockResolvedValueOnce({
      success: true,
      carrinho: {
        id: 'cart-1',
        cliente_id: 'cli-1',
        canal: 'whatsapp',
        status: 'aberto',
        subtotal_centavos: 0,
        desconto_centavos: 0,
        taxa_entrega_centavos: 0,
        total_centavos: 0,
        tipo_entrega: 'retirada',
        itens_carrinho: [],
      },
    })

    const resultado = await executarToolSofia('limpar_carrinho', {}, mockContext)

    expect(resultado.success).toBe(true)
    expect(resultado.mensagem).toContain('esvaziado')
  })

  it('tool: consultar_horarios_retirada retorna slots de domingo', async () => {
    const resultado = await executarToolSofia('consultar_horarios_retirada', {}, mockContext)

    expect(resultado.success).toBe(true)
    expect(resultado.mensagem).toContain('11:30')
    expect(resultado.mensagem).toContain('13:15')
  })
})
