import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processarAcaoInterativaWhatsApp } from '@/lib/whatsapp/action-router'
import * as carrinhoService from '@/lib/carrinho/service'

vi.mock('@/lib/whatsapp/gateways/catalog-gateway', () => ({
  enviarCatalogoCombosWhatsApp: vi.fn().mockResolvedValue({ success: true, sent: 4 }),
}))

vi.mock('@/lib/carrinho/service', () => ({
  adicionarItemAoCarrinho: vi.fn(),
  obterOuCriarCarrinhoAtivo: vi.fn(),
  limparCarrinho: vi.fn(),
  converterCarrinhoEmPedido: vi.fn(),
}))

describe('WhatsApp Action Router (TDD)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('processa ação cart:add:<produto_id> adicionando item ao carrinho', async () => {
    vi.mocked(carrinhoService.adicionarItemAoCarrinho).mockResolvedValueOnce({
      success: true,
      carrinho: {
        id: 'cart-1',
        cliente_id: 'cli-1',
        canal: 'whatsapp',
        status: 'aberto',
        subtotal_centavos: 3990,
        desconto_centavos: 0,
        taxa_entrega_centavos: 0,
        total_centavos: 3990,
        tipo_entrega: 'retirada',
        itens_carrinho: [
          {
            id: 'item-1',
            carrinho_id: 'cart-1',
            produto_id: 'prod-1',
            quantidade: 1,
            preco_unitario_centavos: 3990,
            preco_total_centavos: 3990,
            produtos: { nome: 'Frango Assado Inteiro' },
          },
        ],
      },
    })

    const resultado = await processarAcaoInterativaWhatsApp({
      clienteId: 'cli-1',
      telefone: '5541999998888',
      interactiveId: 'cart:add:prod-1',
    })

    expect(resultado.handled).toBe(true)
    expect(resultado.respostaTexto).toContain('Frango Assado Inteiro')
    expect(resultado.respostaTexto).toContain('39,90')
    expect(carrinhoService.adicionarItemAoCarrinho).toHaveBeenCalledWith(
      expect.objectContaining({
        clienteId: 'cli-1',
        produtoId: 'prod-1',
      })
    )
  })

  it('processa ação cart:view retornando resumo do carrinho', async () => {
    vi.mocked(carrinhoService.obterOuCriarCarrinhoAtivo).mockResolvedValueOnce({
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
            produto_id: 'prod-1',
            quantidade: 1,
            preco_unitario_centavos: 6990,
            preco_total_centavos: 6990,
            produtos: { nome: 'Combo 1 - O Clássico' },
          },
        ],
      },
    })

    const resultado = await processarAcaoInterativaWhatsApp({
      clienteId: 'cli-1',
      telefone: '5541999998888',
      interactiveId: 'cart:view',
    })

    expect(resultado.handled).toBe(true)
    expect(resultado.respostaTexto).toContain('Seu Carrinho de Pedido')
    expect(resultado.respostaTexto).toContain('Combo 1 - O Clássico')
  })

  it('routes catalog:view through the catalog gateway', async () => {
        const result = await processarAcaoInterativaWhatsApp({
          clienteId: 'cli-1', telefone: '5541999998888', interactiveId: 'catalog:view',
          supabaseClient: {
            from: () => ({
              select: () => ({
                eq: async () => ({ data: [
                  { id: 'a1111111-1111-4111-8111-111111111111', nome: 'Combo 1', preco_centavos: 1000 },
                  { id: 'a2222222-2222-4222-8222-222222222222', nome: 'Combo 2', preco_centavos: 1000 },
                  { id: 'a3333333-3333-4333-8333-333333333333', nome: 'Combo 3', preco_centavos: 1000 },
                  { id: 'a4444444-4444-4444-8444-444444444444', nome: 'Combo 4', preco_centavos: 1000 },
                ], error: null }),
              }),
            }),
          },
        })
        expect(result.handled).toBe(true)
        expect(result.catalog?.sent).toBe(4)
      })

      it('retorna handled: false para IDs desconhecidos ou nulos', async () => {
    const resultado = await processarAcaoInterativaWhatsApp({
      clienteId: 'cli-1',
      telefone: '5541999998888',
      interactiveId: null,
    })

    expect(resultado.handled).toBe(false)
    expect(resultado.respostaTexto).toBeUndefined()
  })
})
